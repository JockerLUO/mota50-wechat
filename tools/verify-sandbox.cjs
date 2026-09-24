/**
 * 产物「宿主不配合」实测 —— 在真 V8 里把 game.js 用三种方式加载一遍，看它自己撑不撑得住。
 *
 * ## 这个脚本补的是哪一类盲区
 *
 * `verify:minigame`（Worker 宿主）与 `verify:dom`（Chromium 宿主）都在**真浏览器**
 * 里跑产物，而浏览器是最宽容的宿主：`Intl` 必然存在、`globalThis` 上的键想加就加、
 * 而且**总是把脚本包一层**再执行。于是有两类故障它们是**结构性抓不到**的：
 *
 *   1. **宿主少一个全局**（`Intl`）。真机小游戏与微信开发者工具的白名单沙箱都少。
 *      实测踩到两次：`Intl is not defined` 把整包炸在 pixi 的模块求值期，
 *      而那条报错只出现在 IDE 控制台里、不落盘。
 *   2. **产物自身的作用域被构建工具弄坏**。实测一次：`output.intro` 写成多行 IIFE 后，
 *      Rollup 的 iife 包装与它错位，esbuild 给 `?.` 降级生成的临时变量
 *      `var _a, _c, _k, _l;` 掉进了另一个函数作用域，产物在
 *      `hasPerformance: !!((_a = g$2.performance) == null ? void 0 : _a.now)`
 *      抛 `ReferenceError: _a is not defined`。
 *
 * 第 2 条尤其阴 —— **它在 IDE 里不会暴露**：IDE 把自己的模块和我们的 game.js 跑在
 * 同一个 realm，而它自己那堆压缩代码里就有一个全局 `var _a`，我们的裸 `_a` 被
 * **别人的变量**接住了。真机上没有这个巧合，直接黑屏。也就是说「IDE 里能跑」
 * 在这里是**无效证据**，判据必须落在「产物在干净、可复现的宿主里跑成什么样」。
 *
 * ## 两个宿主模型的区别（都在 `node:vm` 里，秒级）
 *
 *   plain    普通沙箱：realm 自带全部内置对象、全局对象可扩展。
 *            它代表**真机小游戏**：少了 `Intl`，但垫片装得进去 —— 于是
 *            `env.ts` 的 `safeAssign('Intl', {})` 就够用。
 *
 *   curated  白名单沙箱：只有白名单里的键「存在」于**作用域链**上，裸标识符 `Intl` /
 *            `navigator` / `document` 缺失；`globalThis` 是个**影子对象** ——
 *            写进去能读回来，但**裸标识符不走它**，所以垫片「装了却看不见」。
 *            它代表微信开发者工具那条白名单路径：`globalThis.Intl = {}` 写了个寂寞，
 *            裸标识符照样 `ReferenceError`。**只有构建期词法垫片能救这一种**。
 *            （实测证据：IDE 里 `Intl` 缺失，但同一次运行的 DOM 上下文报
 *            `Intl: "object"` —— 两个上下文对同一个全局给出不同答案，正是白名单的形态。）
 *
 * 用法：npm run verify:sandbox
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist-minigame');
const ENTRY = 'game.js';

if (!fs.existsSync(path.join(DIST, ENTRY))) {
  console.error(`找不到 ${path.join(DIST, ENTRY)}，请先运行 npm run build:minigame`);
  process.exit(2);
}

/**
 * 包内全部 js 的源码。key 形如 `/game.js`。
 *
 * 产物已经不是单文件了：`game.js` 是 CJS 入口，开头就 `require("./boot.js")`。
 * 所以这里不是在「跑一段代码」，而是在**按 CommonJS 规则装载一个模块图** ——
 * 见下面的 `loadEntry`。
 *
 * 文件名不写死（枚举目录）：换 chunk 划分时这个脚本不用改，
 * 而「包里到底有哪几个 js」本身也由 `game.js` 的 require 关系决定。
 */
