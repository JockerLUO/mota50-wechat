/**
 * 「微信开发者工具模拟器」环境的最小 wx 桩。
 *
 * 只服务于 `tools/verify-dom-host.cjs` —— 那个脚本要在**有原生 DOM 的宿主**里
 * 跑一遍产物，而 IDE 模拟器正是这种宿主下最典型的一个。
 *
 * ## 桩的设计原则：只假装「环境」，不假装「行为」
 *
 * - `createCanvas()` 返回**真 canvas 并挂到页面上**。这是本文件最要紧的一条：
 *   IDE 模拟器里第一块画布就是玩家眼前那块，不在文档流里的 canvas
 *   `isConnected === false`、`getBoundingClientRect()` 全 0 ——
 *   而后者被 pixi 拿去做坐标倍率，测出来的触摸映射会是假的。
 * - `createImage()` 返回**真 img**，所以图集能走原生加载路径。
 * - `request()` **不真的发出去**，只记一笔。产物里的取证探针默认打向
 *   `127.0.0.1:8899`，真实的取证服务可能正在监听 —— 桩要是真发，
 *   一次本地校验就会污染取证数据（这个坑在 `verify:minigame` 那侧踩过）。
 *   证据通道改走 storage：桩把 `setStorageSync` 落到 `window.__storage`，
 *   判据从那里读，既真实又不外泄。
 *
 * ## 为什么需要它
 *
 * 「无 DOM」那侧已经有 `worker.js` 兜着，而两个宿主的**代码路径不同**：
 * 有 DOM 时 `document`/`navigator` 是只读属性，垫片硬装会抛 ——
 * 而且一抛就黑屏、且不留任何痕迹（IDE 的控制台不落盘）。
 * 没有这一页，这类故障永远只能等到用户在 IDE 里肉眼发现。
 */
