/**
 * SQL 安全校验。
 *
 * 让大模型直接生成 SQL 并执行，是本项目最大的风险面：模型可能被用户诱导
 * 写出 DROP TABLE / DELETE / ATTACH 之类的语句。所以执行前必须过一道白名单校验。
 *
 * 关键设计：先在「剥离注释与字符串字面量」后的 SQL 上做判断。
 * 否则会出现两个方向的错误——
 *   不剥离：数据里含 "DROP" 的字符串会被误判为危险语句；
 *   只看原文：把关键字藏进注释或字符串里又能绕过检测。
 */

export class SqlGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SqlGuardError';
  }
}

/** 写操作与危险语句一律禁止 */
const FORBIDDEN_KEYWORDS = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'replace',
  'truncate', 'attach', 'detach', 'pragma', 'vacuum', 'reindex',
  'grant', 'revoke', 'begin', 'commit', 'rollback', 'savepoint', 'release',
];

/** 能读写文件或加载外部代码的函数 */
const FORBIDDEN_FUNCTIONS = ['load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer'];

/**
 * 把注释和字符串字面量替换掉，只留下 SQL 的“结构部分”。
 * 这样后续的关键字匹配既能避免误报，也能防止用注释/字符串绕过。
 */
function stripLiterals(sql) {
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 行注释 --
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }

    // 块注释 /* */
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }

    // 字符串字面量 / 带引号的标识符，整体替换为占位符
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2; // '' 是转义
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += '?';
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * 校验并规整 SQL。
 * @param {string} rawSql
 * @param {{maxRows?: number}} options
 * @returns {{sql: string, warnings: string[]}}
 * @throws {SqlGuardError}
 */
export function validateSql(rawSql, { maxRows = 500 } = {}) {
  const original = String(rawSql ?? '').trim();
  if (!original) throw new SqlGuardError('模型没有生成 SQL');

  if (original.length > 5000) {
    throw new SqlGuardError('SQL 过长，已拒绝执行');
  }

  const stripped = stripLiterals(original);

  // 1) 只允许单条语句：多语句是典型的注入/破坏手法
  const statements = stripped
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  if (statements.length > 1) {
    throw new SqlGuardError('只允许执行单条 SQL 语句');
  }

  const core = statements[0] ?? '';
  if (!core) throw new SqlGuardError('生成的 SQL 为空');

  // 2) 必须是只读查询
  if (!/^(select|with)\b/i.test(core)) {
    throw new SqlGuardError('出于安全考虑，只允许执行 SELECT 查询');
  }

  // 3) 关键字黑名单（注意：WITH ... INSERT 也在此被拦下）
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(core)) {
      throw new SqlGuardError(`SQL 包含被禁止的关键字：${keyword.toUpperCase()}`);
    }
  }

  // 4) 危险函数
  for (const fn of FORBIDDEN_FUNCTIONS) {
    if (new RegExp(`\\b${fn}\\s*\\(`, 'i').test(core)) {
      throw new SqlGuardError(`SQL 调用了被禁止的函数：${fn}`);
    }
  }

  // 5) pragma_* 表值函数（如 pragma_table_info、pragma_database_list）
  //
  // 这是个容易漏掉的绕过点：它们是「表值函数」而不是 PRAGMA 语句，
  // 所以第 3 步的关键字黑名单拦不住。实测中模型确实主动用过
  // `SELECT name FROM pragma_table_info('t')` 去探测真实表结构。
  // 虽然这类函数只读元数据、危害有限，但应当一并禁止，避免信息泄露。
  if (/\bpragma_\w+\s*\(/i.test(core)) {
    throw new SqlGuardError('SQL 调用了被禁止的元数据函数：pragma_*');
  }

  // 6) 兜底加 LIMIT：避免全表返回把内存打满、把前端卡死
  //    （用去注释后的结构判断，防止把注释里的 LIMIT 当成已有）
  const warnings = [];
  const hasLimit = /\blimit\b/i.test(core);
  const finalSql = hasLimit ? original : `${original.replace(/;\s*$/, '')} LIMIT ${maxRows}`;
  if (!hasLimit) warnings.push(`已自动追加 LIMIT ${maxRows}`);

  return { sql: finalSql, warnings };
}

export { stripLiterals };