const SOURCES = {};
for (const f of fs.readdirSync(DIST).filter((x) => x.endsWith('.js')).sort()) {
  SOURCES[`/${f}`] = fs.readFileSync(path.join(DIST, f), 'utf8');
}

/** 我们自己那句「没有 wx」的报错 —— 模块图跑完、进到适配层时必然撞上它。 */
const NO_WX = '未找到全局 wx';

const checks = [];
const info = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

const BASE = { console, setTimeout, clearTimeout, setInterval, clearInterval };

/** 普通沙箱：realm 自带内置对象，全局可扩展。`dropIntl` 时把 Intl 真删掉。 */
function plainHost({ dropIntl = false } = {}) {
  const ctx = vm.createContext({ ...BASE });
  if (dropIntl) vm.runInContext('delete globalThis.Intl', ctx);
  return {
    ctx,
    run: (src, filename) => vm.runInContext(src, ctx, { filename }),
    evalIn: (src) => vm.runInContext(src, ctx)
  };
}

/**
 * 白名单沙箱（`with` + 两个 Proxy）。
 *
 * 为什么不直接把沙箱对象做成 Proxy：那样裸标识符 `Intl` 会解析成 `undefined`
 * 而**不抛 ReferenceError**，路径就跟真机对不上了（实测过）。这里要的是
 * 「标识符**不在作用域链上**」，所以走 `with(proxy)`：`has` 为假 → 穿透到外层
 * realm，而外层 realm 的 `Intl` 已经**真删掉**了 → 才会抛那句话。
 */
function curatedHost() {
  const ctx = vm.createContext({ ...BASE });
  // 外层 realm 也要删：`with` 命中不了就穿透到这里
  vm.runInContext('delete globalThis.Intl; delete globalThis.navigator', ctx);

  // 影子全局：白名单里的键读得到；**写进去能读回来，但不影响裸标识符**。
  //
  // ⚠️ 「写能不能读回来」这一条是**实测定的**，不是猜的：
  // IDE 里探针报 `navigator: {present:true, hasUA:true}` —— 而带 UA 的那个对象
  // 只可能是 `env.ts` 用 `wx.getSystemInfoSync()` 合成后写进 `globalThis.navigator` 的
  // （预置垫片的兜底版是空 UA）。既然它读得回来，说明这个宿主的写**是落到影子对象上的**，
  // 只是**裸标识符不走影子对象**而已。
  //
  // 第一版这里是「写一律丢弃」（最严格的形态），结果比真机还严：
  // 会让「`globalThis.X = v` 之后回读 `globalThis.X`」这条真实可用的路径也被判死。
  const gTarget = { ...BASE };
  const g = new Proxy(gTarget, {
    has: (t, k) => Reflect.has(t, k),
    get: (t, k) => (Reflect.has(t, k) ? Reflect.get(t, k) : undefined),
    set: (t, k, v) => Reflect.set(t, k, v),
    defineProperty: (t, k, d) => Reflect.defineProperty(t, k, d),
    deleteProperty: (t, k) => Reflect.deleteProperty(t, k),
    getOwnPropertyDescriptor: (t, k) => Reflect.getOwnPropertyDescriptor(t, k)
  });

  const whitelist = { globalThis: g, ...BASE };
  const scope = new Proxy(
    {},
    {
      has: (t, k) => k in whitelist,
      get: (t, k) => (k in whitelist ? whitelist[k] : undefined),
      set: () => true,
      defineProperty: () => true,
      deleteProperty: () => true,
      getOwnPropertyDescriptor: (t, k) =>
        Reflect.getOwnPropertyDescriptor(t, k) ?? {
          value: whitelist[k],
          writable: true,
          enumerable: true,
          configurable: true
        }
    }
  );
  // 内层 realm 也删一遍（`with` 之外的 `vm.runInContext` 看到的是 realm 的真全局）
  vm.runInContext('delete globalThis.Intl; delete globalThis.navigator', ctx);

  return {
    ctx,
    run: (src, filename) =>
      vm.runInContext(`with (__scope) { ${src}\n}`, ctx, { filename: filename ? filename + '.with.js' : undefined }),
    evalIn: (src) => vm.runInContext(src, ctx),
    // 宿主自检用：把 with 作用域挂进 realm，方便外面直接调用
    prepare: () => {
      ctx.__scope = scope;
      return scope;
    }
  };
}

