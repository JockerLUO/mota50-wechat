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
 * 构建号 —— 打进产物、由取证探针报回来。
 *
 * 存在的理由只有一个：**证明 IDE 到底在跑哪一份产物**。
 * 排查「改了代码但现象一模一样」时，先要回答的就是这个问题；没有构建号时
 * 只能拿报错行号去反推，而那个反推有一堆前提（IDE 会不会二次加工代码、
 * 有没有用编译缓存……），推错一次就要多来回一轮。
 */
const BUILD_ID = (() => {
  // 本机时区、秒级 —— 取证报告里要跟「我几点点的编译」对得上，
  // 所以不用 `toISOString()`（那是 UTC，读起来会差 8 小时，白白多一轮对话）。
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
})();

/**
 * 产物开头的**词法垫片**（`output.intro`）—— 只解决 `Intl` 一件事。
 *
 * ## 为什么不能只靠 `env.ts` 往 globalThis 上装
 *
 * `env.ts` 的 `installIntl()` 是 `globalThis.Intl = {}`。这条路径依赖一个前提：
 * **宿主的全局对象允许新增键**。浏览器/真机满足它，但微信开发者工具里有一条
 * 不满足的路径 —— 实测（见 `docs/wechat-minigame.md` §9）：
 *
 *   - 探针在 IDE 里采到的宿主快照是 `hasDocument:false, hasPerformance:false`
 *     —— 一个**白名单式的沙箱全局**（只给 wx / GameGlobal / requestAnimationFrame）；
 *   - 同一个 IDE 的另一个上下文（有 DOM 那个）却报 `Intl: "object"`；
 *   - 报错停在 `Intl is not defined`，而**同一份产物里装上 Intl 的那几行在它前面**。
 *
 * 三者合起来只有一种解释：沙箱里的 `globalThis` **不是**作用域链末端那个对象 ——
 * `globalThis.Intl = {}` 写进了一个影子对象，而裸标识符 `Intl` 仍然从宿主
 * 原本的全局解析，于是照样 `ReferenceError`。
 *
 * > 注意这里的关键区别：**「宿主有 `globalThis.Intl`」≠「裸标识符 `Intl` 读得到」**。
 * > 前者是属性访问，后者走作用域链 —— 沙箱可以把两者切开。所以 `installIntl()`
 * > 里的 `typeof g.Intl !== 'undefined'` 判断在那种宿主上**是对的却没用**。
 *
 * ## 词法绑定为什么能治
 *
 * IIFE 包一层 `var Intl`，就是在这份产物自己的作用域里**多一个绑定**。
 * 裸标识符的解析先看作用域链，链上有就直接用 —— 宿主怎么说都不影响。
 * 这是唯一不依赖宿主配合的做法（`output.intro` 会被 Rollup 放在包装函数的
 * `"use strict"` 之后、所有模块之前）。
 *
 * ## 只垫 `Intl`，不顺手垫别的
 *
 * 别的不行，原因不同：
 *   - `document` / 事件那一套需要 `env.ts` 里那些有行为的替身对象（事件总线、
 *     `getBoundingClientRect` 补丁、上屏画布预订），intro 里造不出来 ——
 *     而且它们**必须在 `wx.createCanvas()` 第一次调用前后按序安装**，
 *     时机比 intro 更晚也更讲究。
 *   - `navigator` 更微妙：`env.ts` 会用 `wx.getSystemInfoSync()` 合成一份，
 *     而 intro 在它之前跑。若这里也 `var navigator = ...` 就会**把后装的那份
 *     挡在作用域外**（pixi 只能看到 intro 里这份简陋的），反而更糟 ——
 *     那是拿一个真问题换一个假问题。
 *
 * 所以 intro 的边界就一句话：**只垫「宿主可能没有、且我们不需要给它行为」的那个
 * 全局**。当前符合这个描述的只有 `Intl`（pixi 只用它做 grapheme 分段，
 * 空对象即等价于「没有 Segmenter」，pixi 自己会退回 `[...s]`）。
 *
 * ## 写法约束（两条都是实测撞出来的，别为了方便破例）
 *
 * **① 必须是单行、括号配平的一条语句。**
 *
 * 最初把它写成多行的 IIFE（`var Intl = (function () { ... })();`），结果
 * Rollup 的 iife 包装与它套在一起**错位**了：产物里 `(function() {` 出现在第 1 行、
 * 包装函数出现在第 55 行，而 esbuild 给降级临时变量生成的 `var _a, _c, _k, _l;`
 * 落在了**另一个函数作用域**里。表现是产物在
 * `hasPerformance: !!((_a = g$2.performance) == null ? void 0 : _a.now)` 这行
 * 抛 `ReferenceError: _a is not defined` —— 整个包连第一行业务代码都到不了。
 *
 * 这个坑特别值得记一笔：**它在 IDE 里不会暴露**。IDE 把自己的模块和我们的
 * `game.js` 跑在同一个 realm 里，而它自己那堆压缩代码里就有一个全局 `var _a`，
 * 于是我们的裸 `_a` 被**别人的变量**意外接住了；真机上没有这个巧合，直接黑屏。
 * 所以「IDE 里能跑」在这里是完全无效的证据 ——
 * 判据必须落在「产物自身结构」上（见 `tools/verify-sandbox.cjs` 的
 * 「函数包裹模式下能跑到 wx 缺失那一句」）。
 *
 * **② 必须自己守 ES2015 地板。**
 *
 * 这段字符串是 Rollup 的 `intro`，虽然也会过一遍 Vite 的 esbuild，但它的位置
 * 特殊（在模块图之外），不要指望降级规则和模块源码一样。所以：不用 `?.`、
 * 不用 `??`、不裸写 `globalThis`（沙箱里它可能是 undefined，只有 `typeof` 安全）。
 */
const PRELUDE =
  'var Intl = (typeof globalThis === "object" && globalThis && globalThis.Intl) || { Segmenter: void 0 };';

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
    __MOTA_WX_BEACON__: JSON.stringify(mode === 'wxbeacon'),
    // 构建号（见文件头的 BUILD_ID）。探针会把它报回来，用来回答「IDE 跑的是哪一份产物」。
    __MOTA_BUILD_ID__: JSON.stringify(BUILD_ID)
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
        assetFileNames: 'assets/[name][extname]',
        /**
         * 词法垫片（完整理由见文件头 `PRELUDE`）。
         *
         * 用 `intro` 而不是 `banner` 是**有意的**：`banner` 落在整个包装函数
         * **外面**（也就是 `"use strict"` 之前），那会让整份产物退化成非严格模式 ——
         * 而严格模式本身是我们的判据之一（`env.ts` 里「只读属性赋值必抛」的探测
         * 就靠它，`nativeDom` 的判断建立在它之上）。`intro` 落在包装函数**内部、
         * `"use strict"` 之后**，既在产物最外层的作用域里，又不动严格模式。
         */
        intro: PRELUDE
      }
    }
  }
}));
