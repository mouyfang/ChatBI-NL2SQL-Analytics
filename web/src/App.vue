<script setup>
import { ref, onMounted } from 'vue';
import DatasetPanel from './components/DatasetPanel.vue';
import ChatPanel from './components/ChatPanel.vue';
import { fetchHealth } from './api.js';

const stats = ref({ datasetCount: 0, totalRows: 0 });
const llmConfigured = ref(true);
const backendError = ref('');

async function refreshStats() {
  try {
    const data = await fetchHealth();
    stats.value = data;
    llmConfigured.value = data.llmConfigured;
    backendError.value = '';
  } catch (err) {
    backendError.value = `无法连接后端服务：${err.message}`;
  }
}

onMounted(refreshStats);
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="logo">BI</span>
        <div>
          <h1>ChatBI · 自然语言数据分析</h1>
          <p class="sub">上传表格 → 用中文提问 → 自动生成 SQL 并可视化</p>
        </div>
      </div>

      <div class="stats">
        <span class="pill">数据集 <b>{{ stats.datasetCount ?? 0 }}</b></span>
        <span class="pill">数据行 <b>{{ stats.totalRows ?? 0 }}</b></span>
        <span class="pill" :class="llmConfigured ? 'ok' : 'bad'">
          LLM {{ llmConfigured ? '已就绪' : '未配置' }}
        </span>
      </div>
    </header>

    <div v-if="backendError" class="banner-error">{{ backendError }}</div>

    <main class="layout">
      <DatasetPanel :stats="stats" @changed="refreshStats" />
      <ChatPanel :has-data="(stats.datasetCount ?? 0) > 0" />
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 20px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.5px;
}

h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
}

.sub {
  margin: 1px 0 0;
  font-size: 12px;
  color: var(--text-dim);
}

.stats {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.pill {
  font-size: 12px;
  color: var(--text-dim);
  background: #f1f5f9;
  border-radius: 999px;
  padding: 4px 12px;
  white-space: nowrap;
}

.pill b {
  color: var(--text);
}

.pill.ok {
  background: #eafaf0;
  color: var(--ok);
}

.pill.bad {
  background: #fdecec;
  color: var(--danger);
}

.banner-error {
  background: #fdecec;
  color: var(--danger);
  padding: 9px 20px;
  font-size: 13px;
  border-bottom: 1px solid #f7c9c9;
}

.layout {
  flex: 1;
  display: grid;
  grid-template-columns: 310px 1fr;
  gap: 16px;
  padding: 16px;
  min-height: 0;
}

@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
</style>
