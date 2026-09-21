/**
 * 小游戏产物「无 DOM 环境」实测 —— Worker 内脚本。
 *
 * ## 为什么宿主是 Web Worker 而不是普通页面
 *
 * 第一版是在页面上「删掉 document」来伪装的，实测直接失败：
 * 按 HTML 规范 `document` 在 window 上是 `[LegacyUnforgeable]` 的**自有属性**
 * （只读、无 setter、且不可配置）—— `delete` 无效，`Object.defineProperty` 抛错，
 * 连 `globalThis.document = xxx` 在严格模式下都会抛
 * 「Cannot set property document of #<Window> which has only a getter」。
 *
 * 而 **Web Worker 天生就是一个没有 DOM 的 JS realm**：没有 `document`、`window`、
 * `Image`、`PointerEvent`、`TouchEvent`、`localStorage`、`DOMParser`，
 * 也**没有 `MouseEvent`**（UIEvent 系列只暴露给 Window）。
 * 这正是小游戏的处境，而且不需要伪造 —— 不用伪造的东西就没法「假装通过」。
 *
 * ## ⚠️ 一个小动作很关键：让 Pixi 仍走「浏览器环境」分支
 *
 * Pixi 用 `self.WorkerGlobalScope` 是否存在来判断自己在不在 Worker 里
 * （`environment-webworker/webworkerExt.mjs` 的 `test`）。小游戏既不是 Worker
 * 也不是浏览器窗口，但它装配的是**浏览器那一套**（`browserAll` =
 * accessibility + dom + events + spritesheet + filters + rendering）。
 * 所以这里把 `WorkerGlobalScope` 抹掉，保证被测的是与小游戏相同的那条代码路径。
 * 不抹的话，Pixi 会走 webworker 分支 —— 那测的就不是同一个东西了。
 *
 * ## 判据（全部是数据，不是「看着对」）
 *
 * 1. 无报错、启动没弹「启动失败」
 * 2. 渲染器是 webgl（不是静默降级的 canvas）
 * 3. 从**上屏画布的 WebGL 上下文** readPixels：非背景色像素占比、颜色种类数
 * 4. `wx.createImage` 收到的 src 全是 `assets/*.png`（无前导斜杠、无 hash）
 * 5. 派发 `wx` 触摸事件点「勇者相邻格」，勇者必须朝**那个方向**移动
 *    —— 坐标映射若漏掉 resolution，dpr=3 下点到的会是另一个格子
 */

'use strict';

const g = globalThis;

