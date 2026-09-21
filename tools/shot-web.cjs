/**
 * 网页端「真机渲染」截图工具 —— 视觉迭代的取证手段。
 *
 * 为什么要它，而不是用 Python 画个 mock：
 *   视觉改动的成败只有**真实渲染管线**算数。像素画放大用的是 nearest、UI 是
 *   Pixi 的 Graphics + Text 光栅化、整体还要过一次 dpr 缩放 —— 任何一处用
 *   手写 mock 代替，都会得到「mock 上好看、游戏里不是那样」的结论。
 *   上一轮的 `tools/preview-board.py` 就是个反面例子：它按格子拉伸填满，
 *   实际游戏里道具是等比缩放的，剑会变形。
 *
 * 设计要点：
 *   1. 视口对齐成**页面报出来的**设计尺寸（`__layout()`）→ 根容器缩放系数恰好为 1，
 *      于是「设计坐标 == CSS 坐标」，裁剪区域可以按源码里的 LAYOUT 硬算。
 *   2. `--clip board` 不写死坐标，而是问渲染树要 `board.toGlobal()` —— 
 *      LAYOUT 改了截图跟着改，不会悄悄错位到别的面板上。
 *   3. `--dpr` 默认 3：截图按设备像素出，像素画的边缘不糊，放大看是准的。
 *
 * 用法：
 *   node tools/shot-web.cjs --out assets/preview/x.png [--floor 6] [--clip board]
 *                           [--dpr 3] [--gold 5000] [--grant yellowKey,sword]
 *                           [--wait 600]
 *   （先 npm run build）
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, findChromium } = require('./lib/chromium.cjs');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 4199);

// 设计稿尺寸：**页面加载后从 `__layout()` 读回来**，不在这里硬编码。
//
// 视口等于设计尺寸时缩放系数为 1，截图坐标就等于源码坐标 —— 这个前提没变，
// 变的是「谁说了算」。上一版这里写死 420×780：改版面（780 → 892）时忘了同步，
// 截图就按旧高度裁，最下面那块面板被悄悄切掉，看图的人还以为面板本来就这么高。
// 现在 DESIGN 由页面自己报，工具跟着走。
//
// 初始视口只要求「够大」，页面就绪后再 setViewportSize 到真实设计尺寸。
let DESIGN = { W: 420, H: 1024 };

// ── 参数 ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { dpr: 3, clip: 'full', wait: 600 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[key] = val;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

if (!args.out) {
  console.error('必须给 --out <png 路径>');
  process.exit(2);
}
const OUT_ABS = path.resolve(ROOT, args.out);

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`找不到 ${path.join(DIST, 'index.html')}，请先运行 npm run build`);
  process.exit(2);
}

// ── 静态服务 ────────────────────────────────────────────────────────
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2'
};

const server = http.createServer((req, res) => {
  let url = (req.url || '/').split('?')[0];
  if (url === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  if (url === '/') url = '/index.html';
  const resolved = path.resolve(path.join(DIST, url));
  // 目录穿越防护：解析结果必须仍在 dist 内
  if (!resolved.startsWith(DIST) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    res.writeHead(404).end('not found: ' + url);
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(resolved)] || 'application/octet-stream' });
  res.end(fs.readFileSync(resolved));
});

/**
 * --clip 取值 → 页面内计算裁剪矩形的表达式（CSS 像素）。
 *
 * 是函数而不是常量，因为 DESIGN 要等页面加载完才知道。棋盘那一档干脆
 * 直接问渲染树（`board.toGlobal`），LAYOUT 改了它跟着改。
 */
function clipExpr(kind) {
  if (kind === 'board') {
    return `(() => {
      const b = window.mota && window.mota.game && window.mota.game.board;
      if (!b) return null;
      const p0 = b.toGlobal({ x: 0, y: 0 });
      const p1 = b.toGlobal({ x: b.span, y: b.span });
      return { x: p0.x - 8, y: p0.y - 8, width: (p1.x - p0.x) + 16, height: (p1.y - p0.y) + 16 };
    })()`;
  }
  if (kind === 'hud' || kind === 'backdrop') {
    const h = kind === 'hud' ? 96 : DESIGN.H;
    return `(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      const s = Math.min(r.width / ${DESIGN.W}, r.height / ${DESIGN.H});
      const x = r.left + (r.width - ${DESIGN.W} * s) / 2;
      const y = r.top + (r.height - ${DESIGN.H} * s) / 2;
      return { x, y, width: ${DESIGN.W} * s, height: ${h} * s };
    })()`;
  }
  return null;
}

