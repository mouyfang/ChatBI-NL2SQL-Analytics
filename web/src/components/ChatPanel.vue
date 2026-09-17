<script setup>
import { ref, computed, nextTick } from 'vue';
import ChatMessage from './ChatMessage.vue';
import { askStream } from '../api.js';

const props = defineProps({ hasData: { type: Boolean, default: false } });

const messages = ref([]);
const input = ref('');
const busy = ref(false);
const errorMsg = ref('');
const listEl = ref(null);
let controller = null;

const canSend = computed(() => input.value.trim().length > 0 && !busy.value);

const EXAMPLES = [
  '各地区的销售额合计是多少？',
  '销售额最高的前 3 个产品类别',
  '每个月的销售额趋势如何？',
  '哪个销售员的业绩最好？',
];

async function scrollToBottom() {
  await nextTick();
  const el = listEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

async function send() {
  const question = input.value.trim();
  if (!question || busy.value) return;

  errorMsg.value = '';
  input.value = '';
  busy.value = true;

  const history = messages.value
    .filter((m) => !m.streaming)
    .map((m) => ({ role: m.role, content: m.content ?? '' }));

  messages.value.push({ role: 'user', content: question });
  messages.value.push({
    role: 'assistant',
    streaming: true,
    stage: 'generating_sql',
    stageMessage: '正在理解问题并生成 SQL…',
    sql: '',
    reasoning: '',
    chart: null,
    result: null,
    insight: '',
    unanswerable: '',
    attempts: 1,
    warnings: [],
  });
  const idx = messages.value.length - 1;

  await scrollToBottom();
  controller = new AbortController();

  try {
    await askStream({ question, history, signal: controller.signal }, (event, data) => {
      const msg = messages.value[idx];
      if (!msg) return;

      switch (event) {
        case 'stage':
          msg.stage = data.stage;
          msg.stageMessage = data.message;
          break;
        case 'sql':
          msg.sql = data.sql;
          msg.reasoning = data.reasoning;
          msg.attempts = data.attempts ?? 1;
          msg.warnings = data.warnings ?? [];
          break;
        case 'result':
          msg.result = data;
          break;
        case 'chart':
          msg.chart = data;
          break;
        case 'unanswerable':
          msg.unanswerable = data.reasoning;
          break;
        case 'insight':
          msg.insight += data;
          scrollToBottom();
          break;
        case 'error':
          errorMsg.value = data?.message ?? '生成失败';
          break;
        case 'done':
          msg.streaming = false;
          break;
      }
    });
  } catch (err) {
    if (err.name !== 'AbortError') errorMsg.value = err.message;
  } finally {
    const msg = messages.value[idx];
    if (msg) msg.streaming = false;
    busy.value = false;
    controller = null;
    scrollToBottom();
  }
}

function stop() {
  controller?.abort();
  busy.value = false;
}

function clearChat() {
  messages.value = [];
  errorMsg.value = '';
}

function useExample(text) {
  input.value = text;
}
</script>

<template>
  <section class="chat">
    <div class="chat-head">
      <h2>分析对话</h2>
      <button v-if="messages.length" class="link" @click="clearChat">清空</button>
    </div>

    <div ref="listEl" class="messages">
      <div v-if="!messages.length" class="welcome">
        <p class="w-title">用中文提问，自动查数据</p>
        <p class="w-sub">
          {{ props.hasData ? '系统会把问题翻译成 SQL、查询数据，并自动选择合适的图表。' : '请先在左侧上传表格文件。' }}
        </p>
        <div class="examples">
          <button v-for="ex in EXAMPLES" :key="ex" class="example" @click="useExample(ex)">
            {{ ex }}
          </button>
        </div>
      </div>

      <ChatMessage v-for="(msg, i) in messages" :key="i" :msg="msg" />

      <p v-if="errorMsg" class="banner-error">{{ errorMsg }}</p>
    </div>

    <div class="composer">
      <textarea
        v-model="input"
        rows="1"
        placeholder="例如：华东地区哪类产品卖得最好？"
        :disabled="busy"
        @keydown.enter.exact.prevent="send"
      />
      <button v-if="busy" class="btn stop" @click="stop">停止</button>
      <button v-else class="btn send" :disabled="!canSend" @click="send">提问</button>
    </div>
  </section>
</template>

<style scoped>
.chat {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}

.link {
  background: none;
  font-size: 12px;
  color: var(--text-dim);
  padding: 2px 4px;
}
.link:hover {
  color: var(--accent);
  text-decoration: underline;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  min-height: 0;
}

.welcome {
  text-align: center;
  padding: 36px 16px;
}

.w-title {
  font-size: 15px;
  font-weight: 700;
  margin: 0 0 6px;
}

.w-sub {
  font-size: 13px;
  color: var(--text-dim);
  margin: 0 0 18px;
}

.examples {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 360px;
  margin: 0 auto;
}

.example {
  background: #f8fafc;
  border: 1px solid var(--border);
  color: var(--text);
  padding: 9px 14px;
  font-size: 12.5px;
  text-align: left;
}
.example:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.banner-error {
  background: #fdecec;
  color: var(--danger);
  padding: 9px 12px;
  border-radius: 8px;
  font-size: 12.5px;
  margin: 0;
}

.composer {
  display: flex;
  gap: 10px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  align-items: flex-end;
}

textarea {
  flex: 1;
  resize: none;
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 10px 12px;
  outline: none;
  max-height: 120px;
  min-height: 42px;
  line-height: 1.5;
  transition: border-color 0.15s;
}
textarea:focus {
  border-color: var(--accent);
}

.btn {
  padding: 10px 20px;
  font-weight: 600;
  color: #fff;
  background: var(--accent);
  flex-shrink: 0;
  height: 42px;
}
.btn:hover:not(:disabled) {
  background: var(--accent-dark);
}
.btn.stop {
  background: var(--danger);
}
.btn.stop:hover {
  background: #b91c1c;
}
</style>
