#!/usr/bin/env node
/**
 * 小游戏产物 · **有原生 DOM 的宿主**实测（宿主 = 真 Chromium 页面 + wx 桩）
 *
 * ## 这个脚本补的是哪一个洞
 *
 * 原本只有 `verify:minigame` 一条实测，宿主是 Web Worker —— 也就是「无 DOM」那侧，
 * 对应真机小游戏。但产物实际会跑在**四种**宿主上，其中微信开发者工具的**模拟器**
 * 属于第四种：**有原生 DOM，也有 wx**。它和另三种的代码路径**不同**，而差异只在它这边暴露。
 *
 * 实测踩到的那次：
 *   `document` / `navigator` 在 `window` 上是 `[LegacyUnforgeable]` 的只读属性，
 *   产物 IIFE 顶部又是 `"use strict"` → `g.navigator = {...}` 直接抛 TypeError。
 *   它排在 `installGlobals()` 的第一位，一抛就把后面的 document 垫片、rAF 兜底、
 *   以及紧随其后的「抢上屏画布」全部带走 —— **纯黑屏，且窗口里一条报错都没有**
 *   （异常进了 IDE 的控制台，而那个控制台不落盘）。
 *   Worker 宿主里永远不会发生这件事，因为那边本来就没有 document 可覆盖。
 *
 * 所以判据的核心不是「画面好看不好看」，而是这两条：
 *   ① **不抛**：原生宿主上垫片必须能「让路」而不是硬装
 *   ② **真的让路了**：原生 document / navigator 没有被替换成替身
 * 第 ② 条看着像洁癖，其实是在防「侥幸装上」——那会得到「画面正常但点不动」。
 *
 * ## 它证明了什么、没证明什么
 *
 * 证明：产物在「有 DOM」的宿主里能启动、能出画面、能跑完取证时间线。
 * **没证明**：真机、以及真正的微信 IDE。桩终究是桩 —— 它与 IDE 的差别至少还有
 * 图集加载路径（IDE 有 `createImageBitmap`，会走 pixi 的 bitmap 分支）。
 * 想拿真机/真 IDE 的证据，仍然要人在 IDE 里点一次「编译」，由取证通道回收。
 *
 * 用法：`npm run verify:dom`（退出码 0/1）
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, findChromium } = require('./lib/chromium.cjs');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist-minigame');
const HARNESS = path.join(ROOT, 'tools', 'minigame-harness');
const OUT = path.join(ROOT, 'assets', 'preview');
const PORT = Number(process.env.PORT || 4191);

if (!fs.existsSync(path.join(DIST, 'game.js'))) {
  console.error(`找不到 ${path.join(DIST, 'game.js')}，请先运行 npm run build:minigame`);
  process.exit(2);
}

// ── 静态服务器 ──────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

/** 允许从 dist-minigame 与 harness 两个根取文件，其余一律 404。 */
function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  if (clean === '/' || clean === '/index.html') return path.join(HARNESS, 'index-dom.html');
  const candidates = [
    path.join(HARNESS, clean),
    path.join(DIST, clean), // /game.js、/assets/*.png、/game.json
    path.join(DIST, 'assets', clean.replace(/^\/assets\//, ''))
  ];
  for (const p of candidates) {
    const abs = path.resolve(p);
    // 防目录穿越：只允许落在两个根里面
    if (!abs.startsWith(HARNESS) && !abs.startsWith(DIST)) continue;
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

const server = http.createServer((req, res) => {
  const file = resolveFile(req.url || '/');
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found: ' + req.url);
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// ── 判据收集 ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function add(label, ok, detail) {
  const mark = ok ? '✅' : '❌';
  if (ok) passed += 1;
  else {
    failed += 1;
    failures.push(label);
  }
  console.log(`  ${mark} ${label}${detail ? '  —— ' + detail : ''}`);
}

/** 把探针采回来的 hex 网格还原成 PNG，顺便统计「有没有画面」。 */
function analyzePixels(rec) {
  if (!rec || typeof rec.px !== 'string') return null;
  const { px, cols, rows } = rec;
  if (px.length !== cols * rows * 6) return null;
  const counts = new Map();
  for (let i = 0; i < cols * rows; i += 1) {
    const hex = px.slice(i * 6, i * 6 + 6);
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  const total = cols * rows;
  let bg = '000000';
  let bgCount = -1;
  for (const [hex, n] of counts) {
    if (n > bgCount) {
      bgCount = n;
      bg = hex;
    }
  }
  return {
    cols,
    rows,
    total,
    distinctColors: counts.size,
    background: bg,
    nonClear: total - bgCount,
    nonClearRatio: (total - bgCount) / total
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────
(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const base = `http://127.0.0.1:${PORT}/`;

  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });

  const pageErrors = [];
  const consoleMsgs = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).split('\n')[0]));
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    if (m.text().includes('favicon')) return;
    consoleMsgs.push(`[${m.type()}] ${m.text().split('\n')[0]}`);
  });
  const badResponses = [];
  page.on('response', (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
  });

  await page.goto(base, { waitUntil: 'load' });

  // 等游戏真正 create 完。带探针的产物还会多等一会儿，好让首帧像素采完（90 帧）。
  await page
    .waitForFunction(() => !!(globalThis.GameGlobal && globalThis.GameGlobal.mota), { timeout: 20000 })
    .catch(() => {});
  await page.waitForTimeout(3500);

  const state = await page.evaluate(() => {
    const g = globalThis;
    const mota = g.GameGlobal && g.GameGlobal.mota;
    const game = mota && mota.game;
    let snapshot = null;
    try {
      snapshot = game && typeof game.__probe === 'function' ? game.__probe() : null;
    } catch (e) {
      snapshot = { error: String(e && e.message) };
    }
    const storage = g.__storage || {};
    const parse = (v) => {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    };
    // 宿主事实：这些必须在垫片安装**之后**仍然成立，才能说明垫片让路了
    let docNative = false;
    let ua = null;
    let docIsWindowDoc = false;
    let docHasRealBody = false;
    let navIsObject = false;
    try {
      docNative = typeof document.createElement === 'function';
      docIsWindowDoc = document === window.document;
      docHasRealBody = !!(document.body && typeof document.body.appendChild === 'function');
      ua = String(navigator.userAgent).slice(0, 80);
      navIsObject = typeof navigator === 'object' && !!navigator.userAgent;
    } catch {
      /* 上面任何一句抛，都说明垫片把原生对象换成了替身 */
    }
    return {
      hasGame: !!game,
      snapshot,
      timeline: parse(storage.__motaBeacon),
      pixels: parse(storage.__motaBeaconPx),
      calls: g.__wxCalls || [],
      canvases: (g.__canvases || []).map((c) => ({ w: c.width, h: c.height })),
      docNative,
      docIsWindowDoc,
      docHasRealBody,
      ua,
      navIsObject,
      // 删 Intl 这件事由 wx-stub.js 在 game.js 之前做，取证分两处：
      //  —— hostHadIntl 读桩记下的**当时事实**（宿主本来有没有，证明删除有意义）
      //  —— intlGone 也读桩记下的**删除后瞬间**的值（那时 game.js 还没跑）
      //
      // ⚠️ `intlGone` 不能在启动之后现查 `!('Intl' in globalThis)`：垫片补上 Intl
      // 之后它当然为真 —— 那会让「垫片工作正常」被误报成「删除失败」。
      // （第一版就是这么写的，DOM 宿主侧直接误红了一次。）
      hostHadIntl: g.__hostHadIntl === true,
      intlGone: g.__intlGone === true,
      // 启动之后 Intl 在不在 —— 在，说明垫片补上了（因为桩已证明删干净过）
      intlAfterBoot: typeof Intl !== 'undefined',
      // navigator 三态取证，理由同 Intl：
      //  —— hostHadNavigator：宿主本来有没有（证明删除这个动作有意义）
      //  —— navigatorGone：删除后是否**不可用**（`in` 判不出来，得看值）
      //  —— navUsableAfterBoot：启动后是否**可用**（垫片补上了才是通过）
      hostHadNavigator: g.__hostHadNavigator === true,
      navigatorGone: g.__navigatorGone === true,
      navUsableAfterBoot: !!(g.navigator && typeof g.navigator.userAgent === 'string' && g.navigator.userAgent.length > 0)
    };
  });

  await page.screenshot({ path: path.join(OUT, 'dom-host.png') });

  // ── 判据 ─────────────────────────────────────────────────────────
  console.log('\n══ 小游戏产物 · 有原生 DOM 的宿主实测（宿主 = 真 Chromium 页面）══\n');
  console.log(`  UA: ${state.ua || '（拿不到）'}`);
  console.log(`  画布: ${state.canvases.map((c) => `${c.w}×${c.h}`).join(', ') || '（一块都没有）'}\n`);

  add(
    '宿主确实有原生 DOM（这一条是前置条件，不成立说明页面搭错了）',
    state.docNative && state.docHasRealBody && state.docIsWindowDoc,
    `createElement=${state.docNative} body.appendChild=${state.docHasRealBody} document===window.document=${state.docIsWindowDoc}`
  );

  // ★ 核心判据一：`document` —— 宿主有可用实现时，垫片必须**让路**
  //
  // 硬覆盖会抛（`document` 在 window 上是 `[LegacyUnforgeable]` 只读自有属性），
  // 而且它排在 `installGlobals()` 前面，一抛就把后面的 rAF 兜底与
  // 「抢上屏画布」全部连坐 → **纯黑屏，且窗口里一条报错都没有**。
  add(
    'document 让路：宿主原生实现未被替换',
    state.docNative && state.docIsWindowDoc && state.docHasRealBody,
    `document===window.document=${state.docIsWindowDoc} body.appendChild=${state.docHasRealBody}`
  );

  // ★ 核心判据二：`navigator` —— 宿主**没有/不可用**时，垫片必须**补上**
  //
  // 这一条才是把上一版打回来的地方。当时规则写成「有原生 DOM 就整体让路」，
  // 而 IDE 模拟器是 **#document 有、navigator 不可用**；Pixi 的**默认**适配器
  // （BrowserAdapter）又在自己模块顶层就被读了一次：
  //
  //     const defaultForceAllocation = isSafari();   // → getNavigator().userAgent
  //     getNavigator: () => navigator                // 裸标识符
  //
  // 这行发生在我们 `DOMAdapter.set(...)` **之前**，于是读到 undefined 当场抛
  // `Cannot destructure property 'userAgent' … as it is undefined`，
  // 整个包死在模块求值期（取证时间线只到 `module`）。
  //
  // 所以判据必须盯住「宿主不可用 → 由垫片补上」这条路径，
  // 而不是假设「有 DOM 就一定可用」。三个条件缺一不可：
  // 宿主本来有（删除有意义）→ 删完不可用（复现到位）→ 启动后可用（补上了）。
  add(
    'navigator 补齐：宿主不可用时垫片补上可用的 UA',
    state.hostHadNavigator === true && state.navigatorGone === true && state.navUsableAfterBoot === true,
    `宿主本来有=${state.hostHadNavigator} 删后不可用=${state.navigatorGone} 启动后可用=${state.navUsableAfterBoot}` +
      `  UA=${(state.ua || '').slice(0, 44)}…`
  );

  // ★ 宿主缺失的全局 `Intl` —— 这条判的是「测试本身有没有效」，不是配置洁癖
  //
  // 真机小游戏**没有** `Intl`，而 Pixi 在**模块求值期**就读了它的裸标识符：
  // esbuild 降到 es2015 时把 `typeof Intl?.Segmenter === 'function'` 改写成了
  // `typeof (Intl == null ? void 0 : Intl.Segmenter) === 'function'` ——
  // `typeof` 那层保护被绕掉（`typeof Intl` 本来不抛，`Intl == null` 会），
  // 于是 `ReferenceError: Intl is not defined` + 黑屏（IDE 里的实测症状）。
  // 所以本页在加载 `game.js` **之前**把 Intl 真删掉，让这条路径每次都被走到。
  //
  // 两个条件缺一不可：`hostHadIntl`（宿主本来有 ⇒ 删除这个动作有意义）
  // 与 `intlGone`（真删干净了 ⇒ 复现到位）。只置 `undefined` 会让
  // `Intl == null` 成立、错误消失，判据还报「通过」—— **假绿比不测更糟**。
  add(
    '宿主本来有 Intl，且已真删（复现真机小游戏的处境）',
    state.hostHadIntl === true && state.intlGone === true,
    `hostHadIntl=${state.hostHadIntl} intlGone=${state.intlGone}` +
      (state.intlGone === false ? ' —— 只置了 undefined，这条路径没被真正测到' : '')
  );

  // 与上一条配对：删掉之后**必须由垫片补上**。
  //
  // 这里正是「同一件事在两侧含义相反」的地方：启动后 `'Intl' in globalThis` 为
  // **真**才是通过（垫片补上了），为假反而是坏消息。所以删除状态必须在
  // `game.js` 之前取证（见 `intlGone`），否则这条判据会把「垫片正常」读成「删除失败」。
  add(
    'Intl 缺失时由垫片补上（所以「启动成功」不是靠宿主自带）',
    state.intlAfterBoot === true,
    `启动后 typeof Intl = ${state.intlAfterBoot ? 'object（垫片）' : 'undefined —— 那 pixi 早该抛了'}`
  );

  add(
    '页面没有未捕获异常（覆盖只读全局会在这里暴露）',
    pageErrors.length === 0,
    pageErrors.length ? pageErrors.join(' | ') : '全程无 pageerror'
  );

  add('游戏启动成功（GameGlobal.mota 已暴露）', state.hasGame, state.hasGame ? '已暴露' : '始终没有出现');

  const snap = state.snapshot || {};
  add('渲染器是 webgl（不是静默降级的 canvas）', snap.rendererType === 'webgl', `rendererType=${snap.rendererType}`);
  add('分辨率 = 设备像素比 3', snap.resolution === 3, `resolution=${snap.resolution}`);

  const first = state.canvases[0];
  // 渲染器的逻辑宽 × 像素比 = 画布的物理宽，两者对上才说明「渲染目标就是第一块画布」
  const firstIsTarget = !!first && !!snap.screen && snap.screen.w * snap.resolution === first.w;
  add(
    '上屏画布 = wx.createCanvas() 的第一块',
    firstIsTarget,
    first ? `#1 ${first.w}×${first.h}（渲染器 ${snap.screen?.w}×${snap.screen?.h} @${snap.resolution}x）` : '没有画布'
  );
  add('离屏画布确实拿到了（createCanvas ≥ 2 次）', state.canvases.length >= 2, `createCanvas × ${state.canvases.length}`);

  // 图集这一条**故意不作为失败判据**，只如实记录。
  //
  // 它不是产物的问题，是宿主差异：有 DOM 时 Pixi 走 `createImageBitmap` 分支，
  // 而那条分支在一个 blob worker 里 `fetch(src)` —— blob worker 的 base URL 是
  // `blob:null/...`，**相对路径无法解析**，于是图集失败、静默回退程序化图形。
  // 真机没有 Worker，走的是 `Image` 分支（经 DOMAdapter 落到 `wx.createImage()`），
  // 包内相对路径正常。所以「IDE 里美术是矢量图」推不出「真机也没美术」，
  // 反过来也一样 —— 这正是两种宿主必须分开测的理由。
  console.log(
    `  ${snap.atlasReady ? '✅' : 'ℹ️ '} 图集加载状态（宿主差异，不计入判据）  —— ` +
      (snap.atlasReady
        ? 'atlas.ready = true'
        : 'atlas.ready = false：Pixi 走了 createImageBitmap 分支，在 blob worker 里解析不了相对路径')
  );

  // ── 取证判据（只有 --mode wxbeacon 的产物才有）──────────────────
  const timeline = Array.isArray(state.timeline) ? state.timeline : null;
  let framePath = null;
  if (timeline) {
    const stages = timeline.map((r) => r.stage);
    const want = ['module', 'shim', 'hostModule', 'host', 'probe', 'boot'];
    add(
      '取证：时间线覆盖 module → shim → hostModule → host → probe → boot',
      want.every((s) => stages.includes(s)),
      stages.join(' → ')
    );
    const pxStats = analyzePixels(state.pixels);
    if (pxStats) {
      add(
        '帧缓冲里有实际画面（非背景色像素 > 30%）',
        pxStats.nonClearRatio > 0.3,
        `${pxStats.nonClear}/${pxStats.total} = ${(pxStats.nonClearRatio * 100).toFixed(1)}%（背景 #${pxStats.background}）`
      );
      add('画面不是纯色块（颜色种类 > 20）', pxStats.distinctColors > 20, `${pxStats.distinctColors} 种颜色`);
      const { pngFromHexGrid } = require('./lib/png.cjs');
      const { png, width, height } = pngFromHexGrid(state.pixels.px, state.pixels.cols, state.pixels.rows, 3);
      const dir = path.join(OUT, 'wx-beacon');
      fs.mkdirSync(dir, { recursive: true });
      framePath = path.join(dir, 'dom-host-frame.png');
      fs.writeFileSync(framePath, png);
      framePath = `assets/preview/wx-beacon/dom-host-frame.png（${width}×${height}，探针自采）`;
    } else {
      add('取证：拿到首帧像素', false, '没等到 __motaBeaconPx');
    }
  } else {
    console.log('  （产物没带取证探针；要看这一组判据请用 npm run build:minigame:beacon）\n');
  }

  // ── 输出 ─────────────────────────────────────────────────────────
  if (badResponses.length) {
    console.log('\n  非 200 响应（查「图集为什么没加载」先看这里）:');
    for (const l of badResponses.slice(0, 10)) console.log('    ' + l);
  }
  if (consoleMsgs.length) {
    console.log('\n  宿主日志:');
    for (const l of consoleMsgs.slice(0, 12)) console.log('    ' + l);
  }
  if (framePath) console.log(`\n  探针自采的首帧：${framePath}`);
  console.log(`  页面截图：assets/preview/dom-host.png`);

  console.log(
    failed === 0
      ? `\n✅ 全部通过（${passed} 项判据）\n`
      : `\n❌ ${failed} 项不通过（通过 ${passed} 项）：\n   - ${failures.join('\n   - ')}\n`
  );

  await browser.close();
  server.close();
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('实测脚本自身出错：', err);
  process.exit(2);
});
