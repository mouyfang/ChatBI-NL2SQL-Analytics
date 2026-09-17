import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, DATA_DIR, MAX_RESULT_ROWS, SAMPLE_ROWS } from './config.js';

/**
 * SQLite 管理（使用 Node 内置的 node:sqlite，零第三方依赖）。
 *
 * 双层防护设计：
 *   1. sqlGuard.js 在执行前做 SQL 白名单校验；
 *   2. 这里用**只读连接**执行用户查询——即使校验被绕过，SQLite 也会拒绝写操作。
 * 只读连接实测：写入报 "attempt to write a readonly database"，删表同样被拒。
 */

let writeDb = null;
let readDb = null;

/** SQL 标识符转义：列名/表名里可能有引号 */
const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

function initWriteDb() {
  if (writeDb) return writeDb;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeDb = new DatabaseSync(DB_FILE);
  writeDb.exec(`
    CREATE TABLE IF NOT EXISTS _datasets (
      id            TEXT PRIMARY KEY,
      table_name    TEXT UNIQUE NOT NULL,
      file_name     TEXT NOT NULL,
      row_count     INTEGER NOT NULL,
      columns_json  TEXT NOT NULL,
      created_at    TEXT NOT NULL
    )
  `);
  return writeDb;
}

/**
 * 查询用的只读连接。
 * 导入/删除数据后会失效重建，确保查询总能读到最新结构。
 */
function getReadDb() {
  if (!readDb) {
    initWriteDb();
    readDb = new DatabaseSync(DB_FILE, { readOnly: true });
  }
  return readDb;
}

function invalidateReadDb() {
  if (readDb) {
    try {
      readDb.close();
    } catch {
      /* 忽略关闭异常 */
    }
    readDb = null;
  }
}

function makeTableName() {
  return `ds_${crypto.randomBytes(5).toString('hex')}`;
}

/** BigInt 不能直接 JSON 序列化，统一转成字符串避免丢精度 */
function normalizeValue(value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function normalizeRow(row) {
  const out = {};
  for (const key of Object.keys(row)) out[key] = normalizeValue(row[key]);
  return out;
}

// ---------------- 数据集 ----------------

export function listDatasets() {
  const db = initWriteDb();
  return db
    .prepare('SELECT * FROM _datasets ORDER BY created_at ASC')
    .all()
    .map((row) => ({
      id: row.id,
      tableName: row.table_name,
      fileName: row.file_name,
      rowCount: row.row_count,
      columns: JSON.parse(row.columns_json),
      createdAt: row.created_at,
    }));
}

/**
 * 导入一张表。
 * @param {{fileName:string, columns:{name:string,type:string}[], rows:any[][]}} input
 */
export function importDataset({ fileName, columns, rows }) {
  const db = initWriteDb();
  const id = crypto.randomUUID();
  const tableName = makeTableName();

  const columnDefs = columns.map((c) => `${quoteIdent(c.name)} ${c.type}`).join(', ');
  db.exec(`CREATE TABLE ${quoteIdent(tableName)} (${columnDefs})`);

  const placeholders = columns.map(() => '?').join(', ');
  const insert = db.prepare(`INSERT INTO ${quoteIdent(tableName)} VALUES (${placeholders})`);

  // 逐行插入必须包在事务里，否则每行一次 fsync，10 万行会慢到无法接受
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      insert.run(...row.map((v) => (v === undefined ? null : v)));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  db.prepare(
    `INSERT INTO _datasets (id, table_name, file_name, row_count, columns_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, tableName, fileName, rows.length, JSON.stringify(columns), new Date().toISOString());

  invalidateReadDb();

  return { id, tableName, fileName, rowCount: rows.length, columns };
}

export function dropDataset(id) {
  const db = initWriteDb();
  const target = db.prepare('SELECT * FROM _datasets WHERE id = ?').get(id);
  if (!target) return { removed: false };

  db.exec(`DROP TABLE IF EXISTS ${quoteIdent(target.table_name)}`);
  db.prepare('DELETE FROM _datasets WHERE id = ?').run(id);

  invalidateReadDb();
  return { removed: true, fileName: target.file_name };
}

export function clearAll() {
  const db = initWriteDb();
  const datasets = listDatasets();
  for (const ds of datasets) {
    db.exec(`DROP TABLE IF EXISTS ${quoteIdent(ds.tableName)}`);
  }
  db.prepare('DELETE FROM _datasets').run();
  invalidateReadDb();
  return { removed: datasets.length };
}

// ---------------- 供 LLM 使用的 schema ----------------

/**
 * 生成给模型看的 schema 描述。
 *
 * 只给列名 + 类型还不够——模型看不出「1/2 代表什么状态」这类语义，
 * 所以每个表附带几行真实样本，让它理解数据形态。
 */
export function getSchemaForPrompt() {
  const datasets = listDatasets();

  return datasets.map((ds) => {
    let sample = [];
    try {
      sample = getReadDb()
        .prepare(`SELECT * FROM ${quoteIdent(ds.tableName)} LIMIT ${SAMPLE_ROWS}`)
        .all()
        .map(normalizeRow);
    } catch {
      sample = [];
    }

    return {
      fileName: ds.fileName,
      tableName: ds.tableName,
      rowCount: ds.rowCount,
      columns: ds.columns,
      sample,
    };
  });
}

// ---------------- 查询 ----------------

/**
 * 执行查询（只读连接）。
 * @param {string} sql 已经过 sqlGuard 校验
 * @returns {{columns: string[], rows: object[], truncated: boolean}}
 */
export function runQuery(sql) {
  const db = getReadDb();
  const statement = db.prepare(sql);

  // columns() 即使结果为空也能拿到列名（用 Object.keys(rows[0]) 就会丢失）
  let columnNames = [];
  try {
    columnNames = statement.columns().map((c) => c.name);
  } catch {
    columnNames = [];
  }

  const rows = statement.all().map(normalizeRow);

  if (columnNames.length === 0 && rows.length > 0) {
    columnNames = Object.keys(rows[0]);
  }

  return {
    columns: columnNames,
    rows,
    truncated: rows.length >= MAX_RESULT_ROWS,
  };
}

export function getStats() {
  const datasets = listDatasets();
  return {
    datasetCount: datasets.length,
    totalRows: datasets.reduce((sum, d) => sum + d.rowCount, 0),
  };
}

export function closeDb() {
  invalidateReadDb();
  if (writeDb) {
    try {
      writeDb.close();
    } catch {
      /* 忽略 */
    }
    writeDb = null;
  }
}
