/**
 * 禁 unsafe-eval —— 两个宿主（无 DOM 的 Worker / 有 DOM 的页面）**共用同一份实现**。
 *
 * ## 为什么要禁
 *
 * 微信开发者工具跑小游戏时的子上下文是 CSP 禁 eval 的。实测（2026-09-21 第四轮，
 * IDE 落盘的 storage 记录）:垫好 `Intl` / `navigator` 之后时间线一路走到 `probe`，
 * 然后死在 `Game.create()` 里：
 *
 *   Error: Current environment does not allow unsafe-eval,
 *          please use pixi.js/unsafe-eval module to enable support.
 *
 * 同一条记录的 `bare: { Intl: "no-new-function" }` 正是互证 —— 那个环境里
 * **`new Function` 本身就抛**（CSP 禁 eval），而不是「`Function` 这个全局不存在」。
 *
 * ## 为什么必须在这一层测，而不是在浏览器里「顺便」跑一遍
 *
 * 浏览器（包括 playwright 起的 chromium）默认**允许** eval，于是
 * Pixi 的 `unsafeEvalSupported()` 返回 true —— 也就是说在允许 eval 的宿主里，
 * 缺 `pixi.js/unsafe-eval` 这个 bug **永远不会暴露**，测试是绿的但什么都没测到。
 * 把禁令显式装上，才让「无 DOM 宿主」和「有 DOM 宿主」两边都真的覆盖这条路径。
 *
 * ## 为什么不能改用「在产物里搜 `new Function`」当判据
 *
 * 原实现是**死代码**：`GlUniformGroupSystem._generateUniformsSync` 等仍被类方法引用，
 * `pixi.js/unsafe-eval` 只是在**原型**上把它们覆盖掉，Rollup tree-shake 不掉。
 * 所以产物里必然还能搜到 `new Function` —— 「搜不到」根本不成立。
 * 唯一有效的证法是**行为判据**：让它执行期抛 EvalError，看游戏还起不起得来。
 *
 * ## 装法必须照 CSP 的样子
 *
 * 真实的 CSP 禁 eval 时：`Function` 全局**还在**、`typeof Function === 'function'`、
 * 原型链不动，只有 `new Function(...)` 抛 EvalError。
 * 所以这里只换 `globalThis.Function` 这一个绑定，并把 `prototype` 指回真实原型，
 * 保证 `x instanceof Function`、`fn.constructor` 这些语义不被顺手弄坏 ——
 * 否则「禁 eval」就变成了「Function 坏了」，测的就不是同一件事了。
 *
 * 装上后可以在任意宿主里用 `globalThis.__unsafeEvalBan` 自查，见下面三个方法。
 */
(function () {
  'use strict';
  const g = globalThis;
  const RealFunction = Function;

  const blockedFunction = function () {
    throw new EvalError(
      'unsafe-eval is disallowed in this environment（pixi.js/unsafe-eval 应当已经接管）'
    );
  };
  // 原型身份保持不变：`instanceof` / `constructor` 仍指向真实构造器。
  blockedFunction.prototype = RealFunction.prototype;
  g.Function = blockedFunction;

  g.__unsafeEvalBan = {
    blockedFunction,
    RealFunction,

    /** 禁令真的生效了吗 —— 必须探 `g.Function`（产物里那句裸 `Function` 就解析到它）。 */
    armed() {
      try {
        // eslint-disable-next-line no-new-func
        new g.Function('return 1');
        return false;
      } catch (err) {
        return err instanceof EvalError;
      }
    },

    /** 真实构造器还完好 —— 用来证明「禁的是动态构造这条路，不是把 Function 弄坏」。 */
    realCtorIntact() {
      try {
        // eslint-disable-next-line no-new-func
        return new RealFunction('return true')() === true;
      } catch {
        return false;
      }
    },

    /** 启动之后禁令还在吗 —— 若产物把 `Function` 换回去，「启动成功」就不算数。 */
    stillInstalled() {
      return g.Function === blockedFunction;
    }
  };
})();
