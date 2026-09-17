/**
 * SQL 安全校验测试（安全关键路径）：npm run test:guard
 *
 * 这是项目里最需要覆盖测试的模块——它决定了大模型生成的 SQL
 * 能不能把用户的数据库删掉。
 */
import { validateSql, SqlGuardError } from '../sqlGuard.js';

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) failed++;
};

const shouldPass = [
  ['SELECT * FROM t', '普通查询'],
  ['SELECT "地区", SUM("销售额") FROM t GROUP BY "地区"', '带中文列名的聚合'],
  ['WITH x AS (SELECT 1 AS n) SELECT * FROM x', 'CTE 查询'],
  ["SELECT * FROM t WHERE name = 'DROP TABLE'", '字符串里含 DROP 不应误报'],
  ['SELECT * FROM t -- DROP TABLE t', '注释里含 DROP 不应误报'],
  ['SELECT * FROM t LIMIT 10', '已有 LIMIT'],
];

const shouldFail = [
  ['DROP TABLE t', 'DROP'],
  ['DELETE FROM t', 'DELETE'],
  ['UPDATE t SET a = 1', 'UPDATE'],
  ['INSERT INTO t VALUES (1)', 'INSERT'],
  ['SELECT 1; DROP TABLE t', '多语句注入'],
  ['PRAGMA table_info(t)', 'PRAGMA'],
  ["ATTACH DATABASE 'x.db' AS y", 'ATTACH'],
  ['WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'WITH + INSERT'],
  ["SELECT load_extension('evil')", '危险函数 load_extension'],
  ["SELECT name FROM pragma_table_info('t')", 'pragma_* 表值函数（绕过关键字黑名单的缺口）'],
  ['CREATE TABLE t2 (a INT)', 'CREATE'],
  ['', '空 SQL'],
];

console.log('--- 应当通过 ---');
for (const [sql, label] of shouldPass) {
  let passed = false;
  let detail = '';
  try {
    validateSql(sql);
    passed = true;
  } catch (err) {
    detail = err.message;
  }
  ok(passed, `${label}${detail ? ` —— 被误拦：${detail}` : ''}`);
}

console.log('\n--- 应当拦截 ---');
for (const [sql, label] of shouldFail) {
  let blocked = false;
  let detail = '';
  try {
    validateSql(sql);
  } catch (err) {
    blocked = err instanceof SqlGuardError;
    detail = err.message;
  }
  ok(blocked, `${label}${blocked ? ` —— ${detail}` : ' —— 未拦截！'}`);
}

console.log('\n--- 自动补 LIMIT ---');
const { sql, warnings } = validateSql('SELECT * FROM t');
ok(/LIMIT \d+$/.test(sql), `未带 LIMIT 时自动补上：${sql}`);
ok(warnings.length > 0, '并给出提示');

const withLimit = validateSql('SELECT * FROM t LIMIT 5');
ok(withLimit.warnings.length === 0, '已有 LIMIT 时不重复追加');

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
