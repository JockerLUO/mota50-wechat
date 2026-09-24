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
  /** 触摸回调登记表。派发在文件末尾的 `__touch` / `__tap`，见那里对「为什么必须非空」的说明。 */
  var handlers = { start: [], move: [], end: [], cancel: [] };
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

  // ── 抹掉 `URL` / `location`（2026-09-24 加）───────────────────────────
  //
  // 成因与 `Intl` 同形，但这次**两个本地宿主都恰好有**，所以「全绿」曾经什么都不说明：
  //
  //   Web Worker（verify:minigame）  有 URL   ← WorkerGlobalScope 自带
  //   真 Chromium（本页）            有 URL
  //   真机小游戏                     **没有**（URL 是 BOM）  ← 只有这一侧会炸
  //
  // 炸点是**拆包之后**才出现的：Vite 给每个 `await import()` 生成
  // `__vitePreload(loader, deps, importerUrl)`，第三实参在**实参位置**求值
  // （哪怕函数体里根本用不到它），形态是 `new URL("boot.js", document.baseURI).href`。
  // 它在 `autoDetectRenderer` 的调用链上 —— 启动必经之路，于是真机启动即失败：
  // `ReferenceError: URL is not defined`。单文件 iife 时代动态导入被全量内联，
  // 这段实参压根不存在，所以这是拆包带来的新问题。完整推理见 src/minigame/env/url.ts。
  //
  // `URL`：Web IDL 接口对象挂在 window 上是 configurable 的，能真删掉。
  // `location`：`[LegacyUnforgeable]` 只读自有属性，**删不掉也遮不住**。
  //            这里如实记一笔就够了 —— 那一侧（产物里唯一的用法是
  //            `globalThis.location` 的属性读取，见 pixi 的 determineCrossOrigin）
  //            由 verify:minigame 的 Worker 宿主负责覆盖，本页不假装测过。
  var hostHadUrl = typeof URL !== 'undefined';
  try {
    delete globalThis.URL;
  } catch (e) {
    /* 落到下面的遮蔽 */
  }
  if (globalThis.URL !== undefined) {
    try {
      Object.defineProperty(globalThis, 'URL', { value: undefined, configurable: true, writable: true });
    } catch (e) {
      /* 删不掉也遮不住 → __urlGone 为 false → 判据会红 */
    }
  }
  var hostHadLocation = typeof location !== 'undefined';
  try {
    delete globalThis.location;
  } catch (e) {
    /* LegacyUnforgeable，预期失败 */
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

  // `URL` / `location` 的取证与上面同规矩：**删除后瞬间**取值（此刻 game.js 还没跑），
  // 不能等启动之后再查 —— 那时垫片已经把它们补上了，「补上了」会被误报成「没删掉」。
  // （Intl 那一版就踩过这个坑，DOM 宿主侧误红过一次。）
  globalThis.__hostHadUrl = hostHadUrl;
  globalThis.__urlGone = typeof globalThis.URL === 'undefined';
  globalThis.__hostHadLocation = hostHadLocation;
  globalThis.__locationGone = typeof globalThis.location === 'undefined';

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

    // ── 代码包内的文件系统（同步读）─────────────────────────────────
    //
    // 与 Worker 宿主（`worker.js`）**同一套语义与同一条理由**，完整说明见那里。
    // 这里只说三件这一侧特有的：
    //
    //   - 表从 `globalThis.__motaData` 取（由 `/__data.js` 注入，服务器枚举
    //     `dist-minigame/data/` 生成）。key 就是**游戏代码传进来的那个字符串**，
    //     所以桩不做任何路径变换。
    //   - 路径不合规时只**记一笔**（`__readFileBadPath`）而不当场抛：这一侧是
    //     「有 DOM 的宿主」，某些宿主差异导致的报错会淹没在这里，交给驱动脚本统一判定
    //     比在桩里抛更好定位。
    //   - 不做任何容错补全 —— 理由同 worker.js：真机上会炸的写法不能在本地报绿。
    getFileSystemManager: function () {
      return {
        readFileSync: function (filePath, encoding) {
          note('readFileSync ' + filePath);
          var table = globalThis.__motaData || {};
          globalThis.__readFileCalls = (globalThis.__readFileCalls || 0) + 1;
          if (
            typeof filePath !== 'string' ||
            filePath.indexOf('./') === 0 ||
            filePath.indexOf('../') === 0 ||
            filePath.charAt(0) === '/'
          ) {
            globalThis.__readFileBadPath = filePath;
          }
          if (encoding !== 'utf8' && encoding !== undefined) {
            globalThis.__readFileBadEncoding = encoding;
          }
          if (!Object.prototype.hasOwnProperty.call(table, filePath)) {
            throw new Error('readFileSync: no such file: ' + filePath);
          }
          return table[filePath];
        }
      };
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

    // ── 触摸：**必须真的注册回调**（见文件末尾 `__touch` 的说明）──────────
    //
    // 这里原先写的是 `function () {}` —— 空实现，回调直接被丢掉。
    // 后果是**事件链从来没有被这一侧测过**：`wx.onTouchStart` 是这条路径上
    // 唯一的入口，空实现等于把整条链路（触摸 → 桥 → Pixi → pointertap）挖掉了，
    // 于是「画面正常但点不动」这类故障在有 DOM 的宿主里永远报绿。
    // （2026-09-21 用户实测：IDE 模拟器预览点不动，而本地四套校验全绿。）
    onTouchStart: function (cb) {
      handlers.start.push(cb);
      note('onTouchStart');
    },
    onTouchMove: function (cb) {
      handlers.move.push(cb);
      note('onTouchMove');
    },
    onTouchEnd: function (cb) {
      handlers.end.push(cb);
      note('onTouchEnd');
    },
    onTouchCancel: function (cb) {
      handlers.cancel.push(cb);
      note('onTouchCancel');
    },
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

  // ── 触摸派发：本页唯一的「玩家动作」入口 ─────────────────────────────
  //
  // 用法（驱动脚本侧的判据都走它）：
  //     window.__tap(x, y)          // 一次完整点击（touchstart + touchend）
  //     window.__touch('move', x, y)
  //
  // ## 为什么这件事不能省，以及为什么要**返回监听器个数**
  //
  // `wx.onTouch*` 是小游戏侧唯一的输入来源。这一页原来把它写成空实现，
  // 于是「触摸 → 事件桥 → Pixi 的 pointertap」整条链在本宿主里**从未被执行过**：
  // 四套校验全绿，而 IDE 模拟器上玩家点不动。判据缺一条，故障就藏一层。
  //
  // 返回值是给判据用的**诊断信息**，不是装饰：
  //     0 → 事件桥根本没装（`nativeDom` 那一侧提前 return 了，或 wx 没拿到）
  //     >0 → 桥装上了，接下来才是「事件能不能走到 Pixi」的问题
  // 这两种情况的修法完全不同，合并成「点不动」一个现象会白查很久。
  function touchPoint(x, y) {
    return {
      clientX: x,
      clientY: y,
      pageX: x,
      pageY: y,
      identifier: 0,
      force: 1,
      timeStamp: performance.now()
    };
  }

  globalThis.__touch = function (phase, x, y) {
    var t = touchPoint(x, y);
    var ev = {
      type: 'touch' + phase,
      // 真实事件里 touchend/touchcancel 的 `touches` 是空的（手指已抬起），
      // 而 `changedTouches` 才有那根手指 —— 桥读的是 changedTouches，别填错。
      touches: phase === 'end' || phase === 'cancel' ? [] : [t],
      changedTouches: [t],
      timeStamp: t.timeStamp
    };
    var list = handlers[phase] || [];
    for (var i = 0; i < list.length; i += 1) list[i](ev);
    return list.length;
  };

  globalThis.__tap = function (x, y) {
    var n = globalThis.__touch('start', x, y);
    globalThis.__touch('end', x, y);
    return n;
  };

  // 小游戏里 GameGlobal 就是全局对象本身
  globalThis.GameGlobal = globalThis;
})();
