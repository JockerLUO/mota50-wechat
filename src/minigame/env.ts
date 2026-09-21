/**
 * 微信小游戏运行时环境垫片 —— DOM / 事件体系的**最小可用子集**。
 *
 * ## ⚠️ 本文件不允许出现任何 `import`
 *
 * ESM 的求值顺序是「依赖先于自身」。只要这里写上 `import { DOMAdapter } from 'pixi.js'`，
 * 整个 Pixi 就会在**本文件之前**求值，而 Pixi 的模块体里已经在读全局了
 * （最典型的是 `ismobilejs`：`const isMobile = isMobileJs(globalThis.navigator)`，
 * 在模块顶层执行）。于是垫片还没装上就先用上了 —— 表现出来是一堆莫名其妙的
 * `xxx is not defined`。需要 `DOMAdapter` 的那部分在 `pixi-adapter.ts`，
 * 入口里排在它后面 `import`，求值顺序就对了。
 *
 * ## 垫片的范围是怎么定的
 *
 * 不是照抄 `weapp-adapter` 的那一套，而是按 **Pixi 8.21 源码里的实际调用点**逐条定的。
 * 每一条都标了出处，注解里写清「不补会怎样」——因为其中好几条的失败形态是
 * **静默降级**（不报错、画面还能出来、但东西不对），只靠眼睛看不出来。
 *
 * ## 刻意**不**做的事
 *
 * - 不做完整的虚拟 DOM 树。Pixi 8.21 的适配面只有 `DOMAdapter` 那 9 个方法，
 *   造一棵 DOM 树是给 Pixi 5/6/7 时代的方案用的，对 8.x 是纯负担。
 * - 不定义 `PointerEvent` / `TouchEvent` / `ontouchstart`。
 *   见 `installGlobals` 里关于「为什么主动锁到鼠标分支」的说明。
 */

type Any = any;

export const g = globalThis as Any;
export const wxApi: Any = g.wx;

// ── 事件总线 ────────────────────────────────────────────────────────
//
// Pixi 的 EventSystem 会在三个不同对象上注册监听：
//   domElement(canvas)  ← pointerdown / mousedown / mouseout / mouseover / wheel
//   globalThis.document ← pointermove / mousemove
//   globalThis          ← pointerup / mouseup
// 小游戏这三者都没有 addEventListener，所以我们造三份独立注册表，
// 由 `wx.onTouch*` 桥接到对应的那一份上去。分三份（而不是合成一份）是为了
// 忠实还原「谁注册的谁收到」，避免将来某处重复注册导致事件被派发两次。

class EventBus {
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

// ── MouseEvent 替身 ─────────────────────────────────────────────────

/**
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
/**
 * 当前的上屏画布。
 *
 * 存在的唯一理由是给合成事件填 `target`（见 `MiniMouseEvent` 的 `target` 说明）。
 * 由 `patchDisplayCanvas` 赋值 —— 那时宿主才刚拿到画布。
 * 在宿主取画布之前它是 `null`，而那个时间窗里不会有触摸事件，所以是安全的。
 */
let displayElement: Any = null;

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
  button: number;
  buttons: number;
  isTrusted = false;
  isNormalized = false;
  srcElement: Any = null;
  target: Any = null;
  currentTarget: Any = null;
  timeStamp: number;

  constructor(type: string, init: Record<string, Any> = {}) {
    this.type = type;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.button = init.button ?? 0;
    this.buttons = init.buttons ?? 1;
    Object.assign(this, init);
    // 必须在上面的 Object.assign 之后兜底：显式传入的 target 优先。
    if (this.target == null) {
      this.target = displayElement;
      this.srcElement = displayElement;
    }
    this.timeStamp = init.timeStamp ?? (g.performance?.now?.() ?? Date.now());
  }

  preventDefault(): void {}
  stopPropagation(): void {}
  stopImmediatePropagation(): void {}
}

// ── 画布 ────────────────────────────────────────────────────────────

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
 * 见 `host.ts` 的 `createMiniGameHost()`。
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
  // 先登记：合成事件的 target 要用它（见 MiniMouseEvent 的说明）
  displayElement = canvas;
  patchGetContext(canvas);
  canvas.addEventListener = (type: string, fn: (ev: Any) => void) => canvasBus.addEventListener(type, fn);
  canvas.removeEventListener = (type: string, fn: (ev: Any) => void) => canvasBus.removeEventListener(type, fn);
  canvas.dispatchEvent = (ev: Any) => canvasBus.dispatchEvent(ev);
  // EventSystem 读 domElement.style（设 touchAction / cursor），缺了会抛
  if (!canvas.style) canvas.style = {};
  canvas.isConnected = true;
  canvas.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height
  });
  return canvas;
}

