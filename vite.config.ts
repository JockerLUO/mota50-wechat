import { defineConfig } from 'vite';

/**
 * 网页端构建配置。
 *
 * ## 数据层：网页端仍走「构建期内联」，不做任何拷贝
 *
 * 本项目的数据来自仓库根的 `data/` 目录。**网页端**通过
 * `import '../data/*.json'` 与 `import.meta.glob('../data/floors/*.json')`
 * 直接引用原始数据文件，由 Vite 在构建期烘进 bundle ——
 * 这样数据只有一个来源，不存在「副本漂移」的可能，首屏也不必为数据多发请求。
 *
 * ⚠️ 这条「不拷贝」的规矩**只对网页端成立**。微信小游戏那边不行：
 * 小游戏没有 bundler 之外的文件系统概念，数据要进代码包就必须有一份实体文件，
 * 于是 `npm run build:minigame` 会按 `src/data/runtime-files.mjs` 的清单
 * 把 `data/` 拷进 `dist-minigame/data/`，由 `source-minigame.ts` 在运行期读取。
 * 两端的**数据源仍是同一份 `data/` 目录**（拷贝是构建产物，不是第二份手写数据），
 * 所以「改数据 → 重跑对应构建」这条纪律照旧。
 *
 * 两端的二选一由 `resolve.alias` 的 `@data-source` 决定，见
 * `src/data/index.ts` 文件头。
 */

/**
 * 网页端的数据源实现（构建期内联）。
 *
 * 用 `new URL(..., import.meta.url).pathname` 而不是 `node:path.resolve`：
 * 本文件要保持「不装 @types/node 也能过 tsc」——项目的 tsconfig 里
 * `types` 只有 `vite/client`，引 `node:path` 会直接 TS2307。
 */
const DATA_SOURCE_WEB = decodeURIComponent(new URL('./src/data/source-web.ts', import.meta.url).pathname);

export default defineConfig({
  root: '.',
  base: './',
  resolve: {
    alias: {
      '@data-source': DATA_SOURCE_WEB
    }
  },
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
