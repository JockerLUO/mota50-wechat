/**
 * 画布相关的三件事：给 GL 上下文打补丁、造离屏画布、给上屏画布打补丁。
 *
 * 三者的关系是「越往下越靠近宿主」：
 *   `patchGetContext`（任何画布都能挂）→ `createOffscreenCanvas`（离屏）
 *   → `patchDisplayCanvas`（上屏，额外负责登记 `envState.displayElement`）。
 */
import { nativeDom } from './assign';
import { canvasBus, hookEventTarget } from './events';
import { envState, wxApi, type Any } from './state';

/**
 * 补上 `getContextAttributes`。
 *
 * Pixi 判定「WebGL 可用」的方式是：
 *   gl = canvas.getContext('webgl', { stencil: true, ... })
 *   success = !!gl?.getContextAttributes()?.stencil
 * 整段包在 try/catch 里，**抛异常等于 false**。而 false 的后果不是报错：
 * `autoDetectRenderer` 会安静地跳过 webgl 分支，一路 fallback 到 CanvasRenderer
 * （一个能力残缺的 2D 渲染器）。画面也许还有东西，但精灵、遮罩、滤镜全不对。
 * 这种「不出声的降级」是最难查的一类问题，所以这里主动补上。
 */
function hardenGl(gl: Any): Any {
  if (typeof gl.getContextAttributes !== 'function') {
    try {
      gl.getContextAttributes = () => ({
        alpha: true,
        antialias: false,
        depth: false,
        stencil: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false
      });
    } catch (err) {
      console.warn('[minigame] 无法补上 getContextAttributes:', err);
    }
  }
  return gl;
}

const glPatched = new WeakSet<Any>();

/** 包一层 getContext，让拿到的 GL 上下文都过一遍 `hardenGl`。 */
export function patchGetContext(canvas: Any): Any {
  if (!canvas || glPatched.has(canvas) || typeof canvas.getContext !== 'function') return canvas;
  glPatched.add(canvas);
  const raw = canvas.getContext.bind(canvas);
  canvas.getContext = (type: string, opts?: Any) => {
    const ctx = raw(type, opts);
    if (ctx && /webgl/i.test(type)) hardenGl(ctx);
    return ctx;
  };
  return canvas;
}

/**
 * 造一块离屏画布。
 *
 * ⚠️ 上屏画布必须是 `wx.createCanvas()` 的**第一次**调用结果，之后的调用才是离屏。
 * 所以调用顺序有硬约束：宿主先取走上屏画布，探针和 Pixi 内部的 CanvasPool 再要离屏的。
 * 见 `host.ts` 的 `createMiniGameHost()`。上屏那一块由 `display.ts` 在模块求值期抢下。
 */
export function createOffscreenCanvas(width?: number, height?: number): Any {
  const canvas = wxApi.createCanvas();
  if (width != null) canvas.width = width;
  if (height != null) canvas.height = height;
  return patchGetContext(canvas);
}

/**
 * 给上屏画布打补丁。
 *
 * 其中坐标那一项是**必须**的，理由如下 ——
 * Pixi `EventSystem.mapPositionToPoint` 的公式是：
 *   point.x = (clientX - rect.left) * (canvas.width / rect.width) / resolution
 * 网页里 `rect.width` 是 CSS 宽度（= 物理宽 / resolution），倍率正好把 resolution 抵消掉。
 * 小游戏没有 `getBoundingClientRect`，Pixi 会退到 `{ width: canvas.width }`（**物理**宽），
 * 倍率变成 1，于是 clientX 被多除了一次 resolution —— dpr=3 的机型上，
 * 触到右下角的按钮，坐标只报到 1/3 的位置。表现是「按钮点不中，越靠右下越偏」。
 * 所以这里补一个返回**逻辑尺寸**的 `getBoundingClientRect`，
 * 并把 `isConnected` 置 true（Pixi 用 isConnected 决定走哪条分支）。
 */
export function patchDisplayCanvas(canvas: Any, width: number, height: number): Any {
  // 先登记：合成事件的 target 要用它（见 mouse-event.ts 的说明）
  envState.displayElement = canvas;
  patchGetContext(canvas);

  /** 逻辑尺寸的 rect —— 小游戏这边必须自己造（见下面的公式说明）。 */
  const logicalRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height
  });

  if (nativeDom) {
    // 原生 DOM 宿主：**只补宿主真正缺的那几样**，能读到原生值就一律不碰
    //（`isConnected` 在真元素上是只读的，硬设会抛 —— 实测撞到过
    //  `Cannot set property isConnected of #<Node>`）。
    //
    // ⚠️ 但 `addEventListener` 这一项**必须接管**（2026-09-21 实测修正）。
    //
    // 上一版认为「真元素上是原型方法，硬设要么抛、要么把 pixi 的事件收进没人派发的
    // canvasBus（画面正常、点不动）」，于是让路了。这个推理一半对一半错：
    //   - 「会抛」只在 `isConnected` 那类**只读访问器属性**上成立；`addEventListener`
    //     是原型方法，实例上赋值只是 shadow 一个自有属性，不抛。
    //   - 「收了没人派发」是**当时**的事实（那时触摸桥在 nativeDom 下整体让路），
    //     但那是「桥的问题」，不该让事件目标去背 —— 桥一装上，canvasBus 就有人派发了。
    //
    // 而让路的代价是致命的：小游戏的触摸只能从 `wx.onTouch*` 来，宿主原生对象
    // 永远收不到，pixi 的 `mousedown` 便挂在一个不会响的地方 —— **点不动**。
    envState.hookedCanvas = hookEventTarget(canvas, canvasBus);
    if (!canvas.style) canvas.style = {};
    let rect: Any = null;
    try {
      rect = canvas.getBoundingClientRect();
    } catch {
      /* 拿不到就当没有 */
    }
    if (!rect || !rect.width) {
      // 画布不在文档流时原生 rect 全 0，而 pixi 的 `mapPositionToPoint` 要拿
      // `rect.width` 当倍率 —— 除零会让所有坐标变成 NaN。
      try {
        canvas.getBoundingClientRect = logicalRect;
      } catch {
        /* 只读就认了 */
      }
    }
    return canvas;
  }

  canvas.addEventListener = (type: string, fn: (ev: Any) => void) => canvasBus.addEventListener(type, fn);
  canvas.removeEventListener = (type: string, fn: (ev: Any) => void) => canvasBus.removeEventListener(type, fn);
  canvas.dispatchEvent = (ev: Any) => canvasBus.dispatchEvent(ev);
  // 这一分支是「整体替换」，等价于 hook 成功 —— 记上，供触摸桥判断要不要补真事件。
  envState.hookedCanvas = true;
  // EventSystem 读 domElement.style（设 touchAction / cursor），缺了会抛
  if (!canvas.style) canvas.style = {};
  canvas.isConnected = true;
  canvas.getBoundingClientRect = logicalRect;
  return canvas;
}
