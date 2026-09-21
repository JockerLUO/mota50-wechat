/**
 * 微信小游戏构建配置。
 *
 * 与网页端（`vite.config.ts`）的三处关键差异：
 *
 * 1. **产物形态**：小游戏入口是一个「脚本」而不是页面，所以走 `lib` 模式的 `iife`，
 *    产出单个 `game.js`。没有 index.html。
 *
 * 2. **资源路径不经过 Vite 的资源管线**：网页端 `import png from '...png'` 会变成带
 *    hash 的 URL，而相对 URL 的解析在 Vite 里依赖 `document.baseURI`
 *    —— 小游戏没有 document。所以这里用 `enforce: 'pre'` 的 load 钩子把
 *    图集的 import **直接换成包内相对路径字面量**：`'assets/terrain.png'`。
 *    文件名不带 hash 也就意味着「包里的文件名 = 构建期写死的名字」，
 *    由 `tools/copy-minigame-assets.mjs` 负责把它们原样拷进包内，两边对得上。
 *
 * 3. **不压缩**：小游戏主包上限 4MB，本项目图集加起来才几十 KB、单文件产物几百 KB。
 *    保留可读性，在微信开发者工具里能直接看堆栈。
 *
 * 注意本文件**不引入任何 node 内置模块**（项目没装 @types/node）。
 * 「往包目录里拷文件」这件事拆到了 `tools/copy-minigame-assets.mjs`，
 * 由 npm script 在构建后调用 —— 职责也更清楚：Vite 管打包，脚本管拷包。
 */

import { defineConfig, type Plugin } from 'vite';

/**
 * 把 `assets/atlas/*.png` 的 import 换成包内相对路径字面量。
 *
 * `enforce: 'pre'` 是关键：这样本插件的 `load` 会排在 Vite 内置 asset 插件之前，
 * 抢先给出结果，图片就完全不进资源管线（不 hash、不转 base64、不依赖 document）。
 */
function atlasPlainUrl(): Plugin {
  return {
    name: 'mota:atlas-plain-url',
    enforce: 'pre',
    load(id) {
      const file = id.split('?')[0].replace(/\\/g, '/');
      if (!file.endsWith('.png') || !file.includes('/assets/atlas/')) return null;
      const name = file.slice(file.lastIndexOf('/') + 1);
      return `export default ${JSON.stringify(`assets/${name}`)};`;
    }
  };
}

export default defineConfig({
  // 小游戏里没有「base URL」概念；留空让 Rollup 不生成相对 URL 辅助代码
  base: '',
  plugins: [atlasPlainUrl()],
  build: {
    outDir: 'dist-minigame',
    emptyOutDir: true,
    // ES2020：小游戏侧 WebGL2 本身就要求 iOS≥14 / 基础库≥2.15，
    // 这个门槛已经高于 ES2020 的语法要求（可选链等）。
    target: 'es2020',
    minify: false,
    chunkSizeWarningLimit: 4000,
    lib: {
      entry: 'src/minigame/main.ts',
      name: 'motaGame',
      formats: ['iife'],
      fileName: () => 'game.js'
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});
