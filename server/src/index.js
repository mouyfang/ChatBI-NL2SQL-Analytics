import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';

import { PORT, DEEPSEEK_API_KEY, MAX_IMPORT_ROWS } from './config.js';
import { csvToTable } from './csv.js';
import { xlsxToTable } from './xlsx.js';
import {
  importDataset,
  listDatasets,
  dropDataset,
  clearAll,
  getSchemaForPrompt,
  getStats,
} from './db.js';
import { ask, streamInsight } from './nl2sql.js';

// node:sqlite 目前标记为实验特性，启动时会打一条警告，这里只过滤掉它
const originalWarning = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  for (const listener of originalWarning) listener(warning);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const SUPPORTED_EXT = ['.csv', '.txt', '.xlsx'];

// multer 默认按 latin1 解析 filename，中文名会乱码
const decodeName = (name) => Buffer.from(name, 'latin1').toString('utf8');

const upload = multer({
  // 走内存存储：解析完直接入库，不产生需要清理的临时文件
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(decodeName(file.originalname)).toLowerCase();
    if (!SUPPORTED_EXT.includes(ext)) {
      cb(new Error(`不支持的格式 ${ext}，当前支持：${SUPPORTED_EXT.join(' / ')}`));
      return;
    }
    cb(null, true);
  },
});

/** 解析文件 → 建表导入 */
async function ingestFile(file) {
  const name = decodeName(file.originalname);
  const ext = path.extname(name).toLowerCase();

  const table =
    ext === '.xlsx'
      ? await xlsxToTable(file.buffer, MAX_IMPORT_ROWS)
      : csvToTable(file.buffer.toString('utf8'), MAX_IMPORT_ROWS);

  if (!table.rows || table.rows.length === 0) {
    throw new Error(`《${name}》中没有解析到数据行`);
  }

  const dataset = importDataset({
    fileName: name,
    columns: table.columns,
    rows: table.rows,
  });

  return {
    ...dataset,
    truncated: table.truncated,
    sheetName: table.sheetName ?? null,
  };
}

// ---------------- 路由 ----------------

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    llmConfigured: Boolean(DEEPSEEK_API_KEY),
    supportedExt: SUPPORTED_EXT,
    ...getStats(),
  });
});

app.get('/api/datasets', (_req, res) => {
  res.json({ datasets: listDatasets(), ...getStats() });
});

app.post('/api/upload', upload.array('files', 10), async (req, res) => {
  const files = req.files ?? [];
  if (files.length === 0) {
    res.status(400).json({ error: '没有收到文件' });
    return;
  }

  const succeeded = [];
  const failed = [];

  for (const file of files) {
    try {
      succeeded.push(await ingestFile(file));
    } catch (err) {
      failed.push({ name: decodeName(file.originalname), error: err.message });
    }
  }

  res.json({ succeeded, failed, ...getStats() });
});

app.delete('/api/datasets/:id', (req, res) => {
  res.json({ ...dropDataset(req.params.id), ...getStats() });
});

app.delete('/api/datasets', (_req, res) => {
  res.json({ ...clearAll(), ...getStats() });
});

/**
 * 提问接口，SSE 流式返回全过程。
 * 事件顺序：stage → sql → result → chart → insight(多次) → done
 * 无法回答时：stage → unanswerable → done
 */
app.post('/api/ask', async (req, res) => {
  const { question, history = [] } = req.body ?? {};

  if (!question || !String(question).trim()) {
    res.status(400).json({ error: '缺少 question' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 只置标志位不够：必须 abort 上游 fetch，否则用户点了停止、模型仍在生成，token 照扣
  const upstream = new AbortController();
  let aborted = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      upstream.abort();
    }
  });

  const text = String(question);

  try {
    const schema = getSchemaForPrompt();

    send('stage', { stage: 'generating_sql', message: '正在理解问题并生成 SQL…' });

    const outcome = await ask({ question: text, schema, history });

    if (!outcome.answerable) {
      send('unanswerable', { reasoning: outcome.reasoning });
      send('done', { ok: true });
      return;
    }

    send('sql', {
      sql: outcome.sql,
      reasoning: outcome.reasoning,
      attempts: outcome.attempts,
      warnings: outcome.warnings,
    });
    send('result', outcome.result);
    send('chart', outcome.chart);

    send('stage', { stage: 'insight', message: '正在解读结果…' });

    for await (const delta of streamInsight({
      question: text,
      sql: outcome.sql,
      result: outcome.result,
      signal: upstream.signal,
    })) {
      if (aborted) break;
      send('insight', delta);
    }

    send('done', { ok: true });
  } catch (err) {
    if (err.name !== 'AbortError') send('error', { message: err.message });
  } finally {
    res.end();
  }
});

app.use((err, _req, res, _next) => {
  const message = err?.message ?? '服务器内部错误';
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(err?.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
});

app.listen(PORT, () => {
  const stats = getStats();
  console.log(`\n  ChatBI 服务已启动：http://localhost:${PORT}`);
  console.log(`  已导入数据集 ${stats.datasetCount} 个 / 数据行 ${stats.totalRows} 行`);
  console.log(`  LLM 配置：${DEEPSEEK_API_KEY ? '已配置' : '❌ 缺少 DEEPSEEK_API_KEY（请检查 server/.env）'}\n`);
});