// ── document / 全局 ─────────────────────────────────────────────────

/**
 * 通用元素替身：只有「被读到 / 被调到时不会炸」这一条设计目标，不具备任何真实 DOM 行为。
 *
 * `remove` / `parentNode` / `contains` 这三项不是凑数补的 —— 它们来自
 * `dom/DOMPipe.mjs` 的 `postrender()`：
 *     if (attachedDomElements.length === 0) { this._domElement.remove(); return; }
 * `_domElement` 是它 `document.createElement("div")` 造出来的，而 `postrender`
 * 挂在渲染器的 postrender runner 上 —— **每渲染一帧就执行一次**。
 * 缺 `remove()` 的后果是每帧抛一次 TypeError，也就是整个游戏根本渲染不了。
 */
function makeStubElement(tag: string): Any {
  const upper = String(tag).toUpperCase();
  const el: Any = {
    tagName: upper,
    nodeName: upper,
    style: {},
    dataset: {},
    children: [],
    childNodes: [],
    title: '',
    id: '',
    className: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    parentNode: null,
    isConnected: false,
    appendChild: (child: Any) => {
      el.children.push(child);
      return child;
    },
    insertBefore: (child: Any) => child,
    removeChild: (child: Any) => {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      return child;
    },
    // 替身没有真实树结构，所以 remove / contains 只能是「不报错」级别的实现。
    // 这够用：Pixi 调它们只是为了调整一个我们并不需要的叠加层。
    remove: () => {},
    contains: () => false,
    setAttribute: () => {},
    getAttribute: () => null,
    removeAttribute: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    focus: () => {},
    blur: () => {},
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 })
  };
  return el;
}

/**
 * 媒体元素替身。
 *
 * `canPlayType` 返回**空串**是刻意的：Pixi 的 `testVideoFormat` 判的是
 * `video.canPlayType(mimeType) !== ''`，空串即「不支持任何格式」——
 * 于是 `detectMp4` / `detectOgv` / `detectWebm` 会把 mp4/m4v/ogv/webm
 * 从资源格式表里**正确摘掉**（小游戏本来就没有 `<video>`）。本项目不用视频资源，
 * 但这条路径是 `Assets.init()` 的必经之路，摘不掉就走不下去。
 */
function makeMediaElement(tag: string): Any {
  const el = makeStubElement(tag);
  el.canPlayType = () => '';
  el.play = () => Promise.reject(new Error('小游戏适配层不提供媒体播放'));
  el.pause = () => {};
  el.load = () => {};
  return el;
}

const ELEMENT_TAGS = new Set([
  'div',
  'span',
  'p',
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'style',
  'link',
  'br',
  'body',
  'head'
]);

/**
 * `document.createElement` —— 覆盖已确认的调用点，**其余主动抛错**。
 *
 * ## 为什么不全盘放行
 *
 * 返回一个「似真似假的破对象」最坏的情况不是报错，而是**问题被推迟到几百行之外**，
 * 或者干脆不报（静默走错分支）。所以只有已经用实测确认过的标签才给替身，
 * 其余当场炸出调用点 —— 让下一个缺口自己暴露出来。
 *
 * ## 目前覆盖到谁（都是实测撞出来的，不是照抄官方 adapter）
 *
 * | 标签 | 调用点 | 不补会怎样 |
 * |---|---|---|
 * | `canvas` | `CanvasPool`、字体测量 | 抛错 |
 * | `img` | `HTMLText`（本项目不用，补上保底） | 抛错 |
 * | `video` | `assets/detections/utils/testVideoFormat.mjs` | **`Assets.init()` 直接 reject** → 图集全挂 |
 * | `audio` | 同上（同类判定） | 抛错 |
 * | `div`/`button` 等 | `AccessibilitySystem._createTouchHook()` | **渲染器初始化失败** → 整局起不来 |
 *
 * ## 两个反直觉的点，都值得单独记一笔
 *
 * **① `testVideoFormat` 有一个 worker 守卫，但**救不了**小游戏。**
 *    它的第一行是：
 *      `const inWorker = "WorkerGlobalScope" in globalThis && globalThis instanceof ...`
 *    Pixi 显然考虑过「在 Worker 里没有 document」这件事。但小游戏是**第三种环境**：
 *    没有 DOM，也**没有 `WorkerGlobalScope`** —— 于是守卫为假，继续往下走，
 *    撞上不存在的 `document.createElement("video")`。官方这条分支正好覆盖不到我们。
 *
 * **② `AccessibilitySystem` 不是「默认关闭所以不碰」，而是初始化时无条件建一个触摸钩子。**
 *    构造函数里：
 *      `if (_mobileInfo.tablet || _mobileInfo.phone) this._createTouchHook();`
 *    这跟 `enabledByDefault` 无关 —— 只看机型判定，而 `isMobile()` 读的是
 *    `navigator.userAgent`（我们的 UA 里带 MicroMessenger，必然判成手机）。
 *    它做的是 `document.createElement("button")` + `document.body.appendChild()`。
 *    抛在这儿的后果最重：它在 `WebGLRenderer._addSystems()` 里，
 *    异常一路穿过 `autoDetectRenderer` → `Application.init`，
 *    **整个应用初始化失败**，连渲染器都建不出来。
 *    （钩子本身在无 focus 事件的环境里是死的，appendChild 收下即可，不必真挂到树上。）
 */
