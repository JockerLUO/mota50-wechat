/**
 * 触摸桥：`wx.onTouch*` → 三份事件总线。
 *
 * 这是「小游戏里画面对了但点不动」那类问题的正解所在，所以本文件注释里
 * 记录的失败形态比代码多。
 */
import { nativeDom } from './assign';
import { canvasBus, documentBus, globalBus, type EventBus } from './events';
import { MiniMouseEvent } from './mouse-event';
import { envState, g, wxApi, type Any } from './state';

/**
 * 把 `wx.onTouch*` 桥接成 Pixi 听得懂的事件。
 *
 * ## ⚠️ 这一条**不能**按 `nativeDom` 让路（2026-09-21 实测打回来的第二次）
 *
 * 上一版的开头是 `if (nativeDom) return;`，注释写着「原生 DOM 宿主事件本来就有」——
 * 这个前提在小游戏里**不成立**：
 *
 *   | 宿主 | 玩家在画面上点一下，事件从哪来 |
 *   |---|---|
 *   | 真机小游戏 | `wx.onTouch*`（唯一来源） |
 *   | **IDE 模拟器** | **`wx.onTouch*`** —— 模拟器把鼠标/触摸转成 wx 触摸事件，<br>上屏画布是**原生视图**，不受页面 DOM 事件系统管辖 |
 *   | 浏览器网页端 | 原生 DOM 事件（但那不是本产物的运行环境） |
 *
 * 也就是说：**只要有 `wx`，输入就只能从 `wx.onTouch*` 来**。`nativeDom` 能说明
 * 「宿主有原生 DOM 对象」，但推不出「玩家点的东西会经过那些对象」。
 * 判据用错在这一条上，代价是「画面完全正常、就是点不动」——而它在本项目的
 * 四套校验里**一条判据都碰不到**（有 DOM 那一侧的 `wx.onTouch*` 桩原本是空实现），
 * 只能等用户在 IDE 里肉眼发现。
 *
 * ## 「送到哪儿」的答案：**先把监听挪到我们自己的对象上**
 *
 * 第一版（本轮）想的是「按宿主挑一条路送」：有原生 DOM 就合成真事件、否则进总线。
 * 这条思路在 IDE 上被实测打回来了 —— 探针回传的事实是
 * `pointerBranch=false nativeDom=true canReal=false`：
 * 模拟器**没有** `PointerEvent`（pixi 走 mouse 分支），有原生 DOM，
 * 而上屏画布 `instanceof HTMLCanvasElement === false`（是原生视图、不是页面里的画布元素），
 * 于是「派发真事件」这条路过不去，总线那条又没人听 —— 两条路都断。
 *
 * 所以正确做法是**先统一监听位置**：用 `hookEventTarget` 把 canvas / document /
 * globalThis 上 Pixi 用到的事件类型接到我们的总线（这一步在模块求值期完成，
 * 早于 Pixi 的注册），然后无论什么宿主都只派发到三份 EventBus。
 * 这样「有 DOM / 无 DOM」走的是同一条路径 —— 「PC 端能点、模拟器不能点」这种分叉
 * 从根上消失了，而不是被逐个宿主打补丁。
 *
 * 合成真事件（`dispatchReal`）保留为**兜底**：万一某个宿主对象不可写、hook 失败，
 * 它还能把事件送到原生监听上。两条都发不会重复触发 —— 其中一条必然是空操作。
 *
 * 事件**类型**由 Pixi 走哪条分支决定（见 `pointerBranch`）：宿主有 `PointerEvent`
 * 时它挂 `pointerdown/move/up`，没有才挂 `mouse*`。派发的事件名必须与之一致。
 *
 * 另外 touchstart 时**先**补一个 move：网页上指针本来就会先移动再按下，
 * 小游戏没有悬停，不补的话右下的详情面板永远不会更新 —— 触摸设备上那等于废掉了。
 */
