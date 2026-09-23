/**
 * 断例宿主：静态服务 + Chromium 会话 + 结果收集。
 *
 * 这里是**唯一**与浏览器打交道的地方。断例模块拿到的 `ctx` 就是它装配出来的，
 * 断例之间不直接互相依赖 —— 需要共享时通过 ctx（例：A1 把变体使用分布挂在
 * `ctx.variantUse` 上，最后汇总时读）。
 *
 * ## 为什么断例共用同一个 page
 *
 * 20 条断言里有一半是「改一下状态再看」的（点按钮、走一格、切楼层）。
 * 每条都重开页面会让整套慢十倍，也没必要 —— 只要每条断例自己把状态收拾干净
 * （A13 开头那句 `press('r')` 就是干这个的），共用页面就是安全的。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, findChromium } = require('../lib/chromium.cjs');
const expect = require('./expect.cjs');

const { ROOT, DIST } = expect;
const PORT = Number(process.env.PORT || 4201);
const VERBOSE = process.argv.includes('--verbose');

// ── 静态服务 ────────────────────────────────────────────────────────
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let url = (req.url || '/').split('?')[0];
  if (url === '/favicon.ico') return res.writeHead(204).end();
  if (url === '/') url = '/index.html';
  const resolved = path.resolve(path.join(DIST, url));
  if (!resolved.startsWith(DIST) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return res.writeHead(404).end('not found: ' + url);
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(resolved)] || 'application/octet-stream' });
  res.end(fs.readFileSync(resolved));
});

// ── 结果收集 ────────────────────────────────────────────────────────
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? '✅' : '❌';
  console.log(`  ${mark} ${name}${detail ? `  —— ${detail}` : ''}`);
}

/** 起浏览器、把页面推到「游戏已就绪」的状态。 */
async function createSession() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error(`找不到 ${DIST}/index.html，请先 npm run build`);
    process.exit(2);
  }

  const floors = expect.loadFloors();
  // A1 与 A5 都要「按楼层升序遍历」，所以排序在宿主里算一次 ——
  // 它不属于任何一条断例（原先写在 A1 里，A5 隔着 90 行去用）。
  const sorted = [...floors.keys()].sort((a, b) => a - b);
  console.log(`=== 渲染层回归测试（真实 WebGL）===\n已加载 ${floors.size} 层地图\n`);

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: true,
    args: ['--use-angle=metal', '--enable-gpu']
  });
  // 视口**对齐页面报出来的设计尺寸**（`__layout()`），不在这里硬编码。
  // 与 tools/shot-web.cjs 同一套做法：版面一改（780 → 916），
  // 这里若还按旧高度开视口，`root` 的缩放系数就不是 1，
  // 所有"按源码坐标算出来"的期望值会集体偏移。
  const page = await browser.newPage({ viewport: { width: 420, height: 1024 }, deviceScaleFactor: 2 });

  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) consoleErrors.push(m.text());
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => !!(window.mota && window.mota.game), null, { timeout: 20000 });
  {
    const l0 = await page.evaluate(() => window.mota.game.__layout());
    await page.setViewportSize({ width: l0.W, height: l0.H });
    // 视口变了会触发 resize → fit()，等它落屏再往下走
    await page.waitForTimeout(200);
    console.log(`设计尺寸 ${l0.W}×${l0.H}（读自 __layout()）`);
  }
  // 图集是异步解码的；等到有格子真的贴上贴图，再做地形断言
  await page.waitForFunction(
    () => window.mota.game.board.terrainSprites.some((s) => s && s.visible),
    null,
    { timeout: 20000 }
  );

  return { browser, page, floors, sorted, consoleErrors };
}

/**
 * 按顺序跑完所有断例。
 *
 * `checks` 是 `{ id, title, run(ctx) }` 的数组，**顺序即依赖**：
 * A1..A20 的编号顺序就是它们历史上的执行顺序，别重排（A13 那条 `press('r')`
 * 假定前面已经跑完全塔）。
 */
async function runAll(checks) {
  const session = await createSession();
  const { browser, page, floors, sorted, consoleErrors } = session;

  /** 本目录下的 terrain 图集文件名（A16/A17/A19 共用，所以提升到这里算一次）。 */
  const terrainPng = fs
    .readdirSync(path.join(DIST, 'assets'))
    .find((n) => /^terrain.*\.png$/.test(n));

  const ctx = {
    ...expect,
    fs,
    path,
    page,
    browser,
    check,
    VERBOSE,
    PORT,
    floors,
    sorted,
    terrainPng,
    consoleErrors,
    /** A1 填它，末尾 VERBOSE 汇总读它。 */
    variantUse: { '0': new Map(), '1': new Map() }
  };

  try {
    for (const c of checks) {
      await c.run(ctx);
    }

    check('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '干净');
    if (VERBOSE) {
      console.log('\n  变体使用分布：');
      for (const k of ['0', '1']) {
        const m = ctx.variantUse[k];
        const total = [...m.values()].reduce((a, b) => a + b, 0);
        console.log(
          `    键 ${k}: ` +
            [...m.entries()].sort((a, b) => a[0] - b[0]).map(([v, c]) => `#${v}×${c}`).join(' ') +
            `  （合计 ${total}）`
        );
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? '✅ 全部通过' : `❌ ${failed.length} 项失败`}` +
      `（${results.length - failed.length}/${results.length}）`
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

module.exports = { runAll, check, results, server, PORT, VERBOSE, ROOT, DIST };
