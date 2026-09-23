/**
 * 上屏画布预订。
 *
 * ## 为什么必须在**模块求值期**就抢下来
 *
 * `wx.createCanvas()` 只在**第一次**调用时返回上屏画布，之后全是离屏。
 * 而 Pixi 自己在**模块求值期**就会调 `DOMAdapter.createCanvas()`：
 *
 *   `lib/rendering/renderers/canvas/utils/canvasUtils.mjs`
 *     → `canUseMultiply: canUseNewCanvasBlendModes()`   ← 模块级对象字面量里就调了
 *     → 内部 `createColoredCanvas()` × 2 + `createCanvas(6, 1)` × 1
 *
 * 三块 6×1 的小画布就诞生在 pixi 的模块体里，**早于宿主 `createMiniGameHost()`**。
 * 而那一刻我们的 DOMAdapter 还没装上（它必然排在 pixi 之后求值），
 * 于是这三块走的是默认 `BrowserAdapter.createCanvas`
 * → `document.createElement('canvas')` → 我们的 `createOffscreenCanvas()`
 * → **把上屏画布离屏用掉了**。
 *
 * 症状特别隐蔽：游戏照常启动、画面完全正确、触摸坐标也准，
 * 只不过渲染到了**一块没人看的画布**上 —— 真机表现就是**黑屏**，
 * 而自动化校验里表现为「上屏画布不是 wx.createCanvas() 的第一块」。
 *
 * 唯一的解法是**做第一个跑起来的模块**：`env/` 整体不含任何指向 `env/` 之外的 import，
 * 只要入口把它排在第一位，它就保证先于整个模块图（含 pixi）求值。
 * 这正是本目录存在的意义 —— 垫片要抢在 pixi 之前，画布也一样。
 * （`env/` 内部模块之间**可以**互相 import：那些依赖同样排在 pixi 之前，
 *   顺序约束只针对「不得把 pixi 拉到自己前面」，见 `index.ts` 的说明。）
 */
import { patchDisplayCanvas } from './canvas';
import { envState, wxApi, type Any } from './state';
import { readSystemInfo } from './system';

/** 预订上屏画布并打好补丁。幂等：宿主再调一次也只会拿回同一块。 */
export function reserveDisplayCanvas(): Any {
  if (envState.reservedCanvas) return envState.reservedCanvas;
  if (typeof wxApi?.createCanvas !== 'function') return null;
  const info = readSystemInfo();
  const w = info.windowWidth || info.screenWidth || 375;
  const h = info.windowHeight || info.screenHeight || 667;
  envState.reservedCanvas = patchDisplayCanvas(wxApi.createCanvas(), w, h);
  return envState.reservedCanvas;
}

export function getReservedCanvas(): Any {
  return envState.reservedCanvas;
}
