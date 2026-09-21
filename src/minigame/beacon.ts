/**
 * 小游戏端「启动取证」探针。
 *
 * ## 它解决的是哪一个具体困境
 *
 * 微信开发者工具的 **服务端口**（设置 → 安全设置）默认关闭，而它是 CLI / automator
 * 驱动 IDE 的前提。本机在这条路上是死的（见 `docs/wechat-minigame.md`）：CLI 里那句
 * 「enter y to confirm」的自动应答分支从未被赋值，是死代码；`wechatide://` scheme
 * 只有 `skill/auth` 一条路由。
 *
 * 于是「模拟器里到底跑成什么样」这件事在外部**没有观测口**：
 *   - 截图：`screencapture` 需要「屏幕录制」授权，被 TCC 拒（could not create image）
 *   - 控制台：只存在调试器 webview 的内存里，不落盘
 *   - 日志：400 行里能确认「工程被当成小游戏加载」（`isMiniAppProject=false`），
 *           但确认不了「第一帧画出来了」——IDE 不记这个
 *
 * **所以让游戏自己说话。** 这个模块把启动过程、致命错误、以及**首帧的真实像素**
 * 发回本机的一个 HTTP 端点；顺带写一份进 `wx.setStorageSync`，作为网络不通时的兜底
 * ——那个值会被 IDE 落到 `WeappSimulator/WeappStorage/storage_*.json`，可以从盘上读到。
 *
 * ## 只在取证构建里存在
 *
 * 由 `vite.minigame.config.ts` 的 `define` 注入 `__MOTA_WX_BEACON__`：
 *   `npm run build:minigame`           → false，探针不装载、不运行、不发任何请求
 *   `npm run build:minigame:beacon`    → true，产物带探针，专供 IDE 里跑
 *
 * ⚠️ 期待「关掉时整块代码从产物里消失」会落空，原因值得记一笔：
 * 本项目 `minify: false`（**有意为之** —— 在微信开发者工具里要能直接读堆栈），
 * 而 Rollup 本身不做控制流可达性分析，`if (!ON) return;` 之后的语句它不认为是死代码，
 * 那是 terser/esbuild 的活。所以关掉时留下的是**不可达的函数体**：不发请求、
 * 不写存储、不产生对象，但仍然占约 3KB（在 1.97MB 的包里是 0.15%）。
 * 真要抹干净，把构建改为 `minify: 'esbuild'` 即可 —— 代价是堆栈不可读，不值得换。
 *
 * 顺带一条实测教训：验证「探针没进包」时**不能用 `grep "a\|b"`** —— BSD grep
 * 不支持 BRE 交替，会静默返回假阴性，把「进了包」误判成「没进包」。用 `grep -E`。
 *
 * ## ⚠️ 本文件不允许出现任何 `import`
 *
 * 和 `env.ts` 同一个理由，而且要求更高：它必须**排在 env.ts 前面**求值，
 * 否则「连垫片都没装上就死了」这种情况将没有任何痕迹 —— 而那恰恰是最可能发生的一种。
 * 入口 `main.ts` 把它列为第一个 import，本模块无依赖，因此保证最先跑。
 */

declare const __MOTA_WX_BEACON__: boolean;

/** 构建期常量，由 `define` 替换成字面量 true / false。 */
const ON: boolean = __MOTA_WX_BEACON__;

/** 本机取证端点。见 `tools/wx-beacon-server.cjs`。 */
const PORT = 8899;

type Any = any;

const g = globalThis as Any;
const wx: Any = g.wx;
const started = Date.now();

/** 每一步都带相对时间戳，这样即使只收到后半段也能看出「卡在哪一步多久」。 */
const since = () => Date.now() - started;

/**
 * 把「任何东西」变成能读的字符串。
 *
 * 这个函数是**踩过一次坑**才加的：`wx.onError` 在不同基础库 / IDE 上给的参数
 * 形状完全不同 —— 真机上是 `(msg: string, stack: string)`，而本机 IDE 里给的是
 * 一个**普通对象**。当时直接写 `String(msg)`，采回来的是 `"[object Object]"`，
 * 等于白采一轮（那一刻只知道「13ms 处炸了」，不知道炸的是什么）。
 *
 * 所以这里按「先挑已知字段、再 JSON、再退回 own keys」的顺序兜底，
 * 调用方另外把**原始形状**（`Object.prototype.toString` 与 key 列表）一并报上来 ——
 * 形状本身就是有用的事实，下次遇到新基础库可以直接按形状加分支。
 */
