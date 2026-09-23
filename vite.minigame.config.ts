/**
 * 微信小游戏构建配置。
 *
 * 与网页端（`vite.config.ts`）的四处关键差异：
 *
 * 1. **产物形态**：小游戏入口是一个「脚本」而不是页面，产出 `game.js`。
 *    但**不是一个单文件** —— 见下面「为什么产物是两个文件」那一节。
 *    没有 index.html。
 *
 * 2. **资源路径不经过 Vite 的资源管线**：网页端 `import png from '...png'` 会变成带
 *    hash 的 URL，而相对 URL 的解析在 Vite 里依赖 `document.baseURI`
 *    —— 小游戏没有 document。所以这里用 `enforce: 'pre'` 的 load 钩子把
 *    图集的 import **直接换成包内相对路径字面量**：`'assets/terrain.png'`。
 *    文件名不带 hash 也就意味着「包里的文件名 = 构建期写死的名字」，
 *    由 `tools/copy-minigame-assets.mjs` 负责把它们原样拷进包内，两边对得上。
 *    数据同理：`data/*.json` 由那个脚本拷进包，运行期用
 *    `wx.getFileSystemManager().readFileSync` 读（见 `src/data/source.ts`）。
 *
 * 3. **不压缩**：小游戏主包上限 4MB，本项目图集加起来才几十 KB、单个 js 也就几百 KB。
 *    保留可读性，在微信开发者工具里能直接看堆栈。
 *
 * 4. **数据源与网页端不同**：`@data-source` 这个 alias 在这里指向
 *    `source-minigame.ts`（运行期读代码包），网页端指向 `source-web.ts`
 *    （构建期内联）。见 `src/data/index.ts` 文件头。
 *
 * ## 为什么产物是 `game.js` + `boot.js` 两个文件
 *
 * 单文件 2MB 在 IDE 里没法看 —— 这不是美观问题：「业务代码到底在跑哪一版」
 * 这种问题每次都要靠堆栈行号反推。拆开之后 `game.js` 只有几百 KB，
 * 且**不含 pixi**，可以直接读。
 *
 * 但拆分边界不能随便选。小游戏是 CommonJS 模块环境，而 CJS 的求值顺序是
 * **「依赖先于自身」** —— 入口天然是最后一个求值的。这与本项目的两条硬约束
 * 直接冲突：
 *
 *   - `beacon` 必须**最先**（它要抓的正是「连垫片都没装上就死了」）
 *   - `env/` 的全局垫片必须**早于 pixi 的模块体**（pixi 模块顶层就读裸标识符
 *     `Intl` / `navigator`，见 PRELUDE 那一大段说明）
 *
 * 所以**不能**按「我们的代码 vs 第三方库」拆 —— 那样 pixi 所在的 chunk 必然先求值，
 * 两条约束全破。正确的边界是**按「必须最先求值的那一层」拆**：
 *
 *   boot.js = PRELUDE（intro） + beacon + env/ 子树 + pixi
 *   game.js = 其余全部（我们的业务代码）
 *
 * 这三者**在同一个 chunk 内**，模块顺序仍由 Rollup 按依赖图排（与拆分前
 * 单文件 IIFE 时**完全同一个机制**）；`main.ts` 里 `import './beacon'` 排第一、
 * `import './env'` 排第二，于是它们在 pixi 之前 —— 这条保证与拆分前**强度相同**，
 * 不是「靠猜」。
 *
 * 另外每个 chunk 顶部都带一份 PRELUDE（`output.intro` 是对每个 chunk 生效的）。
 * 这是有意的冗余：PRELUDE 里那些 `globalThis.X || (globalThis.X = …)` 都是幂等的，
 * 重复执行拿到的是同一个对象；而它多垫的那一层正好覆盖「pixi 模块体要用的
 * 裸标识符」——即便哪天 Rollup 的模块排序变了，也还有这道保险。
 *
 * ⚠️ 构建后**必须实测** boot.js 里 `installGlobals()` 的调用位置早于 pixi 的
 *    模块体（判据见 `tools/verify-minigame.cjs` 的包结构一节）。
 *
 * 注意本文件**不引入任何 node 内置模块**（项目没装 @types/node），
 * 所以下面用的是 `new URL(..., import.meta.url).pathname` 而不是 `node:path`。
 * 「往包目录里拷文件」这件事拆到了 `tools/copy-minigame-assets.mjs`，
 * 由 npm script 在构建后调用 —— 职责也更清楚：Vite 管打包，脚本管拷包。
 */