/**
 * 装载产物（CommonJS 模块图），返回 `{ error, name, message }`。不抛异常，把结果交回调用方判定。
 *
 * ## 为什么必须在这里自己实现 require
 *
 * 产物拆成了 `game.js` + `boot.js`，两个文件之间靠 `require('./boot.js')` 相连，
 * 而**宿主决定怎么执行这条 require**。真机上是基础库做的；三个本地宿主各做各的：
 * 两个浏览器宿主在 `tools/minigame-harness/cjs-loader.js` 里，这里在 node:vm 里。
 *
 * 三处的实现都是「把源码包进 `function (module, exports, require, …)` 再调用」——
 * 这不是巧合，而是 CommonJS 的定义本身（也正是小游戏官方「模块化」文档里
 * 「在 JavaScript 文件中声明的变量和函数只在该文件中有效」那句话的落地方式）。
 *
 * ## 为什么包装比「直接 run 两段源码」重要
 *
 * 直接 `vm.runInContext(boot)` 再 `run(game)` 会让两个文件的 `var` 落到**同一个作用域**：
 * 于是 `game.js` 里那份 PRELUDE（`var Intl`）会替 `boot.js` 里的垫片兜底，
 * 「摘掉 boot 的垫片必须炸」这条反证就再也测不出来了。包装之后每个文件作用域独立，
 * 判据才真的在测那个文件。
 *
 * ## 白名单宿主（`with`）下的一个关键性质
 *
 * `curatedHost.run` 会把源码包进 `with (__scope) { … }`。这里传进去的是
 * **一个函数表达式**，所以函数是在 `with` 作用域里**创建**的 ——
 * 它的 `[[Scope]]` 因此包含那个白名单作用域，函数体内的裸标识符解析照样走白名单。
 * 这一条是「白名单沙箱」模型能同时用在这条装载路径上的原因，
 * 不是顺手写出来的。
 *
 * @param {ReturnType<typeof plainHost>} host
 * @param {Record<string, string>} [overrides] 临时替换某些模块的源码（反证判据用）
 */
function loadEntry(host, overrides = {}) {
  const sources = { ...SOURCES, ...overrides };
  const cache = new Map();

  const dirOf = (url) => {
    const i = url.lastIndexOf('/');
    return i < 0 ? '' : url.slice(0, i);
  };
  const resolve = (spec, from) => {
    if (spec.charAt(0) !== '.') return spec;
    const base = dirOf(from).split('/');
    for (const part of spec.split('/')) {
      if (part === '.' || part === '') continue;
      if (part === '..') base.pop();
      else base.push(part);
    }
    return base.join('/');
  };

  function loadModule(url) {
    if (cache.has(url)) return cache.get(url).exports;
    const src = sources[url];
    if (typeof src !== 'string') {
      throw new Error(`包内没有 ${url}（源码表里只有 ${Object.keys(sources).join(', ')}）`);
    }
    const mod = { exports: {} };
    cache.set(url, mod);
    const factory = host.run(
      `(function (module, exports, require, __filename, __dirname) {\n${src}\n})`,
      url
    );
    factory(mod, mod.exports, (spec) => loadModule(resolve(spec, url)), url, dirOf(url));
    return mod.exports;
  }

  try {
    loadModule(`/${ENTRY}`);
    return { error: null, name: null, message: '' };
  } catch (err) {
    return { error: err, name: err && err.name ? err.name : 'Error', message: String(err && err.message) };
  }
}

