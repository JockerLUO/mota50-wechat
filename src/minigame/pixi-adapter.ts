/**
 * 把 `DOMAdapter` 换成小游戏实现。
 *
 * 本文件是「垫片」与「项目其余部分」的分界线 —— 它是第一个 `import 'pixi.js'` 的模块，
 * 因此必须在 `env.ts` **之后**求值。入口 `main.ts` 里它排在 `./env` 后面就是为这个。
 *
 * Pixi 8.21 的 `DOMAdapter` 只有 9 个方法（`environment-browser/BrowserAdapter.mjs`
 * 整个文件 23 行），所以换起来成本很低 —— 这一点和 Pixi 5/6/7 时代要靠
 * `weapp-adapter` 造一棵虚拟 DOM 树完全不同。
 */

import { DOMAdapter } from 'pixi.js';
/**
 * 免 `eval` 补丁 —— **必须排在 `pixi.js` 之后、任何 `Renderer` 构造之前**。
 *
 * 小游戏（含 IDE 的子上下文）禁 `unsafe-eval`，于是 `new Function` 直接抛。
 * Pixi 8 有两处依赖它：
 *   ① `AbstractRenderer._unsafeEvalCheck()` —— 渲染器一构造就查，查不到就抛
 *      「Current environment does not allow unsafe-eval, please use pixi.js/unsafe-eval module...」
 *      （这就是本轮 IDE 时间线的最后一条：过了 `probe`，死在 `Game.create()` 里）
 *   ② `GlUniformGroupSystem._generateUniformsSync` / `GlUboSystem` / `GlShaderSystem`
 *      —— 用 `new Function` 动态生成 uniform/ubo 同步函数，每帧都跑
 *
 * 这个子路径导出是**纯副作用**：把上面几处的实现（外加 ParticleBuffer 的粒子更新）
 * 换成 `lib/unsafe-eval/` 下那份不用 eval 的 polyfill，并把两个 `_unsafeEvalCheck`
 * 覆盖成空实现。它 import 的 `../rendering/renderers/gl/GlUboSystem.mjs` 等路径，
 * 与主入口 `lib/index.mjs` 里的 `./rendering/...` **解析到同一批文件**，
 * 所以 Vite 去重后补丁打在真实类上 —— 这也是为什么它必须在本文件（第一个 import pixi
 * 的模块）里、而不是某个只在 Web 侧用的地方。
 *
 * `bare: no-new-function`（见 beacon 的 `bareView`）已经先一步印证了这个判断：
 * 那个环境里 `new Function` 本身就抛，`Intl`/`navigator` 探针全返回 `no-new-function`。
 */
import 'pixi.js/unsafe-eval';
import { assertInstalled, createOffscreenCanvas, g, wxApi } from './env';
import { beaconStage } from './beacon';

/**
 * `getWebGLRenderingContext()` 在 Pixi 里有 3 处调用点，全都是**用 `instanceof` 判版本**：
 *
 *   isWebGLSupported():  if (!getWebGLRenderingContext()) return false    ← 只要真值
 *   GlContextSystem:     gl instanceof getWebGLRenderingContext() ? 1 : 2  ← 要判成 2
 *   mapWebGLBlendModes:  同上（WebGL2 才有 MIN/MAX 混合模式）
 *
 * 小游戏里没有 `WebGLRenderingContext` 这个全局。返回 `undefined` 会让第一处直接 false，
 * 而 false 的后果是**静默降级到 CanvasRenderer**（不报错）。
 * 所以给一个空类：既满足真值，又不会把真实的 WebGL2 上下文误判成 WebGL1。
 */
class ShimWebGL1Context {}

/**
 * `CanvasTextMetrics` 会读 `getCanvasRenderingContext2D().prototype` 上有没有
 * `letterSpacing`。返回 `undefined` → 读 `.prototype` 直接 TypeError，
 * 而这条路径在**创建第一个 Text 时**就会走到（HUD 全是文字）。
 */
class ShimCanvas2DContext {}

/**
 * 用 `wx.request` 顶 `fetch`。
 *
 * 本项目当前不依赖它（MANIFEST 是构建期打进包的，图集走 `wx.createImage`），
 * 但适配层是公共设施：以后要加载远端 JSON 配置时，报「fetch is not defined」
 * 不如现在就把这条腿补上。
 */
function fetchViaWx(url: string): Promise<AnyFetchResponse> {
  return new Promise((resolve, reject) => {
    wxApi.request({
      url,
      responseType: 'arraybuffer',
      success: (res: any) => {
        const bytes: ArrayBuffer = res.data;
        const text = () => decodeUtf8(bytes);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: '',
          json: async () => JSON.parse(text()),
          text: async () => text(),
          arrayBuffer: async () => bytes,
          blob: async () => {
            throw new Error('小游戏适配层不提供 blob()');
          }
        });
      },
      fail: (err: unknown) => reject(new Error(`wx.request 失败：${url} ${JSON.stringify(err)}`))
    });
  });
}