function createElement(tag: string): Any {
  const t = String(tag).toLowerCase();
  if (t === 'canvas') return createOffscreenCanvas();
  if (t === 'img' || t === 'image') return wxApi.createImage();
  if (t === 'video' || t === 'audio') return makeMediaElement(t);
  if (ELEMENT_TAGS.has(t)) return makeStubElement(t);
  throw new Error(`小游戏适配层不提供 document.createElement('${tag}')`);
}

const doc = {
  addEventListener: (type: string, fn: (ev: Any) => void) => documentBus.addEventListener(type, fn),
  removeEventListener: (type: string, fn: (ev: Any) => void) => documentBus.removeEventListener(type, fn),
  dispatchEvent: (ev: Any) => documentBus.dispatchEvent(ev),
  createElement,
  createElementNS: (_ns: string, tag: string) => createElement(tag),
  body: makeStubElement('body'),
  head: makeStubElement('head'),
  documentElement: makeStubElement('html')
};

/**
 * 读一次系统信息。
 *
 * `wx.getSystemInfoSync()` 在极早期调用或部分基础库上会抛，所以统一包一层 ——
 * navigator 合成、画布预订、宿主都要用它。
 */
function readSystemInfo(): Any {
  try {
    return wxApi?.getSystemInfoSync?.() ?? {};
  } catch {
    return {};
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
function installNavigator(): void {
  let synthesized = 'WeChatMiniGame';
  let platform = '';
  const info = readSystemInfo();
  if (Object.keys(info).length) {
    platform = String(info.platform ?? '');
    synthesized = `Mozilla/5.0 (${info.system ?? 'unknown'}) WeChatMiniGame/${info.version ?? '?'} MicroMessenger`;
  }
  const existing = g.navigator;
  const hasUA = existing && typeof existing.userAgent === 'string' && existing.userAgent.length > 0;
  g.navigator = {
    userAgent: hasUA ? existing.userAgent : synthesized,
    platform: existing?.platform ?? platform,
    maxTouchPoints: existing?.maxTouchPoints ?? 1,
    gpu: null
  };
}

let installed = false;

export function installGlobals(): void {
  // navigator 要排在最前：它是 pixi 模块求值期唯一会碰到的东西
  installNavigator();
  g.document = doc;
  g.MouseEvent = MiniMouseEvent;
  g.addEventListener = (type: string, fn: (ev: Any) => void) => globalBus.addEventListener(type, fn);
  g.removeEventListener = (type: string, fn: (ev: Any) => void) => globalBus.removeEventListener(type, fn);
  g.dispatchEvent = (ev: Any) => globalBus.dispatchEvent(ev);

  // Pixi `_transferMouseData` 会调 performance.now()。小游戏不一定有。
  if (!g.performance) g.performance = { now: () => Date.now() };

  // 小游戏有 requestAnimationFrame；这个兜底是给「用 Node/vm 跑同一份产物」的
  // 离线校验用的，让同一条代码路径在没有 rAF 的宿主里也能跑。
  if (typeof g.requestAnimationFrame !== 'function') {
    g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(g.performance.now()), 16);
    g.cancelAnimationFrame = (id: Any) => clearTimeout(id);
  }

  installed = true;
}

/**
 * 入口在动 Pixi 之前先调它。
 *
 * 存在的意义是「把顺序错误变成一句人话」：如果将来有人调整了入口的 import 顺序，
 * 这里会立刻抛 `垫片未安装`，而不是让他去猜一连串 `document is not defined`。
 */
export function assertInstalled(): void {
  if (!installed) {
    throw new Error('小游戏环境垫片未安装：入口的第一个 import 必须是 ./env，且不能早于它 import pixi.js');
  }
}

// ── 触摸 → 事件总线 ────────────────────────────────────────────────

/**
 * 把 `wx.onTouch*` 桥接成 Pixi 期望的鼠标事件。
 *
 * 三个去向必须和 Pixi 注册的位置一一对应：
 *   touchstart → canvas 上的 mousedown
 *   touchmove  → document 上的 mousemove
 *   touchend   → globalThis 上的 mouseup
 *
 * 另外 touchstart 时**先**补一个 mousemove：网页上指针本来就会先移动再按下，
 * 小游戏没有悬停，不补的话右下的详情面板永远不会更新 —— 触摸设备上那等于废掉了。
 */
export function installTouchBridge(): void {
  if (!wxApi) return;

  const first = (e: Any) => e?.changedTouches?.[0] ?? e?.touches?.[0];

  const ev = (type: string, t: Any) =>
    new MiniMouseEvent(type, {
      clientX: t?.clientX ?? 0,
      clientY: t?.clientY ?? 0,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
      timeStamp: t?.timeStamp
    });

  wxApi.onTouchStart?.((e: Any) => {
    const t = first(e);
    documentBus.dispatchEvent(ev('mousemove', t));
    canvasBus.dispatchEvent(ev('mousedown', t));
  });
  wxApi.onTouchMove?.((e: Any) => documentBus.dispatchEvent(ev('mousemove', first(e))));
  wxApi.onTouchEnd?.((e: Any) => globalBus.dispatchEvent(ev('mouseup', first(e))));
  wxApi.onTouchCancel?.((e: Any) => globalBus.dispatchEvent(ev('mouseup', first(e))));
}

// ── 上屏画布预订 ──────────────────────────────────────────────────
//
// ## 为什么必须在**模块求值期**就抢下来
//
// `wx.createCanvas()` 只在**第一次**调用时返回上屏画布，之后全是离屏。
// 而 Pixi 自己在**模块求值期**就会调 `DOMAdapter.createCanvas()`：
//
//   `lib/rendering/renderers/canvas/utils/canvasUtils.mjs`
//     → `canUseMultiply: canUseNewCanvasBlendModes()`   ← 模块级对象字面量里就调了
//     → 内部 `createColoredCanvas()` × 2 + `createCanvas(6, 1)` × 1
//
// 三块 6×1 的小画布就诞生在 pixi 的模块体里，**早于宿主 `createMiniGameHost()`**。
// 而那一刻我们的 DOMAdapter 还没装上（它必然排在 pixi 之后求值），
// 于是这三块走的是默认 `BrowserAdapter.createCanvas`
// → `document.createElement('canvas')` → 我们的 `createOffscreenCanvas()`
// → **把上屏画布离屏用掉了**。
//
// 症状特别隐蔽：游戏照常启动、画面完全正确、触摸坐标也准，
// 只不过渲染到了**一块没人看的画布**上 —— 真机表现就是**黑屏**，
// 而自动化校验里表现为「上屏画布不是 wx.createCanvas() 的第一块」。
//
// 唯一的解法是**做第一个跑起来的模块**：本模块不含任何 import，
// 只要入口把它排在第一位，它就保证先于整个模块图（含 pixi）求值。
// 这正是本文件存在的意义 —— 垫片要抢在 pixi 之前，画布也一样。

let reservedCanvas: Any = null;

/** 预订上屏画布并打好补丁。幂等：宿主再调一次也只会拿回同一块。 */
export function reserveDisplayCanvas(): Any {
  if (reservedCanvas) return reservedCanvas;
  if (typeof wxApi?.createCanvas !== 'function') return null;
  const info = readSystemInfo();
  const w = info.windowWidth || info.screenWidth || 375;
  const h = info.windowHeight || info.screenHeight || 667;
  reservedCanvas = patchDisplayCanvas(wxApi.createCanvas(), w, h);
  return reservedCanvas;
}

export function getReservedCanvas(): Any {
  return reservedCanvas;
}

// ── 副作用：模块一被 import 就把垫片装上 ─────────────────────────────
//
// **不能**把这几句挪进入口的函数体。ESM 的求值顺序是「依赖先于自身」，
// 只要入口第一个 import 的是本模块，本模块就保证在整个模块图（含 pixi）之前求值；
// 一旦改成在入口函数体里调用，pixi 早就求值完了：垫片等于没装，
// 上屏画布也已经被人拿走了。
installGlobals();
installTouchBridge();
reserveDisplayCanvas();