export function installTouchBridge(): void {
  if (!wxApi) return;

  /**
   * Pixi 走哪个事件分支 —— 由它**构造 EventSystem 那一刻**的全局决定：
   *
   *     this.supportsPointerEvents = !!globalThis.PointerEvent;
   *     this.supportsTouchEvents   = 'ontouchstart' in globalThis;
   *
   * `env/` 整体比 pixi 先求值（入口第一个 import），所以现在读到的就是它将来读到的。
   * ⚠️ 别改成「按 nativeDom 猜」：IDE 模拟器（有原生 DOM）里 `PointerEvent` 也存在，
   * 但真机小游戏/Worker 宿主里两者都没有 —— 这两件事会分叉，分开判才不会错。
   */
  const pointerBranch = typeof g.PointerEvent === 'function';
  const onDown = pointerBranch ? 'pointerdown' : 'mousedown';
  const onMove = pointerBranch ? 'pointermove' : 'mousemove';
  const onUp = pointerBranch ? 'pointerup' : 'mouseup';

  const first = (e: Any) => e?.changedTouches?.[0] ?? e?.touches?.[0];

  /** 送进我们的 EventBus —— **主路径**。Pixi 的监听要么在垫片对象上（无 DOM 宿主），
   *  要么被 `hookEventTarget` 接到了总线上（有 DOM 宿主），两种情况都走这里。 */
  const dispatchBus = (bus: EventBus, type: string, t: Any, pressed: boolean): void => {
    bus.dispatchEvent(
      new MiniMouseEvent(type, {
        clientX: t?.clientX ?? 0,
        clientY: t?.clientY ?? 0,
        button: 0,
        buttons: pressed ? 1 : 0,
        pointerType: pointerBranch ? 'touch' : 'mouse',
        isPrimary: true,
        pointerId: 1,
        timeStamp: t?.timeStamp
      })
    );
  };

  /**
   * 兜底：合成**真事件**，分别派发到画布 / document / globalThis。
   *
   * 只在「hook 没成功、Pixi 的监听还留在原生对象上」时才需要 —— 但它必须留着，
   * 因为某些宿主对象不可写（`hookEventTarget` 会返回 false），那时这是唯一能送到的路。
   *
   * ## 为什么三个目标分开派发
   *
   * Pixi 的三处注册分别在 `canvas`（down）、`document`（move）、`globalThis`（up）上。
   * 只派发到画布、指望它冒泡过去，依赖两个前提：画布真的在当前文档树里、且与监听者
   * 属于同一个 realm。IDE 模拟器里这两条都不保证（上屏画布是原生视图，实测
   * `el instanceof HTMLCanvasElement === false`）。分开派发把这层依赖去掉。
   *
   * ## ⚠️ 派发到 document / window 时必须补 `composedPath`
   *
   * 那种事件的 `target` 是 document / window 本身，而 Pixi 的 `_onPointerUp` 用它判
   * 「是不是画布外」：`target !== this.domElement` → 事件名被改成 `pointerupoutside`，
   * 而 `EventBoundary` **只在 `pointerup` 上生成 `pointertap`** —— 所有按钮与棋盘格
   * 会一起失效（画面、悬停都正常，只有「点击」不生效）。
   * Pixi 优先读 `nativeEvent.composedPath()[0]`，所以补一个返回 `[画布]` 的方法即可。
   */
  const dispatchReal = (type: string, t: Any, pressed: boolean): boolean => {
    if (!nativeDom) return false;
    const el = envState.displayElement;
    if (!el || typeof el.dispatchEvent !== 'function' || typeof g.MouseEvent !== 'function') return false;
    const Ctor = pointerBranch ? g.PointerEvent : g.MouseEvent;
    if (typeof Ctor !== 'function') return false;
    const init: Any = {
      clientX: t?.clientX ?? 0,
      clientY: t?.clientY ?? 0,
      button: 0,
      buttons: pressed ? 1 : 0,
      bubbles: true,
      cancelable: true,
      composed: true
    };
    if (pointerBranch) {
      init.pointerId = 1;
      init.pointerType = 'touch';
      init.isPrimary = true;
    }
    let ok = false;
    for (const target of [el, g.document, g]) {
      if (!target || typeof target.dispatchEvent !== 'function') continue;
      try {
        const ev = new Ctor(type, init);
        if (target !== el) {
          try {
            Object.defineProperty(ev, 'composedPath', { value: () => [el] });
          } catch {
            /* 不可扩展的事件对象：那就只能接受 target 偏差 */
          }
        }
        target.dispatchEvent(ev);
        ok = true;
      } catch (err) {
        // 单个目标失败不连坐其余：内核之间对 init 字段的宽容度不同。
        console.warn(`[minigame] 合成 ${type} 到 ${target === el ? 'canvas' : 'document/window'} 失败：`, err);
      }
    }
    return ok;
  };

  /**
   * 一次触摸事件 → 两个去向。
   *
   * 两条**都发**，而且不会重复触发：
   *   - hook 成功时 —— 原生监听已不存在（同名类型被我们接管了），真事件派发变成空操作；
   *   - hook 失败时 —— 总线上没有 Pixi 的监听，bus 派发变成空操作。
   * 与其在启动时猜哪条路通，不如两条都走：成本是每次触摸多一次 no-op。
   *
   * 三份 bus 与 Pixi 的三处注册一一对应（canvas ← down、document ← move、globalThis ← up）。
   */
  const emit = (phase: 'down' | 'move' | 'up', t: Any): void => {
    const pressed = phase !== 'up';
    const realType = phase === 'down' ? onDown : phase === 'move' ? onMove : onUp;
    const bus = phase === 'down' ? canvasBus : phase === 'move' ? documentBus : globalBus;
    dispatchBus(bus, realType, t, pressed);
    facts.realDispatch = dispatchReal(realType, t, pressed) || facts.realDispatch === true;
  };

  /** 诊断事实：本地判据与 IDE 探针都读它，用来区分「桥没装 / 装了但送法不对」。 */
  const facts: Any = {
    pointerBranch,
    nativeDom,
    realDispatch: null as boolean | null,
    sent: 0,
    /**
     * 现算一遍此刻的事实。
     *
     * ⚠️ 不能在模块顶层算好：上屏画布要到 `reserveDisplayCanvas()` 才拿到，
     * 而本函数在它**之前**执行 —— 那会儿算出来必然是空，报给探针就成了假证据。
     * 这个函数由采集方（`main.ts` 的 boot 埋点）在游戏起来之后调用，结论才有意义。
     */
    probe: (): Any => ({
      pointerBranch,
      nativeDom,
      // 三个事件坑位的接管情况 —— 全 true 表示「总线一条路就够」
      hooked: {
        canvas: envState.hookedCanvas,
        document: envState.hookedDocument,
        global: envState.hookedGlobal
      },
      /**
       * 上屏画布到底长什么样。
       *
       * 这一项是 2026-09-21 那次排障留下的：IDE 里实测
       * `el instanceof HTMLCanvasElement === false`，但 pixi 又能把监听挂上去 ——
       * 说明它是个「有 addEventListener / dispatchEvent 但不是当前 realm 的 canvas」
       * 的对象。只记这俩能力（而不纠结它是什么类型），下次判断才有据可依。
       */
      canvas: envState.displayElement
        ? {
            ctor: envState.displayElement.constructor?.name ?? null,
            hasDispatchEvent: typeof envState.displayElement.dispatchEvent === 'function',
            hasAddEventListener: typeof envState.displayElement.addEventListener === 'function',
            isHTMLCanvasElement:
              typeof g.HTMLCanvasElement === 'function' ? envState.displayElement instanceof g.HTMLCanvasElement : null,
            isConnected: envState.displayElement.isConnected ?? null
          }
        : null,
      realDispatch: facts.realDispatch,
      sent: facts.sent
    })
  };
  g.__motaTouch = facts;

  wxApi.onTouchStart?.((e: Any) => {
    const t = first(e);
    facts.sent += 1;
    emit('move', t);
    emit('down', t);
  });
  wxApi.onTouchMove?.((e: Any) => {
    facts.sent += 1;
    emit('move', first(e));
  });
  wxApi.onTouchEnd?.((e: Any) => {
    facts.sent += 1;
    emit('up', first(e));
  });
  wxApi.onTouchCancel?.((e: Any) => {
    facts.sent += 1;
    emit('up', first(e));
  });
}
