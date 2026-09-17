import { chatJson, chatStream } from './llm.js';
import { validateSql, SqlGuardError } from './sqlGuard.js';
import { runQuery } from './db.js';
import { MAX_SQL_RETRY, MAX_RESULT_ROWS } from './config.js';

/**
 * NL2SQL：把自然语言问题翻译成 SQL 并执行。
 *
 * 两个关键设计：
 *   1. schema 注入 —— 把表结构 + 样本数据给模型，它才可能写出正确的列名与聚合；
 *   2. 失败分两类处理 —— 安全校验失败直接拒绝（不给绕过机会），
 *      执行失败则把 SQLite 报错回传让模型自愈（列名拼错这类问题很常见）。
 */

const SYSTEM_PROMPT = `你是一个资深数据分析师，负责把用户的自然语言问题翻译成 SQLite 查询语句。

你只能输出一个 JSON 对象，不要输出任何其它内容，格式如下：
{
  "reasoning": "你的分析思路，中文，1-2 句",
  "sql": "完整的 SQLite SELECT 语句；若无法回答则填空字符串",
  "chart": {
    "type": "bar | line | pie | scatter | table",
    "x": "横轴列名",
    "y": ["纵轴列名"],
    "title": "图表标题"
  }
}

生成 SQL 的规则：
1. 只能生成 SELECT 查询。绝对禁止 INSERT / UPDATE / DELETE / DROP / ALTER / PRAGMA 等任何写操作或结构变更。
2. 只能使用【数据表结构】中真实存在的表名和列名，不要臆造字段。
3. 列名一律用双引号包裹，例如 "销售额"、"地区"。
4. 聚合用 GROUP BY，排序用 ORDER BY；"最多/最高/前 N" 类问题用 ORDER BY ... DESC LIMIT n。
5. 结果集不要超过 ${MAX_RESULT_ROWS} 行。
6. 日期字段是 TEXT 类型（形如 2026-01-15），可用字符串比较，或用 substr / strftime 处理。
7. 数值计算用 SUM / AVG / COUNT / MAX / MIN 等聚合函数，并给结果列起可读的别名（用 AS）。

选择图表的规则：
- 类别对比（如各地区的销售额）→ bar
- 时间趋势（如每月销量变化）→ line
- 占比构成（如各品类占比，且类别不超过 8 个）→ pie
- 两个数值字段之间的关系 → scatter
- 单值结果、明细清单、或类别超过 20 个 → table
- x / y 必须是 SQL 结果集中真实存在的列名；table 类型时 x 填 null、y 填空数组

如果用户的问题与数据无关、或所需字段不存在，请把 sql 设为空字符串 ""，并在 reasoning 中说明原因。`;

function formatSchema(schema) {
  return schema
    .map((table) => {
      const cols = table.columns.map((c) => `    - "${c.name}" (${c.type})`).join('\n');
      const samples = table.sample.map((row) => `    ${JSON.stringify(row)}`).join('\n');
      return [
        `表名：${table.tableName}　（来源文件：${table.fileName}，共 ${table.rowCount} 行）`,
        '  列：',
        cols,
        '  示例数据：',
        samples,
      ].join('\n');
    })
    .join('\n\n');
}

export function buildMessages({ question, schema, history = [] }) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    // 只带最近几轮，避免历史把 schema 挤到不重要的位置
    ...history.slice(-4),
    {
      role: 'user',
      content: `【数据表结构】\n${formatSchema(schema)}\n\n【用户问题】\n${question}`,
    },
  ];
}

const VALID_CHART_TYPES = ['bar', 'line', 'pie', 'scatter', 'table'];

/**
 * 校验图表配置是否与真实结果集匹配。
 * 模型经常会编造列名，或对单行结果强行给个饼图，这里一律降级为表格——
 * 宁可少画一张图，也不要画一张错图或空白图。
 */
