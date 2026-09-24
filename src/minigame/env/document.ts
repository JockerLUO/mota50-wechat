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
 * 相对 URL 的兜底基准。
 *
 * 取值只影响「相对路径会被解析成什么」，而本项目的资源加载**不走这条 URL 路径**
 * ——图集由 `wx.createImage()` 直接吃相对路径（`assets/terrain.png`），
 * 守这一点的是 verify:minigame 的「图集走包内相对路径」判据。
 * 用一个一眼看得出「不是真实网络地址」的 scheme，是为了避免将来有人拿它去 fetch。
 */
const FALLBACK_BASE = 'wxgame://code-package/';

/**
 * 一个值能不能当 `new URL(相对, base)` 的基准。判据是**试一次**，不是「长得像不像 URL」。
 *
 * ⚠️ 用**宿主当前那个**构造器试，这一点是必须的：真机上是我们装的 `MiniUrl`，
 * 开发者工具里是原生 `URL`，两者对「什么样的 base 能用」的接受度并不相同
 * （原生对非层级 base 直接抛，我们那份宽松得多）。拿一套固定规则去猜，
 * 只会猜出「本地绿、设备红」或者反过来 —— 那正是这一轮的原样。
 */
function usableAsBase(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false;
  const U = (g as Any).URL;
  if (typeof U !== 'function') return false;
  try {
    new U('base-probe', value);
    return true;
  } catch {
    return false;
  }
}

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
   * 相对 URL 的解析基准（替身用的那份）。
   *
   * ⚠️ 这个字段**不是装饰**：产物与 pixi 都会拿它当 `new URL(x, document.baseURI)`
   * 的 base。所以它必须是**绝对** URL（`new URL(x, '')` / `new URL(x, '/')` 都会抛）。
   *
   * ⚠️ 但**装上它并不够** —— 宿主那份 `document` 可用时我们会让路，那一支压根不经过
   * 这个对象；而微信开发者工具的模拟器正是那一支，且它的 `baseURI` 不能当基准。
   * 所以「让路」之前必须再走一遍 `ensureUsableBaseUri()`，理由见该函数的注释
   *（那里记着同一句报错的三次不同病因 —— 前两轮只治了替身这一侧，所以第三轮又红了一次）。
   */
  baseURI: FALLBACK_BASE,
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
 * 保证 `document.baseURI` 能当基准用 —— **即使用的是宿主那份 document**。
 *
 * ## 为什么非得管「让路」的那一支
 *
 * `installDocument()` 的第一条规则是「宿主那份 document 可用就让路」。这条规则对
 * `createElement` / `addEventListener` 成立（原生确实更完整），但 `baseURI` **不成立** ——
 * 它只有「能用 / 不能用」两种状态，没有「更丰富」的中间态。
 *
 * 微信开发者工具的模拟器给的 `document` 就正好卡在这个缝里：它有 `createElement`
 * （于是判「可用」→ 让路），而它的 `baseURI` **不能用来解析相对地址**。表现是
 * `Failed to construct 'URL': Invalid URL` + 「启动失败」弹窗。
 *
 * ⚠️ 这一条是**同一句报错的第三种病因**，前两轮都没治到这里：
 *   ① 无 DOM 宿主：我们的替身**当时没有** `baseURI` → base 是 `undefined`；
 *   ② 真机小游戏：**没有 `URL` 构造器**（BOM）→ `ReferenceError`；
 *   ③ 开发者工具模拟器：走的是**让路分支**，压根没用我们的替身
 *      —— 所以前两轮给替身补的 `baseURI` 在这一支上**一点用都没有**。
 *
 * ⇒ 三次都在同一行，因为那行同时依赖两样东西（构造器 + 基准），而四种宿主两两缺得不同。
 *    收敛点有两个，缺一不可：
 *      - **构建期**：`vite.minigame.config.ts` 的 `mota:strip-importer-url`
 *        把那个**死实参**整个剥掉（死代码，剥掉零损失，且不再依赖两样东西）；
 *      - **运行期**：本函数 —— 因为 pixi 里还有**活**的
 *        `new URL(url, document.baseURI)`（跨域判定）与 `getBaseUrl()`，
 *        它们仍是在用宿主这个值。
 */
export function ensureUsableBaseUri(target?: Any): void {
  const d = (target as Any) || (g.document as Any);
  if (!d) return;
  if (usableAsBase(d.baseURI)) return;

  const before = d.baseURI;
  try {
    // 定义成**自有数据属性**：真 DOM 里 `baseURI` 是 `Node.prototype` 上的访问器，
    // 摆在实例上正好把它遮住（DOM 对象都可扩展，实测有效）。
    Object.defineProperty(d, 'baseURI', { value: FALLBACK_BASE, configurable: true, writable: true });
  } catch {
    try {
      d.baseURI = FALLBACK_BASE;
    } catch {
      // 只读且不可定义 —— 认了。但必须让这件事**可见**：
      // 否则下一个「Invalid URL」又要从「哪个宿主、哪一行」重新查一遍。
      console.warn(
        `[minigame] document.baseURI = ${String(before)}（不能当相对 URL 的基准）且改不动；` +
          `产物里仍有 new URL(x, document.baseURI) 的调用点`
      );
      return;
    }
  }
  console.log(`[minigame] document.baseURI ${JSON.stringify(String(before))} 不能当基准，已改为 ${JSON.stringify(FALLBACK_BASE)}`);
}

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
  if (!!existing && typeof existing.createElement === 'function') {
    // ⚠️ 但**让路之前必须把基准 URL 校验一遍**。`createElement` 可用 ≠ 整个 document 可用：
    //    微信开发者工具的模拟器就是「能建元素、但 baseURI 不能当基准」。
    //    这一句漏掉的代价是「启动失败」弹窗 —— 见 `ensureUsableBaseUri()` 的注释。
    ensureUsableBaseUri(existing);
    return;
  }

  const target = (g.__motaDocumentShim as Any) || existing;
  if (target && typeof target === 'object') {
    // intro 选中的那个对象 —— 就地补，保住「一个对象、两处引用」。
    try {
      Object.assign(target, doc);
      // 宿主对象若**自带**一个不能当基准的 `baseURI`，上面的 assign 可能被它挡住
      // （只读访问器），所以这里再核一遍，与让路分支同一条纪律。
      ensureUsableBaseUri(target);
      return;
    } catch {
      /* 宿主对象不可写，退回整体安装 */
    }
  }
  safeAssign('document', doc);
  ensureUsableBaseUri(doc);
}