import { defineConfig, type Plugin } from 'vite';

/**
 * 小游戏端的数据源实现（运行期读代码包内文件）。
 *
 * 与网页端二选一，规则见 `src/data/index.ts` 文件头。
 * ⚠️ 改这个值时别忘了 `package.json` 的 `build:minigame` 还要跑一遍
 * `tools/copy-minigame-assets.mjs` —— 是它把 `data/` 拷进包里的。
 */
const DATA_SOURCE_MINIGAME = decodeURIComponent(
  new URL('./src/data/source-minigame.ts', import.meta.url).pathname
);

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
 * ## 边界：**只垫「裸标识符」能被看见这件事**，垫不了行为
 *
 * 当前垫六个：`Intl`、`navigator`、`document`、`performance`、`requestAnimationFrame` /
 * `cancelAnimationFrame`、`MouseEvent`。选它们的标准是**两条同时成立**：
 *   ① pixi 会**裸读**它（不是 `globalThis.X`，也不是 `x.method()` 那种成员访问）；
 *   ② 那条裸读**真的会执行**（不是 `typeof X` 守卫里的一句、也不是被我们替换掉的分支）。
 *
 * 判定 ① 的办法就是搜 pixi 源码；判定 ② 靠的是「这条路径有没有被跑到」——
 * 实测过的方式：`Ticker.update(currentTime = performance.now())` 的默认参数每帧都走、
 * `EventTicker` 合成 mousemove 时会 `new MouseEvent(...)`、`Ticker.start()` 裸调 rAF。
 * 只满足 ① 不满足 ② 的（比如 `new Image()` 只在 `testImageFormat` 的探测里，
 * 外面包着 try/catch）**不垫** —— 垫了反而多一份没人测过的替身。
 *
 * 值从哪来，分两类：
 *   - **不需要行为** → intro 一步到位：`Intl`（空对象即等价于「没有 Segmenter」）。
 *   - **需要行为** → 「**一个对象、两处引用**」：intro 只负责**选或造**那个对象
 *     （并把它同时挂到 globalThis），`env.ts` 改成**就地补字段**（`Object.assign`）
 *     而不是整对象替换。否则 intro 绑在裸标识符上的那份与 env.ts 装上去的那份
 *     会变成两个对象，pixi 只会看到 intro 里那份简陋的 —— 拿真问题换假问题。
 *     属于这一类的：`navigator`、`document`、`performance`、rAF/cAF。
 *     `MouseEvent` 还有第三种形态：兜底要转发给 `globalThis.MouseEvent`
 *     （`env.ts` 装的 `MiniMouseEvent`），所以它**不能**把自己挂到 globalThis 上 ——
 *     会自我递归。它走**懒转发**：调用那一刻才去取。
 *
 * ## 写法约束（两条都是实测撞出来的，别为了方便破例）
 *
 * **① 每条语句必须单行、括号配平。**
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
 * 判据必须落在「产物自身结构」上（见 `tools/verify-sandbox.cjs` 的判据 1：
 * 干净宿主里必须一路跑到我们那句「未找到全局 wx」）。
 *
 * **② 每条语句必须自己守 ES2015 地板。**
 *
 * 这段字符串是 Rollup 的 `intro`，虽然也会过一遍 Vite 的 esbuild，但它的位置
 * 特殊（在模块图之外），不要指望降级规则和模块源码一样。所以：不用 `?.`、
 * 不用 `??`、不裸写 `globalThis`（沙箱里它可能是 undefined，只有 `typeof` 安全）。
 *
 * ## 为什么 `navigator` 也要垫（第二轮才发现的同一个坑）
 *
 * 第一版只垫了 `Intl`，用户在 IDE 里点编译后拿到的新错误是：
 *
 *   Cannot destructure property 'userAgent' of 'DOMAdapter.get().getNavigator()'
 *   as it is undefined        at isSafari (game.js:34510)
 *
 * 而**同一份产物的探针在同一个宿主里报的是 `navigator: {present: true, hasUA: true}`**。
 * 两个观测都对 —— 它们看的是两条不同的路径：
 *
 *   - `globalThis.navigator`      → 宿主给的、有 userAgent 的那个对象
 *   - 裸标识符 `navigator`        → **undefined**
 *
 * pixi 的默认适配器写的是 `getNavigator: () => navigator`（裸标识符），
 * 而 `isSafari()` 由 `const defaultForceAllocation = isSafari()` 在**模块顶层**调用 ——
 * 早于我们把 `DOMAdapter` 换成小游戏实现。于是它读到 undefined，当场炸。
 *
 * ## 第三例：`document`（`AccessibilitySystem`，渲染器构造期）
 *
 * 垫好前两者之后，时间线第一次跑出了 `module`
 * （`module → shim → hostModule → host → probe`），然后死在 `Game.create()` 里：
 *
 *   TypeError: Cannot read properties of undefined (reading 'createElement')
 *     at AccessibilitySystem._createTouchHook   ← const hookDiv = document.createElement("button")
 *
 * 与 `navigator` 完全同一个坑：属性路径有值、裸标识符是 undefined。
 * 值得一提的只有一点：这几例的**暴露顺序是串行的** ——
 * `_a` → `Intl` → `navigator` → `document` → `unsafe-eval`，修掉一个才会露出下一个，
 * 所以「报错一模一样」通常不是「没修」，而是「还没修到会暴露它的那一步」。
 *
 * 所以规则是通用的：**垫片要同时覆盖 `globalThis` 与裸标识符两条路径**。
 * `env.ts` 的 `safeAssign` 只管前一条（它按值判断，在真机上是有效的），
 * 后一条只有词法绑定管得着 —— 这就是本文件存在的原因。
 *
 * ⚠️ 关键细节：`navigator` 这一条必须与 `env.ts` **共用同一个对象**。
 * 否则 `env.ts` 用 `wx.getSystemInfoSync()` 合成的 UA 会被挡在作用域外，
 * pixi 只能看到 intro 里这份简陋的 —— 那是拿真问题换假问题。
 * 做法：intro 把兜底对象**同时装到 `globalThis.navigator` 上**，
 * `env.ts` 那边改成**就地补字段**（`Object.assign`）而不是整对象替换。
 */