// ── 先接管 console，把日志随报告带回主线程（Worker 的 console 不会进 page.on('console')）
const logs = [];
for (const level of ['log', 'warn', 'error', 'info']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    logs.push(`[${level}] ${args.map((a) => (typeof a === 'string' ? a : safeStr(a))).join(' ')}`);
    orig(...args);
  };
}
function safeStr(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const report = {
  steps: [],
  problems: [],
  killed: [],
  imageSrcs: [],
  canvasCreates: 0,
  taps: [],
  moves: [],
  probe: null,
  bootFailed: null,
  pixels: null,
  spriteCount: 0,
  removedNaturally: [],
  /** 宿主（Worker）本来有没有 Intl。真机小游戏没有，见下面 kill 列表的说明。 */
  hostHadIntl: null,
  /** 抹除后 `'Intl' in g === false` 是否成立 —— driver 侧据此断言「这条测试真的有效」。 */
  intlGone: null,
  /** 启动之后 Intl 又被垫片补上了吗（应当为 true，说明游戏能跑不是因为宿主本来就有）。 */
  intlAfterBoot: null,
  /**
   * `new Function` 禁令是否装上了 / 启动后是否仍然有效。
   *
   * 见下面「── 4 禁 unsafe-eval」那一段。这一对值必须都是 true，
   * 否则「启动成功」就不能算作「不依赖 unsafe-eval」的证据。
   */
  evalBanned: null,
  evalStillBannedAfterBoot: null,
  /** 产物自己在 EvalError 之后有没有把 `Function` 换回去（正常应当没有）。 */
  functionWasSwapped: null,
  unremovable: [],
  deviation: null,
  screen: null,
  canvasSize: null,
  appCanvasSize: null,
  displayIsAppCanvas: null,
  canvasLedger: [],
  canvasStacks: [],
  webglInfo: null,
  /**
   * 取证探针写进小游戏存储的东西（只记 `__motaBeacon*` 两个键）。
   *
   * 为什么要在无 DOM 校验里管这件事：探针的**网络通道要求取证服务端恰好在监听**，
   * 而 IDE 只在点「编译」时重载游戏 —— 那一刻服务端在不在取决于人和机器的时序。
   * 所以真正可靠的那条通道是**存储**（IDE 会把它落到 WeappStorage/*.json）。
   * 与其到了 IDE 里才发现存储通道写坏了，不如在这里先验一遍。
   */
  beaconStorage: {},
  logs
};
const step = (m) => report.steps.push(m);
const fail = (m) => report.problems.push(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

addEventListener('error', (e) => fail(`[worker.error] ${e.message}`));
addEventListener('unhandledrejection', (e) => fail(`[unhandledrejection] ${e.reason && e.reason.message}`));

(async function main() {
  // ⚠️ 这几项必须挂在 main 作用域，不能写在 try 块里 —— `finally` 要读它们。
  //    （第一版写进了 try，`finally` 里直接 ReferenceError: displayCanvas is not defined）
  let displayCanvas = null;
  let touchStart = [];
  let touchEnd = [];
  /** 每次 wx.createCanvas() 的产物，按调用序编号。用来验证「上屏画布必须是第一块」。 */
  const canvases = [];
  /** 所有 getContext 调用记录 —— 谁在哪块画布上建了什么上下文，一目了然。 */
  const contextCalls = [];
  /** 前几块画布的创建调用栈 —— 用来定位「谁抢在宿主前面拿了画布」。 */
  const canvasStacks = [];
  /**
   * 禁 eval 的自查句柄（`/no-unsafe-eval.js` 挂上来的）。
   *
   * 必须声明在 `try` 之外的 main 作用域：`finally` 里要读它来判断
   * 「启动之后禁令还在不在」。第一版没这么做，`finally` 直接 ReferenceError。
   */
  let ban = null;

  try {
    // ── 0. 留住原始引用（马上要被抹掉）
    const realFetch = typeof fetch === 'function' ? fetch.bind(g) : null;
    const realCreateImageBitmap = typeof createImageBitmap === 'function' ? createImageBitmap.bind(g) : null;
    // Intl 在真机小游戏里**不存在**，必须先记下宿主本来的状态（Worker/页面都有），
    // 后面删掉它才能复现小游戏的处境。见 kill 列表与 notReallyGone 的说明。
    report.hostHadIntl = typeof Intl !== 'undefined';

    // ── 1. 让 Pixi 走浏览器环境分支（见文件头说明）
    //
    // ⚠️ 必须用 `delete`，不能写成 `g.WorkerGlobalScope = undefined`。
    //    Pixi 在 `assets/detections/utils/testVideoFormat.mjs` 里是这么判的：
    //       const inWorker = "WorkerGlobalScope" in globalThis
    //                        && globalThis instanceof globalThis.WorkerGlobalScope;
    //    赋成 undefined 会让 `in` 依然为真，随后 `instanceof undefined` 直接抛
    //    「Right-hand side of 'instanceof' is not an object」。
    //    （真机上这个全局本来就不存在，所以这只是宿主自己的坑。）
    delete g.WorkerGlobalScope;
    if ('WorkerGlobalScope' in g) {
      fail('删不掉 WorkerGlobalScope，无法迫使 Pixi 走 browserAll 分支，本次测试不成立');
      return;
    }
    step('已 delete self.WorkerGlobalScope，迫使 Pixi 加载 browserAll（=小游戏实际路径）');

    // ── 2. 记录「Worker 里本来就没有」的东西（这才是最有力的证据：不用伪造）
    for (const key of [
      'document',
      'window',
      'Image',
      'HTMLImageElement',
      'HTMLCanvasElement',
      'MouseEvent',
      'PointerEvent',
      'TouchEvent',
      'localStorage',
      'DOMParser',
      'FontFace'
    ]) {
      if (typeof g[key] === 'undefined') report.removedNaturally.push(key);
    }

    // ── 3. 抹掉 Worker 里有、但小游戏里没有的
    function kill(key) {
      try {
        delete g[key];
      } catch {
        /* 继承来的属性删不掉，下面用自有属性遮蔽 */
      }
      if (g[key] !== undefined) {
        try {
          Object.defineProperty(g, key, { value: undefined, configurable: true, writable: true });
        } catch {
          return;
        }
      }
      report.killed.push(key);
    }
    // `Intl` 是其中最有欺骗性的一个：Worker 和浏览器都有，真机小游戏没有，
    // 而 Pixi 恰好在**模块求值期**读它的裸标识符（esbuild 降级把
    // `typeof Intl?.Segmenter` 变成了 `Intl == null ? ...`）。
    // 不删掉它，这条路径就永远只有进了 IDE 才会暴露。
    ['fetch', 'createImageBitmap', 'XMLHttpRequest', 'navigator', 'caches', 'WebGLRenderingContext', 'Intl'].forEach(kill);
    step(`已抹掉 Worker 有、小游戏没有的全局：${report.killed.join(', ')}`);

    // Pixi 里环境探测有两套写法，必须分开对待：
    //
    //   真值判定 —— `if (globalThis.createImageBitmap && ...)`（loadTextures 用的就是它）
    //   `in` 判定 —— `if ("createImageBitmap" in globalThis && ...)`
    //
    // 对**真值判定**来说，置成 undefined 就够了；对 `in` 判定则不管用。
    // 而 Worker 里 `fetch` / `createImageBitmap` 挂在 WorkerGlobalScope 原型上，
    // `delete` 删不掉自己（本来就没有自有属性），所以这两个只能做到「假值」。
    //
    // 影响面：只有 `assets/detections/utils/testImageFormat.mjs` 那处 `in` 探测会多跑一次，
    // 而它整个包在 try/catch 里（调用 undefined 会抛 → 返回 false），与图集加载无关。
    // 真正决定图集走哪条路的是 loadTextures 里的真值判定，这里已经与小游戏一致。
    report.unremovable = ['createImageBitmap', 'fetch'].filter((k) => k in g);
    if (report.unremovable.length) {
      report.deviation =
        `${report.unremovable.join(' / ')} 挂在 WorkerGlobalScope 原型上，无法从 globalThis 上移除；` +
        '已置为 undefined，因此真值判定与小游戏一致，仅 assets/detections 的 `in` 探测有差异（被 try/catch 兜住）。';
    }
    if (g.createImageBitmap || g.fetch) {
      fail('createImageBitmap / fetch 仍是真值：Pixi 会改走 fetch+createImageBitmap 加载纹理，测的就不是 createImage 那条路了');
      return;
    }
    const notReallyGone = ['Image', 'ontouchstart', 'ResizeObserver', 'WorkerGlobalScope'].filter((k) => k in g);
    if (notReallyGone.length) {
      fail(`以下全局没能真正删掉（Pixi 的 \`in globalThis\` 探测会因此走错分支）：${notReallyGone.join(', ')}`);
      return;
    }

    // Intl 必须**真的不存在**（`'Intl' in g === false`），不能只置成 undefined：
    // 出问题的那句是裸标识符 `Intl == null`，只有它**未被声明**时才抛
    // ReferenceError。置成 undefined 会把这个 bug 悄悄“修好”，判据随之失效 ——
    // **假绿比不测更糟**，所以这里宁可显式红掉。
    report.intlGone = !('Intl' in g);
    if (!report.intlGone) {
      fail("Intl 仍在全局上（置成 undefined 也算）：裸标识符 ReferenceError 只在 Intl 不存在时复现，此判据已失效");
      return;
    }

    // ── 4. 禁 unsafe-eval —— 按 CSP 的样子复现微信 IDE 子上下文
    //
    // 实现抽去了 `/no-unsafe-eval.js`，与「有 DOM 宿主」那条路径共用同一份，
    // 免得两边对「什么叫禁 eval」产生分歧（理由与依据都写在那份文件的头部注释里）。
    //
    // ⚠️ 必须在本行（早于 `importScripts('/game.js')`）装上：Pixi 的
    //    `unsafeEvalSupported()` 结果会被**记忆化**，第一次探测发生在渲染器构造时。
    step("importScripts(/no-unsafe-eval.js)");
    importScripts('/no-unsafe-eval.js');
    ban = g.__unsafeEvalBan;
    if (!ban || !ban.armed()) {
      fail('没能禁掉 unsafe-eval（`new Function` 仍可用），这条判据不成立 —— 后面的结论不可信');
      return;
    }
    if (!ban.realCtorIntact()) {
      fail('真实 Function 构造器被弄坏了，禁 eval 的方式与 CSP 不符，判据失真');
      return;
    }
    report.evalBanned = true;
    step('已禁 unsafe-eval（`new Function` 抛 EvalError，Function 全局与原型链保持完好）');

    // ── 5. wx 运行时垫片
    const INFO = {
      windowWidth: 390,
      windowHeight: 844,
      screenWidth: 390,
      screenHeight: 844,
      pixelRatio: 3,
      platform: 'android',
      system: 'Android 13',
      SDKVersion: '3.5.0',
      version: '8.0.50'
    };
    report.screen = { w: INFO.windowWidth, h: INFO.windowHeight, dpr: INFO.pixelRatio };

    /** 顶 `wx.createImage()`：一块能被 WebGL 当纹理源的离屏画布 + src/onload/complete */
    function makeImage() {
      const img = new OffscreenCanvas(1, 1);
      let srcVal = '';
      img.complete = false;
      img.onload = null;
      img.onerror = null;
      Object.defineProperty(img, 'src', {
        configurable: true,
        get: () => srcVal,
        set: (v) => {
          srcVal = v;
          report.imageSrcs.push(String(v));
          realFetch(v)
            .then((r) => {
              if (!r.ok) throw new Error(`${r.status} ${v}`);
              return r.blob();
            })
            .then((b) => realCreateImageBitmap(b))
            .then((bmp) => {
              img.width = bmp.width;
              img.height = bmp.height;
              img.getContext('2d').drawImage(bmp, 0, 0);
              if (bmp.close) bmp.close();
              img.complete = true;
              if (img.onload) img.onload({ type: 'load' });
            })
            .catch((e) => {
              fail(`图片加载失败 ${v}: ${e && e.message}`);
              if (img.onerror) img.onerror(e);
            });
        }
      });
      return img;
    }

    g.wx = {
      getSystemInfoSync: () => INFO,
      getLaunchOptionsSync: () => ({ scene: 1001 }),
      createCanvas: () => {
        report.canvasCreates += 1;
        const idx = report.canvasCreates;
        // ⚠️ 第一次才是上屏画布；之后的都是离屏。
        // 顺序错了不会报错，只会渲染到一块没人看的画布上。
        const canvas =
          idx === 1
            ? new OffscreenCanvas(INFO.windowWidth * INFO.pixelRatio, INFO.windowHeight * INFO.pixelRatio)
            : new OffscreenCanvas(1, 1);
        canvas.__idx = idx;
        canvases.push(canvas);
        if (idx <= 6) {
          canvasStacks.push({
            idx,
            stack: (new Error().stack || '')
              .split('\n')
              .slice(1, 6)
              .map((l) => l.trim().replace(/^at\s+/, ''))
              .join('  ←  ')
          });
        }
        // 记账：谁在这块画布上建了什么上下文。这是判「上屏画布有没有被别的东西抢用」
        // 最直接的一条证据 —— 真上屏画布上只应该出现 webgl/webgl2。
        const rawGetContext = canvas.getContext.bind(canvas);
        canvas.getContext = (type, opts) => {
          const ctx = rawGetContext(type, opts);
          contextCalls.push({ idx, type, got: !!ctx });
          return ctx;
        };
        if (idx === 1) displayCanvas = canvas;
        return canvas;
      },
      createImage: makeImage,
      onTouchStart: (cb) => touchStart.push(cb),
      onTouchMove: () => {},
      onTouchEnd: (cb) => touchEnd.push(cb),
      onTouchCancel: () => {},
      onWindowResize: () => {},
      setPreferredFramesPerSecond: () => {},
      showModal: (o) => {
        report.bootFailed = o;
      },
      showToast: () => {},
      /**
       * 不变式仍然是「**游戏逻辑**不发网络请求」。但 `src/minigame/beacon.ts`
       * 是**测试基础设施**，它的请求只去回环地址的取证端点。
       *
       * 这里把它写成一条显式的例外规则、而不是干脆放宽整条守卫，是因为两种做法的
       * 信息量差很多：一刀切会让「探针开着时整个校验变红」，逼人把探针关掉
       * （于是丢掉它存在的意义）；而「只准去回环且只准那两个路径」既放行了探针，
       * 又照样拦住任何真的业务请求 —— 项目里一旦有人加了真实网络调用，这里还是会红。
       */
      request: (opts) => {
        const url = String(opts?.url ?? '');
        if (/^http:\/\/127\.0\.0\.1:\d+\/(beacon|shot)$/.test(url)) {
          report.beaconRequests = (report.beaconRequests || 0) + 1;
          return;
        }
        fail(`wx.request 被调用了（本项目不该走网络）：${url}`);
      },
      /**
       * 实现存储 API。小游戏本来就有，这里补齐有两个作用：
       *   ① 让取证探针的**落盘通道**在本地就能被验证（它才是 IDE 里可靠的那条路）
       *   ② 复现单键 1MB 上限 —— 探针的像素记录约 140KB，越界应当当场暴露
       */
      setStorageSync: (key, value) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        if (text.length > 1024 * 1024) {
          fail(`wx.setStorageSync('${key}') 单键超过 1MB（${text.length} 字节）—— 真机上会失败`);
        }
        if (String(key).startsWith('__motaBeacon')) report.beaconStorage[key] = text;
      },
      getStorageSync: (key) => {
        const text = report.beaconStorage[key];
        return text === undefined ? '' : text;
      }
    };

    // ── 6. 装载产物（importScripts 是宿主用来装载的，不是游戏依赖的 API）
    step('importScripts(/game.js)');
    importScripts('/game.js');

    // ── 7. 等启动 / 等弹窗
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (g.mota && g.mota.game) break;
      if (report.bootFailed) break;
      await sleep(100);
    }
    if (!g.mota || !g.mota.game) {
      fail(report.bootFailed ? `启动失败并弹窗：${report.bootFailed.content}` : '25s 内没起来，也没弹窗');
      return;
    }
    step('游戏已启动');
    const game = g.mota.game;

    // ── 7. 状态 / 渲染器 / 精灵数
    report.probe = game.__probe();
    let spriteCount = 0;
    (function walk(node) {
      if (node && node.texture && node.anchor) spriteCount += 1;
      const kids = node && node.children;
      if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i]);
    })(game.app.stage);
    report.spriteCount = spriteCount;

    // ── 7b. 画布台账：上屏画布到底是哪一块、长什么样、被谁建过什么上下文。
    //
    // 这一项是「渲染到一块没人看的画布上」这类问题的唯一线索来源 ——
    // 症状和「渲染正常但截图黑」完全一样，光看画面分不出来。
    const appCanvas = game.app.canvas;
    report.canvasLedger = canvases.map((c) => ({
      idx: c.__idx,
      w: c.width,
      h: c.height,
      isAppCanvas: c === appCanvas,
      contexts: contextCalls.filter((k) => k.idx === c.__idx).map((k) => `${k.type}${k.got ? '' : '(null)'}`)
    }));
    report.displayIsAppCanvas = displayCanvas === appCanvas;
    report.canvasSize = { w: displayCanvas.width, h: displayCanvas.height };
    report.appCanvasSize = { w: appCanvas.width, h: appCanvas.height };
    // 不往 problems 里塞：这是「画布序」这一条专属判据的事，
    // 混进「无报错」里会让后者失去「完全没有异常」的含义。
    step(
      report.displayIsAppCanvas
        ? '上屏画布 = wx.createCanvas() 第一块 ✅'
        : `上屏画布不是第一块：第一块 #${displayCanvas.__idx} 是 ${displayCanvas.width}×${displayCanvas.height}，` +
          `实际渲染 #${appCanvas.__idx} ${appCanvas.width}×${appCanvas.height}`
    );

    // ── 8. 读回帧缓冲
    //
    // 从**真正被渲染的那块**画布读，而不是「我们以为是上屏的那块」——
    // 这样即使画布搞错了，也能分辨出「画面是好的、只是拿错了画布」
    // 与「画面本身就不对」。这两件事的修法完全不同。
    game.app.render(); // 必须渲染完立刻读，否则 drawing buffer 已经失效
    const gl = appCanvas.getContext('webgl2');
    if (!gl) {
      fail(`渲染画布 #${appCanvas.__idx} 拿不到 webgl2 上下文`);
      return;
    }
    {
      const w = appCanvas.width;
      const h = appCanvas.height;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const clear = Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE)).map((v) => Math.round(v * 255));
      const colors = new Set();
      let nonClear = 0;
      for (let i = 0; i < buf.length; i += 4) {
        colors.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
        if (
          Math.abs(buf[i] - clear[0]) > 6 ||
          Math.abs(buf[i + 1] - clear[1]) > 6 ||
          Math.abs(buf[i + 2] - clear[2]) > 6
        ) {
          nonClear += 1;
        }
      }
      report.pixels = {
        w,
        h,
        total: w * h,
        nonClear,
        nonClearRatio: +(nonClear / (w * h)).toFixed(4),
        distinctColors: colors.size,
        clearColor: clear
      };
      report.webglInfo = {
        version: String(gl.getParameter(gl.VERSION)),
        renderer: String(gl.getParameter(gl.RENDERER)),
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE)
      };
    }

    // ── 9. 触摸 → 游戏
    function tap(clientX, clientY) {
      report.taps.push({ x: Math.round(clientX), y: Math.round(clientY) });
      const t = {
        clientX,
        clientY,
        pageX: clientX,
        pageY: clientY,
        identifier: 0,
        force: 1,
        timeStamp: performance.now()
      };
      for (const cb of touchStart) {
        cb({ type: 'touchstart', touches: [t], changedTouches: [t], timeStamp: t.timeStamp });
      }
      for (const cb of touchEnd) {
        cb({ type: 'touchend', touches: [], changedTouches: [t], timeStamp: t.timeStamp });
      }
    }

    async function settle(maxMs) {
      const t0 = performance.now();
      while (performance.now() - t0 < maxMs) {
        await sleep(60);
        if (!game.walking) return true;
      }
      return false;
    }

    const board = game.board;
    const cell = board.cellPx;
    // 除了 4 个相邻格，再点两个**远格**。
    // 相邻格只能证明「偏不到一格」，而缩放类错误（漏掉 resolution）会整体偏约 4 格；
    // 远格能把「映射在整个棋盘上线性正确」这件事钉死，相邻格做不到。
    //
    // 注意：远格**命中但走不过去是正常的** —— floor 1 从起点 (5,10) 起
    // 连通的空地只有 6 格（(4,9) (5,9) (6,9) (4,10) (5,10) (6,10)），
    // (5,6) 是墙、(9,9) 虽是空地但被第 7 列的墙隔断。
    // 所以「送到了哪一格」和「有没有走」必须分开判，见下。
    const probes = [
      ['down', 0, 1],
      ['up', 0, -1],
      ['left', -1, 0],
      ['right', 1, 0],
      ['far-up', 0, -3],
      ['far-right', 4, 0]
    ];
    for (const [name, dx, dy] of probes) {
      const before = game.__probe();
      const target = { x: before.pos.x + dx, y: before.pos.y + dy };
      const inBounds = target.x >= 0 && target.x <= 10 && target.y >= 0 && target.y <= 10;
      const p = board.toGlobal({ x: (target.x + 0.5) * cell, y: (target.y + 0.5) * cell });
      tap(p.x, p.y);
      await settle(6000);
      const after = game.__probe();
      const distBefore = Math.abs(before.pos.x - target.x) + Math.abs(before.pos.y - target.y);
      const distAfter = Math.abs(after.pos.x - target.x) + Math.abs(after.pos.y - target.y);
      // 点击「送到了哪一格」与「有没有真的走」是两件事，必须分开记：
      // 前者证明事件链 + 坐标映射，后者还掺进了游戏规则（那格可不可走）。
      // 合成一个判据就分不清故障在哪一侧 —— 实测中就被这么误导过。
      const hit = after.lastBoardClick || null;
      const arrived = !!hit && hit.x === target.x && hit.y === target.y;
      report.moves.push({
        dir: name,
        from: before.pos,
        target,
        inBounds,
        to: after.pos,
        hit,
        arrived,
        moved: after.pos.x !== before.pos.x || after.pos.y !== before.pos.y,
        closer: distAfter < distBefore
      });
    }
    step(`触摸派发 ${report.taps.length} 次`);
  } catch (err) {
    fail(`harness 抛错：${(err && err.stack) || err}`);
  } finally {
    // ── 若产物带取证探针，先等它把首帧采样写进存储，再交报告 ──
    //
    // 探针按「等 90 帧」取画面（≈1.5s，WebGL 的绘制缓冲在跨帧后不保证还有内容，
    // 所以必须在同一个 rAF 回调里 render + readPixels，见 beacon.ts）。
    // 不显式等它，报告就会在像素记录之前发出去 —— 而「像素网格能不能落进存储」
    // 正是本地要验的那一件事，等不到就等于没验。
    if (Object.keys(report.beaconStorage).length) {
      const pxDeadline = Date.now() + 12000;
      while (Date.now() < pxDeadline && !report.beaconStorage.__motaBeaconPx) await sleep(100);
      step(
        report.beaconStorage.__motaBeaconPx
          ? '取证探针首帧采样已落存储'
          : '取证探针 12s 内没写出像素记录'
      );
    }

    // 先把报告发回去，再试图截一帧（transferToImageBitmap 会清掉画布，必须放最后做）
    report.canvasStacks = canvasStacks;
    // 启动之后 Intl 又“回来了”吗？—— 本该有的。我们把它删掉，产物里的
    // `installIntl()` 应该补一个垫片上去（否则 pixi 那句裸标识符就抛了）。
    // 这一条与 `intlGone` 配对成证据链：删除前有 → 删干净 → 垫片补上 →
    // 于是「无异常 + 启动成功」是真实结论，而不是「宿主本来就有 Intl」的假绿。
    report.intlAfterBoot = typeof Intl !== 'undefined';
    // 禁令有没有在启动过程中被换掉 —— 若产物（或某个依赖）自己给 globalThis.Function
    // 赋了新值，那「启动成功」就可能是靠把 eval 要回来换取的，判据必须跟着失效。
    report.evalStillBannedAfterBoot = !!(ban && ban.armed());
    report.functionWasSwapped = !(ban && ban.stillInstalled());
    postMessage({ type: 'report', report });
    try {
      const game = g.mota && g.mota.game;
      // 截「真正被渲染的那块」，而不是「我们以为是上屏的那块」——
      // displayCanvas 可能根本不是渲染目标（见步骤 7b 的判断）。
      const shot = (game && game.app && game.app.canvas) || displayCanvas;
      if (game && shot && typeof shot.transferToImageBitmap === 'function') {
        game.app.render();
        const bitmap = shot.transferToImageBitmap();
        postMessage({ type: 'frame', bitmap }, [bitmap]);
      }
    } catch (err) {
      postMessage({ type: 'frameError', message: String((err && err.message) || err) });
    }
  }
})();
