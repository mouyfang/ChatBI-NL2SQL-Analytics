<script setup>
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

// 按需注册，避免把整个 echarts 打进包里
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  CanvasRenderer,
]);

const props = defineProps({
  sql: { type: String, default: '' },
  reasoning: { type: String, default: '' },
  chart: { type: Object, default: null },
  result: { type: Object, default: null },
  insight: { type: String, default: '' },
  attempts: { type: Number, default: 1 },
  warnings: { type: Array, default: () => [] },
});

const chartEl = ref(null);
const showSql = ref(false);
const showAllRows = ref(false);
let instance = null;

const MAX_PREVIEW_ROWS = 30;

const visibleRows = () => {
  if (!props.result) return [];
  const rows = props.result.rows ?? [];
  return showAllRows.value ? rows : rows.slice(0, MAX_PREVIEW_ROWS);
};

/** 把模型给的图表配置翻译成 ECharts option */
function buildOption() {
  const { chart, result } = props;
  if (!chart || !result || chart.type === 'table') return null;
  if (!chart.x || !chart.y?.length) return null;

  const { columns, rows } = result;
  const xIndex = columns.indexOf(chart.x);
  const yIndices = chart.y.map((c) => columns.indexOf(c)).filter((i) => i >= 0);
  if (xIndex < 0 || yIndices.length === 0 || rows.length === 0) return null;

  const base = {
    title: chart.title
      ? { text: chart.title, left: 'center', textStyle: { fontSize: 13, fontWeight: 600 } }
      : undefined,
    grid: { left: 60, right: 24, top: chart.title ? 46 : 24, bottom: 46 },
  };

  if (chart.type === 'pie') {
    return {
      ...base,
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, type: 'scroll' },
      series: [
        {
          type: 'pie',
          radius: ['32%', '62%'],
          center: ['50%', '54%'],
          data: rows.map((r) => ({ name: String(r[xIndex]), value: r[yIndices[0]] })),
          label: { fontSize: 11 },
        },
      ],
    };
  }

  if (chart.type === 'scatter') {
    return {
      ...base,
      tooltip: { trigger: 'item' },
      legend: { bottom: 0 },
      xAxis: { type: 'value', name: chart.x, nameTextStyle: { fontSize: 11 } },
      yAxis: { type: 'value', name: columns[yIndices[0]], nameTextStyle: { fontSize: 11 } },
      series: yIndices.map((i) => ({
        type: 'scatter',
        name: columns[i],
        symbolSize: 8,
        data: rows.map((r) => [r[xIndex], r[i]]),
      })),
    };
  }

  // bar / line
  const categories = rows.map((r) => String(r[xIndex]));
  return {
    ...base,
    tooltip: { trigger: 'axis' },
    legend: yIndices.length > 1 ? { bottom: 0 } : undefined,
    xAxis: {
      type: 'category',
      data: categories,
      axisLabel: { fontSize: 11, rotate: categories.length > 6 ? 28 : 0, hideOverlap: true },
    },
    yAxis: { type: 'value', axisLabel: { fontSize: 11 } },
    series: yIndices.map((i) => ({
      type: chart.type,
      name: columns[i],
      data: rows.map((r) => r[i]),
      smooth: chart.type === 'line',
      itemStyle: { borderRadius: chart.type === 'bar' ? [4, 4, 0, 0] : 0 },
      barMaxWidth: 42,
    })),
  };
}

function renderChart() {
  if (!chartEl.value) return;
  const option = buildOption();

  if (!option) {
    if (instance) {
      instance.dispose();
      instance = null;
    }
    return;
  }

  if (!instance) instance = echarts.init(chartEl.value);
  instance.setOption(option, true);
}

function onResize() {
  instance?.resize();
}

watch(
  () => [props.chart, props.result],
  async () => {
    await nextTick();
    renderChart();
  },
  { deep: true },
);

onMounted(() => {
  renderChart();
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  instance?.dispose();
  instance = null;
});
</script>