// ── 主流程 ──────────────────────────────────────────────────────────
(async () => {
  fs.mkdirSync(path.dirname(OUT_ABS), { recursive: true });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: true,
    // 图形后端：headless 下要显式开 GPU 才能拿到真实 WebGL2
    args: ['--use-angle=metal', '--enable-gpu']
  });
  const page = await browser.newPage({
    viewport: { width: DESIGN.W, height: DESIGN.H },
    deviceScaleFactor: Number(args.dpr)
  });

  const problems = [];
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('console', async (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    if (m.text().includes('favicon')) return;
    const args = await Promise.all(
      m.args().map((h) =>
        h.evaluate((a) => {
          if (a === undefined) return 'undefined';
          if (a === null) return 'null';
          if (typeof a === 'object' && a !== null && a.stack) return a.toString() + '\n' + a.stack;
          try {
            return typeof a === 'object' ? JSON.stringify(a) : String(a);
          } catch {
            return '[object]';
          }
        })
      )
    );
    problems.push(`[${m.type()}] ${args.join(' ')}`);
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 30000 });

  // 等游戏就绪。window.mota 只在 Game.create() 成功后挂上，所以它就是「启动完成」信号。
  try {
    await page.waitForFunction(() => !!(window.mota && window.mota.game), null, { timeout: 20000 });
  } catch {
    const boot = await page.evaluate(() => {
      const b = document.getElementById('boot');
      return b ? b.textContent : '(没有 #boot)';
    });
    console.error(`等不到 window.mota（20s）。#boot 内容：${boot}`);
    console.error(problems.join('\n'));
    await browser.close();
    server.close();
    process.exit(1);
  }

  // 设计尺寸从页面读回来（见 DESIGN 的说明），再按它对齐视口
  const layout = await page.evaluate(() =>
    window.mota && window.mota.game && window.mota.game.__layout
      ? window.mota.game.__layout()
      : null
  );
  if (layout && (layout.W !== DESIGN.W || layout.H !== DESIGN.H)) {
    DESIGN = { W: layout.W, H: layout.H };
    await page.setViewportSize({ width: DESIGN.W, height: DESIGN.H });
    // 视口变了会触发 resize → fit() 重算缩放，等它落屏再继续
    await page.waitForTimeout(250);
  }
  if (layout) console.log(`  设计尺寸 ${DESIGN.W}×${DESIGN.H}（读自 __layout()）`);

  // 布置场景：开发接口是同步的，但改完要让渲染跑几帧才落屏
  const setup = await page.evaluate(
    ({ floor, gold, grants }) => {
      const g = window.mota.game;
      const log = [];
      if (gold) log.push(g.__gold(Number(gold)));
      if (grants) for (const id of String(grants).split(',').filter(Boolean)) log.push(g.__grant(id));
      if (floor) log.push(g.__goto(Number(floor)));
      return { log, probe: g.__probe() };
    },
    { floor: args.floor, gold: args.gold, grants: args.grant }
  );

  // 等若干动画帧 + 一点点墙钟，让怪物 idle 与字体纹理都稳定下来
  await page.evaluate(
    (ms) =>
      new Promise((r) => {
        const t0 = performance.now();
        const tick = () => (performance.now() - t0 >= ms ? r() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    Number(args.wait)
  );

  // --eval：在页面里跑一段表达式并把结果打出来。
  // 存在的理由是**别靠猜**：名牌宽度、字号、格子占比这类东西只有实测才知道，
  // 凭「字号 7 × 2 个字 = 14px」推断会错（字体进距和 Pixi 的文本度量都不是想当然）。
  if (args.eval) {
    const val = await page.evaluate(
      new Function(`return (${args.eval});`) // eslint-disable-line no-new-func
    );
    console.log('--eval → ' + JSON.stringify(val, null, 2));
  }

  // --after：等画面稳定**之后**再动一下状态（撞 NPC、开面板…），然后再截图。
  // 存在的理由：--eval 与截图之间没有渲染帧，改完状态立刻截图会拍到一个
  // 「状态已变、画面未重绘」的中间态 —— 拍出来的东西不是玩家会看到的。
  if (args.after) {
    const val = await page.evaluate((code) => {
      const fn = new Function(`return (${code});`); // eslint-disable-line no-new-func
      return fn();
    }, args.after);
    console.log('--after → ' + JSON.stringify(val));
    await page.evaluate(
      (ms) =>
        new Promise((r) => {
          const t0 = performance.now();
          const tick = () => (performance.now() - t0 >= ms ? r() : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
      Number(args.afterWait || 400)
    );
  }

  const expr = clipExpr(args.clip);
  const clip = expr ? await page.evaluate(expr) : null;
  if (expr && !clip) {
    console.error(`--clip ${args.clip} 拿不到矩形（渲染树里没找到目标）`);
    await browser.close();
    server.close();
    process.exit(1);
  }

  await page.screenshot({
    path: OUT_ABS,
    ...(clip ? { clip } : {}),
    animations: 'disabled'
  });

  await browser.close();
  server.close();

  const probe = setup.probe || {};
  console.log(`已保存 ${path.relative(ROOT, OUT_ABS)}`);
  console.log(
    `  场景：第 ${probe.floor} 层 位置 (${probe.pos?.x},${probe.pos?.y}) ` +
      `HP ${probe.hp} 步数 ${probe.steps} 渲染器 ${probe.rendererType} dpr ${probe.resolution}`
  );
  if (setup.log && setup.log.length) console.log('  开发接口：' + setup.log.join(' / '));
  if (clip) console.log(`  裁剪：${JSON.stringify(clip)}（CSS px，dpr ${args.dpr}）`);
  if (problems.length) {
    console.log(`  ⚠️ 控制台有 ${problems.length} 条：`);
    for (const p of problems.slice(0, 6)) console.log('    ' + p);
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error(err);
  try {
    server.close();
  } catch {
    /* 已经关了 */
  }
  process.exit(1);
});
