/**
 * `Intl` 与 `navigator` 两个全局的补齐。
 *
 * 放在一起的理由：它们撞的是**同一个坑**（Pixi 在**模块求值期**裸读一个不存在的全局），
 * 修复思路也是同一条（`safeAssign` 到 `globalThis`）。缺哪个都是整包起不来，
 * 而失败形态一模一样（黑屏 + 一行 `X is not defined`），所以合成一个文件读起来最快。
 */
import { safeAssign } from './assign';
import { g, type Any } from './state';
import { readSystemInfo } from './system';

/**
 * `Intl` —— 微信小游戏里**根本不存在**，而 Pixi 会在**模块求值期**读它。
 *
 * ## 为什么“不存在的全局”也能把整个包炸掉
 *
 * Pixi 源码写的是 `typeof Intl?.Segmenter === 'function'`，本意是「有 Intl 且有
 * Segmenter」。在浏览器/Node 里 `Intl` 必然存在，所以这句一直很安全。
 *
 * 但 esbuild 降到 es2015 时把 `Intl?.Segmenter` 改写成
 * `Intl == null ? void 0 : Intl.Segmenter` —— **`typeof` 那层保护被绕掉了**，
 * `Intl` 退回成**裸标识符**。裸标识符不存在时 `Intl == null` 直接抛
 * `ReferenceError: Intl is not defined`（而 `typeof Intl` 本身是不会抛的），
 * 于是「探测一个可选全局」变成了「假设它必然存在」。
 *
 * 这段代码位于 `CanvasTextMetrics` 的**静态字段初始化器**里，属于模块求值期 ——
 * 一抛就整个包起不来，表现为模拟器里 `ReferenceError: Intl is not defined`
 * 加一块黑屏。
 *
 * ## 垫什么：一个空对象，故意不实现 Segmenter
 *
 * 空对象能让 `typeof Intl.Segmenter === 'function'` 为假，Pixi 于是走它自带的
 * `[...s]` 兜底（按码点分段）。对中文/ASCII 而言这与 `Intl.Segmenter` 的
 * grapheme 结果一致；自己写一个 Segmenter 只会凭空多出一个没人测过的排版分支。
 * 所以垫它的唯一目的是**给裸标识符一个落脚点**，不是为了提供 Intl 功能。
 *
 * 顺带一提：`Intl` 缺失只是「小游戏比浏览器少了一堆全局」里最先撞上的一个，
 * 所以 `verify:minigame` / `verify:dom` 两个宿主都会**主动删掉 Intl** 再跑，
 * 免得这条路径又变成「只有在 IDE 里才能发现」。
 *
 * ## ⚠️ 真正兜住这一条的是**构建期**的词法垫片，不是这里
 *
 * 这里的 `safeAssign` 依赖「宿主全局对象允许扩展」。微信开发者工具有一条
 * 白名单沙箱路径不满足这个前提：垫片写进去了（`safeAssign` 返回 true），
 * 裸标识符却照样 `ReferenceError` —— 因为沙箱里的 `globalThis` 不是作用域链
 * 末端那个对象。实测证据与完整推理见 `vite.minigame.config.ts` 的 `PRELUDE`。
 *
 * 所以现在的分工是：
 *   - **词法垫片**（构建期 `var Intl = ...`，跑在所有模块之前）—— 保命。不依赖宿主配合。
 *   - **这里**（垫到 `globalThis` 上）—— 让**运行期**读 `Intl` 的代码也有个落脚点，
 *     并且是「宿主真缺这个全局」时唯一能对宿主本身产生效果的动作。
 *
 * 两者不冲突：词法绑定只在产物内部生效，宿主那份该怎么补还怎么补。
 */
export function installIntl(): void {
  if (typeof g.Intl !== 'undefined') return;
  // 宿主本来就没有，`safeAssign` 这里不可能失败；失败也只是少了个垫片，
  // 由上面的 esbuild 降级分析可知后果很严重，所以留一条日志便于定位。
  if (!safeAssign('Intl', {})) {
    console.warn('[minigame] 无法安装 Intl 垫片：Pixi 的 CanvasTextMetrics 会在求值期抛 ReferenceError');
  }
}

