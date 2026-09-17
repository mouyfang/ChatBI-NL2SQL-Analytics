/**
 * 确定性验证「执行失败 → 回传报错 → 自愈重试」这条链路。
 *
 * 不依赖真实模型（它每次输出都不一样，测试会变成碰运气），
 * 而是注入一个可控的 SQL 生成器：
 *   第 1 次：故意引用不存在的列 → 执行必然失败
 *   第 2 次：生成正确 SQL     → 应成功
 * 若链路正常，最终应成功、attempts === 2，且第 2 次调用时能拿到 SQLite 的原始报错。
 *
 * 运行：npm run test:retry
 */
import { ask } from '../nl2sql.js';
import { getSchemaForPrompt, closeDb } from '../db.js';

const tables = getSchemaForPrompt();
if (tables.length === 0) {
  console.error('❌ 数据库里还没有表，请先上传一份 CSV 再运行本测试');
  process.exit(1);
}

const target = tables[0];
const firstColumn = target.columns[0].name;

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) failed++;
};

// ---------------- 场景 1：一次失败后自愈成功 ----------------

let callCount = 0;
const seenMessages = [];

const fakeGenerate = async (messages) => {
  callCount++;
  seenMessages.push(messages.map((m) => ({ role: m.role, content: m.content })));

  if (callCount === 1) {
    return {
      sql: `SELECT "这个列根本不存在" FROM ${target.tableName}`,
      reasoning: '第一次故意写错列名，用于触发执行失败',
      chart: { type: 'table' },
    };
  }

  return {
    sql: `SELECT "${firstColumn}" FROM ${target.tableName} LIMIT 5`,
    reasoning: '收到报错后修正了列名',
    chart: { type: 'table' },
  };
};

console.log('--- 场景 1：首次执行失败 → 自愈后成功 ---\n');

const outcome = await ask({ question: '测试自愈（占位问题）', schema: [target], generateSql: fakeGenerate });

ok(callCount === 2, `模型被调用了 2 次（首次 + 1 次自愈），实际 ${callCount} 次`);
ok(outcome.attempts === 2, `返回值 attempts = 2（实际 ${outcome.attempts}）`);
ok(outcome.result.rows.length > 0, `自愈后的 SQL 执行成功，返回 ${outcome.result.rows.length} 行`);

// 最关键的一条：第二次调用时，模型必须真的收到了 SQLite 的原始报错
const secondCallUserMsg = seenMessages[1].filter((m) => m.role === 'user').pop();
const gotError = /执行失败/.test(secondCallUserMsg.content) && /no such column/i.test(secondCallUserMsg.content);
ok(gotError, '第二次调用时把 SQLite 的原始报错回传给了模型');
if (gotError) {
  const snippet = /SQLite 报错：([^\n]{0, 70})/.exec(secondCallUserMsg.content);
  console.log(`   回传的报错：${snippet ? snippet[1] : '(已包含)'}`);
}

// ---------------- 场景 2：一直失败时受重试上限约束 ----------------

console.log('\n--- 场景 2：持续失败 → 受重试上限约束 ---\n');

let alwaysFailCalls = 0;
const alwaysFail = async () => {
  alwaysFailCalls++;
  return {
    sql: `SELECT "永远不存在" FROM ${target.tableName}`,
    reasoning: '',
    chart: { type: 'table' },
  };
};

try {
  await ask({ question: '测试上限', schema: [target], generateSql: alwaysFail });
  ok(false, '期望最终抛出错误，但竟然成功了');
} catch (err) {
  ok(/连续 \d+ 次执行失败/.test(err.message), `最终抛出可识别的上限错误：${err.message.slice(0, 70)}…`);
  // MAX_SQL_RETRY = 2 → 首次 + 2 次重试 = 3 次
  ok(alwaysFailCalls === 3, `重试受上限约束：共尝试 ${alwaysFailCalls} 次（首次 + 2 次重试）`);
}

// ---------------- 场景 3：安全拦截不应触发重试 ----------------

console.log('\n--- 场景 3：安全拦截 → 直接终止，不给重试机会 ---\n');

let guardCalls = 0;
const dangerousGenerate = async () => {
  guardCalls++;
  return { sql: 'DROP TABLE ' + target.tableName, reasoning: '', chart: { type: 'table' } };
};

try {
  await ask({ question: '测试安全拦截', schema: [target], generateSql: dangerousGenerate });
  ok(false, '危险 SQL 竟然没有被拦截');
} catch (err) {
  ok(/安全校验/.test(err.message), `危险 SQL 被拦截：${err.message.slice(0, 70)}…`);
  ok(guardCalls === 1, `只调用 1 次、没有重试（安全问题失败即终止），实际 ${guardCalls} 次`);
}

closeDb();
console.log(failed === 0 ? '\n自愈与安全链路验证通过 ✅' : `\n${failed} 项失败 ❌`);
process.exitCode = failed === 0 ? 0 : 1;
