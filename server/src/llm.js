import { DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, CHAT_MODEL } from './config.js';

function assertKey() {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('缺少 DEEPSEEK_API_KEY，请在 server/.env 中配置');
  }
}

async function requestChat(messages, { temperature = 0.2, stream = false, signal, jsonMode = false } = {}) {
  assertKey();

  const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages,
      temperature,
      stream,
      // 开启 JSON 模式能让模型稳定输出合法 JSON，省掉大量容错代码
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`DeepSeek API 调用失败 (${res.status})：${detail.slice(0, 300)}`);
  }

  return res;
}

export async function chatOnce(messages, options = {}) {
  const res = await requestChat(messages, { ...options, stream: false });
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * 容错解析模型返回的 JSON。
 * 即便开了 JSON 模式，模型偶尔仍会套一层 ```json 代码块，或者前后带说明文字，
 * 所以这里做两级兜底：先去代码块，再截取首尾大括号。
 */
export function parseJsonLoose(text) {
  const trimmed = String(text ?? '').trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('模型返回的内容不是合法 JSON');
  }
}

export async function chatJson(messages, options = {}) {
  const text = await chatOnce(messages, { ...options, jsonMode: true });
  return parseJsonLoose(text);
}

/** 流式返回文本增量（用于生成自然语言解读） */
export async function* chatStream(messages, options = {}) {
  const res = await requestChat(messages, { ...options, stream: true });
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');

  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 留住最后一段不完整的数据，避免网络分片把一行劈开导致丢字
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;

        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // 不完整的 JSON 行跳过，等下一轮补齐
        }
      }
    }
  } finally {
    // 调用方提前退出（用户点停止）时，必须取消读取，否则上游会继续生成、token 照扣
    await reader.cancel().catch(() => {});
  }
}