/**
 * 补 `navigator`。
 *
 * ## 这不是「以防万一」，是硬要求
 *
 * Pixi 8.21 在**模块求值期**就会调 `DOMAdapter.get().getNavigator()`：
 *   `lib/rendering/renderers/gl/texture/utils/uploaders/glUploadImageResource.mjs`
 *   → `const defaultForceAllocation = isSafari();`（**模块级常量**，不在函数体内）
 *
 * 而那一刻 `DOMAdapter` 还是默认的 `BrowserAdapter`（`getNavigator: () => navigator`）——
 * 我们的 `DOMAdapter.set()` 根本还没轮到执行，因为 ESM 的求值顺序决定了
 * **任何 import pixi 的模块都排在 pixi 之后**。于是整包在加载阶段直接抛：
 *   TypeError: Cannot destructure property 'userAgent' of
 *   'DOMAdapter.get(...).getNavigator(...)' as it is undefined
 * 表现就是**白屏，且没有任何业务代码参与**。
 *
 * 这条是实测撞出来的，不是推导出来的：宿主删掉 `navigator` 后，
 * 产物连第一行业务代码都没跑到就死了。
 *
 * ## `gpu: null` 也是有意写的
 *
 * `isWebGPUSupported()` 读的就是 `navigator.gpu`；给 `null` 才会干脆利落地返回 false。
 * 小游戏侧没有 WebGPU，留一个真值的 gpu 只会让它去尝试 requestAdapter 然后失败。
 *
 * 平台若自带 `navigator.userAgent`（真机可能有），保留它，只补齐缺的字段 ——
 * 那会让 `isSafari()` / `isMobile()` 的判断更贴近真实机型。
 */
export function installNavigator(): void {
  // ⚠️ 这里**不能**因为 `nativeDom` 就 return —— 上一版正是这么写的，于是 IDE 里炸了。
  //
  // ## 为什么「有原生 DOM 就让路」在 navigator 上是错的
  //
  // Pixi 的**默认**适配器（BrowserAdapter）在**模块顶层**就会读一次裸 `navigator`：
  //
  //     const defaultForceAllocation = isSafari();         // game.js 模块顶层常量初始化
  //       → DOMAdapter.get().getNavigator().userAgent
  //     getNavigator: () => navigator                      // BrowserAdapter：裸标识符
  //
  // 这一行发生在「我们把 DOMAdapter 换成小游戏实现」**之前**（`DOMAdapter.set`
  // 在 `pixi-adapter.ts` 里执行），所以那一刻读到的还是 BrowserAdapter。
  // IDE 模拟器里 `navigator` 的值是 undefined，于是当场抛：
  //   Cannot destructure property 'userAgent' of 'DOMAdapter.get(...).getNavigator(...)'
  //   as it is undefined
  // 整个包死在模块求值期（IDE 取回的探针记录里，时间线**只到 module**）。
  //
  // ## 正确的规则：**按项判断可用性**，而不是「有原生 DOM 就整体让路」
  //
  //   宿主已有且**可用**      → 让路。真浏览器里 navigator 是只读的 unforgeable 属性，
  //                            硬覆盖必抛；而且它的真 UA 比我们编的准。
  //   宿主没有 / **不可用**   → 必须补上。IDE 模拟器正是这一种：#document 有、
  //                            navigator 却是 undefined —— 上一版只看了 document
  //                            就断定「原生环境完备」，把 navigator 一起放掉了。
  //
  // 判据取「有没有可用的 userAgent」而不是「在不在」：IDE 里它“在”但值是
  // undefined，用 `in` 或 `!== undefined` 判都看不出来。
  const existing = g.navigator as Any;
  const hasUA = !!existing && typeof existing.userAgent === 'string' && existing.userAgent.length > 0;
  if (hasUA) return;

  let synthesized = 'WeChatMiniGame';
  let platform = '';
  const info = readSystemInfo();
  if (Object.keys(info).length) {
    platform = String(info.platform ?? '');
    synthesized = `Mozilla/5.0 (${info.system ?? 'unknown'}) WeChatMiniGame/${info.version ?? '?'} MicroMessenger`;
  }
  const fields = {
    userAgent: synthesized,
    platform: existing?.platform ?? platform,
    maxTouchPoints: existing?.maxTouchPoints ?? 1,
    gpu: null
  };

  // ⚠️ **就地补字段**，不要整对象替换 —— 这一条是实测逼出来的。
  //
  // 产物最外层有一条**词法垫片** `var navigator = ...`（见 `vite.minigame.config.ts`
  // 的 `PRELUDE`），它给裸标识符 `navigator` 兜底 —— 而 pixi 的默认适配器读的正是
  // 裸标识符（`getNavigator: () => navigator`）。垫片里的那份对象如果被这里**替换**掉，
  // 词法绑定仍然指向**旧对象**，pixi 就永远看不到这里合成的 UA：
  // 真机上有 `wx.getSystemInfoSync()` 却等于没用上，白干。
  //
  // 所以约定是「一个对象、两处引用」：垫片负责建（宿主没有时）、并挂到 `globalThis`
  // 上；这里只往上补字段。`Object.assign` 对同一个对象的两个引用都生效。
  if (existing && typeof existing === 'object') {
    try {
      Object.assign(existing, fields);
      return;
    } catch {
      // 宿主对象可能是只读的（浏览器里 `navigator` 就是）：那种情况下就地补字段会抛，
      // 而这里一抛就会连坐 `installGlobals()` 后面的所有步骤（第三轮黑屏就是这么来的）。
      // 所以退回到「装一份新的」，让 `safeAssign` 自己去认怂。
    }
  }
  safeAssign('navigator', fields);
}
