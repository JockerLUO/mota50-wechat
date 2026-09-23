/**
 * 小游戏宿主实现。
 *
 * ## 画布顺序：谁排在哪一位
 *
 * `wx.createCanvas()` 的**第一次**调用返回的是**上屏画布**（直接显示在屏幕上），
 * 之后的调用才返回离屏画布。真实顺序是：
 *
 *   0. `env/` 模块求值期（`installGlobals()` → `installTouchBridge()` →
 *       `reserveDisplayCanvas()`）—— **预订**上屏画布（见 `env/display.ts`）
 *   1. `createMiniGameHost()` —— 取回预订的那块，按当前尺寸刷新补丁
 *   2. `probeWebGL2()`        —— 探针只能拿离屏画布
 *   3. Pixi 的 CanvasPool     —— 字体测量之类，也是离屏
 *
 * 第 0 步是**必需**的，不能省：Pixi 自己的模块体（`canvasUtils.mjs` 的
 * `canUseNewCanvasBlendModes()`）在求值期就会造 3 块 6×1 画布，
 * 排在宿主前面。少这一步的后果不会报错 —— 而是 Pixi 渲染到一块没人看的
 * 画布上，真机表现是**黑屏，且毫无线索**。
 */

import type { Host, RenderCanvas } from '../host';
import { g, getReservedCanvas, patchDisplayCanvas, wxApi } from './env';
import { beaconStage } from './beacon';

interface SystemInfo {
  pixelRatio?: number;
  windowWidth?: number;
  windowHeight?: number;
  screenWidth?: number;
  screenHeight?: number;
  platform?: string;
  system?: string;
  SDKVersion?: string;
  version?: string;
}

export function createMiniGameHost(): Host {
  const info: SystemInfo = wxApi.getSystemInfoSync();
  const dpr = Math.min(info.pixelRatio || 1, 3);

  let screen = {
    w: info.windowWidth || info.screenWidth || 375,
    h: info.windowHeight || info.screenHeight || 667
  };

  // 上屏画布**不是**在这里抢的 —— 它在 `env/display.ts` 的模块求值期就已经预订好了。
  // 因为在「本函数被调用」之前，Pixi 的模块体就已经借
  // `canvasUtils.mjs` 的 `canUseNewCanvasBlendModes()` 造掉了 3 块离屏画布，
  // 那时 `wx.createCanvas()` 的第一次调用就被用掉了。详见 `env/display.ts` 的
  // 「上屏画布预订」一节。这里只按当前尺寸把补丁刷新一遍（该函数幂等）。
  const canvas = patchDisplayCanvas(getReservedCanvas() ?? wxApi.createCanvas(), screen.w, screen.h);

  // 把系统信息挂到全局，方便小游戏调试器里一眼看到「这台机器是什么环境」——
  // 小游戏没有 navigator.userAgent 可查，出问题时要靠这几个字段定位。
  g.__motaSystemInfo = info;

  return {
    name: 'minigame',
    dpr,
    size: () => ({ ...screen }),
    canvas: () => canvas as RenderCanvas,
    attach: () => {
      // 上屏画布由小游戏运行时直接呈现，没有「挂载到 DOM」这一步。
    },
    onResize: (cb) => {
      wxApi.onWindowResize?.((res: { windowWidth: number; windowHeight: number }) => {
        screen = { w: res.windowWidth, h: res.windowHeight };
        // 逻辑尺寸变了，坐标映射的表也得换。patchDisplayCanvas 是幂等的，
        // 重新调一次即刷新 getBoundingClientRect。
        patchDisplayCanvas(canvas, screen.w, screen.h);
        cb();
      });
    },
    onKey: () => {
      // 小游戏没有键盘。触摸事件在 `env/touch.ts` 里桥接成 Pixi 的联邦事件，
      // 由各按钮自己的 pointertap 消费，不经过这里。
      // 若将来要接外接键盘/手柄，在这里转成方向键字符调 cb 即可。
    },
    bootSettled: (err) => {
      if (err === undefined) {
        console.log('[mota] 启动完成');
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error('[mota] 启动失败：', err);
      // 不白屏：小游戏里弹窗是唯一「玩家一定能看到」的通道。
      wxApi.showModal?.({
        title: '启动失败',
        content: message,
        showCancel: false,
        confirmText: '知道了'
      });
    },
    expose: (name, value) => {
      // 小游戏全局对象就是 GameGlobal（== globalThis）
      ;(g.GameGlobal ?? g)[name] = value;
    }
  };
}

// 取证：模块求值期的第二个埋点（另一个在 `pixi-adapter.ts`）。
// 收到它 = 「env + pixi + 适配器 + 本模块」都求值完了，还没炸；
// 没收到它而收到了 `shim` = 炸在 `host/probe/app` 这三个 import 里。详见 beacon.ts。
beaconStage('hostModule');
