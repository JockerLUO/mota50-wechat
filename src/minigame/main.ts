/**
 * 微信小游戏入口。
 *
 * ## ⚠️ import 顺序就是本文件的全部要害，不要重排
 *
 *   ① `./env`          —— 副作用：装全局垫片（document / MouseEvent / 事件总线）。
 *                        它自己**不含任何 import**，所以只要排在第一位，
 *                        就保证在整个模块图（含 pixi）之前求值。
 *   ② `./pixi-adapter` —— 副作用：把 `DOMAdapter` 换成小游戏实现。
 *                        它是第一个 import pixi 的模块，因此 pixi 在它之后求值。
 *   ③ 其余模块          —— 此时环境已经完全就绪。
 *
 * 排错了不会立刻报错（Pixi 主入口在模块顶层只做 extensions 注册，不碰 DOM），
 * 但会在很后面冒出莫名其妙的 `xxx is not defined`。所以 `env.ts` 里留了
 * `assertInstalled()` 做兜底断言。
 *
 * 构建：`npm run build:minigame` → `dist-minigame/game.js`（单文件 IIFE）
 */

import './env'; // ①
import './pixi-adapter'; // ②
import { createMiniGameHost } from './host';
import { probeWebGL2 } from './probe';
import { host, setHost } from '../host';
import { Game } from '../app';

const log = (...args: unknown[]) => console.log('[mota]', ...args);

// ── 顺序硬约束（详见 host.ts 注释）──────────────────────────────────
// ① 先抢走上屏画布 —— 只有第一次 wx.createCanvas() 才是上屏那块
setHost(createMiniGameHost());

// ② 再探针 —— 它只能拿到离屏画布
const probe = probeWebGL2();
log('WebGL2 探针:', probe.ok ? '通过' : '失败', probe.detail);

if (!probe.ok) {
  // 不白屏：原因文案已经写成「请升级微信」这种人话，直接弹给玩家
  host().bootSettled(new Error(probe.reason ?? 'WebGL2 不可用'));
} else {
  Game.create()
    .then((game) => {
      // ③ 最后建应用 —— Pixi 内部要的离屏画布（CanvasPool / 字体测量）也在这一步之后
      const snapshot = game.__probe() as Record<string, unknown>;
      if (snapshot.rendererType !== 'webgl') {
        // Pixi 的 autoDetectRenderer 在 WebGL 判定失败时会**静默**退到 CanvasRenderer：
        // 不报错、画面也出得来，但精灵/遮罩/滤镜都不对。这种降级必须留下痕迹。
        console.warn('[mota] 渲染器不是 webgl，而是', snapshot.rendererType, '——画面很可能不正确');
      }
      host().bootSettled();
      host().expose('mota', { game });
      log('启动完成，渲染器 =', snapshot.rendererType);
    })
    .catch((err: unknown) => {
      console.error(err);
      host().bootSettled(err);
    });
}
