/**
 * CSV 解析（零依赖，状态机实现）。
 *
 * 为什么不用 `line.split(',')`：CSV 标准允许字段被双引号包裹，引号内可以出现
 * 逗号、换行符，以及用 `""` 转义的双引号。简单 split 会把这类字段切碎——
 * 比如地址 "重庆市,渝北区" 会被拆成两列，整行错位。
 */

/**
 * 把 CSV 文本解析成二维数组。
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去掉 Excel 常带的 BOM

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // "" 表示一个字面双引号
          i += 2;
          continue;
        }
        inQuotes = false; // 引号段结束
        i++;
        continue;
      }
      field += ch; // 引号内的逗号、换行都算普通字符
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++; // CRLF 算一个换行
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  // 文件末尾没有换行时，最后一行也要收进来
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** 列名规整：去空白、补空列名、重名去重（SQL 不允许重复列名） */
function normalizeHeader(rawHeader) {
  const seen = new Map();
  return rawHeader.map((raw, idx) => {
    let name = String(raw ?? '').trim() || `列${idx + 1}`;
    name = name.replace(/["'`;]/g, ''); // 去掉会干扰 SQL 标识符的字符
    if (seen.has(name)) {
      const next = seen.get(name) + 1;
      seen.set(name, next);
      name = `${name}_${next}`;
    } else {
      seen.set(name, 1);
    }
    return name;
  });
}

/**
 * 推断列类型：INTEGER / REAL / TEXT
 *
 * 有些「看起来是数字」的值必须保留为 TEXT，否则会丢失信息：
 *   1) 前导 0 的编码，如 "007" —— 转成数字会变成 7
 *   2) 超出安全整数范围的大数，如订单号、身份证号 —— 会精度丢失
 */
export function inferType(values) {
  const strs = values
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
    .map((v) => String(v).trim());

  if (strs.length === 0) return 'TEXT';

  const isIntegerLike = (s) => /^-?\d+$/.test(s);
  const isNumberLike = (s) => /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) && Number.isFinite(Number(s));

  /** 整数形态但必须当文本存的情况 */
  const mustStayText = (s) => isIntegerLike(s) && (/^-?0\d+/.test(s) || !Number.isSafeInteger(Number(s)));

  if (strs.every(isIntegerLike) && !strs.some(mustStayText)) return 'INTEGER';
  if (strs.every(isNumberLike) && !strs.some(mustStayText)) return 'REAL';
  return 'TEXT';
}

function convertValue(raw, type) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (type === 'INTEGER' || type === 'REAL') {
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  return s;
}

/**
 * 把二维数组转成结构化表格。
 * @param {string[][]} rows
 * @param {number} maxRows
 * @returns {{columns: {name:string,type:string}[], rows: any[][], truncated: boolean}}
 */
export function rowsToTable(rows, maxRows = Infinity) {
  const clean = rows.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (clean.length === 0) throw new Error('文件里没有可解析的数据');

  const header = normalizeHeader(clean[0]);
  let body = clean.slice(1);

  let truncated = false;
  if (body.length > maxRows) {
    body = body.slice(0, maxRows);
    truncated = true;
  }

  // 按列收集原始值，用于类型推断
  const columns = header.map((name, colIdx) => ({
    name,
    type: inferType(body.map((r) => r[colIdx])),
  }));

  const typedRows = body.map((r) => columns.map((col, colIdx) => convertValue(r[colIdx], col.type)));

  return { columns, rows: typedRows, truncated };
}

export function csvToTable(text, maxRows) {
  return rowsToTable(parseCsv(text), maxRows);
}
