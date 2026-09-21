import { defineConfig } from 'vite';

/**
 * 注意：本项目的数据层直接来自仓库根的 `data/` 目录，**不做任何拷贝**。
 * src 里通过 `import '../data/*.json'` 与 `import.meta.glob('../data/floors/*.json')`
 * 直接引用原始数据文件 —— 这样数据只有一个来源，不存在「副本漂移」的可能。
 */
export default defineConfig({
  root: '.',
  base: './',
  server: {
    host: 'localhost',
    port: 5173,
    open: false
  },
  preview: {
    host: 'localhost',
    port: 4173,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    // 单文件体积预警阈值（数据层是纯文本，压缩后很小，不必紧张）
    chunkSizeWarningLimit: 1200
  }
});