/** 宿主自检：这个宿主真的会让裸标识符 `Intl` 抛 ReferenceError 吗？ */
function hostHasTeeth(host) {
  try {
    host.evalIn('with (__scope) { Intl }');
    return false;
  } catch (err) {
    return /Intl/.test(String(err && err.message)) && /is not defined/.test(String(err && err.message));
  }
}

// ── 判据 1：普通宿主里，模块图必须完整跑完 ──────────────────────────
//
// 「跑完」的标志是撞上我们自己那句「未找到全局 wx」：它位于 `pixi-adapter`
// 的模块顶层 —— 也就是 `beacon → env → pixi → adapter` 整条模块图都求值完了之后。
// 任何 `_a is not defined` / `SyntaxError` / 别的 `xxx is not defined` 都说明
// 产物**自己**有问题，与宿主无关。（这条就是 `output.intro` 错位那次的绊线。）
{
  const host = plainHost();
  const { error, name, message } = loadEntry(host);
  const ok = !!error && message.includes(NO_WX);
  check(
    '普通宿主（无 wx / 无 DOM）：模块图完整求值到适配层',
    ok,
    ok ? `按预期停在「${NO_WX}」` : `${name}: ${message || '没有抛错（异常情况）'}`
  );
  if (!ok && error) info.push(String(error.stack).split('\n').slice(0, 3).join(' | '));
}

// ── 判据 2：普通宿主但 Intl 被删 —— `env.ts` 的垫片应当够用 ──────────
{
  const host = plainHost({ dropIntl: true });
  const present = host.evalIn('typeof Intl');
  const { name, message } = loadEntry(host);
  const hitIntl = /Intl/.test(message) && /is not defined/.test(message);
  check(
    '普通宿主 + 缺 Intl：不因 Intl 倒下',
    present === 'undefined' && !hitIntl,
    present !== 'undefined'
      ? `宿主没删干净（typeof Intl = ${present}）`
      : hitIntl
        ? `${name}: ${message}`
        : `按预期（产物停在：${message.slice(0, 40)}…）`
  );
}

// ── 判据 3：白名单沙箱（垫片装不进去）—— 只有词法垫片能救 ────────────
//
// 这是 `Intl is not defined` 那次的**回归判据**。前提是这个宿主真的「有牙齿」
// （裸 Intl 会抛）—— 没牙齿的话这条判据就是空转，必须当场说明而不是给个假绿。
//
// `navigator` 也在同一条判据里：它和 Intl 是**同一个坑的第二例**（实测）——
// IDE 里 `globalThis.navigator` 有 UA、裸标识符 `navigator` 却是 undefined，
// pixi 的 `getNavigator: () => navigator` 读到 undefined，
// 在模块顶层 `isSafari()` 里当场炸。所以两个都要覆盖，缺一个就还是黑屏。
{
  const host = curatedHost();
  host.prepare();
  const teeth = hostHasTeeth(host);
  const { name, message } = loadEntry(host);
  // 只要不是死在「我们垫过的那两个全局」上就算过；后面还可能因别的全局缺失而倒，
  // 那是**另一条待办**（见报告末尾的「已知边界」），不该混进这条判据里。
  const hit = ['Intl', 'navigator'].filter((k) => new RegExp(`\\b${k} is not defined`).test(message));
  check(
    '白名单沙箱（缺 Intl/navigator + 写入被丢弃）：不因这两个全局倒下',
    teeth && hit.length === 0,
    !teeth
      ? '宿主模型没牙齿（裸 Intl 没抛 ReferenceError）—— 判据会空转，先修宿主'
      : hit.length
        ? `${name}: ${message}`
        : `按预期（产物停在：${message.slice(0, 40)}…）`
  );
  if (teeth && hit.length === 0 && !message.includes(NO_WX)) {
    info.push(`白名单沙箱里的已知边界：垫片装不上，产物停在「${message.slice(0, 70)}」`);
  }
}