const PRELUDE = [
  // Intl：pixi 的 CanvasTextMetrics 静态字段初始化器会读它。
  // 空对象（没有 Segmenter）等价于「宿主不支持」，pixi 自己会退回 `[...s]` 分段。
  'var Intl = (typeof globalThis === "object" && globalThis && globalThis.Intl) || { Segmenter: void 0 };',
  // navigator：pixi 的 BrowserAdapter `getNavigator: () => navigator`，由模块顶层的
  // isSafari() 触发。优先用宿主那份（它的 UA 比我们编的准）；宿主没有就造一份**空 UA** 的，
  // 并同时挂到 globalThis 上 —— 空 UA 是为了让 `env.ts` 仍然认为「不可用」，
  // 从而继续用 wx.getSystemInfoSync() 补上真实机型。
  'var navigator = (typeof globalThis === "object" && globalThis && globalThis.navigator) || (typeof globalThis === "object" && globalThis ? (globalThis.navigator = { userAgent: "", platform: "", maxTouchPoints: 1, gpu: null }) : { userAgent: "", platform: "", maxTouchPoints: 1, gpu: null });',
  // ③ document：pixi 的 AccessibilitySystem._createTouchHook()（渲染器构造期）与
  // DOMPipe（每帧）都会读裸 `document`。判据是**可用性**（createElement 是不是函数），
  // 不是「属性在不在」—— IDE 里实测过「属性在、裸读 undefined」，也有「属性在但不可用」的形态。
  'var document = (typeof globalThis === "object" && globalThis && globalThis.document && typeof globalThis.document.createElement === "function") ? globalThis.document : {};',
  // ③b 把**选中的那个对象**留个记号给 `env.ts`。
  //     为什么需要它：`env.ts` 要「就地补字段」到裸标识符指着的那一个对象上，
  //     而单靠 `globalThis.document` 读回来的可能**不是同一个**——
  //     宿主若把 `document` 设成只读属性，下一句的赋值会失败，
  //     于是 `globalThis.document` 仍是宿主那个不可用的对象，而裸标识符是这里的占位对象。
  //     有这条记号，「补哪个对象」就是个事实而不是猜测（这一整轮的教训）。
  'if (typeof globalThis === "object" && globalThis) { try { globalThis.__motaDocumentShim = document; } catch (e) { } }',
  // ③c 占位对象能挂上 globalThis 就挂上：两条路径指向同一个对象最省事。
  'if (typeof globalThis === "object" && globalThis && !document.createElement) { try { globalThis.document = document; } catch (e) { } }',
  // ④ performance —— pixi 有几十处**裸读** `performance.now()`：
  //    `Ticker.update(currentTime = performance.now())` 的默认参数**每帧**都会走到，
  //    `AccessibilitySystem`（就是 §③ 那个 document 崩在同一批 `_addSystems` 里）构造期也要。
  //    判据用「`now` 是不是函数」，与 document 那条同一条思路。
  'var performance = (typeof globalThis === "object" && globalThis && globalThis.performance && typeof globalThis.performance.now === "function") ? globalThis.performance : (typeof globalThis === "object" && globalThis ? (globalThis.performance = { now: function () { return Date.now(); } }) : { now: function () { return Date.now(); } });',
  // ⑤ requestAnimationFrame / cancelAnimationFrame —— Ticker 启停时裸读。
  //    ⚠️ 时间戳必须与 `performance` **同源**，否则 Ticker 算出的 delta 会跳变；
  //    所以这里显式调上面那个词法绑定 `performance`，而不是 `Date.now()`。
  'var requestAnimationFrame = (typeof globalThis === "object" && globalThis && typeof globalThis.requestAnimationFrame === "function") ? globalThis.requestAnimationFrame : (typeof globalThis === "object" && globalThis ? (globalThis.requestAnimationFrame = function (cb) { return setTimeout(function () { cb(performance.now()); }, 16); }) : function (cb) { return setTimeout(function () { cb(performance.now()); }, 16); });',
  'var cancelAnimationFrame = (typeof globalThis === "object" && globalThis && typeof globalThis.cancelAnimationFrame === "function") ? globalThis.cancelAnimationFrame : (typeof globalThis === "object" && globalThis ? (globalThis.cancelAnimationFrame = function (id) { clearTimeout(id); }) : function (id) { clearTimeout(id); });',
  // ⑥ MouseEvent —— pixi 的 `EventTicker` 合成 mousemove 时裸写 `new MouseEvent("mousemove", …)`。
  //    ⚠️ 这一条**不能**用上面那种「把兜底挂到 globalThis 上」的写法：兜底本身要转发给
  //    `globalThis.MouseEvent`，挂上去就自我递归了。改成**懒转发** ——
  //    调用那一刻才去取 `globalThis.MouseEvent`（也就是 `env.ts` 装的 `MiniMouseEvent`）。
  'var MouseEvent = (typeof globalThis === "object" && globalThis && typeof globalThis.MouseEvent === "function") ? globalThis.MouseEvent : function (type, init) { return new globalThis.MouseEvent(type, init); };'
].join('\n');

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

  resolve: {
    alias: {
      '@data-source': DATA_SOURCE_MINIGAME
    }
  },

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
     * `tools/copy-minigame-assets.mjs` 显式负责（它会清掉不再需要的图集与数据文件）。
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
     * 提前变成「本地构建期就红」。这条判据现在**对每个 chunk 都跑**（game.js + boot.js），
     * 因为云端检查器看到的是两个文件。
     */
    target: 'es2015',
    minify: false,
    chunkSizeWarningLimit: 4000,
    /**
     * 关掉 module preload 的 polyfill 注入。
     *
     * 小游戏里没有 `<link rel="modulepreload">` 这回事，这个 polyfill 没有意义。
     *
     * ⚠️ **它拦不住 `__vitePreload` 包装本身**（实测确认）：产物里仍然有
     * `__vitePreload(loader, void 0, <import.meta.url 的展开式>)`。
     * 而那句展开式在无 DOM 宿主里会抛 —— 真正的修法在 `src/minigame/env/document.ts`
     * 的 `doc.baseURI`（给相对 URL 一个绝对基准），这里只是把没用的 polyfill 摘掉。
     *
     * 展开式的形态（`cjs` 格式下由 Rollup 生成，两个分支小游戏都用不了）：
     *
     *   typeof document === "undefined"
     *     ? require("url").pathToFileURL(__filename).href          // 左支：小游戏没有 url 模块
     *     : _documentCurrentScript && … || new URL("boot.js", document.baseURI).href
     *                                                              // 右支：baseURI 必须有效
     *
     * 左支取不到（我们的 `document` 是词法绑定，`typeof` 永不为 `undefined`），
     * 所以只要 baseURI 有效就不会抛。
     */
    modulePreload: false,
    rollupOptions: {
      /**
       * 入口用 `input` 而不是 `build.lib` 的 `formats: ['iife']`。
       *
       * 原因只有一个：**iife 格式只支持单 chunk**，而我们要拆成两个文件。
       * 换成 `cjs` 之后产物是小游戏原生的 CommonJS 模块
       *（官方「基础能力 / 模块化」：每个 js 文件是独立作用域，用 `require` 互引），
       * 于是 `game.js` 开头会是 `var boot = require('./boot.js')`。
       *
       * ⚠️ `require` 的写法有讲究：路径**必须带 `.js` 后缀**。
       * 官方文档的示例（`require('./src/util/drawLogo')`）不带后缀，
       * 但那依赖基础库「猜后缀」的行为；把小游戏包丢给别的构建工具或做静态分析时，
       * 带后缀是唯一无歧义的写法，而带后缀也一定能命中（文件确实叫 `boot.js`）。
       * 宿主侧（`tools/minigame-harness/`）刻意**不复刻猜后缀逻辑** ——
       * 让本地就能把「路径写错」抓出来。
       */
      input: 'src/minigame/main.ts',
      output: {
        format: 'cjs',
        /** 入口固定叫 game.js（小游戏约定的入口名，不能变） */
        entryFileNames: 'game.js',
        /**
         * 其余 chunk 用 `[name].js`，`name` 由下面的 `manualChunks` 给。
         * 刻意**不加 hash**：小游戏包内文件名要能被 require 静态指到，
         * 而带 hash 的名字会让「包里有个 boot.js」这件事每次构建都变。
         */
        chunkFileNames: '[name].js',
        assetFileNames: 'assets/[name][extname]',
        /**
         * 拆包边界 —— 只有一条：**引导层 + 第三方库** 进 `boot`，其余留在入口。
         *
         * ## 为什么必须是「引导层 + pixi」而不是「pixi」单独一个包
         *
         * 见文件头那一节。一句话：CJS 的 chunk 执行顺序是「被依赖的先执行」，
         * 而入口依赖 boot，所以 boot 一定先跑。若把 `env/` 留在入口、
         * 只把 pixi 拆出去，pixi 就会**早于垫片**求值 —— 那是把这个项目
         * 花了好几轮才修好的 `Intl is not defined` / `navigator is undefined` /
         * `document.createElement undefined` 三个坑一次性踩回去。
         *
         * 三者同 chunk 后，它们的相对顺序仍由 Rollup 按依赖图排，
         * 与拆分前单文件时是**同一个机制**（`main.ts` 里 beacon 第一、env 第二）。
         *
         * ## 为什么用函数形式而不是对象形式
         *
         * 对象形式要写出「pixi 的全部入口 id」，而 `pixi.js/unsafe-eval`、
         * `pixi.js`、以及 pixi 内部的子路径是三个不同的 id。函数形式按**路径**判断，
         * 一次覆盖 `node_modules/pixi.js/` 下的全部模块，加一个 pixi 子路径时
         * 不需要改这里。
         */
        manualChunks(id: string) {
          const p = id.replace(/\\/g, '/');
          // 取证探针：它要抓的第一件事就是「连垫片都没装上就死了」，所以必须最先求值。
          if (p.includes('/src/minigame/beacon.ts')) return 'boot';
          // 全局垫片（document / navigator / 事件总线 / 上屏画布预订）
          if (p.includes('/src/minigame/env/')) return 'boot';
          // pixi 及其子路径（含 pixi.js/unsafe-eval）
          if (p.includes('/node_modules/pixi.js/')) return 'boot';
          return undefined;
        },
        /**
         * 词法垫片（完整理由见文件头 `PRELUDE`）。
         *
         * 用 `intro` 而不是 `banner` 是**有意的**：`banner` 落在整个包装函数
         * **外面**（也就是 `"use strict"` 之前），那会让整份产物退化成非严格模式 ——
         * 而严格模式本身是我们的判据之一（`env/assign.ts` 里「只读属性赋值必抛」的探测
         * 就靠它，`nativeDom` 的判断建立在它之上）。`intro` 落在 `"use strict"` 之后，
         * 既在产物自己的作用域里、又不动严格模式。
         *
         * ⚠️ `intro` 对**每个 chunk** 都生效，所以 boot.js 和 game.js 顶部各有一份。
         * 重复执行是安全的（里面的 `globalThis.X || (globalThis.X = …)` 幂等），
         * 而且 game.js 那份正好让业务代码的裸标识符也能解析到 env 装好的那些对象。
         */
        intro: PRELUDE
      }
    }
  }
}));
