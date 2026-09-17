const BASE = '/api';

async function asJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `请求失败 (${res.status})`);
  return data;
}

export const fetchHealth = () => fetch(`${BASE}/health`).then(asJson);
export const fetchDatasets = () => fetch(`${BASE}/datasets`).then(asJson);
export const clearAll = () => fetch(`${BASE}/datasets`, { method: 'DELETE' }).then(asJson);
export const deleteDataset = (id) => fetch(`${BASE}/datasets/${id}`, { method: 'DELETE' }).then(asJson);

export async function uploadFiles(files) {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  return fetch(`${BASE}/upload`, { method: 'POST', body: form }).then(asJson);
}

/**
 * 提问，SSE 流式接收全过程。
 *
 * 事件序列：stage → sql → result → chart → insight(多次) → done
 * 无法回答时：stage → unanswerable → done
 * 出错时：error
 *
 * @param {{question:string, history:Array, signal?:AbortSignal}} payload
 * @param {(event:string, data:any)=>void} onEvent
 */
export async function askStream({ question, history, signal }, onEvent) {
  const res = await fetch(`${BASE}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history }),
    signal,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `请求失败 (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE 事件之间用空行分隔；最后一块可能不完整，留到下一轮再拼
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      let event = 'message';
      let data = '';

      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }

      if (!data) continue;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = data;
      }
      onEvent(event, parsed);
    }
  }
}
