/**
 * 微信小游戏运行时环境垫片 —— DOM / 事件体系的**最小可用子集**。
 * 本文件是这棵子树的**门面**：对外导出面与拆分前的 `env.ts` 逐字一致，
 * 同时负责在模块求值期把垫片装上。
 *
 * ## ⚠️ 本目录（含本文件）不允许 import 本目录之外的任何东西
 *
 * 拆分前这条规则写的是「本文件不允许出现任何 `import`」。那个写法**保护的是结果，
 * 不是原因** —— 真正要保证的是下面这条链：
 *
 *     入口的第一个 import 是 ./env
 *       → env 子树整体先求值
 *         → 垫片装好、`wx.createCanvas()` 第一次调用被我们抢下
 *           → 此后才轮到 pixi 的模块体
 *
 * 拆成目录后，`env/` **内部**互相 import 是完全安全的：那些兄弟模块同样排在
 * pixi 之前（`main.ts` 的 import 顺序没变，`env` 子树是一个整体）。真正会打破
 * 上面那条链的只有一种情况：**`env/` 里 import 了 `env/` 之外的东西**，
 * 尤其是 `pixi.js` —— 那会让 pixi 反过来排到我们前面求值，
 * 于是「垫片还没装上，pixi 模块体已经在读全局了」。所以规则收窄成现在这句。
 *
 * （完整原理见拆分前的原注释，仍然适用：ESM 的求值顺序是「依赖先于自身」。
 *   需要 `DOMAdapter` 的那部分在 `pixi-adapter.ts`，入口里排在 `env` 之后 import；
 *   而 `env/` 自己一个字节的 pixi 都不碰。）
 *
 * ## 内部层次（import 箭头**只能**从上往下，反向即为设计错误）
 *
 * ```
 *   state.ts           共享槽位 + 宿主对象（最底层，不依赖任何同目录模块）
 *   ├── assign.ts      装全局 / nativeDom 判据
 *   ├── system.ts      wx.getSystemInfoSync() 唯一入口
 *   ├── events.ts      三份事件总线 + hookEventTarget
 *   ├── mouse-event.ts MouseEvent 替身（读 displayElement）
 *   ├── navigator.ts   Intl / navigator 补齐       ← assign, system
 *   ├── canvas.ts      GL 补丁 + 离屏/上屏画布     ← assign, events
 *   ├── document.ts    document 替身               ← assign, canvas, events
 *   ├── globals.ts     installGlobals 装配顺序     ← assign, events, mouse-event, navigator, document
 *   ├── touch.ts       wx.onTouch* → 总线          ← assign, events, mouse-event
 *   ├── display.ts     上屏画布预订                ← canvas, system
 *   └── bare.ts        裸标识符自查                ← （只读 g）
 * ```
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
 *   见 `globals.ts` 里关于「为什么主动锁到鼠标分支」的说明。
 */

// ── 对外导出面：与拆分前的 env.ts 逐字一致 ────────────────────────────
// 显式逐项列出（不用 `export *`），这样「模块对外的承诺」在文件里是一张可读的清单。
export { g, wxApi } from './state';
export { canvasBus, documentBus, globalBus } from './events';
export { MiniMouseEvent } from './mouse-event';
export { patchGetContext, createOffscreenCanvas, patchDisplayCanvas } from './canvas';
export { nativeDom } from './assign';
export { installGlobals, assertInstalled } from './globals';
export { installTouchBridge } from './touch';
export { reserveDisplayCanvas, getReservedCanvas } from './display';

// ── 副作用：本子树一被 import 就把垫片装上 ──────────────────────────
//
// **不能**把这几句挪进入口的函数体。ESM 的求值顺序是「依赖先于自身」，
// 只要入口第一个 import 的是本子树，本子树就保证在整个模块图（含 pixi）之前求值；
// 一旦改成在入口函数体里调用，pixi 早就求值完了：垫片等于没装，
// 上屏画布也已经被人拿走了。
//
// 顺序本身也是有语义的，四项各管一段，详见各自文件头：
//   installGlobals        —— 全局垫片（Intl / navigator / document / MouseEvent / rAF）
//   installTouchBridge    —— wx.onTouch* → 三份总线（必须有 wx，没有则内部直接返回）
//   reserveDisplayCanvas  —— **抢下** wx.createCanvas() 的第一次调用
//   reportBareReachability—— 量一遍裸标识符，挂 __motaEnvBare 给探针
import { installGlobals } from './globals';
import { installTouchBridge } from './touch';
import { reserveDisplayCanvas } from './display';
import { reportBareReachability } from './bare';

installGlobals();
installTouchBridge();
reserveDisplayCanvas();
reportBareReachability();
