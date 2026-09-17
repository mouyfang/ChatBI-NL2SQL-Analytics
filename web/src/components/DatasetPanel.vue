<script setup>
import { ref, onMounted } from 'vue';
import { fetchDatasets, uploadFiles, deleteDataset, clearAll } from '../api.js';

defineProps({ stats: { type: Object, default: () => ({}) } });
const emit = defineEmits(['changed']);

const datasets = ref([]);
const uploading = ref(false);
const dragging = ref(false);
const message = ref(null);
const fileInput = ref(null);

async function loadDatasets() {
  try {
    const data = await fetchDatasets();
    datasets.value = data.datasets ?? [];
  } catch (err) {
    message.value = { type: 'error', text: err.message };
  }
}

async function handleFiles(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;

  uploading.value = true;
  message.value = null;

  try {
    const res = await uploadFiles(files);
    const lines = [];
    if (res.succeeded?.length) {
      lines.push(...res.succeeded.map((d) => `《${d.fileName}》导入 ${d.rowCount} 行${d.truncated ? '（超出上限已截断）' : ''}`));
    }
    if (res.failed?.length) {
      lines.push(...res.failed.map((f) => `${f.name} 失败：${f.error}`));
    }
    message.value = { type: res.failed?.length ? 'warn' : 'ok', text: lines.join('；') };
    await loadDatasets();
    emit('changed');
  } catch (err) {
    message.value = { type: 'error', text: err.message };
  } finally {
    uploading.value = false;
  }
}

function onDrop(e) {
  dragging.value = false;
  handleFiles(e.dataTransfer.files);
}

function onPick(e) {
  handleFiles(e.target.files);
  e.target.value = '';
}

async function onDelete(ds) {
  try {
    await deleteDataset(ds.id);
    message.value = { type: 'ok', text: `已删除《${ds.fileName}》` };
    await loadDatasets();
    emit('changed');
  } catch (err) {
    message.value = { type: 'error', text: err.message };
  }
}

async function onClear() {
  if (!confirm('确定清空所有数据集？')) return;
  try {
    await clearAll();
    message.value = { type: 'ok', text: '已清空全部数据集' };
    await loadDatasets();
    emit('changed');
  } catch (err) {
    message.value = { type: 'error', text: err.message };
  }
}

onMounted(loadDatasets);
</script>

<template>
  <aside class="panel">
    <div class="panel-head">
      <h2>数据集</h2>
      <button v-if="datasets.length" class="link danger" @click="onClear">清空</button>
    </div>

    <div
      class="dropzone"
      :class="{ dragging, busy: uploading }"
      @click="fileInput?.click()"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <input ref="fileInput" type="file" multiple hidden accept=".csv,.txt,.xlsx" @change="onPick" />
      <template v-if="uploading">
        <div class="spinner" />
        <p>解析并导入中…</p>
      </template>
      <template v-else>
        <p class="drop-title">点击或拖拽表格文件</p>
        <span class="hint">支持 CSV / TXT / XLSX，单个 ≤ 20MB</span>
      </template>
    </div>

    <p v-if="message" class="msg" :class="message.type">{{ message.text }}</p>

    <div class="list">
      <div v-if="!datasets.length" class="empty">还没有数据，先上传一份表格试试</div>

      <div v-for="ds in datasets" :key="ds.id" class="item">
        <div class="item-main">
          <span class="item-name" :title="ds.fileName">{{ ds.fileName }}</span>
          <span class="item-meta">{{ ds.rowCount }} 行 · {{ ds.columns.length }} 列</span>
          <div class="cols">
            <span v-for="col in ds.columns.slice(0, 6)" :key="col.name" class="col-tag" :title="col.name + ' · ' + col.type">
              {{ col.name }}
            </span>
            <span v-if="ds.columns.length > 6" class="col-tag more">+{{ ds.columns.length - 6 }}</span>
          </div>
        </div>
        <button class="icon-btn" title="删除" @click="onDelete(ds)">✕</button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 14px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}

.link {
  background: none;
  font-size: 12px;
  padding: 2px 4px;
}
.link.danger {
  color: var(--danger);
}
.link.danger:hover {
  text-decoration: underline;
}

.dropzone {
  border: 1.5px dashed #c7d2e0;
  border-radius: 10px;
  padding: 18px 12px;
  text-align: center;
  cursor: pointer;
  background: #fbfcfe;
  transition: border-color 0.15s, background 0.15s;
}
.dropzone:hover,
.dropzone.dragging {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.dropzone.busy {
  cursor: progress;
}

.drop-title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
}

.hint {
  font-size: 11.5px;
  color: var(--text-dim);
}

.spinner {
  width: 22px;
  height: 22px;
  margin: 0 auto 8px;
  border: 2.5px solid #e2d9f7;
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.msg {
  font-size: 12px;
  border-radius: 7px;
  padding: 7px 10px;
  margin: 10px 0 0;
  word-break: break-all;
}
.msg.ok {
  background: #eafaf0;
  color: #15803d;
}
.msg.warn {
  background: #fff8e6;
  color: #a16207;
}
.msg.error {
  background: #fdecec;
  color: var(--danger);
}

.list {
  margin-top: 12px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.empty {
  font-size: 12.5px;
  color: var(--text-dim);
  text-align: center;
  padding: 16px 8px;
}

.item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
}
.item:hover {
  background: #f8fafc;
  border-color: var(--border);
}

.item-main {
  flex: 1;
  min-width: 0;
}

.item-name {
  display: block;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-meta {
  font-size: 11.5px;
  color: var(--text-dim);
}

.cols {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 5px;
}

.col-tag {
  font-size: 10.5px;
  background: #f1f5f9;
  color: #475569;
  border-radius: 4px;
  padding: 1px 6px;
  max-width: 84px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-tag.more {
  background: #ede9fe;
  color: var(--accent-dark);
}

.icon-btn {
  background: none;
  color: #9aa5b4;
  font-size: 13px;
  padding: 4px 7px;
  border-radius: 6px;
  flex-shrink: 0;
}
.icon-btn:hover {
  background: #fdecec;
  color: var(--danger);
}
</style>