<template>
  <div class="result">
    <!-- 生成思路 -->
    <p v-if="reasoning" class="reasoning">
      <span class="tag">思路</span>{{ reasoning }}
      <span v-if="attempts > 1" class="retry-badge" title="生成的 SQL 执行失败后自动修正过">
        已自动修正 {{ attempts - 1 }} 次
      </span>
    </p>

    <!-- SQL -->
    <div v-if="sql" class="sql-wrap">
      <button class="sql-toggle" @click="showSql = !showSql">
        {{ showSql ? '▾' : '▸' }} 查看生成的 SQL
      </button>
      <pre v-if="showSql" class="sql-block">{{ sql }}</pre>
      <p v-for="(w, i) in warnings" :key="i" class="warning">⚠️ {{ w }}</p>
    </div>

    <!-- 图表 -->
    <div v-if="chart && chart.type !== 'table'" ref="chartEl" class="chart" />

    <!-- 结果表格 -->
    <div v-if="result && result.rows.length" class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="col in result.columns" :key="col">{{ col }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in visibleRows()" :key="ri">
            <td v-for="(col, ci) in result.columns" :key="ci">
              {{ row[ci] === null || row[ci] === undefined ? '—' : row[ci] }}
            </td>
          </tr>
        </tbody>
      </table>

      <button
        v-if="result.rows.length > MAX_PREVIEW_ROWS"
        class="more-btn"
        @click="showAllRows = !showAllRows"
      >
        {{ showAllRows ? '收起' : `展开全部 ${result.rows.length} 行` }}
      </button>
    </div>

    <!-- 解读 -->
    <div v-if="insight" class="insight">
      <span class="tag insight-tag">解读</span>
      <span class="insight-text">{{ insight }}</span>
    </div>
  </div>
</template>

<style scoped>
.result {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.reasoning {
  margin: 0;
  font-size: 12.5px;
  color: #475569;
  background: #f8fafc;
  border-left: 3px solid var(--accent);
  border-radius: 0 6px 6px 0;
  padding: 8px 12px;
}

.tag {
  display: inline-block;
  font-size: 10.5px;
  font-weight: 700;
  color: #fff;
  background: var(--accent);
  border-radius: 4px;
  padding: 1px 6px;
  margin-right: 7px;
  vertical-align: 1px;
}

.retry-badge {
  display: inline-block;
  margin-left: 8px;
  font-size: 11px;
  color: #a16207;
  background: #fff8e6;
  border-radius: 4px;
  padding: 1px 7px;
}

.sql-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sql-toggle {
  align-self: flex-start;
  background: none;
  color: var(--accent);
  font-size: 12.5px;
  padding: 2px 0;
}
.sql-toggle:hover {
  text-decoration: underline;
}

.warning {
  margin: 0;
  font-size: 11.5px;
  color: #a16207;
  background: #fff8e6;
  border-radius: 6px;
  padding: 5px 10px;
}

.chart {
  width: 100%;
  height: 320px;
}

.table-wrap {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.data-table th {
  background: #f8fafc;
  color: #475569;
  font-weight: 600;
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.data-table td {
  padding: 7px 12px;
  border-bottom: 1px solid #f1f5f9;
  white-space: nowrap;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.data-table tbody tr:last-child td {
  border-bottom: none;
}

.data-table tbody tr:hover {
  background: #fafbfd;
}

.more-btn {
  width: 100%;
  background: #f8fafc;
  color: var(--accent);
  font-size: 12px;
  padding: 7px;
  border-radius: 0;
  border-top: 1px solid var(--border);
}
.more-btn:hover {
  background: var(--accent-soft);
}

.insight {
  background: var(--accent-soft);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.65;
}

.insight-tag {
  background: var(--accent-dark);
}

.insight-text {
  white-space: pre-wrap;
}

.cursor {
  display: inline-block;
  width: 6px;
  height: 14px;
  background: var(--accent);
  vertical-align: text-bottom;
  margin-left: 2px;
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}
</style>