function describe(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Any;
    const parts: string[] = [];
    for (const k of ['name', 'message', 'msg', 'errMsg', 'reason', 'stack', 'error', 'code']) {
      const val = o[k];
      if (typeof val === 'string' && val) parts.push(`${k}=${val}`);
    }
    if (parts.length) return parts.join(' | ');
    try {
      const j = JSON.stringify(o);
      if (j && j !== '{}') return j;
    } catch {
      /* 循环引用 —— 继续往下兜 */
    }
    try {
      return `{${safeKeys(o)
        .map((k) => `${k}=${String(o[k])}`)
        .join(', ')}}`;
    } catch {
      /* 连取属性都可能抛，那就只剩形状了 */
    }
    return Object.prototype.toString.call(o);
  }
  return String(v);
}

function safeKeys(o: Any): string[] {
  try {
    return Object.keys(o).slice(0, 24);
  } catch {
    return [];
  }
}

function stackOf(v: unknown): string | null {
  const s = v && typeof v === 'object' ? (v as Any).stack : null;
  return typeof s === 'string' ? s.slice(0, 1500) : null;
}

function post(path: string, body: string): void {
  try {
    // 失败是正常路径（真机、或取证服务没起），必须静默 —— 探针绝不能影响游戏。
    wx?.request?.({
      url: `http://127.0.0.1:${PORT}${path}`,
      method: 'POST',
      header: { 'content-type': 'text/plain' },
      data: body,
      fail: () => {}
    });
  } catch {
    /* 忽略 */
  }
}

/**
 * 兜底通道：写进小游戏本地存储，IDE 会把它落到 WeappStorage/*.json。
 *
 * 分**两个键**存，理由是失败模式不同：
 *   `__motaBeacon`    时间线（阶段 + 异常），很小，每来一条就整体重写 ——
 *                     它要回答「走到第几步、在哪炸的」，丢了前面任何一条都会误判
 *   `__motaBeaconPx`  最后一次首帧像素，约 140KB —— 它只需要最新的那一张
 * 混在一个键里的话，140KB 的像素会把时间线挤掉。
 */
const timeline: Any[] = [];

function alsoStore(rec: Any): void {
  try {
    const small = { ...rec };
    if (small.stage === 'pixels') {
      const px = small.px;
      delete small.px;
      wx?.setStorageSync?.('__motaBeaconPx', JSON.stringify({ ...small, px }));
    }
    timeline.push(small);
    wx?.setStorageSync?.('__motaBeacon', JSON.stringify(timeline));
  } catch {
    /* 忽略 */
  }
}

/** 报一个阶段。`data` 里放该阶段能拿到的一切事实，别放结论。 */
export function beaconStage(stage: string, data?: Any): void {
  if (!ON) return;
  const rec = { stage, t: since(), data: data ?? null };
  post('/beacon', JSON.stringify(rec));
  alsoStore(rec);
}

/** 报一个异常。`where` 写清是**哪一步**炸的，比 stack 更有用。 */
export function beaconError(where: string, err: unknown): void {
  if (!ON) return;
  const e = err as Any;
  const rec = {
    stage: 'error',
    where,
    t: since(),
    message: describe(err),
    stack: typeof e?.stack === 'string' ? String(e.stack).slice(0, 1500) : null
  };
  post('/beacon', JSON.stringify(rec));
  alsoStore(rec);
}

/**
 * 装全局错误钩子。
 *
 * 覆盖不到的一种情况值得单独说明：**模块求值期就抛**（比如 pixi 在顶层读
 * `navigator.userAgent`）。小游戏里 `wx.onError` 对「首个脚本的顶层异常」是否上报
 * 因基础库版本而异，所以入口在关键步骤外面另加了 try/catch，双保险。
 */