// ── 判据 4：对照 —— 这个宿主里「属性路径有值、裸读死掉」确实会发生 ──────
//
// 上面判据 3 只说「产物没死在那两个全局上」。可它凭什么算数？得先证明这个宿主
// 真的会长出那个分叉。所以这里在一段**最小脚本**里复现一次：
// 往影子全局上装 `document`（属性路径），然后**裸读**它 —— 必须抛 ReferenceError。
//
// 这一段也是 `document` 那一例（`AccessibilitySystem._createTouchHook` 报
// `Cannot read properties of undefined (reading 'createElement')`）的最小复现：
// 当时 `hasDocument: true`（属性有值），裸 `document` 却是 undefined。
{
  const host = curatedHost();
  host.prepare();
  // ⚠️ 必须 `host.run`（会包一层 `with (__scope)`），不能用 `evalIn` ——
  // `evalIn` 跑在 realm 顶层，那里的 `globalThis` 是**真全局**，
  // 于是「属性路径」和「裸标识符」自动一致，这个宿主就没有分叉了（第一版就写错了这个）。
  // 另外必须**直接读** `document`：`typeof document` 对未声明的标识符返回 `'undefined'`
  // 而**不抛**，会把「根本没声明」这个最严重的情况掩盖成「不可用」。
  let outcome;
  try {
    host.run(
      `(function () {
         globalThis.document = { createElement: function () { return 1; } };
         var d = document;
         return 'ok:' + typeof d;
       })()`,
      'fork-probe.js'
    );
    outcome = '没抛错（宿主没分叉，判据无效）';
  } catch (err) {
    outcome = String(err && err.name);
  }
  check(
    '白名单沙箱里「属性路径有值、裸读死掉」确实会发生（证明这类判据不是想象出来的）',
    outcome === 'ReferenceError',
    `属性路径装好之后裸读 → ${outcome}`
  );
}

// ── 判据 5：裸标识符视图 —— 产物内部量出来的三态（第三例的回归判据）─────
//
// `env.ts` 的 `reportBareReachability()` 在**模块作用域**里直接读裸标识符
// （不写 `typeof X` —— 那样未声明也返回 `'undefined'`，会把最致命的
// `ReferenceError` 掩盖成「不可用」），结果挂在 `globalThis.__motaEnvBare`。
//
// 这是唯一量得到「pixi 到底拿到什么」的位置：pixi 是产物的一部分，
// 它读的就是产物自己的作用域链；从外面量只能量到宿主那一侧。
//
// 三态取值：类型名（可用）/ `'undefined'`（存在但没值）/ `'ReferenceError'`（根本没声明）。
// `Intl` / `navigator` / `document` 三个都必须**不是**后两种 ——
// 它们各自对应一次真实的黑屏，是这条判据的由来。
{
  const host = curatedHost();
  host.prepare();
  loadEntry(host);
  const map = host.evalIn('__scope.globalThis.__motaEnvBare');
  // 这份名单与 `vite.minigame.config.ts` 的 `PRELUDE` **必须一一对应**：
  // 每一个都是「pixi 会裸读、且那条裸读真的会执行」的全局，各自对应一次真实的
  // `xxx is not defined` 黑屏（见 `docs/wechat-minigame.md` §9）。
  const must = [
    'Intl',
    'navigator',
    'document',
    'performance',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'MouseEvent',
    // `URL`（2026-09-24 加）—— 它和前七个的**装的时机不同**：前七个是构建期
    // 词法垫片（`output.intro` 里的 `var X = …`），`URL` 是运行期 `env/url.ts`
    // 用 `safeAssign` 装到 `globalThis` 上的。但**判据要问的是同一件事**：
    // 「pixi 那条裸读路径通不通」。产物里它是裸 `new URL(...)`，而且真的会执行
    // （`autoDetectRenderer` 调链上的 `__vitePreload` 第三实参）——
    // 所以它必须在这份名单里，否则「白名单沙箱里裸标识符读不到」这个坑
    // （见 docs/wechat-minigame.md §9.3）会在 `URL` 上原样重演一次。
    'URL'
  ];
  const bad = !map
    ? must
    : must.filter((k) => {
        const v = map[k];
        return v === 'undefined' || v === 'ReferenceError' || v == null;
      });
  check(
    '白名单沙箱里八个词法垫片都真的接上了（在产物内部量的裸标识符视图）',
    !!(map && bad.length === 0),
    !map
      ? '拿不到 __motaEnvBare —— env.ts 的自查没跑起来'
      : bad.length
        ? `${bad.map((k) => `${k}=${map[k]}`).join(' ')}`
        : must.map((k) => `${k}=${map[k]}`).join(' ')
  );
  if (map) {
    // 完整清单很有用：它一次性列出「这个宿主还有哪些全局的裸路径是死的」，
    // 省掉「一轮报一个 xxx is not defined」的来回。
    const dead = Object.entries(map).filter(([, v]) => v === 'ReferenceError');
    const empty = Object.entries(map).filter(([, v]) => v === 'undefined');
    info.push(`裸标识符清单：可用 ${Object.keys(map).length - dead.length - empty.length} 项` +
      `，undefined ${empty.length} 项，ReferenceError ${dead.length} 项`);
    if (dead.length) info.push(`  ReferenceError（没声明）：${dead.map(([k]) => k).join(', ')}`);
    if (empty.length) info.push(`  undefined（存在但没值）：${empty.map(([k]) => k).join(', ')}`);
  }
}

