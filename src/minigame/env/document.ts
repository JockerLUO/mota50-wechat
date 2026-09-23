/**
 * `document` 替身 —— 只做 `createElement` 一件真事，其余是「被读到不会炸」的替身对象。
 *
 * ## 覆盖范围是「实测撞出来的」，不是照抄官方 adapter
 *
 * 见 `createElement` 的注解：只有已经用实测确认过的标签才给替身，
 * 其余**当场抛错**（而不是返回一个似真似假的破对象）——
 * 后者最坏的情况不是报错，而是**问题被推迟到几百行之外**。
 */
import { safeAssign } from './assign';
import { createOffscreenCanvas } from './canvas';
import { documentBus } from './events';
import { g, wxApi, type Any } from './state';

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
  /**
   * 相对 URL 的解析基准。
   *
   * ⚠️ 这个字段**不是装饰**，是 pixi 在**构造期**真的会读的东西：
   *
   *   - `autoDetectRenderer` 里有 `new URL("boot.js", document.baseURI)` ——
   *     它是 Vite 给动态导入生成的 `__vitePreload(loader, deps, importerUrl)`
   *     的**第三个实参**。那个参数在这份产物里**根本不会被用到**
   *     （`deps` 是 `void 0`，helper 里消费它的分支被 `if (false)` 消除掉了），
   *     但**实参照样要求值** —— base 是 `undefined` 就抛
   *     `TypeError: Failed to construct 'URL': Invalid URL`，而它发生在
   *     渲染器构造期，后果是整局起不来。
   *   - pixi 的 loader 里还有一处 `new URL(url, document.baseURI)`（跨域判定）。
   *
   * 所以它必须是个**绝对** URL：`new URL(x, '')` / `new URL(x, '/')` 都会抛。
   *
   * 具体取值只影响「相对路径会被解析成什么」，而本项目的资源加载**不走这条 URL
   * 路径** —— 图集由 `wx.createImage()` 直接吃相对路径（`assets/terrain.png`），
   * 守这一点的是 verify:minigame 的「图集走包内相对路径」判据。
   * 用一个一眼看得出「不是真实网络地址」的 scheme，是为了避免将来有人拿它去 fetch。
   *
   * ⚠️ 这个坑是**产物拆成 CJS 多文件之后才出现的**，而且**只有无 DOM 宿主抓得到**：
   *   - iife 单文件时代动态导入被 `inlineDynamicImports` 全部内联，
   *     Vite 不生成 `__vitePreload`，这段实参压根不存在；
   *   - 有 DOM 的宿主里 `document.baseURI` 有真值，右支走得通，看起来一切正常。
   * 记在这里是因为它太容易在「换个打包格式」的时候再犯一次。
   */
  baseURI: 'wxgame://code-package/',
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
 * 装 `document` —— 但**就地补字段**，不整对象替换。
 *
 * ## 为什么不能整对象替换（第三例，与 `navigator` 同一条纪律）
 *
 * 构建期 `PRELUDE` 里已经有一句 `var document = ...`（见 `vite.minigame.config.ts`），
 * 它解决的是「**属性路径有值、裸标识符读不到**」这个分叉。但词法绑定的值
 * 是**在 intro 那一刻定下的**，而 `env/` 在这之后才跑 —— 若这里
 * `safeAssign('document', doc)` 整对象换掉属性，两条路径就指向两个对象了：
 * 裸标识符仍旧指着 intro 那份，pixi 读到的就是它，于是「补了却没用」。
 *
 * ## 「补哪个对象」必须是事实，不能是猜测
 *
 * 首选 `globalThis.__motaDocumentShim` —— 那是 intro **留下记号的那个对象**，
 * 也就是裸标识符指着的那一个。为什么不直接用 `globalThis.document` 呢：
 * 宿主若把 `document` 设成只读属性，intro 那句赋值会失败，于是
 * `globalThis.document` 仍是宿主那个**不可用**的对象，而裸标识符是 intro 的占位对象 ——
 * 两个不同的东西。有记号就不用在这上面赌一把（这一整轮的教训就是这个）。
 *
 * ## 让路的判据必须与 intro **完全一致**
 *
 * intro 选对象的判据是「`createElement` 是不是函数」（可用性）。这里若改用
 * `nativeDom`（= 「在」且「不可覆盖」），就会出现错配：某个宿主里
 * `document` 属性在、也覆盖得动，但**根本不可用** —— intro 判定「不可用、用占位」，
 * 而 `nativeDom` 会判「有原生 DOM、让路」，两边打架。所以这里用同一条判据。
 */
export function installDocument(): void {
  const existing = g.document as Any;
  // 宿主那份**可用** → 让路。真 DOM 比垫片完整，硬装上去反而更糟：
  // `document.addEventListener` 会收进我们的 documentBus，而原生事件永远不派发到那里
  // →「画面有了但点不动」（理由详见 `assign.ts` 的 `nativeDom`）。
  if (!!existing && typeof existing.createElement === 'function') return;

  const target = (g.__motaDocumentShim as Any) || existing;
  if (target && typeof target === 'object') {
    // intro 选中的那个对象 —— 就地补，保住「一个对象、两处引用」。
    try {
      Object.assign(target, doc);
      return;
    } catch {
      /* 宿主对象不可写，退回整体安装 */
    }
  }
  safeAssign('document', doc);
}
