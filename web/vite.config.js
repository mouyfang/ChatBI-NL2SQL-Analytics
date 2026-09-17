import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  build: {
    rollupOptions: {
      output: {
        // echarts 体积较大，单独分包便于浏览器缓存（改动业务代码不必重新下载它）
        manualChunks: {
          echarts: ['echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers'],
          vendor: ['vue'],
        },
      },
    },
  },
  server: {
    port: 5174,
    // 开发期代理到后端，避免跨域配置
    proxy: {
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
});