// ── 判据 6：反证 —— 摘掉词法垫片，判据 3 必须变红 ────────────────────
//
// 「不抛错」有可能因为宿主模型没牙齿而空转成假绿，所以人工把垫片里对应那一行删掉、
// 在**同一个宿主**里再跑一次：必须重新抛出 `Intl is not defined` / `navigator is not defined`。
// 这一条同时证明了两件事：① 判据 3 确实在测垫片；② 这条路（缺全局且装不上的宿主）
// 是真实可达的 —— 不是想象出来的场景，这两次报错都是这么来的。
//
// ⚠️ 摘的是 **boot.js** 里那一行，不是入口里那一行。
// 拆包之后 PRELUDE 在每个 chunk 顶部各有一份（`output.intro` 的性质），
// 而 pixi 住在 boot.js 里 —— 只有摘 boot.js 那份，pixi 才会真的失去垫片。
// 这一条顺带把「每个模块作用域独立」这件事测实了：入口里那份**兜不住** boot.js，
// 因为它们是两个函数作用域。
const BOOT = '/boot.js';
for (const [key, re] of [
  ['Intl', /^\s*var Intl = /],
  ['navigator', /^\s*var navigator = /]
]) {
  const bootLines = (SOURCES[BOOT] || '').split('\n');
  const idx = bootLines.findIndex((l) => re.test(l));
  if (idx < 0) {
    check(`反证：boot.js 里存在 ${key} 的词法垫片`, false, `找不到 \`var ${key} = ...\``);
    continue;
  }
  const stripped = bootLines.filter((_, i) => i !== idx).join('\n');
  const host = curatedHost();
  host.prepare();
  const { name, message } = loadEntry(host, { [BOOT]: stripped });
  const expect = new RegExp(`\\b${key} is not defined`);
  check(
    `反证：摘掉 boot.js 的 ${key} 垫片后，同一宿主必须炸出 ${key} is not defined`,
    expect.test(message),
    message ? `${name}: ${message.slice(0, 90)}` : `摘掉 ${key} 垫片后居然没抛错 —— 判据 3 是空转的`
  );
}