export function beaconInstall(): void {
  if (!ON || !wx) return;
  try {
    wx.onError?.((a: unknown, b?: unknown) => {
      post(
        '/beacon',
        JSON.stringify({
          stage: 'wxError',
          t: since(),
          message: describe(a),
          arg2: b === undefined ? null : describe(b),
          // 形状与 key 列表是**有用的事实**：下次遇到另一版基础库可以直接照它加分支
          shape: a && typeof a === 'object' ? Object.prototype.toString.call(a) : typeof a,
          keys: a && typeof a === 'object' ? safeKeys(a) : null,
          stack: stackOf(a) ?? (typeof b === 'string' ? b.slice(0, 1500) : null)
        })
      );
    });
  } catch {
    /* 忽略 */
  }
  try {
    wx.onUnhandledRejection?.((res: Any) => {
      const r = res?.reason ?? res;
      post(
        '/beacon',
        JSON.stringify({
          stage: 'unhandledRejection',
          t: since(),
          message: describe(r),
          shape: r && typeof r === 'object' ? Object.prototype.toString.call(r) : typeof r,
          keys: r && typeof r === 'object' ? safeKeys(r) : null,
          stack: stackOf(r)
        })
      );
    });
  } catch {
    /* 忽略 */
  }
}

/**
 * 抽样读回帧缓冲，把画面变成一张可以离线重建的粗网格。
 *
 * ## 为什么要「先自己渲染一次」
 *
 * Pixi 的 context 是 `preserveDrawingBuffer: false`（见 `env.ts` 里
 * `getContextAttributes` 的补丁）。这种上下文里，绘制缓冲在**呈现之后**就不保证还有内容，
 * 所以不能在 rAF 回调外面随手 `readPixels` —— 拿回来大概率是全黑，
 * 然后被误判成「画面没出来」。在同一个 rAF 回调里先 `render()` 再 `readPixels`，
 * 中间不跨帧，内容才确定是这一帧的。
 *
 * ## 为什么要降采样
 *
 * canvas 是物理像素（390×844 逻辑 × dpr3 = 1170×2532），整幅 RGBA 有 11.8 MB。
 * 探针要把它塞进一次 HTTP POST，必须降。按步长抽样到约 105×195 个采样点，
 * 每点 6 个十六进制字符 —— 约 130 KB，够看清棋盘、HUD、名字胶囊的布局。
 * （抽样会漏掉细线，所以它是**布局证据**，不是逐像素的回归基线；后者归
 * `npm run verify:visual` 管，那条跑在真实 WebGL 上。）
 */
