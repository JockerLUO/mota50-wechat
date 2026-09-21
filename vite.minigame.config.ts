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

export default defineConfig(({ mode }) => ({
  // 小游戏里没有「base URL」概念；留空让 Rollup 不生成相对 URL 辅助代码
  base: '',
  plugins: [atlasPlainUrl()],

  /**
   * 启动取证探针的开关（见 `src/minigame/beacon.ts`）。
   *
   * 用 `mode` 而不是 `process.env` 是因为本文件不引 node 内置类型（见文件头）。
   * 关掉时 `__MOTA_WX_BEACON__` 是字面量 `false`，`beacon.ts` 里每个函数都在
   * 第一行返回，整块会被 Rollup 摇掉 —— 正式产物里不留探针代码。
   */
  define: {
    __MOTA_WX_BEACON__: JSON.stringify(mode === 'wxbeacon')
  },
  build: {
    outDir: 'dist-minigame',
    /**
     * ⚠️ 刻意**不**清空产物目录。
     *
     * 微信开发者工具会把 appid 写进 `dist-minigame/project.config.json`，并额外生成
     * `project.private.config.json` —— 那两个文件描述的是「谁在跑这个工程」，
     * 不是构建产物。清空 = 每次重建都把它们抹掉，表现是「重建一次，IDE 里就得重新选一次
     * appid」，而且不报错，只是下次打开工程多一个说不清的提示。
     *
     * 代价是残留文件，所以「哪些文件该在包里」这件事改由
     * `tools/copy-minigame-assets.mjs` 显式负责（它会清掉不再需要的图集）。
     * 这其实比 vite 的盲目清空更安全：小游戏主包有 4MB 上限，
     * 「包里只有什么」本来就该是一条明确断言，而不是「反正清空了」。
     */
    emptyOutDir: false,
    /**
     * ES2015 —— 这个值不是「保守偏好」，是被**微信云端的语法检查**实测卡出来的。
     *
     * 原先写的是 `es2020`，理由是「小游戏侧 WebGL2 本身要求 iOS≥14 / 基础库≥2.15，
     * 运行时门槛已经高于 ES2020 的语法门槛」。这个推理漏掉了关键一环：
     * **代码在上传/预览时会过一次云端语法检查，而那个检查器不接受 ES2020 语法。**
     * 表现是在 IDE 里点「编译」后立刻失败：
     *
     *   task type:upload exec error Error: invalid file: game.js, 13:9
     *   SyntaxError: Unexpected token .        ← 指向 `wx?.request?.(` 里的 `?`
     *
     * 错误码是服务端的 `DEV_COMPILE_INVALID_FILE`（-80057）；DevTools 的
     * `upload.parseError` 收到后会拿 sourcemap 把它渲染成 code frame 给用户看。
     * rollup 的 `target` 只影响**本地**打包产物，管不到这一步。
     *
     * 复现与反证：产品里第 1–12 行（箭头函数、`const`、`satisfies` 之外的普通 ES2015）
     * 都能过，报错精确停在文件里**第一个** ES2020 token 上 —— 说明检查器的地板
     * 在 ES2015 与 ES2020 之间，而 ES2015 是它明确能吃下的（箭头函数/const 已过）。
     * 所以这里取 ES2015：任何能接受 ES2015 的检查器都必然接受本产物。
     *
     * 代价：async/await 被降级成「生成器 + `__async` 辅助函数」、对象展开变成
     * `Object.assign`、`?.`/`??` 变成三元。语义不变，包体略涨。
     *
     * ⚠️ 改这个值时**必须同步**改 `tools/verify-minigame.cjs` 里的
     * `SYNTAX_FLOOR` —— 那条判据会用 esbuild 以该目标复算 token 计数，
     * 计数一旦对不上就说明产物里混进了高于地板的语法。两处对齐，IDE 报错才会
     * 提前变成「本地构建期就红」。
     */
    target: 'es2015',
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
}));
