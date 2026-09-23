/**
 * `installGlobals()` —— 垫片的**装配顺序**都在这里，所以这个文件是 `env/` 的顶层编排。
 *
 * 每一项的顺序理由写在调用点旁边。这里的注释之所以长得像事故报告，
 * 是因为「谁排在谁前面」在这个文件里是**有语义的**：
 * 前一项一抛，后一项全部失效，表现是黑屏且窗口里一条报错都没有。
 */
import { nativeDom, safeAssign } from './assign';
import { installDocument } from './document';
import { documentBus, globalBus, hookEventTarget } from './events';
import { MiniMouseEvent } from './mouse-event';
import { installIntl, installNavigator } from './navigator';
import { envState, g, type Any } from './state';

export function installGlobals(): void {
  // Intl 排在最前：它是 pixi **模块求值期**唯一会读的“裸标识符”全局，
  // 一旦缺失就是 `ReferenceError`，比 navigator 那条路径还早、还硬。
  installIntl();

  // navigator 紧随其后：它是 pixi 模块求值期会碰的第二个全局。
  installNavigator();

  // Pixi `_transferMouseData` 会调 performance.now()。小游戏不一定有。
  if (!g.performance) safeAssign('performance', { now: () => Date.now() });

  // 小游戏有 requestAnimationFrame；这个兜底是给「用 Node/vm 跑同一份产物」的
  // 离线校验用的，让同一条代码路径在没有 rAF 的宿主里也能跑。
  if (typeof g.requestAnimationFrame !== 'function') {
    safeAssign('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(g.performance.now()), 16));
    safeAssign('cancelAnimationFrame', (id: Any) => clearTimeout(id));
  }

  // `document` **两种情况都要过一遍** —— 这是第三轮黑屏那一类错配的解药。
  //
  // `nativeDom` 问的是「宿主有原生 DOM 吗」，但它用的是「在 且 不可覆盖」这条判据；
  // 而实测存在**第三种形态**：`document` 属性在、也覆盖得动，但**根本不可用**
  // （IDE 里那次：`hasDocument: true`，而 pixi 读裸 `document` 得到 undefined）。
  // 这种宿主会被 `nativeDom` 判成「非原生 DOM」，却在下面这行 return 之前就……
  // 不，它会正常走到 `installDocument()`。真正要防的是相反的一侧：
  // 宿主 `document` **不可覆盖但不可用** → `nativeDom` 为真 → 提前 return
  // → 谁都没补 → 渲染器构造时 `document.createElement` 照样炸。
  //
  // 所以让 `installDocument()` 自己判（判据与构建期 intro 完全一致：createElement 是不是函数），
  // 两边都调用：可用就让路（函数内部第一句 return），不可用就地补。
  installDocument();

  if (nativeDom) {
    // 原生 DOM 宿主：`document` / `MouseEvent` 这类**垫片让路** —— 宿主有更好的实现，
    // 硬装会抛（`document` / `navigator` 在 window 上是只读自有属性），
    // 而 `installNavigator()` 排在 `installGlobals()` 第一位，一抛就把后面全部带走
    //（含「抢上屏画布」），表现是**纯黑屏、且窗口里一条报错都没有**。
    //
    // ⚠️ 但**事件**不能让路（2026-09-21 实测修正，代价是「模拟器预览点不动」）。
    //
    // 小游戏的输入只能从 `wx.onTouch*` 来 —— IDE 模拟器也不例外（模拟器把鼠标转成
    // wx 触摸事件，上屏画布是原生视图，不受页面 DOM 事件系统管辖）。而 Pixi 会把
    // 监听注册到原生 `document` / `window` 上，那些对象永远不会响。
    // 所以这里把 Pixi 用到的事件类型接到我们的总线上，由 `installTouchBridge()` 派发。
    //
    // 安全性：只拦 `PIXI_EVENT_TYPES` 那 14 个类型，其余调用原样转发给原生实现，
    // 宿主自己的监听行为不变（见 `hookEventTarget`）。
    //
    // 注意 `installed` 照样要置位：`assertInstalled()` 问的是「环境有没有就绪」，
    // 而不是「垫片有没有装上」—— 让路也是一种就绪。
    envState.hookedDocument = hookEventTarget(g.document, documentBus);
    envState.hookedGlobal = hookEventTarget(g, globalBus);
    envState.installed = true;
    return;
  }

  // 以下三项各自独立：任何一个装不上都不能连坐其余（这是实测踩出来的约束）
  safeAssign('MouseEvent', MiniMouseEvent);
  envState.hookedGlobal = safeAssign('addEventListener', (type: string, fn: (ev: Any) => void) =>
    globalBus.addEventListener(type, fn)
  );
  safeAssign('removeEventListener', (type: string, fn: (ev: Any) => void) => globalBus.removeEventListener(type, fn));
  safeAssign('dispatchEvent', (ev: Any) => globalBus.dispatchEvent(ev));
  // 这一分支里 `document` 是 `installDocument()` 造的替身（它的 `addEventListener`
  // 接的是 `documentBus`），`globalThis` 是上面那两句 —— 三处都在总线上。
  // 标记出来，与 nativeDom 分支的 hook 结果**同义**：都是「事件已接到总线」，
  // 供触摸桥与判据统一判读（否则要分两种宿主写两套判据，正是这一轮踩的坑）。
  envState.hookedDocument = true;

  envState.installed = true;
}

/**
 * 入口在动 Pixi 之前先调它。
 *
 * 存在的意义是「把顺序错误变成一句人话」：如果将来有人调整了入口的 import 顺序，
 * 这里会立刻抛 `垫片未安装`，而不是让他去猜一连串 `document is not defined`。
 */
export function assertInstalled(): void {
  if (!envState.installed) {
    throw new Error('小游戏环境垫片未安装：入口的第一个 import 必须是 ./env，且不能早于它 import pixi.js');
  }
}
