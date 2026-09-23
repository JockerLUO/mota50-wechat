/**
 * `MouseEvent` 的替身。
 *
 * 为什么造 `MouseEvent` 而不造 `PointerEvent`：
 *
 * Pixi 的 `EventSystem` 在初始化时按两个全局特征选分支：
 *   supportsPointerEvents = !!globalThis.PointerEvent
 *   supportsTouchEvents   = 'ontouchstart' in globalThis
 *
 * 选了 pointer 分支，就同时要求 `PointerEvent` 构造器和
 * `globalThis.document.dispatchEvent`（`EventTicker` 每 50ms 会派发一个合成的
 * pointermove），要补的面更大；touch 分支则要求 `TouchEvent`，
 * 且 `_normalizeToPointerData` 里有一堆 `changedTouches` 的字段补全逻辑。
 *
 * **鼠标分支要求的全局最少**，而且 —— 关键 —— 它就是本项目网页端每天在跑、
 * 已经过自动化验证的那条路径。小游戏端刻意复用同一条路径，
 * 就不存在「两个平台走两套 Pixi 内部逻辑」的隐性分叉。
 *
 * 因此这里只造 `MouseEvent`，并故意**不**设置 `pointerType`，
 * 让它落到 Pixi 的默认值 `'mouse'`。
 */
import { envState, g, type Any } from './state';

/**
 * 合成事件必须带上 `target` —— 这一条**不是可选的**，它决定了点击能不能变成 tap。
 *
 * Pixi `EventSystem._onPointerUp` 里：
 *     let target = nativeEvent.target;
 *     if (nativeEvent.composedPath && nativeEvent.composedPath().length > 0) {
 *       target = nativeEvent.composedPath()[0];
 *     }
 *     const outside = target !== this.domElement ? "outside" : "";
 *     event.type += outside;          // ← 'pointerup' 变成 'pointerupoutside'
 *
 * 而 `EventBoundary` 只在 **`pointerup`** 上生成 `pointertap`。
 * 换句话说：`target` 为空 → 事件被改名成 `pointerupoutside` → 所有
 * `on('pointertap')` 的按钮和棋盘格子**全部失效**。
 *
 * 这个坑的性质值得记住 —— 它是**静默的**：
 * 事件确实送到了、`pointerdown`/`pointermove` 都正常触发（悬停高亮照常变），
 * 只有「点击」这一件事不生效。所以只看「有没有事件进去」是查不出来的。
 * 实测中它就伪装成了「目标格不可走」。
 */
export class MiniMouseEvent {
  type: string;
  clientX: number;
  clientY: number;
  pageX = 0;
  pageY = 0;
  button: number;
  buttons: number;
  isTrusted = false;
  isNormalized = false;
  srcElement: Any = null;
  target: Any = null;
  currentTarget: Any = null;
  timeStamp: number;
  // ── 下面这些是「真 PointerEvent 有、我们的替身也得有」的字段 ──────────
  //
  // Pixi 的 `_bootstrapEvent` / `_transferMouseData` 会把它们**逐个读出来**
  // 赋到联邦事件上（`event.altKey = nativeEvent.altKey` 这种）。读不到不是抛错，
  // 而是把一个 `undefined` 灌进联邦事件 —— 平时看不出来，等某个判据或滤镜
  // 恰好用它参与算术时，才会以 NaN 的形式在很远的地方冒出来。
  // 补齐的成本是几行，而追一个 NaN 的成本是几小时。
  pointerId = 1;
  pointerType = 'mouse';
  isPrimary = true;
  width = 1;
  height = 1;
  tiltX = 0;
  tiltY = 0;
  twist = 0;
  tangentialPressure = 0;
  pressure = 0.5;
  movementX = 0;
  movementY = 0;
  layerX = 0;
  layerY = 0;
  offsetX = 0;
  offsetY = 0;
  altKey = false;
  ctrlKey = false;
  metaKey = false;
  shiftKey = false;

  constructor(type: string, init: Record<string, Any> = {}) {
    this.type = type;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.button = init.button ?? 0;
    this.buttons = init.buttons ?? 1;
    Object.assign(this, init);
    // 必须在上面的 Object.assign 之后兜底：显式传入的 target 优先。
    if (this.target == null) {
      this.target = envState.displayElement;
      this.srcElement = envState.displayElement;
    }
    this.timeStamp = init.timeStamp ?? (g.performance?.now?.() ?? Date.now());
    // `pageX/pageY` 缺省与 client 一致 —— 省略会让 Pixi 写出 `page.x = undefined`。
    if (init.pageX == null) this.pageX = this.clientX;
    if (init.pageY == null) this.pageY = this.clientY;
    if (init.layerX == null) this.layerX = this.clientX;
    if (init.layerY == null) this.layerY = this.clientY;
    if (init.offsetX == null) this.offsetX = this.clientX;
    if (init.offsetY == null) this.offsetY = this.clientY;
  }

  preventDefault(): void {}
  stopPropagation(): void {}
  stopImmediatePropagation(): void {}
}