interface AnyFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<any>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<never>;
}

/** 小游戏不保证有 `TextDecoder`，手写一个 UTF-8 解码兜底。 */
function decodeUtf8(bytes: ArrayBuffer): string {
  if (typeof (g as { TextDecoder?: unknown }).TextDecoder === 'function') {
    return new (g as { TextDecoder: new (label: string) => { decode(b: ArrayBuffer): string } }).TextDecoder(
      'utf-8'
    ).decode(bytes);
  }
  const u8 = new Uint8Array(bytes);
  let out = '';
  let i = 0;
  while (i < u8.length) {
    const b0 = u8[i++];
    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
    } else if (b0 < 0xe0) {
      cp = ((b0 & 0x1f) << 6) | (u8[i++] & 0x3f);
    } else if (b0 < 0xf0) {
      cp = ((b0 & 0x0f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f);
    } else {
      cp = ((b0 & 0x07) << 18) | ((u8[i++] & 0x3f) << 12) | ((u8[i++] & 0x3f) << 6) | (u8[i++] & 0x3f);
    }
    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

export const miniGameAdapter = {
  createCanvas: (width?: number, height?: number) => createOffscreenCanvas(width, height),
  createImage: () => wxApi.createImage(),
  getCanvasRenderingContext2D: () => g.CanvasRenderingContext2D ?? ShimCanvas2DContext,
  getWebGLRenderingContext: () => g.WebGLRenderingContext ?? ShimWebGL1Context,
  getNavigator: () => g.navigator ?? { userAgent: '' },

  /**
   * 必须返回**空串**，这是全线最容易踩的一脚。
   *
   * Pixi 解析资源路径走 `path.toAbsolute(url, root, DOMAdapter.get().getBaseUrl())`：
   *   baseUrl = '/'  →  'assets/terrain.png' 被拼成  '/assets/terrain.png'
   * 小游戏里带前导斜杠的路径不是「包内相对路径」，图集直接加载失败
   * （而且失败是静默的：`atlas.ready=false`，画面退回程序化图形，肉眼看着「还行」）。
   * 空串时 `path.join('', 'assets/terrain.png')` 原样返回，正是小游戏要的相对路径。
   */
  getBaseUrl: () => '',

  /** 只有加载 Web 字体时会被读，且 Pixi 那边有 `if (fonts)` 守卫。本项目用系统字体。 */
  getFontFaceSet: () => undefined,

  fetch: (url: string) => fetchViaWx(url),

  /** 只有位图字体（.fnt/.xml）会用到；本项目不用。显式抛错好过谜之 TypeError。 */
  parseXML: () => {
    throw new Error('小游戏适配层未提供 parseXML（本项目不使用位图字体）');
  }
};

export function installDomAdapter(): void {
  if (!wxApi) {
    throw new Error('未找到全局 wx：这份产物是给小游戏用的，请在微信小游戏环境（或提供 wx 的测试宿主）中运行');
  }
  // `Adapter` 接口本身没有从 pixi.js 主入口导出（只导出了 `DOMAdapter`），
  // 所以这里用 Parameters<> 取它的形参类型，比 `as any` 保留了大部分检查。
  // 需要断言的原因是我们的实现**故意**与浏览器版不同：fetch 返回的是手工拼的
  // Response 形状，getWebGLRenderingContext 返回的是一个空类做 instanceof 替身。
  DOMAdapter.set(miniGameAdapter as unknown as Parameters<typeof DOMAdapter.set>[0]);
}

// 顺序兜底：如果将来有人把 `installGlobals()` 从 env.ts 的模块顶层挪进入口函数体，
// 这里会立刻炸出一句人话，而不是让人去追一连串 `document is not defined`。
assertInstalled();

// 同样是副作用：本模块是入口里第一个 import pixi 的模块，
// 在它求值时 `./env` 已经装好了全局垫片。这一步之后 `../app` 才会求值。
installDomAdapter();

// 取证：模块**求值期**的埋点。顶层异常是本项目最难查的一类故障 ——
// 入口 `main.ts` 的函数体还没跑到，所以 `host`/`probe`/`boot` 三个阶段一个都不会出现，
// 采回来的时间线会**只有一条 module**，看不出炸在哪一段 import 里。
// 这里按 import 顺序铺两个埋点（本文件 + `host.ts`），把「六个 import 的黑盒」
// 切成三段：`module`→（env + pixi）→`shim`→（host/probe/app 模块）→`hostModule`→入口函数体。
// 非取证构建里 `beaconStage` 是空实现（第一行 return），不影响正式产物行为。
beaconStage('shim');
