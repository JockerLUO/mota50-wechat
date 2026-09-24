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
const { inlineAsJs, collectJsSources, collectDataFiles } = require('./lib/package-tables.cjs');

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
    path.join(DIST, clean), // /game.js、/boot.js、/data/*.json、/assets/*.png、/game.json
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

/**
 * 包内文件表：源码 + 数据。
 *
 * 产物是 CJS 多文件（`game.js` require `./boot.js`），而数据是用
 * `wx.getFileSystemManager().readFileSync()` 同步读的 —— 两者都不能靠异步 fetch。
 * 所以由服务器当场把包内文件内联成两张表，页面用 `<script src>` 同步拿到。
 *
 * 两张表都是**枚举产物目录**得到的（见 `tools/lib/package-tables.cjs`），
 * 所以它们就是「包里有什么」的事实描述，不需要人维护。
 */
const PACKAGE_TABLES = {
  '/__sources.js': () => inlineAsJs('__motaSources', collectJsSources(DIST)),
  '/__data.js': () => inlineAsJs('__motaData', collectDataFiles(DIST))
};

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (PACKAGE_TABLES[url]) {
    res.writeHead(200, { 'content-type': MIME['.js'] });
    res.end(PACKAGE_TABLES[url]());
    return;
  }
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
      // `URL` 三态取证，理由同 Intl（删除状态必须在 game.js 之前由桩记下）。
      // 行为探针用属性路径 `g.URL` 读**产物装在 globalThis 上的那份**。
      hostHadUrl: g.__hostHadUrl === true,
      urlGone: g.__urlGone === true,
      urlUsableAfterBoot: typeof g.URL !== 'undefined',
      urlProbe: (() => {
        try {
          return new g.URL('a/../b.png', 'wxgame://code-package/dir/').href;
        } catch (err) {
          return `ERR: ${err && err.message}`;
        }
      })(),
      hostHadLocation: g.__hostHadLocation === true,
      locationGone: g.__locationGone === true,
      // navigator 三态取证，理由同 Intl：
      //  —— hostHadNavigator：宿主本来有没有（证明删除这个动作有意义）
      //  —— navigatorGone：删除后是否**不可用**（`in` 判不出来，得看值）
      //  —— navUsableAfterBoot：启动后是否**可用**（垫片补上了才是通过）
      hostHadNavigator: g.__hostHadNavigator === true,
      navigatorGone: g.__navigatorGone === true,
      navUsableAfterBoot: !!(g.navigator && typeof g.navigator.userAgent === 'string' && g.navigator.userAgent.length > 0),
      // 禁 unsafe-eval 的三态。桩在 `game.js` 之前装上（见 tools/minigame-harness/no-unsafe-eval.js），
      // 所以「装上的当刻」那个值由页面自己存证到 `__evalBannedAtStart`。
      //
      // ⚠️ 有 DOM 的宿主默认**允许** eval，Pixi 的 `unsafeEvalSupported()` 会返回 true ——
      //    这意味着「漏了 `pixi.js/unsafe-eval`」这个 bug 在允许 eval 的宿主里
      //    **永远不会暴露**。必须在有 DOM 这一侧也禁掉，判据才有意义。
      evalBannedAtStart: g.__evalBannedAtStart === true,
      evalStillBannedAfterBoot: !!(g.__unsafeEvalBan && g.__unsafeEvalBan.armed()),
      realCtorIntact: !!(g.__unsafeEvalBan && g.__unsafeEvalBan.realCtorIntact()),
      functionWasSwapped: !!(g.__unsafeEvalBan && !g.__unsafeEvalBan.stillInstalled())
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

  // ★ 宿主缺失的全局 `URL` —— 与 Intl 同一条规矩，但成因不同（2026-09-24）
  //
  // 这次**两个本地宿主都恰好有** `URL`（本页是真 Chromium，另一页是 Web Worker），
  // 而真机小游戏没有（`URL` 是 BOM）—— 于是「两侧全绿」曾经什么都不说明：
  // 拆包后 Vite 给动态导入生成的 `__vitePreload(loader, deps, importerUrl)`
  // 第三实参是 `new URL("boot.js", document.baseURI).href`，**实参照样求值**，
  // 位于 `autoDetectRenderer` 的调用链上 ⇒ 真机启动即失败。
  //
  // 判据结构与 Intl 那条一致（宿主本来有 ⇒ 删除有意义；真删掉 ⇒ 复现到位），
  // 但**追加行为探针**：只看「存不存在」分不清「宿主原生」与「我们的垫片」，
  // 而后者才是要证明的事。探针串带一段 `..`，一次验到 merge /
  // remove_dot_segments / recompose 三段。
  add(
    '宿主本来有 URL，且已抹掉（复现真机小游戏的处境）',
    state.hostHadUrl === true && state.urlGone === true,
    `hostHadUrl=${state.hostHadUrl} urlGone=${state.urlGone}` +
      (state.urlGone === false ? ' —— 没抹掉，这条路径没被真正测到' : '')
  );
  add(
    'URL 缺失时由垫片补上，且相对解析结果正确',
    state.urlUsableAfterBoot === true && state.urlProbe === 'wxgame://code-package/dir/b.png',
    `启动后 new URL('a/../b.png', 'wxgame://code-package/dir/') = ${state.urlProbe}` +
      (state.urlUsableAfterBoot ? '' : '（垫片没装上）')
  );
  // `location` 在真 Chromium 里是 `[LegacyUnforgeable]` 只读属性，**删不掉也遮不住** ——
  // 所以本页不假装测过它，只如实报出这一侧的覆盖边界。
  // 产物里 `location` 唯一的用法是 pixi `determineCrossOrigin` 的属性读取
  // （`loc || (loc = globalThis.location)`），那条路径由 `verify:minigame` 的
  // Worker 宿主负责覆盖（那里 `location` 删得掉）。
  if (!state.locationGone) {
    console.log(
      `  ⓘ location 未能抹掉（真 Chromium 的 [LegacyUnforgeable] 属性）：` +
        `hostHadLocation=${state.hostHadLocation}。该路径由 verify:minigame 覆盖。\n`
    );
  }

  // ★ 禁用 unsafe-eval —— `pixi.js/unsafe-eval` 有没有真的接管（2026-09-21 第四轮）
  //
  // 微信 IDE 的子上下文是 CSP 禁 eval 的，实测死在 `Game.create()` 里：
  //   Error: Current environment does not allow unsafe-eval, please use pixi.js/unsafe-eval ...
  //
  // 这条判据在**有 DOM 的宿主**上尤其必要，而且不是「顺便再测一遍」：
  // 浏览器默认允许 eval，`unsafeEvalSupported()` 会返回 true —— 也就是说
  // 在允许 eval 的宿主里，「漏了 `pixi.js/unsafe-eval`」这个 bug 永远不暴露，测试全绿但什么都没测到。
  // 所以本页在 `game.js` 之前把 `new Function` 禁掉（实现与无 DOM 宿主共用
  // `tools/minigame-harness/no-unsafe-eval.js`）。
  //
  // ⚠️ 不能用「产物里搜 `new Function`」代替：原实现是死代码，被 polyfill 在原型上覆盖，
  //    Rollup tree-shake 不掉，必然还能搜到。唯一有效的证法是让它执行期抛错。
  add(
    '宿主已禁 unsafe-eval（`new Function` 抛 EvalError）—— 本组判据的前提',
    state.evalBannedAtStart === true,
    `装上的当刻 armed=${state.evalBannedAtStart}`
  );
  add(
    '启动后禁令仍有效（成功不是靠把 eval 要回来）',
    state.evalStillBannedAfterBoot === true && state.functionWasSwapped === false,
    `仍 armed=${state.evalStillBannedAfterBoot} Function 被换=${state.functionWasSwapped}`
  );
  add(
    '禁的是 eval 而非 Function 本身（真实构造器仍完好）',
    state.realCtorIntact === true,
    `new Function("return true")() === true → ${state.realCtorIntact}`
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

  // ★ 图集：从「只记录、不计入判据」升级为**硬判据**（2026-09-21）。
  //
  // 原先不计入的理由是「宿主差异」：有 DOM 时 Pixi 走 `createImageBitmap` 分支，
  // 那条分支在 blob worker 里 `fetch(src)` —— base URL 是 `blob:null/...`，
  // 相对路径解析不了，于是图集失败、静默回退程序化图形。当时把它当成「环境的锅」。
  //
  // 但用户实测反馈是：**PC 端微信预览「界面简陋」**——同一份产物在另一类宿主里
  // 也退回了程序化图形。这就说明「宿主差异」这个解释是错的：游戏素材加载不该由
  // 宿主碰巧有没有 `createImageBitmap` 抽签决定。
  // 现在 `atlas.ts` 在小游戏端显式走 `wx.createImage()` + `ImageSource`，
  // 唯一依赖只剩「包内相对路径」—— 那是所有宿主都必须支持的东西。
  //
  // 所以这条判据要**跟着变成红/绿**：它现在守的正是「素材有没有真的用上」。
  // 只在 `atlas.ready=false` 时可能漏掉一类情况 —— 静默回退（画面只是变朴素、
  // 没有任何报错），所以 `atlasError` 也一起打出来，便于区分失败原因。
  add(
    '图集加载成功（素材真的用上了，不是回退程序化图形）',
    snap.atlasReady === true,
    snap.atlasReady === true
      ? 'atlas.ready = true'
      : `atlas.ready = false${snap.atlasError ? `　原因：${snap.atlasError}` : ''}`
  );

  // ── 触摸 → 游戏：本侧**原本一条判据都没有**（2026-09-21 补）──────────
  //
  // 无 DOM 的 Worker 宿主早就有「派发触摸 → 勇者移动」的端到端判据
  // （见 worker.js 第 9 节），有 DOM 的这一侧却只有「画面出来了」。
  // 于是「IDE 模拟器预览点不动」在本地四套校验里**永远报绿** ——
  // 探针能证明画面渲染了，证明不了玩家能不能碰它。
  //
  // 这条判据的设计要点是**把失败拆开报**（`__probe().lastBoardClick` 专为此存在）：
  //     监听器 0 个               → 事件桥没装（`nativeDom` 那一侧提前 return 了）
  //     有监听器、但没命中任何格   → 事件没走到 Pixi（分支/目标对象不匹配）
  //     命中了但不是那格          → 走到了，坐标映射偏了（漏 resolution 会整体偏约 4 格）
  //     命中对了但没移动          → 事件链没问题，是那格本来就走不过去（游戏规则）
  // 合成一条「点不动」会把这四种混成一个现象，修法完全不同。
  const touch = await page.evaluate(async () => {
    const g = globalThis;
    const game = g.GameGlobal && g.GameGlobal.mota && g.GameGlobal.mota.game;
    if (!game || typeof g.__tap !== 'function') return { ok: false, reason: '没有 game 或 wx 桩没提供 __tap' };
    const board = game.board;
    const cell = board.cellPx;
    // 四个相邻方向：floor 1 起点 (5,10) 周围有连通空地，四个方向都试，
    // 只要有一格是路就足以证明「事件链 + 坐标映射」是对的（可走与否是游戏规则）。
    const probes = [
      ['down', 0, 1],
      ['up', 0, -1],
      ['left', -1, 0],
      ['right', 1, 0]
    ];
    const results = [];
    let listeners = null;
    for (const [name, dx, dy] of probes) {
      const before = game.__probe();
      const target = { x: before.pos.x + dx, y: before.pos.y + dy };
      const p = board.toGlobal({ x: (target.x + 0.5) * cell, y: (target.y + 0.5) * cell });
      listeners = g.__tap(p.x, p.y);
      const t0 = performance.now();
      while (performance.now() - t0 < 3000 && game.walking) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const after = game.__probe();
      const hit = after.lastBoardClick || null;
      results.push({
        dir: name,
        target,
        hit,
        arrived: !!hit && hit.x === target.x && hit.y === target.y,
        moved: after.pos.x !== before.pos.x || after.pos.y !== before.pos.y
      });
    }
    return {
      ok: true,
      listeners,
      results,
      // 取 `probe()` 的结果而不是 `__motaTouch` 本身：钩子/画布形态要**现算**才准
      //（上屏画布是游戏起来之后才有的），`__motaTouch` 上的静态字段是安装当刻的快照。
      facts: g.__motaTouch && typeof g.__motaTouch.probe === 'function' ? g.__motaTouch.probe() : null
    };
  });

  if (touch.ok) {
    const arrived = touch.results.filter((r) => r.arrived);
    const moved = touch.results.filter((r) => r.moved);
    const detail = touch.results.map((r) => `${r.dir}→${r.hit ? `(${r.hit.x},${r.hit.y})` : '无'}`).join(' ');
    add(
      '触摸桥装上了（wx.onTouchStart 至少有一个监听器）',
      touch.listeners > 0,
      `监听器 ${touch.listeners} 个${touch.listeners ? '' : '（0 = 事件桥根本没装，玩家必然点不动）'}`
    );
    // ★ 这一条是「模拟器点不动」的护栏。
    //
    // 小游戏的触摸只能从 wx.onTouch* 来，而 Pixi 会把监听挂到 canvas / document /
    // globalThis 上 —— 三处都得接到总线，缺一处就有一类事件送不到
    //（缺 canvas → 按下收不到；缺 document → 悬停/详情面板不更新；缺 global → 抬手收不到，
    // 而 pointertap 正是在抬手时才生成的）。
    const hooked = touch.facts && touch.facts.hooked;
    add(
      'Pixi 的事件坑位已接管到总线（canvas / document / global）',
      !!(hooked && hooked.canvas && hooked.document && hooked.global),
      hooked
        ? `canvas=${hooked.canvas} document=${hooked.document} global=${hooked.global}`
        : '拿不到 __motaTouch（垫片没装上）'
    );
    add(
      '触摸送到棋盘上（lastBoardClick 命中点的那一格）',
      arrived.length > 0,
      `${arrived.length}/${touch.results.length} 命中　${detail}`
    );
    add(
      '触摸能驱动游戏（至少一个方向让勇者移动）',
      moved.length > 0,
      `${moved.length}/${touch.results.length} 移动　${moved.map((r) => r.dir).join(',') || '一个都没动'}`
    );
    if (touch.facts) console.log(`  触摸桥机制: ${JSON.stringify(touch.facts)}`);
  } else {
    add('触摸判据可执行', false, touch.reason);
  }

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
