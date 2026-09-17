<script setup>
import ResultView from './ResultView.vue';

defineProps({ msg: { type: Object, required: true } });
</script>

<template>
  <div class="row" :class="msg.role">
    <div class="avatar">{{ msg.role === 'user' ? '我' : 'AI' }}</div>

    <div class="bubble-wrap">
      <!-- 用户消息 -->
      <div v-if="msg.role === 'user'" class="bubble user-bubble">
        <div class="plain">{{ msg.content }}</div>
      </div>

      <!-- 助手消息 -->
      <div v-else class="bubble ai-bubble">
        <!-- 阶段进行中 -->
        <div v-if="msg.streaming && !msg.sql && !msg.unanswerable" class="stage">
          <span class="spinner" />
          <span>{{ msg.stageMessage || '处理中…' }}</span>
        </div>

        <!-- 判定无法回答 -->
        <div v-else-if="msg.unanswerable" class="unanswerable">
          <p class="ua-title">无法回答该问题</p>
          <p class="ua-text">{{ msg.unanswerable }}</p>
        </div>

        <!-- 查询结果 -->
        <template v-else-if="msg.sql">
          <ResultView
            :sql="msg.sql"
            :reasoning="msg.reasoning"
            :chart="msg.chart"
            :result="msg.result"
            :insight="msg.insight"
            :attempts="msg.attempts"
            :warnings="msg.warnings"
          />
          <span v-if="msg.streaming" class="cursor" />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  gap: 10px;
  margin-bottom: 18px;
  align-items: flex-start;
}
.row.user {
  flex-direction: row-reverse;
}

.avatar {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-size: 11.5px;
  font-weight: 700;
  flex-shrink: 0;
  background: #e2e8f0;
  color: #475569;
}
.row.assistant .avatar {
  background: var(--accent);
  color: #fff;
}

.bubble-wrap {
  max-width: 88%;
  min-width: 0;
  flex: 1;
}

.bubble {
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 13.5px;
  word-break: break-word;
}

.user-bubble {
  background: var(--accent);
  border: 1px solid var(--accent);
  color: #fff;
  display: inline-block;
}

.ai-bubble {
  background: #fcfdff;
  border: 1px solid var(--border);
}

.plain {
  white-space: pre-wrap;
}

.stage {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--text-dim);
  font-size: 13px;
}

.spinner {
  width: 15px;
  height: 15px;
  border: 2px solid #e2d9f7;
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.unanswerable {
  background: #fff8e6;
  border-radius: 8px;
  padding: 10px 12px;
}

.ua-title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 700;
  color: #a16207;
}

.ua-text {
  margin: 0;
  font-size: 12.5px;
  color: #854d0e;
  line-height: 1.6;
}

.cursor {
  display: inline-block;
  width: 6px;
  height: 14px;
  background: var(--accent);
  vertical-align: text-bottom;
  margin-left: 3px;
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}
</style>