(function () {
  'use strict';

  var calls = [];
  var storage = {};
  var info = {
    windowWidth: 390,
    windowHeight: 844,
    screenWidth: 390,
    screenHeight: 844,
    pixelRatio: 3,
    platform: 'devtools',
    system: 'iOS 17.0',
    version: '3.17.3',
    SDKVersion: '3.17.3',
    brand: 'devtools',
    model: 'iPhone 15'
  };

  var canvasCount = 0;
  var canvases = [];

  function note(name) {
    calls.push(name);
  }

  // ── 抹掉「浏览器/IDE 有、真机小游戏没有」的全局：`Intl` ──────────────
  //
  // 真机小游戏里没有 `Intl`，而 Pixi 在**模块求值期**就读了它的裸标识符：
  // esbuild 降到 es2015 时把 `typeof Intl?.Segmenter === 'function'` 改写成了
  // `typeof (Intl == null ? void 0 : Intl.Segmenter) === 'function'` ——
  // `typeof` 那层保护被绕掉，`Intl` 退回裸标识符，于是
  // `ReferenceError: Intl is not defined`，整个包起不来（IDE 里实测如此）。
  //
  // 这一步必须**真删**：`'Intl' in globalThis` 要变成 false。
  // 只置成 `undefined` 会让 `Intl == null` 成立、错误消失 —— 那等于把这个 bug
  // 悄悄修好，判据却还在报「通过」，比不测更糟。删不掉时下面的判据会红。
  var hostHadIntl = typeof Intl !== 'undefined';
  try {
    delete globalThis.Intl;
  } catch (e) {
    /* 删不掉 → __intlGone 为 false → verify-dom-host.cjs 判据红 */
  }

  // ── 抹掉 `navigator`：这是 IDE 模拟器与真浏览器**最关键的一处不同** ──────
  //
  // 实测（从 IDE 取回的探针记录）：模拟器有 `window`、有 `document`，
  // 但 `navigator` 拿到的值是 undefined。而 Pixi 的**默认**适配器是
  // BrowserAdapter，它的写法是裸引用 `getNavigator: () => navigator`；
  // 更早一行 `const defaultForceAllocation = isSafari()` 是**模块顶层的常量初始化**，
  // 也就是在「我们把 DOMAdapter 换成小游戏实现」**之前**就会执行 ——
  // 于是 `const { userAgent } = getNavigator()` 当场抛：
  //   Cannot destructure property 'userAgent' of '...getNavigator(...)' as it is undefined
  //
  // 真 Chromium 里 `navigator` 完备，所以这一页**测不出**这个坑 —— 必须删掉它，
  // 才能让「有 DOM 宿主」这一侧真的覆盖 IDE 的处境。
  var hostHadNavigator = typeof navigator !== 'undefined';
  try {
    delete globalThis.navigator;
  } catch (e) {
    /* 落到下面的遮蔽 */
  }
  if (globalThis.navigator !== undefined) {
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: undefined,
        configurable: true,
        writable: true
      });
    } catch (e) {
      /* 删不掉也遮不住 → 判据会红 */
    }
  }

  globalThis.__wxCalls = calls;
  globalThis.__storage = storage;
  globalThis.__canvases = canvases;
  globalThis.__hostHadIntl = hostHadIntl;
  globalThis.__intlGone = !('Intl' in globalThis);
  globalThis.__hostHadNavigator = hostHadNavigator;
  // 删干净了吗？——「让路」的判据不能只看它在不在，得看**值**：
  // IDE 里它“在”但值是 undefined。这一项为 true 才说明本页确实复现了那种处境。
  globalThis.__navigatorGone = !(globalThis.navigator && globalThis.navigator.userAgent);

  globalThis.wx = {
    // ── 系统信息 ──────────────────────────────────────────────────
    getSystemInfoSync: function () {
      note('getSystemInfoSync');
      return info;
    },
    getSystemInfo: function (o) {
      note('getSystemInfo');
      if (o && o.success) o.success(info);
    },
    getWindowInfo: function () {
      note('getWindowInfo');
      return info;
    },
    getDeviceInfo: function () {
      note('getDeviceInfo');
      return info;
    },
    getLaunchOptionsSync: function () {
      return { scene: 1001, query: {}, referrerInfo: {} };
    },

    // ── 画布 / 图像 ───────────────────────────────────────────────
    createCanvas: function () {
      var c = document.createElement('canvas');
      c.width = info.windowWidth * info.pixelRatio;
      c.height = info.windowHeight * info.pixelRatio;
      c.style.width = info.windowWidth + 'px';
      c.style.height = info.windowHeight + 'px';
      document.body.appendChild(c);
      canvases.push(c);
      canvasCount += 1;
      note('createCanvas #' + canvasCount);
      return c;
    },
    createImage: function () {
      note('createImage');
      return document.createElement('img');
    },

    // ── 网络：只记账，不真发（避免污染 8899 取证服务）─────────────
    request: function (o) {
      note('request ' + (o && o.url ? o.url.replace(/^https?:\/\/[^/]+/, '') : '?'));
      if (o && o.fail) o.fail({ errMsg: 'request:fail 桩不发真实请求' });
      return { abort: function () {} };
    },

    // ── 存储：探针的兜底证据通道 ──────────────────────────────────
    setStorageSync: function (k, v) {
      storage[k] = v;
      note('setStorage ' + k);
    },
    getStorageSync: function (k) {
      return storage[k] === undefined ? '' : storage[k];
    },
    removeStorageSync: function (k) {
      delete storage[k];
    },

    // ── 错误钩子：探针会挂上去，驱动脚本也靠它拿未捕获异常 ────────
    onError: function (fn) {
      globalThis.__onError = fn;
      note('onError');
    },
    onUnhandledRejection: function (fn) {
      globalThis.__onUnhandledRejection = fn;
      note('onUnhandledRejection');
    },

    // ── 触摸：IDE 里是鼠标转的，这里只登记，不主动派发 ────────────
    onTouchStart: function () {},
    onTouchMove: function () {},
    onTouchEnd: function () {},
    onTouchCancel: function () {},
    offTouchStart: function () {},
    offTouchMove: function () {},
    offTouchEnd: function () {},
    offTouchCancel: function () {},

    onShow: function () {},
    onHide: function () {},
    offShow: function () {},
    offHide: function () {},
    onWindowResize: function () {},
    offWindowResize: function () {}
  };

  // 小游戏里 GameGlobal 就是全局对象本身
  globalThis.GameGlobal = globalThis;
})();
