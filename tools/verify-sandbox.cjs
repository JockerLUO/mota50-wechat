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
 *   curated  白名单沙箱：只有白名单里的键「存在」，裸标识符 `Intl` / `navigator`
 *            缺失，且 `globalThis` 是个**写入被丢弃**的影子对象 —— 垫片**装不进去**。
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
const BUNDLE = path.join(ROOT, 'dist-minigame', 'game.js');

if (!fs.existsSync(BUNDLE)) {
  console.error(`找不到 ${BUNDLE}，请先运行 npm run build:minigame`);
  process.exit(2);
}

const code = fs.readFileSync(BUNDLE, 'utf8');

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

  // 影子全局：白名单里的键读得到，**写一律丢弃**（这就是「垫片装不进去」）
  const gTarget = { ...BASE };
  const g = new Proxy(gTarget, {
    has: (t, k) => Reflect.has(t, k),
    get: (t, k) => (Reflect.has(t, k) ? Reflect.get(t, k) : undefined),
    set: () => true,
    defineProperty: () => true,
    deleteProperty: () => true,
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

/** 加载产物，返回 { error, name, message }。不抛异常，把结果交回调用方判定。 */
function load(host) {
  try {
    host.run(code, 'game.js');
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
  const { error, name, message } = load(host);
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
  const { name, message } = load(host);
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
  const { name, message } = load(host);
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

// ── 判据 4：反证 —— 摘掉词法垫片，判据 3 必须变红 ────────────────────
//
// 「不抛错」有可能因为宿主模型没牙齿而空转成假绿，所以人工把垫片里对应那一行删掉、
// 在**同一个宿主**里再跑一次：必须重新抛出 `Intl is not defined` / `navigator is not defined`。
// 这一条同时证明了两件事：① 判据 3 确实在测垫片；② 这条路（缺全局且装不上的宿主）
// 是真实可达的 —— 不是想象出来的场景，这两次报错都是这么来的。
for (const [key, re] of [
  ['Intl', /^\s*var Intl = /],
  ['navigator', /^\s*var navigator = /]
]) {
  const lines = code.split('\n');
  const idx = lines.findIndex((l) => re.test(l));
  if (idx < 0) {
    check(`反证：产物里存在 ${key} 的词法垫片`, false, `找不到 \`var ${key} = ...\``);
    continue;
  }
  const stripped = lines.filter((_, i) => i !== idx).join('\n');
  const host = curatedHost();
  host.prepare();
  let err = null;
  try {
    host.run(stripped, `game-no-${key}.js`);
  } catch (e) {
    err = e;
  }
  const message = err ? String(err.message) : '';
  const expect = new RegExp(`\\b${key} is not defined`);
  check(
    `反证：摘掉 ${key} 垫片后，同一宿主必须炸出 ${key} is not defined`,
    expect.test(message),
    err ? `${err.name}: ${message.slice(0, 90)}` : `摘掉 ${key} 垫片后居然没抛错 —— 判据 3 是空转的`
  );
}

// ── 判据 5：词法垫片不能把宿主的 Intl 顶掉 ──────────────────────────
//
// `var Intl = ...` 必须落在 IIFE 包装**内部**（那样才是词法绑定）。一旦落到文件
// 顶层，它就变成全局属性，会把宿主真正的 Intl **换掉** —— 那是拿「修好黑屏」
// 换「污染宿主」，在浏览器宿主上尤其不可接受。
{
  const host = plainHost();
  const before = host.evalIn('[Intl, typeof Intl.Segmenter]');
  load(host);
  const after = host.evalIn('Intl');
  const same = after === before[0];
  check(
    '宿主原有的 Intl 未被覆盖（垫片是词法绑定而非全局赋值）',
    same,
    same ? `仍是宿主原来那个对象（Segmenter 类型 ${before[1]}）` : '宿主的 Intl 被顶掉了'
  );
}

// ── 判据 6：垫片位置 —— 在包装内、且早于第一处 Intl 读取 ────────────
//
// 这是**结构绊线**，不是原理判据（真正说话的是 3/4/5）。它拦的是「位置被构建配置
// 改坏」这类事故：intro 一旦掉出包装函数或挪到模块代码之后，上面几条的结论就不再
// 成立，而这个脚本会把话先说明白。
{
  const lines = code.split('\n');
  const introIdx = lines.findIndex((l) => /^\s*var Intl = /.test(l));
  const firstRead = lines.findIndex((l) => l.includes('Intl == null'));
  const introLine = introIdx >= 0 ? lines[introIdx] : '';
  const indented = /^\s/.test(introLine);
  check(
    '垫片位置：在 IIFE 包装内，且早于第一处 Intl 读取',
    introIdx >= 0 && indented && firstRead > introIdx,
    introIdx < 0
      ? '找不到垫片'
      : `垫片第 ${introIdx + 1} 行（${indented ? '有缩进=在包装内' : '顶格=在包装外！'}），` +
        `第一处读取第 ${firstRead + 1} 行`
  );
}

// ── 报告 ────────────────────────────────────────────────────────────
console.log(`\n产物：${path.relative(ROOT, BUNDLE)}（${code.split('\n').length} 行）`);
const build = (code.match(/const BUILD = "([^"]+)"/) || [])[1];
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