function capture(game: Any): void {
  const r = game?.app?.renderer;
  const canvas = game?.app?.canvas ?? r?.canvas;
  const gl = r?.gl;
  if (!gl || !canvas) {
    beaconError('capture', new Error('拿不到 renderer.gl 或 canvas'));
    return;
  }

  try {
    game.app.render();
  } catch (err) {
    beaconError('capture.render', err);
  }

  // gl.drawingBufferWidth 才是**真实的绘制缓冲**尺寸；canvas.width 在部分实现里
  // 与它不一致（canvas 是「外部尺寸」）。以绘制缓冲为准，readPixels 才不会越界。
  const W = gl.drawingBufferWidth || canvas.width;
  const H = gl.drawingBufferHeight || canvas.height;

  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);

  const stepX = Math.max(1, Math.ceil(W / 105));
  const stepY = Math.max(1, Math.ceil(H / 195));
  const cols = Math.floor((W - 1) / stepX) + 1;
  const rows = Math.floor((H - 1) / stepY) + 1;

  const px: string[] = [];
  const seen = new Set<number>();
  let nonBlack = 0;

  for (let gy = 0; gy < rows; gy++) {
    // WebGL 原点在**左下角**，而人看图是从上往下 —— 这里直接翻转，
    // 下游重建出来的 PNG 就是正的，不用再多记一条「记得 flip」。
    const y = H - 1 - Math.min(H - 1, gy * stepY);
    for (let gx = 0; gx < cols; gx++) {
      const x = Math.min(W - 1, gx * stepX);
      const i = (y * W + x) * 4;
      const rr = buf[i];
      const gg = buf[i + 1];
      const bb = buf[i + 2];
      px.push(((rr << 16) | (gg << 8) | bb).toString(16).padStart(6, '0'));
      seen.add((rr << 16) | (gg << 8) | bb);
      if (rr || gg || bb) nonBlack += 1;
    }
  }

  const total = cols * rows;
  const rec = {
    stage: 'pixels',
    t: since(),
    drawingBuffer: { w: W, h: H },
    canvasAttr: { w: canvas.width, h: canvas.height },
    cols,
    rows,
    resolution: r?.resolution ?? null,
    distinctColors: seen.size,
    nonBlackRatio: +(nonBlack / total).toFixed(3),
    px: px.join('')
  };
  post('/beacon', JSON.stringify(rec));
  // ⚠️ 这一条**必须**同时落存储，不能只走 HTTP。
  //
  // HTTP 通道要求取证服务端此刻正在监听；而 IDE 只在**点「编译」**时才重新加载游戏，
  // 那一刻服务端在不在，取决于人和机器的时序 —— 靠不住。
  // 存储通道没有这个问题：`wx.setStorageSync` 会被 IDE 落到
  // `WeappSimulator/WeappStorage/storage_*.json`，随时可以从盘上读。
  // 约 140KB，低于单键 1MB 的上限。
  alsoStore(rec);

  // 真截图是加分项，不是必需项：`wx.canvasToTempFilePath` 对 WebGL 主画布的支持
  // 在不同基础库上不一致，失败就走上面那条粗网格，不影响取证成立。
  try {
    wx?.canvasToTempFilePath?.({
      canvas,
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
      destWidth: canvas.width,
      destHeight: canvas.height,
      success: (res: Any) => {
        try {
          const b64 = wx.getFileSystemManager().readFileSync(res.tempFilePath, 'base64');
          post('/shot', String(b64));
        } catch (err) {
          beaconError('shot.readFile', err);
        }
      },
      fail: (err: Any) => {
        post('/beacon', JSON.stringify({ stage: 'shotUnsupported', err: JSON.stringify(err).slice(0, 300) }));
      }
    });
  } catch (err) {
    beaconError('canvasToTempFilePath', err);
  }
}

/**
 * 等 `frames` 帧后取一次画面。
 *
 * 为什么不是「启动完成立刻取」：`Game.create()` resolve 时只说明 `Application.init()`
 * 回来了，图集是异步加载的，此时棋盘上多半还是空的。等约 90 帧（≈1.5s）能让
 * 纹理、字体、首屏布局都落定 —— 取证要取「玩家看到的样子」，不是「init 时刻的样子」。
 */
export function beaconShotAfter(get: () => Any, frames = 90): void {
  if (!ON) return;
  let n = 0;
  const tick = () => {
    n += 1;
    if (n < frames) {
      try {
        g.requestAnimationFrame?.(tick);
      } catch {
        /* 忽略 */
      }
      return;
    }
    try {
      capture(get());
    } catch (err) {
      beaconError('capture.outer', err);
    }
  };
  try {
    g.requestAnimationFrame?.(tick);
  } catch (err) {
    beaconError('rAF', err);
  }
}

// ── 副作用：本模块是入口的第一个 import，所以下面这段跑在整个模块图之前 ──
//
// 用常量守卫包起来（而不是直接调用）是为了让正式构建里的模块**求值期零副作用**：
// `if (false) {...}` 是 Rollup 能识别并整段丢掉的形态，于是关掉探针时
// 连「安装钩子」这件事都不会发生。
if (ON) {
  beaconInstall();
  beaconStage('module', {
    // 这些事实决定了「垫片该怎么补」，先记下来
    hasWx: !!wx,
    wxKeys: typeof wx === 'object' && wx ? Object.keys(wx).length : 0,
    hasGameGlobal: !!g.GameGlobal,
    // 小游戏是「无 DOM 也无 WorkerGlobalScope」的第三种环境（见 env.ts 的注释），
    // 把实际情况发回来，省得再靠推断
    hasWindow: typeof g.window !== 'undefined',
    hasDocument: typeof g.document !== 'undefined',
    hasWorkerGlobalScope: typeof g.WorkerGlobalScope !== 'undefined',
    hasRAF: typeof g.requestAnimationFrame === 'function',
    hasPerformance: !!g.performance?.now
  });
}
