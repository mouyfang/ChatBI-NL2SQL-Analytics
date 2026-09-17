/**
 * CSV 解析器测试（覆盖引号、转义、换行等边界）：npm run test:csv
 */
import { parseCsv, csvToTable } from '../csv.js';

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) failed++;
};

// --- 解析器 ---
const basic = parseCsv('a,b,c\n1,2,3');
ok(basic.length === 2 && basic[1][2] === '3', '基本解析');

const quoted = parseCsv('name,addr\n甲,"重庆,渝北区"');
ok(quoted[1][1] === '重庆,渝北区', '引号内的逗号不当分隔符');

const multiline = parseCsv('a,b\n"第一行\n第二行",x');
ok(multiline[1][0] === '第一行\n第二行', '引号内的换行不当行分隔');

const escaped = parseCsv('a\n"他说""你好"""');
ok(escaped[1][0] === '他说"你好"', '双引号转义（"" → "）');

ok(parseCsv('a,b\r\n1,2\r\n').length === 2, 'CRLF 换行');

ok(parseCsv('\uFEFFa,b\n1,2')[0][0] === 'a', '去掉 BOM');

const noEol = parseCsv('a,b\n1,2');
ok(noEol.length === 2 && noEol[1][1] === '2', '文件末尾无换行也能解析');

ok(parseCsv('a,b\n1,2\n').length === 2, '末尾换行不产生多余空行');

// 空行过滤发生在 rowsToTable 阶段（parseCsv 只负责切分，不做业务过滤）
ok(csvToTable('a,b\n1,2\n,\n3,4').rows.length === 2, '跳过全空行');

// --- 类型推断 ---
const codes = csvToTable('code,amount\n007,100');
ok(codes.columns[0].type === 'TEXT', '前导 0 的编码推断为 TEXT（否则 007 会变成 7）');
ok(codes.columns[1].type === 'INTEGER', '纯整数列推断为 INTEGER');

const big = csvToTable('id\n9007199254740993');
ok(big.columns[0].type === 'TEXT', '超出安全整数范围推断为 TEXT（避免精度丢失）');

const decimals = csvToTable('price\n12.5\n8.25');
ok(decimals.columns[0].type === 'REAL', '小数推断为 REAL');

const mixed = csvToTable('v\n1\nabc');
ok(mixed.columns[0].type === 'TEXT', '混合内容推断为 TEXT');

// --- 列名规整 ---
const dup = csvToTable('a,a,\n1,2,3');
ok(dup.columns[1].name === 'a_2', '重名列自动改名');
ok(dup.columns[2].name === '列3', '空列名自动补全');

const dirty = csvToTable('"na;me",b\n1,2');
ok(!dirty.columns[0].name.includes(';'), '列名中的分号被清理（避免干扰 SQL）');

// --- 值转换 ---
const values = csvToTable('n,s\n1,hello\n2,');
ok(values.rows[0][0] === 1, '整数转为 number');
ok(values.rows[1][1] === null, '空单元格转为 null');

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