// ── 判据 7：拆包边界（本轮「入口 + 库」拆分的结构性判据）──────────────
//
// 产物从单文件 IIFE 改成了 `game.js` + `boot.js` 两个 CJS 模块。
// 这次拆分有两条**必须成立**的性质，而它们都不是「看一眼就知道」的：
//
//   ① pixi 住在 boot.js 里 —— 否则「入口只有几百 KB、能直接读」这个目的没达到；
//   ② **boot.js 内部，垫片必须早于 pixi 的模块体** —— 这条是本项目花了好几轮
//      才修好的三个黑屏（Intl / navigator / document）的命门。
//      CJS 的求值顺序是「依赖先于自身」，一旦拆分边界切错（比如把 env 留在入口、
//      只把 pixi 拆出去），pixi 就会早于垫片求值，直接把这几个坑踩回去。
//
// 判据 ① 用「pixi 的内部函数名」判：`canUseNewCanvasBlendModes` 是 pixi 模块级的
// 缓存探测函数（`minify: false`，名字不会被改）。它在 boot.js 里、不在入口里。
//
// 判据 ② 用**行号**判：同一个文件里 `installGlobals()` 的调用必须早于
// `canUseNewCanvasBlendModes` 的定义。`installGlobals` 是 env 子树的安装入口，
// 它的调用行就是「垫片装好了」那一刻。
{
  const boot = SOURCES[BOOT] || '';
  const entry = SOURCES[`/${ENTRY}`] || '';
  const PIXI_MARK = 'canUseNewCanvasBlendModes';

  check(
    `拆包：包内是 ${ENTRY} + ${BOOT.replace('/', '')} 两个模块`,
    !!boot && !!entry,
    Object.keys(SOURCES).map((k) => k.replace('/', '')).join('、')
  );
  check(
    '拆包：pixi 在 boot.js 里，入口里没有（入口才是「能直接读」的那份）',
    boot.includes(PIXI_MARK) && !entry.includes(PIXI_MARK),
    entry.includes(PIXI_MARK) ? '入口里也有 pixi —— 拆分没生效' : `入口 ${(entry.length / 1024).toFixed(0)}KB / boot ${(boot.length / 1024).toFixed(0)}KB`
  );

  const lines = boot.split('\n');
  const shimCall = lines.findIndex((l) => /^\s*installGlobals\(\);/.test(l));
  const pixiBody = lines.findIndex((l) => l.includes(`function ${PIXI_MARK}(`));
  check(
    '拆包：boot.js 内部垫片先于 pixi 模块体（拆分边界没切错）',
    shimCall >= 0 && pixiBody > shimCall,
    shimCall < 0
      ? '找不到 installGlobals() 的调用 —— 垫片没装？'
      : `垫片第 ${shimCall + 1} 行，pixi 模块体第 ${pixiBody + 1} 行`
  );

  const reqLine = lines.findIndex((l) => /require\(["']\.\/boot\.js["']\)/.test(l));
  const entryReq = entry.split('\n').findIndex((l) => /require\(["']\.\/boot\.js["']\)/.test(l));
  check(
    '拆包：入口用 require("./boot.js") 连到 boot，路径带 .js 后缀',
    entryReq >= 0,
    entryReq >= 0 ? `入口第 ${entryReq + 1} 行` : `入口里找不到 require("./boot.js")（${reqLine}）`
  );
}

// ── 判据 8：词法垫片不能把宿主的 Intl 顶掉 ──────────────────────────
//
// `var Intl = ...` 必须是**词法绑定**而不是全局赋值 —— 一旦落到全局上，
// 它就会把宿主真正的 Intl **换掉**，那是拿「修好黑屏」换「污染宿主」，
// 在浏览器宿主上尤其不可接受。
//
// ⚠️ 这是一条**行为判据**，所以它在拆包之后**继续有效**：
// 产物从 IIFE 变成 CJS 之后，文件顶层就是模块作用域，原先那条
// 「看缩进判断有没有掉出包装」的结构判据不再成立（见判据 9 的说明），
// 而「宿主那个 Intl 对象还是不是原来那个」不受产物形态影响。
// 换句话说：这条判据替代了旧结构判据里**真正有意义的那一半**。
{
  const host = plainHost();
  const before = host.evalIn('[Intl, typeof Intl.Segmenter]');
  loadEntry(host);
  const after = host.evalIn('Intl');
  const same = after === before[0];
  check(
    '宿主原有的 Intl 未被覆盖（垫片是词法绑定而非全局赋值）',
    same,
    same ? `仍是宿主原来那个对象（Segmenter 类型 ${before[1]}）` : '宿主的 Intl 被顶掉了'
  );
}

// ── 判据 9：垫片位置 —— 在每个 chunk 的顶部，且早于第一处 Intl 读取 ────
//
// 这是**结构绊线**，不是原理判据（真正说话的是 3/4/5/6/8）。它拦的是「位置被构建配置
// 改坏」这类事故，而这个脚本会把话先说明白。
//
// ⚠️ 拆包之后这条判据的**表述变了，含义没变**。
// 原先写的是「在 IIFE 包装内」，靠**缩进**判断（顶格 ⇒ 掉到包装外 ⇒ 变成全局赋值）。
// 现在产物是 CJS，文件顶层**本身就是模块作用域**，缩进不再携带这个信息。于是拆成两半：
//   - 「垫片是词法绑定、不是全局赋值」 → 交给判据 8 的**行为判据**（更可靠）；
//   - 「垫片在该文件开头、没挪到模块代码之后」 → 留在本条，用行号判。
//
// 两个 chunk 各查一遍 —— PRELUDE 走的是 `output.intro`，对每个 chunk 都生效。
for (const [file, src] of Object.entries(SOURCES)) {
  const lines = src.split('\n');
  const introIdx = lines.findIndex((l) => /^\s*var Intl = /.test(l));
  // `Intl == null` 是 esbuild 把 `typeof Intl?.Segmenter` 降级之后的形态，出在 pixi 里。
  // ⚠️ 入口 chunk（game.js）**没有 pixi，因此没有这个读取点** —— `findIndex` 返回 -1。
  // 第一版把 -1 当成「读取点在垫片之前」判红，是**期望值写错了**（这条判据的适用范围
  // 只到「本文件里有读取点」这一层）。所以 -1 视作「本文件无读取点」，只查顶部位置。
  const firstRead = lines.findIndex((l) => l.includes('Intl == null'));
  const readOk = firstRead < 0 || firstRead > introIdx;
  // 「在前 150 行内」是个宽裕的上界：intro 紧跟 `"use strict"` 与 Rollup 的辅助函数，
  // 实测两个 chunk 分别落在 43 / 56 行。留余量是因为辅助函数个数会随语法降级需求变。
  check(
    `垫片位置：${file.replace('/', '')} 顶部就有${firstRead >= 0 ? '、且早于第一处 Intl 读取' : ''}`,
    introIdx >= 0 && introIdx < 150 && readOk,
    introIdx < 0
      ? '找不到垫片'
      : `垫片第 ${introIdx + 1} 行` +
        (firstRead >= 0 ? `，第一处读取第 ${firstRead + 1} 行` : '（本文件里没有 pixi，故无读取点）') +
        (introIdx >= 150 ? '（挪到模块代码之后了！）' : '')
  );
}

// ── 报告 ────────────────────────────────────────────────────────────
const files = Object.keys(SOURCES);
console.log(
  `\n产物：${path.relative(ROOT, DIST)}/（${files.length} 个 js）` +
    files.map((f) => `\n        ${f.replace('/', '')}  ${SOURCES[f].split('\n').length} 行`).join('')
);
const build = (Object.values(SOURCES).join('\n').match(/const BUILD = "([^"]+)"/) || [])[1];
console.log(`构建号：${build || '（这是非取证构建）'}\n`);

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? '  ✅' : '  ❌'} ${c.name}\n      ${c.detail}`);
}
if (info.length) {
  console.log('\n  补充信息：');
  for (const l of info) console.log('    ' + l);
}
console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条不通过`}（共 ${checks.length} 条）\n`);
process.exit(failed === 0 ? 0 : 1);
