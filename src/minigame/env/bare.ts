/**
 * 量一遍「**裸标识符**读得到哪些全局」—— 在产物自己的作用域里量。
 *
 * ## 为什么非要在产物内部量，而且非要用「直接读」而不是 `typeof X`
 *
 * 前几轮排查 `Intl` / `navigator` / `document` 时，每次都要**等 IDE 报一次错**
 * 才知道某个全局的裸路径是死的 —— 因为「`globalThis.X` 有值」与「裸标识符 `X` 有值」
 * 是两件事（白名单式宿主会把它们切开），而从产物**外面**量到的永远是宿主那一侧。
 *
 * 这段代码在模块作用域里，它读到的裸标识符就是**模块图里所有代码读到的那个**
 * —— 也就是 pixi 读到的那个。于是「还有哪些全局是死的」一次就能全列出来，
 * 不必一轮报一个。
 *
 * ⚠️ 这也是本文件**不能**引入任何同名局部绑定（`Intl` / `navigator` / `document` /
 * `performance` / `MouseEvent` / `requestAnimationFrame` / `window` …）的原因：
 * 任何同名局部量都会把那句裸读变成读局部量，于是量出来的是我们自己，不是宿主。
 * 约束写在 `state.ts` 的文件头，全目录共同遵守。
 *
 * ⚠️ 两个细节：
 *
 * 1. **必须直接读 `X`，不能写 `typeof X`。** `typeof 未声明标识符` 按规范返回
 *    `'undefined'` 而**不抛**，于是「未声明」与「声明了但是 undefined」会被混成一种 ——
 *    而前者才是致命的（pixi 读它就是 `ReferenceError`，整包起不来）。
 *    直接读放进 try/catch 才能把三态分开：`类型名` / `'undefined'` / `'ReferenceError'`。
 * 2. **结果挂在 `globalThis` 上**（`__motaEnvBare`），不是导出给别的模块：
 *    模块间 import 会改变 ESM 求值顺序，而这个文件的存在意义就是「第一个求值」。
 *    走 props 传给探针（探查在 `pixi-adapter` 的 `shim` 埋点处顺手取走）。
 *
 * 判读方式：把结果与探针 `module` 阶段那栏 `env`（**属性路径** `typeof g.X`）对照。
 * **两者不一致 = 这个宿主的两条路径分叉**，那就照 `Intl` / `navigator` / `document`
 * 的做法补一个词法垫片（见 `vite.minigame.config.ts` 的 `PRELUDE`）。
 */
import { g } from './state';

export function reportBareReachability(): void {
  const read = (get: () => unknown): string => {
    try {
      return typeof get();
    } catch (err) {
      // `ReferenceError` = 这个标识符**根本没被声明**（最严重的那种）
      return (err as Error).name;
    }
  };

  const out: Record<string, string> = {
    // ── 已垫过词法垫片的三个：这里量的是「垫片有没有真的接上」──
    Intl: read(() => Intl),
    navigator: read(() => navigator),
    document: read(() => document),
    // ── 其余：量的是「宿主的作用域链给不给」，用来**一次列出全部缺口** ──
    performance: read(() => performance),
    requestAnimationFrame: read(() => requestAnimationFrame),
    cancelAnimationFrame: read(() => cancelAnimationFrame),
    MouseEvent: read(() => MouseEvent),
    TouchEvent: read(() => TouchEvent),
    addEventListener: read(() => addEventListener),
    removeEventListener: read(() => removeEventListener),
    dispatchEvent: read(() => dispatchEvent),
    window: read(() => window),
    self: read(() => self),
    Image: read(() => Image),
    HTMLImageElement: read(() => HTMLImageElement),
    HTMLCanvasElement: read(() => HTMLCanvasElement),
    WebGLRenderingContext: read(() => WebGLRenderingContext),
    CanvasRenderingContext2D: read(() => CanvasRenderingContext2D),
    fetch: read(() => fetch),
    XMLHttpRequest: read(() => XMLHttpRequest),
    atob: read(() => atob),
    btoa: read(() => btoa),
    structuredClone: read(() => structuredClone),
    queueMicrotask: read(() => queueMicrotask),
    TextDecoder: read(() => TextDecoder),
    TextEncoder: read(() => TextEncoder),
    URL: read(() => URL),
    ResizeObserver: read(() => ResizeObserver),
    AbortController: read(() => AbortController),
    OffscreenCanvas: read(() => OffscreenCanvas),
    createImageBitmap: read(() => createImageBitmap),
    matchMedia: read(() => matchMedia),
    devicePixelRatio: read(() => devicePixelRatio),
    location: read(() => location),
    screen: read(() => screen),
    WebAssembly: read(() => WebAssembly)
  };
  g.__motaEnvBare = out;
}
