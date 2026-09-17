import ExcelJS from 'exceljs';
import { rowsToTable } from './csv.js';

/**
 * Excel 解析（.xlsx）。
 *
 * 坑点：exceljs 把单元格值返回成各种形态——富文本、公式结果、超链接、Date 对象。
 * 直接 String() 会得到 "[object Object]"，所以必须逐类拆解。
 */

/**
 * Excel 的日期没有时区概念，exceljs 会按 UTC 解释。
 * 这里一律用 UTC 取值，否则东八区会读出「2026-01-14 16:00」这种偏移一天的结果。
 */
function formatExcelDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = date.getUTCHours();
  const mm = date.getUTCMinutes();
  const ss = date.getUTCSeconds();

  if (hh === 0 && mm === 0 && ss === 0) return `${y}-${m}-${d}`;
  return `${y}-${m}-${d} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatExcelDate(value);

  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((t) => t.text ?? '').join('');
    if (value.text !== undefined) return String(value.text); // 超链接
    if (value.result !== undefined) return String(value.result); // 公式结果
    if (value.error !== undefined) return '';
    return String(value);
  }

  return String(value);
}

/**
 * 把 Excel 的第一个非空工作表解析为表格。
 * @param {Buffer} buffer 文件内容（走内存存储，省去临时文件的清理）
 * @param {number} maxRows
 * @returns {Promise<{columns:any[], rows:any[][], truncated:boolean, sheetName:string}>}
 */
export async function xlsxToTable(buffer, maxRows = Infinity) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheet = workbook.worksheets.find((ws) => ws.rowCount > 0 && ws.actualColumnCount > 0);
  if (!sheet) throw new Error('Excel 文件里没有找到有数据的工作表');

  const raw = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = [];
    // 用 1..columnCount 遍历，保证空单元格不会让整行左移错位
    for (let col = 1; col <= sheet.actualColumnCount; col++) {
      values.push(cellText(row.getCell(col).value));
    }
    raw.push(values);
  });

  const table = rowsToTable(raw, maxRows);
  return { ...table, sheetName: sheet.name };
}