export function normalizeChart(chart, result) {
  const fallback = { type: 'table', x: null, y: [], title: '' };
  if (!chart || typeof chart !== 'object') return fallback;

  const type = VALID_CHART_TYPES.includes(chart.type) ? chart.type : 'table';
  const title = String(chart.title ?? '');
  const columnSet = new Set(result.columns);

  const x = columnSet.has(chart.x) ? chart.x : null;
  const y = (Array.isArray(chart.y) ? chart.y : [chart.y]).filter((c) => columnSet.has(c));

  const charted = { type, x, y, title };

  if (type === 'table') return { ...charted, x: null, y: [] };

  // 单行或无数据，画图没有意义
  if (result.rows.length <= 1) return { ...fallback, title };

  // x/y 与结果集对不上 → 降级
  if (!x || y.length === 0) return { ...fallback, title };

  // 饼图类别过多会糊成一团，改用柱状图
  if (type === 'pie' && result.rows.length > 12) {
    return { ...charted, type: 'bar' };
  }

  // 散点图必须有第二个数值维度
  if (type === 'scatter' && y.length < 1) return { ...fallback, title };

  return charted;
}

/**
 * 默认的 SQL 生成器：调用大模型。
 *
 * 之所以抽成一个参数，是为了让「执行失败 → 回传报错 → 重试」这段逻辑
 * 能被确定性地测试——依赖真实模型的话，它的输出每次都不一样，
 * 测试就成了碰运气。
 */
const defaultGenerateSql = (messages) => chatJson(messages, { temperature: 0.1 });

/**
 * 完整问答：生成 SQL → 安全校验 → 执行（失败则自愈）→ 返回结果与图表配置
 *
 * @param {{question:string, schema:Array, history?:Array, generateSql?:Function}} params
 * @returns {Promise<object>}
 */
export async function ask({ question, schema, history = [], generateSql = defaultGenerateSql }) {
  if (!schema || schema.length === 0) {
    throw new Error('还没有导入任何数据，请先上传 CSV 或 Excel 文件');
  }

  const messages = buildMessages({ question, schema, history });
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_SQL_RETRY; attempt++) {
    const raw = await generateSql(messages);

    const sql = String(raw.sql ?? '').trim();

    // 模型判断无法回答（问题与数据无关 / 字段不存在）
    if (!sql) {
      return {
        answerable: false,
        reasoning: String(raw.reasoning ?? '数据中似乎没有能回答该问题的信息。'),
        sql: '',
        chart: null,
        result: null,
        attempts: attempt + 1,
      };
    }

    let safeSql;
    let warnings = [];
    try {
      ({ sql: safeSql, warnings } = validateSql(sql, { maxRows: MAX_RESULT_ROWS }));
    } catch (err) {
      // 安全拦截不重试：再给模型一次机会，等于给它一次绕过限制的机会。
      // 安全问题应该「失败即终止」，而不是「失败即重试」。
      if (err instanceof SqlGuardError) {
        throw new Error(`生成的 SQL 未通过安全校验：${err.message}`);
      }
      throw err;
    }

    try {
      const result = runQuery(safeSql);
      return {
        answerable: true,
        reasoning: String(raw.reasoning ?? ''),
        sql: safeSql,
        chart: normalizeChart(raw.chart, result),
        result,
        warnings,
        attempts: attempt + 1,
      };
    } catch (err) {
      // 执行失败（列名拼错、语法错误等）——把报错回给模型，让它自我修正
      lastError = err;
      if (attempt >= MAX_SQL_RETRY) break;

      messages.push({ role: 'assistant', content: JSON.stringify(raw) });
      messages.push({
        role: 'user',
        content:
          `上面的 SQL 执行失败，SQLite 报错：${err.message}\n` +
          '请修正后重新输出完整的 JSON。注意：只能使用数据表结构中真实存在的表和列名，且只能用 SELECT。',
      });
    }
  }

  throw new Error(`SQL 连续 ${MAX_SQL_RETRY + 1} 次执行失败：${lastError?.message ?? '未知错误'}`);
}

/** 基于查询结果流式生成自然语言解读 */
export async function* streamInsight({ question, sql, result, signal }) {
  const preview = result.rows.slice(0, 30);

  const messages = [
    {
      role: 'system',
      content:
        '你是数据分析师。请用简体中文简洁解读查询结果，点出关键发现或趋势。' +
        '不要重复 SQL，不要罗列全部数据，不要编造结果里没有的信息。控制在 3 句话以内。',
    },
    {
      role: 'user',
      content:
        `用户问题：${question}\n\n` +
        `执行的 SQL：${sql}\n\n` +
        `查询结果（共 ${result.rows.length} 行，这里展示前 ${preview.length} 行）：\n` +
        JSON.stringify(preview),
    },
  ];

  yield* chatStream(messages, { temperature: 0.4, signal });
}

export { SYSTEM_PROMPT };
