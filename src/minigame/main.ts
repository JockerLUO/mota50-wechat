/**
 * 微信小游戏入口。
 *
 * ## ⚠️ import 顺序就是本文件的全部要害，不要重排
 *
 *   ⓪ `./beacon`       —— 副作用 + 取证。**必须排在第一位**，而且它比 ① 更严格：
 *                        它要抓的正是「连垫片都没装上就死了」这种情况，
 *                        所以它不能晚于任何可能抛错的模块。
 *                        它自己**不含任何 import**，排在第一位就保证最先求值。
 *                        （非取证构建里它整个是空实现，见 `beacon.ts`。）
 *   ① `./env`          —— 副作用：装全局垫片（document / MouseEvent / 事件总线）。
 *                        它是 env/ 子树的门面；子树**内部**可以互相 import，
 *                        但**不许 import 子树之外的任何东西**（尤其 pixi.js），
 *                        否则 pixi 会反过来排到它前面求值。见 env/index.ts 文件头。
 *   ② `./pixi-adapter` —— 副作用：把 `DOMAdapter` 换成小游戏实现。
 *                        它是第一个 import pixi 的模块，因此 pixi 在它之后求值。
 *   ③ 其余模块          —— 此时环境已经完全就绪。
 *
 * 排错了不会立刻报错（Pixi 主入口在模块顶层只做 extensions 注册，不碰 DOM），
 * 但会在很后面冒出莫名其妙的 `xxx is not defined`。所以 `env/globals.ts` 里留了
 * `assertInstalled()` 做兜底断言。
 *
 * 构建：`npm run build:minigame` → `dist-minigame/game.js`（单文件 IIFE）
 *       加 `:beacon` 后缀的脚本会额外打开启动取证探针。
 */

import { beaconError, beaconShotAfter, beaconStage } from './beacon'; // ⓪
import './env'; // ①
import './pixi-adapter'; // ②
import { createMiniGameHost } from './host';
import { probeWebGL2 } from './probe';
import { host, setHost } from '../host';
import { Game } from '../app';

const log = (...args: unknown[]) => console.log('[mota]', ...args);

/**
 * 取触摸桥的自述（`env/touch.ts` 里挂的 `globalThis.__motaTouch`）。
 *
 * 用 try/catch 包着是因为它只在垫片装成功后才存在 —— 而「取不到」本身也是证据
 * （说明 wx 没拿到、或 env 没装上），所以返回 null 而不是抛。
 */
function readTouchFacts(): unknown {
  try {
    const facts = (globalThis as { __motaTouch?: { probe?: () => unknown } }).__motaTouch;
    return typeof facts?.probe === 'function' ? facts.probe() : null;
  } catch {
    return null;
  }
}

// ── 顺序硬约束（详见 host.ts 注释）──────────────────────────────────
// ① 先抢走上屏画布 —— 只有第一次 wx.createCanvas() 才是上屏那块
try {
  setHost(createMiniGameHost());
  beaconStage('host');
} catch (err) {
  // 这一步炸了就没有上屏画布，游戏必然起不来 —— 但要让它带着证据死
  beaconError('createMiniGameHost', err);
  throw err;
}

// ② 再探针 —— 它只能拿到离屏画布
const probe = probeWebGL2();
log('WebGL2 探针:', probe.ok ? '通过' : '失败', probe.detail);
beaconStage('probe', { ok: probe.ok, detail: probe.detail, reason: probe.reason ?? null });

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
      beaconStage('boot', {
        rendererType: snapshot.rendererType,
        resolution: snapshot.resolution,
        screen: snapshot.screen,
        floor: snapshot.floor,
        displayFloor: snapshot.displayFloor,
        pos: snapshot.pos,
        hp: snapshot.hp,
        // 图集是真加载了还是悄悄退成了程序化图形 —— 这一条在 IDE 里特别值得看：
        // IDE 有 `createImageBitmap`，Pixi 会走它的 bitmap 分支（在 blob worker 里
        // fetch 相对路径），而真机没有 Worker，走的是 Image 分支。两条路径不同，
        // 所以「IDE 里美术是矢量图」并不代表「真机也没美术」。
        atlasReady: snapshot.atlasReady,
        atlasError: snapshot.atlasError ?? null,
        // 触摸桥在**这个宿主**里实际选了哪条路（见 env/touch.ts 的 installTouchBridge）。
        // 这一项是给「模拟器/真机点不动」这类问题准备的：`canReal=false` 意味着
        // 上屏画布不是宿主真 canvas，我们派发的合成事件到不了 Pixi 挂在原生
        // document/window 上的监听 —— 那时要换机制（遮蔽宿主监听），而不是继续猜。
        touch: readTouchFacts()
      });
      // 等首屏落定再取像素：取的是「玩家看到的画面」，不是 init 那一刻
      beaconShotAfter(() => game);
    })
    .catch((err: unknown) => {
      console.error(err);
      beaconError('Game.create', err);
      host().bootSettled(err);
    });
}
