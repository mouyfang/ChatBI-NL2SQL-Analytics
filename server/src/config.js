import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** server/ 目录 */
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const DB_FILE = path.join(DATA_DIR, 'chatbi.db');

dotenv.config({ path: path.join(ROOT, '.env') });

/** 与项目一（3001）错开，两者可同时运行 */
export const PORT = Number(process.env.PORT) || 3002;

// ---- LLM ----
export const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
export const CHAT_MODEL = process.env.CHAT_MODEL || 'deepseek-chat';

// ---- 数据与查询限制 ----
/** 单表最多导入行数，防止超大文件把内存打满 */
export const MAX_IMPORT_ROWS = Number(process.env.MAX_IMPORT_ROWS) || 100000;
/** 返回给前端的最大结果行数 */
export const MAX_RESULT_ROWS = Number(process.env.MAX_RESULT_ROWS) || 500;
/** 抽样给 LLM 看的行数：太少模型理解不了数据形态，太多浪费上下文 */
export const SAMPLE_ROWS = Number(process.env.SAMPLE_ROWS) || 3;
/** SQL 执行失败后让模型自我修正的最大重试次数 */
export const MAX_SQL_RETRY = Number(process.env.MAX_SQL_RETRY) || 2;
