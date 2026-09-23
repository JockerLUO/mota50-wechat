/**
 * 三份事件总线 + 「把宿主对象上的事件坑位接到总线」的那一步。
 *
 * ## 为什么是三份而不是一份
 *
 * Pixi 的 `EventSystem` 会在三个不同对象上注册监听：
 *   domElement(canvas)  ← pointerdown / mousedown / mouseout / mouseover / wheel
 *   globalThis.document ← pointermove / mousemove
 *   globalThis          ← pointerup / mouseup
 * 小游戏这三者都没有 `addEventListener`，所以我们造三份独立注册表，
 * 由 `wx.onTouch*` 桥接到对应的那一份上去（见 `touch.ts`）。
 *
 * 分三份（而不是合成一份）是为了**忠实还原「谁注册的谁收到」**，
 * 避免将来某处重复注册导致事件被派发两次。
 */
import type { Any } from './state';

export class EventBus {
  private readonly map = new Map<string, Set<(ev: Any) => void>>();

  addEventListener(type: string, fn: (ev: Any) => void): void {
    let set = this.map.get(type);
    if (!set) this.map.set(type, (set = new Set()));
    set.add(fn);
  }

  removeEventListener(type: string, fn: (ev: Any) => void): void {
    this.map.get(type)?.delete(fn);
  }

  dispatchEvent(ev: Any): void {
    const set = this.map.get(ev?.type);
    if (!set) return;
    for (const fn of [...set]) {
      // 单个监听器炸掉不能连坐 —— 这个回调是 wx 的触摸回调，
      // 抛出去会让后续触摸全部失效，表现成「点着点着就不动了」。
      try {
        fn(ev);
      } catch (err) {
        console.error('[minigame] 事件监听器抛错:', ev?.type, err);
      }
    }
  }
}

export const canvasBus = new EventBus();
export const documentBus = new EventBus();
export const globalBus = new EventBus();

/**
 * Pixi 会注册的事件类型 —— 只有这几个坑位需要接到我们自己的总线上。
 *
 * 列表来自 `events/EventSystem.mjs` 的 `_addEventListeners()`（mouse 与 pointer 两个分支
 * 加 touch 附加项，一次性全列上，免得将来 pixi 换分支时漏一个）：
 *
 *     document   ← mousemove / pointermove
 *     domElement ← mousedown / mouseout / mouseover / wheel（pointer 分支同理）
 *     globalThis ← mouseup / pointerup
 *     附加       ← touchstart / touchmove / touchend（`supportsTouchEvents` 为真时）
 *
 * 只拦这些、其余原样转发，是为了把对宿主的影响限制在「Pixi 真正用到的那几个类型」上 ——
 * 这几个对象（`document` / `window`）是宿主的，我们只借坑位，不做整体替换。
 */
export const PIXI_EVENT_TYPES = [
  'mousedown',
  'mouseup',
  'mousemove',
  'mouseout',
  'mouseover',
  'wheel',
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointerout',
  'pointerover',
  'touchstart',
  'touchend',
  'touchmove'
];

/**
 * 把宿主对象上的 `addEventListener` / `removeEventListener` **选择性**接到某个总线上。
 *
 * ## 为什么必须做这件事（而不是「有原生 DOM 就让路」）
 *
 * 小游戏的输入**只能从 `wx.onTouch*` 来**（真机如此，IDE 模拟器也如此：模拟器把鼠标
 * 转成 wx 触摸事件，上屏画布是原生视图，不受页面 DOM 事件系统管辖）。而 Pixi 会把监听
 * 注册到原生 `document` / `window` / canvas 上 —— 那些对象**永远收不到**小游戏的触摸。
 * 不给它换目标，玩家看到的就是「画面完全正常、就是点不动」。
 *
 * ## 为什么是「选择性 hook」而不是整体替换
 *
 * `document` / `window` 是宿主的东西，我们只借 Pixi 用到的类型（见 `PIXI_EVENT_TYPES`），
 * 其余调用原样转发给原生实现 —— 宿主自己的监听行为不变。整体替换会把宿主的事件
 * 一并吞掉，那是在解决一个问题的同时制造另一个。
 *
 * ## 时机
 *
 * `env/` 整体是入口第一个 import、比 pixi 先求值，而 Pixi 的注册发生在**渲染器构造时**
 * （`EventSystem.setTargetElement()` → `_addEventListeners()`）—— 中间隔着整个模块求值，
 * 所以「在模块顶层就 hook 好」是完全来得及的。等到游戏起来再换就晚了。
 */
export function hookEventTarget(obj: Any, bus: EventBus): boolean {
  if (!obj || typeof obj.addEventListener !== 'function') return false;
  const rawAdd = obj.addEventListener;
  const rawRemove = obj.removeEventListener;
  const ours = (type: string) => PIXI_EVENT_TYPES.indexOf(type) >= 0;
  try {
    obj.addEventListener = function (type: string, fn: (ev: Any) => void, opts?: Any): void {
      if (ours(type)) {
        bus.addEventListener(type, fn);
        return;
      }
      return rawAdd.call(this, type, fn, opts);
    };
    obj.removeEventListener = function (type: string, fn: (ev: Any) => void, opts?: Any): void {
      if (ours(type)) {
        bus.removeEventListener(type, fn);
        return;
      }
      return rawRemove.call(this, type, fn, opts);
    };
  } catch (err) {
    // 不可写 / 不可扩展的宿主对象 —— 不强行改，由 `installTouchBridge` 走「合成真事件」兜底。
    console.warn('[minigame] 无法接管事件目标，改用合成事件兜底：', err);
    return false;
  }
  return true;
}
