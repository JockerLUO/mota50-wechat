/**
 * 往宿主全局对象上**装键**，以及「这个键装得上吗」的探测。
 *
 * 拆出来的理由：这三件事被三处共用，而它们之间没有从属关系 ——
 * `navigator.ts`（合成 UA）、`document.ts`（装 document）、`canvas.ts`（读 `nativeDom`）。
 * 单独放一层之后，`env/` 里其余模块的 import 箭头才是单向的（见 `index.ts` 的层次图）。
 */
import { g } from './state';

/**
 * 某个全局键能不能被覆盖。做法是**试赋值**：只读属性在严格模式下赋值会抛，
 * 可写属性则悄无声息 —— 而且赋的是它自己，没有任何副作用。
 *
 * 兜底的 `defineProperty` 只给 `value`，不碰其它特性 ——
 * 按规范这叫「原样重设」，不会把原本 `configurable:false` 的键打开后门。
 */
export function canOverride(key: string): boolean {
  try {
    g[key] = g[key];
    return true;
  } catch {
    /* 严格模式下只读属性赋值必抛 */
  }
  try {
    Object.defineProperty(g, key, { value: g[key] });
    return true;
  } catch {
    return false;
  }
}

/**
 * 宿主是不是**已经有原生 DOM**（微信开发者工具的模拟器 / 浏览器）。
 *
 * 这个判据决定了垫片该「装」还是该**让路**。本项目的产物要面对四种宿主：
 *
 * | 宿主 | `document` | 事件从哪来 | 谁派发 |
 * |---|---|---|---|
 * | Node / vm（离线校验的降级模式） | 无 | 垫片 | 触摸桥 |
 * | Web Worker（`verify:minigame` 用的） | 无 | 垫片 | 触摸桥 |
 * | **真机小游戏** | 无 | 垫片 | 触摸桥 |
 * | **IDE 模拟器 / 浏览器** | **有** | **原生** | **宿主自己** |
 *
 * 前三者的差异只是「谁在跑 JS」，垫片行为一致，所以一直没暴露问题；
 * 第四种被漏掉了 —— 而它恰恰最容易被当成基准（"IDE 里跑通了，真机应该也行"）。
 *
 * ## 第四种宿主有两个必须区别对待的事实
 *
 * **① 硬覆盖会抛，而且一抛就黑屏。**
 * `document` / `navigator` 在 `window` 上是 `[LegacyUnforgeable]` 的**只读**自有属性。
 * 产物 IIFE 顶部有 `"use strict"`，于是 `g.document = doc` 直接抛：
 *   `TypeError: Cannot set property document of #<Window> which has only a getter`
 * 更要命的是 `installNavigator()` 排在 `installGlobals()` 第一位 —— 它先抛，
 * 后面的 `document`/`MouseEvent`/rAF 兜底、以及紧随 `installGlobals()` 的
 * `reserveDisplayCanvas()` **全都不会执行**。没有上屏画布，表现就是**纯黑屏**，
 * 而窗口里一条报错都没有（异常进了 IDE 的控制台，那个控制台不落盘）。
 * 实测复现：真 Chromium + wx 桩 → `pageerror: Cannot set property navigator of
 * #<Window> which has only a getter`，`GameGlobal.mota` 始终没有出现。
 *
 * **② 原生 DOM 比垫片完整，硬装上去反而更糟。**
 * 就算侥幸装上了，`document.addEventListener` 会收进我们的 `documentBus`，
 * 而原生事件永远不会派发到那里 —— 结果是「画面有了但点不动」。
 * 让 pixi 走浏览器分支才是正确的。
 *
 * 判据取 `document`：前三者里它根本不存在，第四种里它是只读属性，两头都不会误判。
 */
export const nativeDom: boolean = typeof g.document !== 'undefined' && !canOverride('document');

/**
 * 装一个全局，装不上就认怂。
 *
 * 存在的意义是**隔离**：任何一个键覆盖失败都不能连坐后面的键。
 * 这条约束是实测逼出来的 —— `navigator` 一抛，它后面的全部失效。
 */
export function safeAssign(key: string, value: unknown): boolean {
  try {
    g[key] = value;
    return true;
  } catch {
    /* 落到 defineProperty */
  }
  try {
    Object.defineProperty(g, key, { value, configurable: true, writable: true });
    return true;
  } catch {
    console.warn(`[minigame] 无法安装全局 ${key}（宿主已有不可覆盖的实现，改用宿主原生的）`);
    return false;
  }
}
