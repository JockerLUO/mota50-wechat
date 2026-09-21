/**
 * 小游戏产物「无 DOM 环境」实测 —— 驱动脚本。
 *
 * 三件事：
 *   1. 起静态服务器，把 `dist-minigame/`（游戏产物）与 `tools/minigame-harness/`
 *      （无 DOM 宿主 + 最小 wx 垫片）一起伺服；
 *   2. 用 Chromium 打开宿主页，等 Worker 里的实测报告通过 HTTP 回传；
 *   3. 按预先写死的判据逐条判定，并保存截图。
 *
 * 为什么宿主是 Worker 而不是页面：页面的 `document` 是 `[LegacyUnforgeable]`
 * 自有属性，删不掉也覆盖不了（第一版就是这么失败的，见 worker.js 文件头）。
 * Worker 是真实的无 DOM realm。
 *
 * 为什么用 .cjs：`playwright-core` 装在 WorkBuddy 的共享 node 工作区，不在本项目
 * node_modules 里。ESM 解析器不认 NODE_PATH，CJS 的 `require` 认。下面用
 * `module.paths.push` 把它加进解析路径，脚本因此可以留在仓库里。
 *
 * 用法：npm run verify:minigame
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── 解析 playwright-core ────────────────────────────────────────────
const SHARED_MODULES = [
  process.env.PLAYWRIGHT_MODULES,
  path.join(os.homedir(), '.workbuddy/binaries/node/workspace/node_modules'),
  path.join(__dirname, '..', 'node_modules')
].filter(Boolean);
for (const p of SHARED_MODULES) module.paths.push(p);

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('找不到 playwright-core。已尝试的解析路径：');
  for (const p of SHARED_MODULES) console.error('  ' + p);
  console.error('可用 PLAYWRIGHT_MODULES=<node_modules 目录> 覆盖。');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist-minigame');
const HARNESS = path.join(ROOT, 'tools', 'minigame-harness');
const OUT = path.join(ROOT, 'assets', 'preview');
const PORT = Number(process.env.PORT || 4190);

if (!fs.existsSync(path.join(DIST, 'game.js'))) {
  console.error(`找不到 ${path.join(DIST, 'game.js')}，请先运行 npm run build:minigame`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

// ── 静态服务 ────────────────────────────────────────────────────────
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

let resolveResult;
const resultPromise = new Promise((r) => {
  resolveResult = r;
});

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'POST' && url === '/__result') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(204).end();
      try {
        resolveResult(JSON.parse(body));
      } catch (e) {
        resolveResult({ problems: [`报告不是合法 JSON: ${e.message}`] });
      }
    });
    return;
  }

  if (url === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  // 先找游戏产物，再找宿主文件
  const candidates =
    url === '/' || url === '/index.html'
      ? [path.join(HARNESS, 'index.html')]
      : [path.join(DIST, url), path.join(HARNESS, url)];

  const file = candidates.find((p) => {
    const resolved = path.resolve(p);
    if (!resolved.startsWith(DIST) && !resolved.startsWith(HARNESS)) return false; // 目录穿越防护
    return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  });

  if (!file) {
    res.writeHead(404).end('not found: ' + url);
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

function findChromium() {
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* 版本不匹配时抛错，落到兜底扫描 */
  }
  // 兜底：直接扫 playwright 的浏览器缓存目录。各平台路径不同，且装了也未必就在
  // executablePath() 指向的位置（版本更新后旧的仍在），所以逐个试。
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), 'Library/Caches/ms-playwright'), // macOS
    path.join(os.homedir(), '.cache/ms-playwright'), // Linux
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null
  ].filter((p) => p && fs.existsSync(p));
  const layouts = [
    ['chrome-mac-arm64', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
    ['chrome-mac-arm64', 'Chromium.app/Contents/MacOS/Chromium'],
    ['chrome-mac', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
    ['chrome-mac', 'Chromium.app/Contents/MacOS/Chromium'],
    ['chrome-mac-x64', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
    ['chrome-mac-x64', 'Chromium.app/Contents/MacOS/Chromium'],
    ['chrome-linux', 'chrome'],
    ['chrome-win', 'chrome.exe']
  ];
  for (const root of caches) {
    const dirs = fs
      .readdirSync(root)
      .filter((x) => x.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const d of dirs) {
      for (const [sub, rel] of layouts) {
        const p = path.join(root, d, sub, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error(
    '找不到可用的 Chromium。请先执行：npx playwright install chromium\n' +
      '  若已装在别处，可用 PLAYWRIGHT_BROWSERS_PATH=<目录> 指定。'
  );
}

// ── 主流程 ──────────────────────────────────────────────────────────
(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const base = `http://127.0.0.1:${PORT}/`;

  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });

  const consoleMsgs = [];
  page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    if (m.text().includes('favicon')) return; // 浏览器自动请求，与本次无关
    consoleMsgs.push(`[${m.type()}] ${m.text()}`);
  });

  await page.goto(base, { waitUntil: 'load', timeout: 30000 });

  const report = await Promise.race([
    resultPromise,
    new Promise((r) => setTimeout(() => r({ problems: ['等待报告超时（90s）'] }), 90000))
  ]);

  await page.screenshot({ path: path.join(OUT, 'minigame-board.png') });
  await browser.close();
  server.close();

  // ── 判定 ─────────────────────────────────────────────────────────
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  const workerLogs = report.logs || [];
  const logErrors = workerLogs.filter((l) => l.startsWith('[error]'));
  const problems = [...(report.problems || []), ...consoleMsgs, ...logErrors];
  add('无报错 / 无异常', problems.length === 0, problems.slice(0, 4).join(' | ') || '干净');

  add(
    '启动没有弹「启动失败」',
    !report.bootFailed,
    report.bootFailed ? JSON.stringify(report.bootFailed) : '无弹窗'
  );

  const probe = report.probe || {};
  add(
    '渲染器是 webgl（不是静默降级的 canvas）',
    probe.rendererType === 'webgl',
    `rendererType=${probe.rendererType}`
  );
  add('分辨率 = 设备像素比 3', probe.resolution === 3, `resolution=${probe.resolution}`);

  const px = report.pixels;
  add(
    '帧缓冲里有实际画面（非背景色像素 > 30%）',
    px && px.nonClearRatio > 0.3,
    px ? `${px.nonClear}/${px.total} = ${(px.nonClearRatio * 100).toFixed(1)}%` : '没拿到像素'
  );
  add('画面不是纯色块（颜色种类 > 20）', px && px.distinctColors > 20, px ? `${px.distinctColors} 种颜色` : '-');

  const srcs = report.imageSrcs || [];
  const badSrc = srcs.filter((s) => !/^assets\/[a-z]+\.png$/.test(s));
  add(
    '图集走包内相对路径（无前导斜杠、无 hash）',
    srcs.length >= 4 && badSrc.length === 0,
    srcs.length ? srcs.join(', ') : '没有图片被加载'
  );

  add('离屏画布确实拿到了（createCanvas ≥ 2 次）', report.canvasCreates >= 2, `createCanvas × ${report.canvasCreates}`);
  add('场景图里有精灵', report.spriteCount > 20, `Sprite 节点 ${report.spriteCount} 个`);
  const naturallyGone = report.removedNaturally || [];
  add(
    '宿主本来就没有 DOM（不用伪造）',
    naturallyGone.includes('document') && naturallyGone.includes('window') && naturallyGone.length >= 10,
    `${naturallyGone.length} 个：${naturallyGone.join(', ')}`
  );

  const moves = report.moves || [];
  const moved = moves.filter((m) => m.moved);
  const wrongDir = moved.filter((m) => !m.closer);

  // 画布序：这条约束被打破时画面是对的、什么都看不出来，所以必须单独判。
  add(
    '上屏画布 = wx.createCanvas() 的第一块',
    report.displayIsAppCanvas === true,
    report.displayIsAppCanvas
      ? `#1 ${report.appCanvasSize.w}×${report.appCanvasSize.h}`
      : `渲染目标尺寸 ${JSON.stringify(report.appCanvasSize)} 与第一块 ${JSON.stringify(report.canvasSize)} 不一致`
  );

  // 「点击送到哪一格」与「有没有走成」必须分开判：
  //   - 送到哪一格 → 只考事件链 + 坐标映射（本适配任务的责任范围）
  //   - 有没有走   → 还掺进游戏规则（那格可不可走、路通不通）
  // 越界格（棋盘外的目标）被忽略是**正确行为**，所以只对界内目标断言。
  const inBoard = moves.filter((m) => m.inBounds);
  const arrived = inBoard.filter((m) => m.arrived);
  // 界内探针数固定为 5（6 个探针里有 1 个是刻意越界的）。
  // 只断言「界内的每一次点击都落到预期格」——远格是否**走得到**取决于地形
  // （floor 1 从起点起可达的格子只有 6 个），那属于游戏规则，不归适配层管。
  add(
    '触摸点击精确落到预期格子（含远距离格）',
    inBoard.length >= 5 && arrived.length === inBoard.length,
    inBoard.length
      ? `${arrived.length}/${inBoard.length} 命中：` +
          inBoard.map((m) => `${m.dir}→${m.hit ? `(${m.hit.x},${m.hit.y})` : 'null'}`).join(' ')
      : '一次都没送到 —— 事件链断了'
  );
  add(
    '越界点击被正确忽略（没有误判成界内格子）',
    moves.filter((m) => !m.inBounds).every((m) => !m.arrived && !m.moved),
    `${moves.filter((m) => !m.inBounds).length} 次越界点击，均未产生动作`
  );

  add(
    '触摸事件能驱动游戏（至少一次有效移动）',
    moved.length > 0,
    moved.length ? `${moved.length}/${moves.length} 次点击产生了移动` : '一次都没动'
  );
  add(
    '移动方向与点击方向一致（坐标映射没偏）',
    moved.length > 0 && wrongDir.length === 0,
    wrongDir.length ? `有 ${wrongDir.length} 次跑反了：${JSON.stringify(wrongDir)}` : '全部正确'
  );

  // ── 输出 ─────────────────────────────────────────────────────────
  console.log('\n══ 小游戏产物 · 无 DOM 环境实测（宿主 = Web Worker）══\n');
  console.log(`宿主屏幕: ${JSON.stringify(report.screen)}   上屏画布: ${JSON.stringify(report.canvasSize)}`);
  console.log(`Worker 天生没有 (${naturallyGone.length}): ${naturallyGone.join(', ')}`);
  console.log(`主动抹掉 (${(report.killed || []).length}): ${(report.killed || []).join(', ')}\n`);
  // 画布台账：因为「上屏画布必须是 wx.createCanvas() 的第一块」这条约束一旦被打破，
  // 症状与「渲染正常但截图黑」完全一样，肉眼分不出来，只能靠编号和调用栈。
  const ledger = report.canvasLedger || [];
  if (ledger.length) {
    console.log('画布台账（按 wx.createCanvas 调用序）:');
    for (const c of ledger.slice(0, 8)) {
      console.log(
        `    #${String(c.idx).padStart(2)}  ${String(c.w).padStart(5)}×${String(c.h).padEnd(5)}` +
          `${c.isAppCanvas ? '  ← 渲染目标' : '            '}` +
          `  上下文: ${c.contexts.length ? c.contexts.join(', ') : '（无）'}`
      );
    }
    if (ledger.length > 8) console.log(`    … 另有 ${ledger.length - 8} 块离屏画布`);
    console.log('');
  }
  for (const s of report.canvasStacks || []) {
    console.log(`  画布 #${s.idx} 谁建的: ${s.stack}`);
  }
  if ((report.canvasStacks || []).length) console.log('');
  console.log(`WebGL: ${JSON.stringify(report.webglInfo)}`);
  console.log(
    `引擎探针: floor=${probe.floor} pos=${JSON.stringify(probe.pos)} hp=${probe.hp}/${probe.hpMax ?? '-'} ` +
      `steps=${probe.steps} renderer=${probe.rendererType} @${probe.resolution}x\n`
  );

  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed += 1;
    console.log(`${c.ok ? '  ✅' : '  ❌'} ${c.name}  —— ${c.detail}`);
  }

  console.log('\n  触摸移动记录:');
  for (const m of moves) {
    console.log(
      `    ${m.dir.padEnd(9)} ${JSON.stringify(m.from)} → ${JSON.stringify(m.to)}` +
        `  目标 ${JSON.stringify(m.target)}${m.inBounds ? '      ' : '(界外)'}  ` +
        `${m.arrived ? '✅' : '❌'} 落到 ${m.hit ? `(${m.hit.x},${m.hit.y})` : '（没送到）'}  ` +
        `${m.moved ? (m.closer ? '✅ 朝目标移动' : '❌ 方向不符') : '⏸ 未移动'}`
    );
  }

  if (workerLogs.length) {
    console.log('\n  游戏/垫片日志:');
    for (const l of workerLogs.slice(0, 20)) console.log('    ' + l);
  }

  console.log(
    `\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条不通过`}（截图：assets/preview/minigame-board.png）\n`
  );
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  server.close();
  process.exit(2);
});
