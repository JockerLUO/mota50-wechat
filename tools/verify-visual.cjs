/**
 * 渲染层回归测试 —— 在**真实浏览器 + 真实 WebGL** 里跑，不是读代码。
 *
 * ## 为什么要这个文件
 *
 * 前面几轮踩的坑有个共同点：**代码读起来是对的，画面上是错的。**
 *   · 假墙漏洞：`terrainKeyFor` 里 `key === '1'` 这个写法，只有拿真墙去对照才发现
 *     假墙拿不到压顶 —— 光看渲染代码看不出来。
 *   · 地面重复：变体函数写对了，但 `paintCell` 根本没调用它，代码也「看起来很对」。
 *   · 怪物浮空：素材帧底留白是 0（构建期断言），但渲染层把精灵摆在哪，只有量出来才知道。
 *
 * 所以这里的每条断言都拿**两个独立来源**对撞：
 *   · 期望值：Node 侧从 `data/floors/*.json` + `assets/manifest.json` **重新实现**一遍
 *     规则算出来（不是 import 渲染层的函数）。
 *   · 实测值：浏览器里跑起来之后，从渲染树读回真正落屏的东西。
 * 两边都是从源码派生的，但派生路径不同，所以能抓到「改了 A 忘了改 B」。
 *
 * ## 覆盖
 *   A1 地形键：全塔每一格，渲染树里的键必须与独立推导一致
 *   A2 假墙不泄漏：`w` 格必须与「同位置真墙」走同一条规则（隐藏通路设计的命门）
 *   A3 无空键：不许出现 `?字符` 这种「没映射」的兜底态
 *   A4 变体是活的：地面/墙身键在棋盘上确实用到了多个变体（防止变体路径被绕过）
 *   A5 怪物布局：非 BOSS 精灵装得进一格；每只怪有且只有一个战斗评级指示灯，且指示灯在格内
 *   A6 BOSS 与倍数：画得比一格大的必须是玩法上的 BOSS（不许有「巨大的杂兵」）
 *   A7 面板版式：每块面板的标题落在同一套坐标上（见「统一版式」）
 *   A8 版面：模块间隙相等，棋盘没被挤小，棋盘盒与面板同栏
 *   A9 塔壁与地图内墙同源（比 source.uid，不比颜色）
 *   A10 位面：地平线随楼层单调上移、同一层可复现、背景跟随显示层
 *   A11 道具栏：空背包整块不占位，有道具时高度按件数算
 *   A12 手绘怪物：落屏用的是 monsters 图集且帧与 MANIFEST 一致（不退回程序化图形）
 *   A13 楼层浏览：选完某一层后「返回」始终可达，返回后勇者回来且输入复活
 *   A14 攻击动画：挥剑全程勇者精灵的形体和尺寸**不变**，靠 `attackFx` 的时间轴演
 *   A15 对话折行：台词折行不超卡片内宽、不以收尾标点开头（中文行首禁则）
 *   A16 上下楼梯：两张瓦片既不逐像素相同、也不互为上下翻转，且形体走向各就各位
 *   A17 像素密度：图集帧升到出图网格（原始素材 ×supersample）、drawScale 同比缩小，落屏尺寸不变
 *   A18 文字光栅化分辨率跟随设备像素比（dsf=3 时必须是 3，写死 2 会挂）
 *
 * 用法：node tools/verify-visual.cjs [--verbose]（先 npm run build）
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, findChromium } = require('./lib/chromium.cjs');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 4201);
const VERBOSE = process.argv.includes('--verbose');

// ── 期望值：在 Node 侧独立重实现一遍渲染规则 ────────────────────────
// ⚠️ 这里的映射必须与 src/render/atlas.ts 的 CHAR_TO_KEY 一致。
// 不一致会立刻暴露成 A1 大面积失败 —— 那正是这个测试的作用。
const CHAR_TO_KEY = {
  '.': '0',
  '#': '1',
  '~': '5',
  '*': '6',
  D: '2',
  a: '10',
  y: '7',
  b: '8',
  r: '9',
  '^': '4',
  v: '3'
};

const RENDER_ALIAS = { w: '#' };
const renderChar = (ch) => RENDER_ALIAS[ch] ?? ch;
const isWallChar = (ch) => {
  const c = renderChar(ch);
  return c === '#' || c === 'w';
};

function terrainKeyFor(ch, wallAbove) {
  const c = renderChar(ch);
  const key = CHAR_TO_KEY[c];
  if (key === undefined) return null;
  if (isWallChar(c) && !wallAbove) return `${key}:top`;
  return key;
}

/** 与 atlas.ts 的 variantIndex 逐位一致（只用 Math.imul / >>>，两边语义都是 32 位回绕） */
function variantIndex(x, y, floor, count) {
  if (count <= 1) return 0;
  let h =
    0x9e3779b9 ^
    Math.imul(x + 1, 0x85ebca6b) ^
    Math.imul(y + 1, 0xc2b2ae35) ^
    Math.imul(floor + 1, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h = (h ^ (h >>> 13)) >>> 0;
  return h % count;
}

function loadFloors() {
  const dir = path.join(ROOT, 'data/floors');
  const out = new Map();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'index.json')) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (typeof j.index !== 'number' || !Array.isArray(j.terrain)) continue;
    out.set(j.index, j.terrain.map((r) => String(r)));
  }
  return out;
}

const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/manifest.json'), 'utf8'));
const VARIANT_COUNT = (key) => {
  const n = MANIFEST.meta.terrainVariants?.[key] ?? 1;
  return n > 1 ? n : 1;
};

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

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error(`找不到 ${DIST}/index.html，请先 npm run build`);
    process.exit(2);
  }

  const floors = loadFloors();
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

  try {
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

    // ── A1 / A2 / A3 / A4：逐层比对全部 121 格 ──────────────────────
    const sorted = [...floors.keys()].sort((a, b) => a - b);
    const mismatches = [];
    const unknownCells = [];
    const fakeWallRows = [];
    const variantUse = { '0': new Map(), '1': new Map() };
    let cellCount = 0;

    for (const floor of sorted) {
      const rows = floors.get(floor);
      const seen = await page.evaluate((f) => {
        const g = window.mota.game;
        const r = g.__goto(f);
        return { log: r, sigs: g.board.terrainKeys.slice() };
      }, floor);

      if (/^未知|^没有|失败/.test(String(seen.log))) {
        mismatches.push({ floor, why: `__goto 失败：${seen.log}` });
        continue;
      }

      for (let y = 0; y < 11; y++) {
        for (let x = 0; x < 11; x++) {
          const idx = y * 11 + x;
          const ch = rows[y]?.[x];
          if (ch === undefined) {
            mismatches.push({ floor, x, y, why: `地图缺这一格` });
            continue;
          }
          cellCount++;
          const wallAbove = y > 0 && isWallChar(rows[y - 1][x]);
          const key = terrainKeyFor(ch, wallAbove);
          const expect =
            key === null
              ? `?${renderChar(ch)}`
              : `${key}#${variantIndex(x, y, floor, VARIANT_COUNT(key))}`;
          const actual = seen.sigs[idx];

          if (actual !== expect) {
            mismatches.push({ floor, x, y, ch, expect, actual });
          }
          if (String(actual).startsWith('?')) {
            unknownCells.push({ floor, x, y, ch, actual });
          }
          if (key !== null && variantUse[key]) {
            const vi = variantIndex(x, y, floor, VARIANT_COUNT(key));
            const m = variantUse[key];
            m.set(vi, (m.get(vi) || 0) + 1);
          }
          if (ch === 'w') {
            fakeWallRows.push({ floor, x, y, aboveIsWall: y > 0 ? isWallChar(rows[y - 1][x]) : false, sig: actual, expect });
          }
        }
      }
    }

    check(
      `A1 地形键：全塔 ${cellCount} 格逐一与独立推导对照`,
      mismatches.length === 0,
      mismatches.length === 0
        ? `${sorted.length} 层 × 121 格全部一致`
        : `不一致 ${mismatches.length} 处，前 3：${JSON.stringify(mismatches.slice(0, 3))}`
    );

    // 假墙里「上方不是墙」的那批才是命门：它们必须拿到 1:top，
    // 而真墙在该位置也会拿到 1:top —— 两者一致，才挑不出来。
    const exposed = fakeWallRows.filter((r) => !r.aboveIsWall);
    const fakeBad = fakeWallRows.filter((r) => r.sig !== r.expect);
    check(
      `A2 假墙不泄漏：${fakeWallRows.length} 面假墙与同位置真墙规则一致`,
      fakeBad.length === 0,
      fakeBad.length === 0
        ? `其中 ${exposed.length} 面「上方无墙」的假墙已正确拿到 1:top 压顶（隐藏通路的关键）`
        : `有 ${fakeBad.length} 面假墙与真墙不同，前 3：${JSON.stringify(fakeBad.slice(0, 3))}`
    );

    check(
      'A3 无空键：没有任何格子落到「未映射」兜底态',
      unknownCells.length === 0,
      unknownCells.length === 0
        ? '全部格子都拿到了 MANIFEST 里的地形键'
        : `${unknownCells.length} 格未映射，例如 ${JSON.stringify(unknownCells.slice(0, 3))}`
    );

    const floorVars = variantUse['0'].size;
    const wallVars = variantUse['1'].size;
    check(
      `A4 变体是活的：地面用到 ${floorVars} 种变体、墙身 ${wallVars} 种`,
      floorVars >= 2 && wallVars >= 2,
      `MANIFEST 声明 地面 ${VARIANT_COUNT('0')} 种 / 墙身 ${VARIANT_COUNT('1')} 种；` +
        `实际各用到 ${floorVars} / ${wallVars} 种` +
        (floorVars < 2 || wallVars < 2 ? '（只用到 1 种说明变体路径没生效）' : '')
    );

    // ── A5 / A6：怪物布局 ───────────────────────────────────────────
    const bossIds = await page.evaluate(() => {
      const m = window.mota.game.data.monsters;
      return Object.keys(m).filter((k) => m[k] && m[k].boss);
    });
    // 「大家伙」= **落屏画得比一格大**。⚠️ 不能再用 `drawScale > 2` 判定：
    // 出图网格翻倍后 drawScale 变成小数（常规 0.5 / 大家伙 0.75），整数阈值
    // 当场失效 —— 实测会静默变成「0 只大家伙」，于是 A5a 拿「必须装进一格」
    // 去卡 BOSS，红得莫名其妙。判据要落在**语义**上（画得多大），不是倍数上。
    const cellPx = Number(MANIFEST.meta.cell ?? 32);
    const bigIds = Object.keys(MANIFEST.monsters).filter((k) => {
      const n = MANIFEST.monsters[k];
      return n && n.frame.w * n.drawScale > cellPx + 1e-6;
    });
    const fakeBoss = bigIds.filter((k) => !bossIds.includes(k));
    check(
      `A6 BOSS 与倍数：画得比一格大的 ${bigIds.length} 只必须都是玩法 BOSS`,
      fakeBoss.length === 0,
      fakeBoss.length === 0
        ? `巨大化的都名副其实；另有 ${bossIds.length - bigIds.length} 只玩法 BOSS 未增大（见报告说明）`
        : `有非 BOSS 被画大：${fakeBoss.join(', ')}`
    );

    const layoutBad = [];
    const noPlate = [];
    const outsideCell = [];
    let monsterViews = 0;
    let floorsWithMonsters = 0;

    for (const floor of sorted) {
      await page.evaluate((f) => window.mota.game.__goto(f), floor);
      const mons = await page.evaluate(() => {
        const g = window.mota.game;
        const b = g.board;
        const S = b.cellPx;
        const isSp = (n) => n && n.texture !== undefined && n.anchor !== undefined;
        const isTx = (n) => n && typeof n.text === 'string' && n.style !== undefined;
        // 生产构建会压缩类名（Graphics → H），所以不能看 constructor.name；
        // 渲染层给指示灯设置了唯一的 label='gradeDot'（Pixi v8 用 label 不用 name），直接按 label 找。
        const isPlate = (n) => n && n.label === 'gradeDot';
        const out = [];
        for (const v of b.entityViews) {
          if (!v.node || !v.monsterId) continue;
          const sp = (v.node.children || []).find(isSp);
          const plate = (v.node.children || []).find(isPlate);
          const nPlates = (v.node.children || []).filter(isPlate).length;
          const gb = sp ? sp.getBounds() : null;
          const pb = plate ? plate.getBounds() : null;
          const cellL = b.x + v.x * S;
          const cellT = b.y + v.y * S;
          out.push({
            id: v.monsterId,
            x: v.x,
            y: v.y,
            cellL,
            cellT,
            S,
            hasSprite: !!sp,
            spriteBottom: gb ? gb.maxY : null,
            spriteTop: gb ? gb.minY : null,
            spriteH: gb ? gb.height : null,
            plateCount: nPlates,
            plateL: pb ? pb.minX : null,
            plateR: pb ? pb.maxX : null,
            plateT: pb ? pb.minY : null,
            plateB: pb ? pb.maxY : null
          });
        }
        return out;
      });

      if (mons.length) floorsWithMonsters++;
      monsterViews += mons.length;

      for (const m of mons) {
        const boss = bossIds.includes(m.id) && bigIds.includes(m.id);
        if (!m.hasSprite) {
          layoutBad.push({ ...m, why: '没有精灵（图集没就绪？）' });
          continue;
        }
        // 脚不能越过格子下沿：越过就说明「它站哪一格」在画面上不确定
        if (m.spriteBottom > m.cellT + m.S + 0.01) {
          layoutBad.push({ id: m.id, cell: [m.x, m.y], why: `脚越过下沿 ${(m.spriteBottom - m.cellT - m.S).toFixed(1)}px` });
        }
        if (!boss && m.spriteH > m.S + 0.01) {
          layoutBad.push({ id: m.id, cell: [m.x, m.y], why: `精灵高 ${m.spriteH}px > 格子 ${m.S}px` });
        }
        if (m.plateCount !== 1) {
          noPlate.push({ id: m.id, cell: [m.x, m.y], plateCount: m.plateCount });
          continue;
        }
        // 指示灯要留在格子里（允许 1px 抗锯齿溢出）
        const pad = 1.01;
        if (
          m.plateL < m.cellL - pad ||
          m.plateR > m.cellL + m.S + pad ||
          m.plateT < m.cellT - pad ||
          m.plateB > m.cellT + m.S + pad
        ) {
          outsideCell.push({
            id: m.id,
            cell: [m.x, m.y],
            plate: [m.plateL.toFixed(1), m.plateT.toFixed(1), m.plateR.toFixed(1), m.plateB.toFixed(1)],
            cellBox: [m.cellL, m.cellT, m.cellL + m.S, m.cellT + m.S]
          });
        }
      }
    }

    check(
      `A5a 怪物精灵：${monsterViews} 只（${floorsWithMonsters} 层）脚不越格、非 BOSS 装得进一格`,
      layoutBad.length === 0,
      layoutBad.length === 0
        ? '全部符合'
        : `${layoutBad.length} 只异常，前 3：${JSON.stringify(layoutBad.slice(0, 3))}`
    );

    check(
      `A5b 怪物指示灯：每只怪恰好一个战斗评级指示灯，且落在自己格内`,
      noPlate.length === 0 && outsideCell.length === 0,
      noPlate.length === 0 && outsideCell.length === 0
        ? `全部 ${monsterViews} 只都恰好一个指示灯且未出格`
        : `缺/多个指示灯 ${noPlate.length} 只；指示灯出格 ${outsideCell.length} 只，前 3：${JSON.stringify(outsideCell.slice(0, 3))}`
    );

    // ── A7：面板版式一致性 ────────────────────────────────────────
    //
    // 「六块面板看起来是同一套 UI」这件事，靠眼看是**不可靠**的：
    // 上一轮的交易浮层标题横向用了 `+UI.pad`(14)，而短条占 12..15 ——
    // 标题压在自己的短条上，差 1px，截图上根本看不出来，
    // 但同一时刻其它五块面板用的是 +23，「两套版式」是看得出来却又说不清在哪的。
    //
    // 所以这里量的是**渲染树里的真实坐标**：Game.__panels() 把每块面板的标题
    // 换算成「相对自己卡片左上角的偏移」。期望值在 Node 侧独立写死 ——
    // 与 theme.ts 的 UI.titleX / titleYTitle / titleYHead 一一对应，
    // 改了令牌而没同步这里，就是一条会红。
    //
    // ⚠️ 状态卡（StatusBar）**刻意不在这一组里**：它的左侧是 40×40 的楼层徽章，
    // 徽章就占着短条的位置，标题要按徽章实际宽度往后量（`STATUS_TEXT_W`）——
    // 与这六块「短条 + 标题」的面板不是同一种结构，硬套同一个偏移反而会错。
    const PANEL_LAYOUT = { dx: 23, dyBySize: { 15: 12, 12.5: 14 } };
    const EXPECTED_PANELS = ['detail', 'items', 'floor', 'dialogue', 'merchant', 'shop'];
    // 每块浮层都得先真的打开 —— 交易类浮层的卡片高度由 open() 现算，
    // 没开过的面板 `__panels()` 直接不出（卡片矩形还是 0，量出来会是「面板在 (0,0)」）。
    // 商人只在有货的层摆摊（第 6 层有蓝钥匙），商店在第 4 层。
    await page.evaluate(() => {
      const g = window.mota.game;
      g.__goto(6);
      g.openFloorPanel('browse');
      g.openMerchant();
      g.__goto(4);
      g.openShop();
    });

    const panels = await page.evaluate(() => window.mota.game.__panels());
    const seen = new Set(panels.map((p) => p.panel));
    const missing = EXPECTED_PANELS.filter((p) => !seen.has(p));
    const bad = panels.filter((p) => {
      const want = PANEL_LAYOUT.dyBySize[p.fontSize];
      return want === undefined || p.dx !== PANEL_LAYOUT.dx || p.dy !== want;
    });

    check(
      `A7 面板版式：${panels.length} 块面板的标题落在同一套坐标上（dx=${PANEL_LAYOUT.dx}）`,
      missing.length === 0 && bad.length === 0,
      missing.length > 0
        ? `没量到这些面板：${missing.join(', ')}`
        : bad.length === 0
          ? panels
              .map((p) => `${p.panel}(${p.dx},${p.dy})`)
              .join(' ')
          : `偏移不合令牌的：${JSON.stringify(bad)}`
    );

    // ── A8 版面：间隙相等、棋盘没被挤小、棋盘盒与面板同上下一栏 ──
    //
    // 玩家这一轮的原话是「各模块间隙加大，不要挤占游戏地图的空间」。
    // 两件事都要能量：间隙读的是**渲染树里各面板回填的卡片矩形**，
    // 棋盘那一块用 `boardBox()`（格子区 + 塔壁 + 城垛的整体视觉盒）。
    //
    // ⚠️ 必须用视觉盒而不是格子区：上一版就是拿格子区当边界算间隙，
    // 而塔壁向上还多占 24px（城垛 10 + 壁厚 14），于是"间隙 20"在屏幕上
    // 实际是 −4 —— 城垛压在状态卡上，看单个文件发现不了。
    //
    // 棋盘 352 / 格子 32 是**上一版的值**，写死在这里当锚点：
    // 这一版加间隙的来源是"把设计稿的黑边吃回来"，不是缩棋盘。
    const layout = await page.evaluate(() => window.mota.game.__layout());
    const BOARD_SPAN_KEPT = 352;
    const BOARD_CELL_KEPT = 32;
    // 期望值在这里**独立写死**（与 hud.ts 的 LAYOUT.gap / LAYOUT.boardGap 一一对应）。
    // `after` 指的是「这一项之后那段缝」：top = 状态卡之前、hud = 状态卡与棋盘之间…
    //
    // ⚠️ **模块序列末尾那一条不算「间距」**，它是自由留白：
    // 空背包时道具栏整块不占位（见 A11），`detail` 之后就是到底边的一片场景（170px）；
    // 有道具时又回到 28。按构造它恒等于 `H −（最后一个模块的底）`，
    // 拿它做相等断言是同义反复，所以只量**模块之间**那几条。
    // 判据用「最后一个真的参与排版的模块」来定位，而不是写死索引 ——
    // 道具栏在不在序列里是动态的。
    const GAP_BETWEEN = { top: 28, hud: 40, board: 40, toolbar: 28, detail: 28, items: 28 };
    const lastPlaced = layout.placed[layout.placed.length - 1];
    const gapBad = layout.gaps
      .filter((g) => g.after !== lastPlaced)
      .filter((g) => g.value !== GAP_BETWEEN[g.after]);
    const boardKept = layout.boardSpan === BOARD_SPAN_KEPT && layout.boardCell === BOARD_CELL_KEPT;
    // 棋盘视觉盒的宽 = 面板宽 → 两者左右两端对齐，是「同一栏」的硬指标
    const aligned = layout.boardBox.w === layout.modules[0].w;
    // 棋盘前后那两条缝必须比面板之间更宽 —— 「不挤占地图空间」就是这一条
    const boardRoomier =
      layout.gaps.find((g) => g.after === 'hud').value >
      layout.gaps.find((g) => g.after === 'toolbar').value;
    // 空背包这一条要真的成立，A8 量的间隙才有意义
    const itemsDetached = !layout.itemsHidden || !layout.placed.includes('items');
    check(
      `A8 版面：间隙 ${GAP_BETWEEN.top}px、棋盘前后 ${GAP_BETWEEN.hud}px，棋盘 ${layout.boardSpan}px（未缩）、与面板同栏`,
      gapBad.length === 0 && boardKept && aligned && boardRoomier && itemsDetached,
      gapBad.length > 0
        ? `间隙不合：${gapBad.map((g) => `${g.after}=${g.value}（应 ${GAP_BETWEEN[g.after]}）`).join(' ')}`
        : !boardKept
          ? `棋盘被改了：span=${layout.boardSpan}（应 ${BOARD_SPAN_KEPT}）cell=${layout.boardCell}（应 ${BOARD_CELL_KEPT}）`
          : !aligned
            ? `棋盘盒宽 ${layout.boardBox.w} ≠ 面板宽 ${layout.modules[0].w}`
            : !boardRoomier
              ? '棋盘前后那两条缝没有比面板之间更宽'
              : !itemsDetached
                ? `道具栏空着但还占在排版序列里：placed=${layout.placed.join(',')}`
                : layout.gaps.map((g) => `${g.after}=${g.value}`).join(' ')
    );

    // ── A9 塔壁与地图内墙同源 ──
    //
    // 「地图周边的墙和地图的风格一致」：这一版的做法是让塔壁**直接平铺地图
    // 那面墙的贴图**，而不是调一个相近的颜色。所以断言比的是两张 Texture 的
    // `source`（base texture）—— 相同就意味着它们字面意义上是同一张图上的像素。
    // 有人把塔壁换成纯色几何体、或换成另一套素材，这条就会红。
    const walls = await page.evaluate(() => window.mota.game.board.__wallSources());
    check(
      'A9 塔壁与地图内墙同源（同一张素材图）',
      walls.parapet !== null && walls.parapet === walls.inner,
      walls.parapet === null
        ? '图集未加载，塔壁走的是程序化兜底 —— 这条断言无从谈起'
        : `parapet source=${walls.parapet} / 地图内墙 source=${walls.inner}`
    );

    // ── A10 位面：越往上星空越多 ──
    //
    // 背景的地平线高度由楼层位面决定。三条硬指标：
    //   ① 同一层重复问，画出来的地平线一致（背景是确定性的，星点也不该跳）；
    //   ② 从第 1 层到第 50 层，地平线**单调不升**（星空占比只增不减）；
    //   ③ 背景真的画的是当前显示层（`paintedFloor` 与 displayFloor 一致），
    //      否则换层后背景会慢一拍 —— 这种 bug 只有把两者分开报才抓得住。
    const realms = await page.evaluate(() => {
      const g = window.mota.game;
      const at = (f) => {
        g.__goto(f);
        return g.__probe().realm;
      };
      const f1 = at(1);
      at(2); // 中间穿插一层，确保第二次回到第 1 层是**真的重绘**过
      const f1again = at(1);
      const f13 = at(13);
      const f26 = at(26);
      const f50 = at(50);
      const bad = at(3);
      return { f1, f1again, f13, f26, f50, bad };
    });
    const hz = [realms.f1.horizon, realms.f13.horizon, realms.f26.horizon, realms.f50.horizon];
    const monotone = hz.every((v, i) => i === 0 || v <= hz[i - 1] + 1e-9);
    // 离开一层再回来，地平线必须回到同一个值 —— 星点用的是固定种子的
    // mulberry32，整层背景因此是可复现的（否则每次回来星星都换位置）
    const stable = realms.f1.horizon === realms.f1again.horizon;
    // 背景画的是不是"当前显示层"：`paintedFloor` 由 Backdrop 自己报，
    // 与 state.floor 分开报，才有可能发现"背景慢一拍"
    const followed = realms.bad.paintedFloor === 3;
    check(
      `A10 位面：地平线随楼层上移（第 1 层 ${hz[0].toFixed(2)} → 第 50 层 ${hz[3].toFixed(2)}）且可复现`,
      monotone && stable && followed,
      `单调=${monotone} 可复现=${stable}（1 层 ${realms.f1.horizon} / 回来 ${realms.f1again.horizon}）` +
        ` 背景跟随=${followed}（第 3 层时 paintedFloor=${realms.bad.paintedFloor}）`
    );

    // ── A11 道具栏：按需占位（空背包时整块不占位） ──
    //
    // 玩家原话是「移除无用的道具栏」。它不是没用 —— 可用道具（铁锹 / 地震卷轴 /
    // 炸药 / 上下飞行器 / 楼层传送器…共 12 种）只能从这一栏使用。真正的问题是
    // **它空着的时候也占着一整块版面**：上一版常驻 18 个空格子、高度写死 114px，
    // 一进游戏就有一块什么都不放的地方。
    //
    // 期望值在这里**独立重算**（与 hud.ts 的 itemBoxHeight 对撞）：
    //   空背包 → 0；1 件 → 1 行；10 件 → 2 行。
    // 最后一条还要检查「两行时卡片底正好距画布底 28」—— 那是版面节奏本身，
    // 只验高度看不出卡片跑偏。
    const ITEM_HEAD = 34;
    const SLOT_SIZE = 36;
    const SLOT_GAP = 3;
    const PER_ROW = 9;
    const PAD_BOTTOM = 5;
    const expectItemH = (n) => {
      if (n <= 0) return 0;
      const rows = Math.ceil(n / PER_ROW);
      return ITEM_HEAD + rows * SLOT_SIZE + (rows - 1) * SLOT_GAP + PAD_BOTTOM;
    };
    const itemFlow = await page.evaluate((ids) => {
      const g = window.mota.game;
      const snap = () => {
        const l = g.__layout();
        const m = l.modules.find((x) => x.id === 'items');
        return {
          h: m.h,
          y: m.y,
          H: l.H,
          hidden: l.itemsHidden,
          placed: l.placed.join(','),
          bag: g.__probe().bag.length
        };
      };
      const none = snap();
      g.__grant(ids[0]);
      const one = snap();
      for (const id of ids.slice(1)) g.__grant(id); // 补到 10 件
      const ten = snap();
      return { none, one, ten };
    }, ['shovel', 'snowflake', 'bomb', 'quakeScroll', 'upFlyer', 'downFlyer',
        'mirrorFlyer', 'floorTeleporter', 'holyWater', 'goldenKey']);
    // ① 空背包：高度 0、不参与排版、渲染层也不可见
    const noBagOk =
      itemFlow.none.h === 0 &&
      itemFlow.none.hidden === true &&
      !itemFlow.none.placed.split(',').includes('items') &&
      itemFlow.none.bag === 0;
    // ② 1 件：一行高
    const oneOk =
      itemFlow.one.h === expectItemH(1) &&
      itemFlow.one.hidden === false &&
      itemFlow.one.placed.includes('items');
    // ③ 10 件：两行高，且卡片底与画布底的距离回到 28（与其它模块同节奏）
    const bottomGap = itemFlow.ten.H - (itemFlow.ten.y + itemFlow.ten.h);
    const tenOk =
      itemFlow.ten.bag === 10 &&
      itemFlow.ten.h === expectItemH(10) &&
      itemFlow.ten.h === 114 &&
      bottomGap === 28;
    check(
      `A11 道具栏：空背包不占位（0px）、1 件 ${expectItemH(1)}px、10 件 ${expectItemH(10)}px 且底距 ${bottomGap}px`,
      noBagOk && oneOk && tenOk,
      !noBagOk
        ? `空背包时：h=${itemFlow.none.h} hidden=${itemFlow.none.hidden} placed=${itemFlow.none.placed} bag=${itemFlow.none.bag}`
        : !oneOk
          ? `1 件时：h=${itemFlow.one.h}（应 ${expectItemH(1)}）hidden=${itemFlow.one.hidden}`
          : !tenOk
            ? `10 件时：h=${itemFlow.ten.h}（应 ${expectItemH(10)}=114）bag=${itemFlow.ten.bag} 底距=${bottomGap}（应 28）`
            : `空背包 0 → 1 件 ${itemFlow.one.h} → 10 件 ${itemFlow.ten.h}`
    );

    // ── A12 手绘怪物：落屏的确实是图集，不是退回的程序化图形 ──
    //
    // 两代手绘共 35 只（MANIFEST 里 src 含「手绘」，清单是**动态**读的，不写死）：
    //   第一代 13 只「名字与素材对不上」：史莱姆族 4、蝙蝠族 3、石人 / 乌贼 / 龙 / 吸血鬼 / 魔王 2；
    //   第二代 22 只人形怪「读不出职业与等级」：守卫 3、骑士 5、法师 6、兽人 3、骷髅 3、幽魂 2。
    // 它们存在的意义就是**换掉**原来那张不符的素材。而渲染层是「有图集用图集，
    // 没有就退回 icons.ts 的程序化图形」—— 一旦退回，这一轮就等于白做，
    // 而画面看上去「还好」，肉眼比对不可靠。`source.uid` 是同一性，一比就知道。
    //
    // 两个独立来源对撞：
    //   期望值：Node 侧读 assets/MANIFEST.json 的 idle[0] + data/floors/*.json 的实体表；
    //   实测值：浏览器里 `board.__sprites()` 报出的落屏纹理 uid 与帧矩形。
    // 判据：
    //   ① 棋盘上没有**任何**怪物走到程序化兜底（uid === null）；
    //   ② 全部怪物共用同一个 source（怪物只有一张 monsters.png）；
    //   ③ 落屏帧矩形与 MANIFEST 里的 idle[0] 一致（图集与运行时同一份坐标）；
    //   ④ 这 6 层里该出现的手绘怪物一只不少地被看见过（抓「改完忘了接进 PROC_MONSTERS」）。
    //
    // 注：`vampire` 与 `demonKingTrue` 在 50 层里没有出场点，只在图集里备着，
    // 所以下面按「这几层实际出现的」来算，不硬要求 13 只全见过。
    const handDrawn = Object.entries(MANIFEST.monsters)
      .filter(([, m]) => String(m.src ?? '').includes('手绘'))
      .map(([id]) => id);
    const SHOWCASE = [1, 14, 15, 35, 45, 50];
    const perFloor = new Map(); // 楼层 → 该层出现的手绘怪物 id
    for (const f of SHOWCASE) {
      const p = path.join(ROOT, 'data/floors', `floor-${String(f).padStart(2, '0')}.json`);
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      perFloor.set(
        f,
        (j.entities ?? [])
          .filter((e) => e.type === 'monster' && handDrawn.includes(e.id))
          .map((e) => e.id)
      );
    }
    const seenMon = new Map(); // 手绘怪物 id → uid
    const monUids = new Set(); // 棋盘上出现过的**全部**怪物 uid
    const fellBack = [];
    const frameBad = [];
    for (const f of SHOWCASE) {
      if (perFloor.get(f).length === 0) continue;
      const sprites = await page.evaluate((floor) => {
        window.mota.game.__goto(floor);
        return window.mota.game.board.__sprites();
      }, f);
      const want = new Set(perFloor.get(f));
      for (const s of sprites) {
        if (s.kind !== 'monster') continue;
        monUids.add(s.uid);
        if (s.uid === null) fellBack.push(`第 ${f} 层 ${s.id}`);
        if (!want.has(s.id)) continue;
        // 落屏的必须是 MANIFEST 里 **idle 四帧中的某一帧** —— 不能只对 idle[0]：
        // 渲染层按相位错开取帧，所以拍到哪一帧取决于相位，但对 idle[0]
        // 会得到「明明对却报错」的假红（这条断言第一版就是这么红的）。
        const idle = MANIFEST.monsters[s.id]?.idle ?? [];
        const fw = MANIFEST.monsters[s.id]?.frame;
        const hit = idle.findIndex((fr) => s.frame && fr.x === s.frame.x && fr.y === s.frame.y);
        const sizeOk = s.frame && s.frame.w === (fw?.w ?? 16) && s.frame.h === (fw?.h ?? 16);
        if (hit < 0 || !sizeOk) {
          frameBad.push(
            `第 ${f} 层 ${s.id} 落屏 ${JSON.stringify(s.frame)} / 该怪的 idle ${JSON.stringify(idle)}`
          );
        } else if (!seenMon.has(s.id)) {
          seenMon.set(s.id, { uid: s.uid, frameIdx: hit });
        }
      }
    }
    const shouldSee = [...new Set(SHOWCASE.flatMap((f) => perFloor.get(f)))];
    const notSeen = shouldSee.filter((id) => !seenMon.has(id));
    const uids = [...monUids].filter((u) => u !== null);
    check(
      `A12 手绘怪物：${shouldSee.length} 只全部落在一张图集上（帧 ${MANIFEST.meta.rasterTile}×${MANIFEST.meta.rasterTile} 与 MANIFEST 一致）`,
      handDrawn.length >= 10 &&
        fellBack.length === 0 &&
        frameBad.length === 0 &&
        notSeen.length === 0 &&
        uids.length === 1,
      handDrawn.length < 10
        ? `MANIFEST 里标了「手绘」的怪物只有 ${handDrawn.length} 只，前提不成立`
        : fellBack.length
          ? `这些怪物走了程序化兜底（uid=null）：${fellBack.slice(0, 4).join(' ')}`
          : frameBad.length
            ? `落屏帧与 MANIFEST 不符：${frameBad.slice(0, 3).join(' | ')}`
            : notSeen.length
              ? `这几层里该出现却没在棋子上看见：${notSeen.join(' ')}`
              : uids.length !== 1
                ? `怪物用到了 ${uids.length} 个不同的 source：${uids.join(',')}`
                : `手绘 ${handDrawn.length} 只 / 本组实见 ${shouldSee.length} 只，全部落在 source=${uids[0]}，` +
                  `拍到 idle 第 ${[...new Set([...seenMon.values()].map((v) => v.frameIdx))].sort().join('/')} 帧`
    );

    // ── A13 楼层浏览：选完还能返回，返回后输入复活 ──
    //
    // 修的是一条**死路**：选完楼层后面板收起，而 `browseFloor` 仍非空 —— 于是
    // 「唯一能返回的入口」消失了，棋盘输入又被 `browseFloor` 全量挡掉（所有入口
    // 都写 `browseFloor !== null` 就 return），勇者还被隐藏了。触摸设备没有 Esc，
    // 玩家彻底卡死。实测症状是「点棋盘步数 0 → 0」这种**静默**的没反应。
    //
    // 修法不是「别收面板」，而是**把出口挪到一个收起来也还在的地方**：
    // 工具栏中间那颗按钮在浏览态下变成「返回第 N 层」并高亮。收面板反而是必须的 ——
    // 面板卡片 y=240..700 会把棋盘（178..544）和工具栏（584..616）一起盖住，
    // 留着它既看不清点开的那一层，也按不到那颗返回键（实测：点上去毫无反应，
    // Pixi `hitTest` 命中的是面板自己的全屏遮罩）。
    //
    // 断言只看行为，不看代码：
    //   ① 选完这一层后面板收起、棋盘真的换成了第 7 层、勇者被隐藏；
    //   ② 工具栏摆出「返回第 1 层」——文案报的是**要回到哪一层**（勇者自己那层）；
    //   ③ 点它之后回到自己那层、**勇者回来了**；
    //   ④ 然后棋盘**真的能走**（步数变了）—— 这才是「无法继续操作」的正面反驳。
    //
    // ⚠️ 顺带抓住一个真 bug：`Toolbar.browseLabel` 一度写成读 `browsePill.label`
    //    （Pixi `Container.label`，渲染树标记字符串），于是这条断言永远看到标记而
    //    不是文案。所以这里比的是**完整文案**，不是「非空」。
    const cellCenter = (cx, cy) => ({ x: 34 + cx * 32 + 16, y: 178 + cy * 32 + 16 });
    /**
     * 一次「像手指那样」的点击：移动 → 停一帧 → 按下 → 停一帧 → 抬起。
     *
     * ⚠️ 不能图省事用 `page.mouse.click()` —— 它在同一毫秒里发完 move/down/up，
     *    而 Pixi 的事件边界是在**帧**里更新命中目标的：down 会沿用上一次移动
     *    算出来的那个目标。实测后果是「点面板里的楼层格子毫无反应」，而且
     *    `page.mouse.click()` 点工具栏却是好的（因为那一下之前刚移动过），
     *    于是症状看着像「面板坏了」。中间留一帧就正常了。
     */
    const tap = async (x, y) => {
      await page.mouse.move(x, y);
      await page.waitForTimeout(60);
      await page.mouse.down();
      await page.waitForTimeout(60);
      await page.mouse.up();
    };
    const browseBtn = { x: 20 + 120 + 10 + 60, y: 584 + 16 }; // 工具栏三按钮的中间那颗
    const floorCell = (i) => ({
      // FLOOR_CARD x=20 y=240 w=380 head=76；6 列 × 50 宽、间距 4；格高 34、行距 38
      x: 20 + Math.round((380 - (6 * 50 + 5 * 4)) / 2) + (i % 6) * 54 + 25,
      y: 240 + 76 + Math.floor(i / 6) * 38 + 17
    });

    // ⚠️ 先把游戏**重开**，否则这一组断言会红得莫名其妙。
    //
    // A1~A12 会 `__goto` 跑遍全塔，而有些楼层的落点正好在**巫师领域**里 ——
    // 于是勇者在中途阵亡，`showDeath()` 往 `deathLayer`（舞台最顶层）铺了一张
    // 满屏 `eventMode='static'` + `hitArea` 的 Graphics。那张遮罩是全屏的，
    // 它会**吃掉所有点击**，症状就是「点面板里的楼层格子毫无反应」——
    // 实测排查时 Pixi 的 `hitTest` 命中的正是 `root.children[10].children[0]`。
    // `r` 走的是游戏自己的重开路径（清 deathLayer、复位状态、回到第 1 层），
    // 比在测试里手动拆遮罩更贴近真实 —— 玩家也是这么复活的。
    await page.keyboard.press('r');
    await page.waitForTimeout(250);

    const snap = () =>
      page.evaluate(() => {
        const g = window.mota.game;
        const p = g.__probe();
        // `floorPanel` 是 TS private，运行时可直接读；用 `visible` 而不是另加探针字段 ——
        // 面板开没开这件事本身就写在渲染树上，加一层转发只会多一个漂移点。
        return {
          browsing: p.browsing,
          displayFloor: p.displayFloor,
          floor: p.floor,
          steps: p.steps,
          modal: p.modal,
          dead: p.dead,
          label: String(p.toolbarBrowseLabel ?? ''),
          panelOpen: g.floorPanel.visible,
          panelMode: g.floorPanel.mode,
          // 「返回后角色没了」是用户的原话，所以直接把勇者层的可见性量出来 ——
          // 它比任何间接推断都更贴题（`heroLayer` 是 TS private，运行时可直接读）
          heroVisible: g.board.heroLayer.visible
        };
      });

    await tap(browseBtn.x, browseBtn.y); // 「楼层浏览」
    await page.waitForTimeout(180);
    const opened = await snap();
    await tap(floorCell(7).x, floorCell(7).y); // 「第 7 层」格
    await page.waitForTimeout(220);
    const afterPick = await snap();

    // 此刻工具栏中间那颗按钮已经变成「返回第 1 层」—— 文案报的是**要回到哪一层**
    // （勇者自己那层），不是正在看的那一层。这一点写错会让断言一直红得很冤枉。
    const wantBack = `返回第 ${afterPick.floor} 层`;
    await tap(browseBtn.x, browseBtn.y); // 此时它就是「返回」
    await page.waitForTimeout(240);
    const afterReturn = await snap();

    const beforeWalk = afterReturn.steps;
    const upCell = cellCenter(5, 9); // 第 1 层勇者站在 (5,10)，正上方就是可走的空地
    await tap(upCell.x, upCell.y);
    await page.waitForTimeout(700);
    const afterWalk = await snap();

    const a13Bad = [];
    if (opened.dead || afterPick.steps !== 0) {
      a13Bad.push(
        `重开之后不干净（dead=${opened.dead} steps=${afterPick.steps}）—— ` +
          `多半是前面某条断言把勇者留在了阵亡状态，那张死亡遮罩会吃掉全部点击`
      );
    }
    if (opened.panelOpen !== true) a13Bad.push('点「楼层浏览」后面板没打开');
    // 选完必须收起面板：面板卡片 y=240..700 会把棋盘（178..544）和工具栏（584..616）
    // 一起盖住 —— 留着面板，既看不清点开的那一层，也按不到工具栏上的「返回」。
    if (afterPick.panelOpen !== false) {
      a13Bad.push('选完楼层后面板没收起 —— 它盖着棋盘也让工具栏的「返回」按不着');
    }
    if (afterPick.browsing !== true) a13Bad.push(`选完楼层后 browsing=${afterPick.browsing}（没进入浏览态）`);
    if (afterPick.displayFloor !== 7) a13Bad.push(`选完第 7 层后棋盘显示的是第 ${afterPick.displayFloor} 层`);
    if (afterPick.floor !== 1) a13Bad.push(`浏览不该改变勇者所在层，但它变成了第 ${afterPick.floor} 层`);
    if (afterPick.heroVisible !== false) {
      a13Bad.push('浏览别的层时勇者不该还站在棋盘上（这一格是那一层的地形）');
    }
    if (afterReturn.heroVisible !== true) {
      a13Bad.push('返回后勇者没有回到棋盘上 —— 这就是用户说的「返回后角色没了」');
    }
    if (afterPick.label !== wantBack) {
      a13Bad.push(`选完之后工具栏文案是「${afterPick.label}」而不是「${wantBack}」—— 返回入口没摆出来`);
    }
    if (afterReturn.browsing !== false) a13Bad.push(`点了返回但仍在浏览态（browsing=${afterReturn.browsing}）`);
    if (afterReturn.displayFloor !== 1) a13Bad.push(`返回后棋盘还停在第 ${afterReturn.displayFloor} 层`);
    if (afterReturn.label !== '楼层浏览') a13Bad.push(`返回后工具栏文案是「${afterReturn.label}」—— 状态没复位`);
    if (afterReturn.panelOpen !== false) a13Bad.push('点了返回面板还开着');
    if (afterWalk.steps <= beforeWalk) {
      a13Bad.push(`返回后点棋盘步数 ${beforeWalk} → ${afterWalk.steps}，人还是不动`);
    }
    check(
      `A13 楼层浏览：选完第 7 层后面板收起、工具栏摆出「${afterPick.label}」；` +
        `返回后勇者归位且棋盘恢复可走（步数 ${beforeWalk} → ${afterWalk.steps}）`,
      a13Bad.length === 0,
      (a13Bad.length ? a13Bad.slice(0, 3).join(' | ') + ' ⟵ ' : '') +
        `opened=${JSON.stringify(opened)} pick=${JSON.stringify(afterPick)} ` +
        `ret=${JSON.stringify(afterReturn)} steps ${beforeWalk}→${afterWalk.steps}`
    );

    // ── A14 攻击动画：挥剑全程形体与尺寸不变，靠 attackFx 的时间轴演 ──
    //
    // 「攻击时角色会变小」是观感问题，但它有可量的代理量：**精灵的贴图矩形与
    // 落屏宽高**。旧做法是切到挥剑帧，而挥剑帧身体只有 17 行、剑尖顶到底边，
    // 在 bottom_center 锚点下把整个人抬离地面 —— 看起来就是「变小 + 浮空」。
    // 新做法全程用走路帧，动的是 `heroLunge`（前冲）与 `attackFx`（刀光）。
    // 所以断言量：全程 size/frame 只有**一个**取值、且等于待机时的取值；
    // 过程中 attackFx 的实测包围盒面积 > 0（真的有东西落屏），
    // 结束后回到 0 且 attacking=false（收干净）。四个方向都过一遍。
    const atk = await page.evaluate(async () => {
      const b = window.mota.game.board;
      const idle = b.__hero();
      const sizes = new Set();
      const frames = new Set();
      const turn = {};
      let maxLunge = 0;
      let maxFx = 0;
      const key = (o) => (o ? `${o.w}x${o.h}` : 'null');
      for (const dir of ['right', 'left', 'up', 'down']) {
        b.playHeroAttack(dir);
        const t0 = performance.now();
        while (performance.now() - t0 < 340) {
          const h = b.__hero();
          sizes.add(key(h.size));
          frames.add(key(h.frame));
          turn[dir] = turn[dir] ?? h.dir;
          maxLunge = Math.max(maxLunge, Math.abs(h.lunge.x), Math.abs(h.lunge.y));
          maxFx = Math.max(maxFx, h.fxBounds.w * h.fxBounds.h);
          await new Promise((r) => requestAnimationFrame(r));
        }
      }
      const after = b.__hero();
      return {
        idleSize: key(idle.size),
        idleFrame: key(idle.frame),
        sizes: [...sizes],
        frames: [...frames],
        turn,
        maxLunge,
        maxFx,
        afterAttacking: after.attacking,
        afterFx: after.fxBounds.w * after.fxBounds.h
      };
    });
    const atkBad = [];
    if (atk.sizes.length !== 1 || atk.sizes[0] !== atk.idleSize) {
      atkBad.push(`挥剑全程落屏尺寸出现 ${atk.sizes.length} 种：${atk.sizes.join(' / ')}（待机是 ${atk.idleSize}）`);
    }
    if (atk.frames.length !== 1 || atk.frames[0] !== atk.idleFrame) {
      atkBad.push(`挥剑全程贴图帧出现 ${atk.frames.length} 种：${atk.frames.join(' / ')}（待机是 ${atk.idleFrame}）`);
    }
    if (atk.maxFx <= 0) atkBad.push('挥剑全程 attackFx 的包围盒一直是 0 —— 刀光根本没画出来');
    if (atk.maxLunge <= 1) atkBad.push(`前冲位移最大只有 ${atk.maxLunge.toFixed(2)}px —— 没看出有挥剑动作`);
    if (atk.afterAttacking || atk.afterFx !== 0) {
      atkBad.push(`挥剑结束后没有收干净：attacking=${atk.afterAttacking} fxArea=${atk.afterFx}`);
    }
    for (const dir of ['right', 'left', 'up', 'down']) {
      if (atk.turn[dir] !== dir) atkBad.push(`朝 ${dir} 挥剑时朝向是 ${atk.turn[dir]}`);
    }
    check(
      `A14 攻击动画：四向挥剑全程形体恒为 ${atk.idleSize}（不切帧、不变小），刀光面积峰值 ${atk.maxFx}px²`,
      atkBad.length === 0,
      atkBad.slice(0, 3).join(' | ') || `尺寸/帧各只有 1 种取值，前冲峰值 ${atk.maxLunge.toFixed(1)}px`
    );

    // ── A15 对话折行：不超卡片内宽，且守住中文行首/行尾禁则 ──
    //
    // 「NPC 对话内容不会换行」的根因是 `LINE_UNITS` 写死 32，而卡片正文可用宽只有
    // 352px / 正文 11.5px ≈ 30 个单位 —— 于是 46 个 NPC 里 42 行**捅出卡片右边缘**
    // （实测最宽 368px）。现在单位数由几何算出来（hud.ts `unitsPerLine`）。
    //
    // 可用宽度**从渲染树反推**（正文 Text 的 x 减卡片左边 = UI.pad），
    // 不在这里抄一份 `14` —— 抄一份就多一个漂移点。
    const dia = await page.evaluate(() => {
      const g = window.mota.game;
      const rows = [];
      let npcs = 0;
      let firstRet = null;
      let maxKids = 0;
      const modalBefore = g.__probe().modal;
      for (const [floor] of g.data.floors) {
        for (const e of (g.data.floors.get(floor)?.entities ?? []).filter((x) => x.type === 'npc')) {
          g.__goto(floor);
          const ret = g.__talk(e.id);
          if (firstRet === null) firstRet = String(ret);
          maxKids = Math.max(maxKids, g.dialogue.body.children.length);
          for (const t of g.dialogue.body.children) {
            rows.push({ floor, id: e.id, text: t.text, w: Math.round(t.width), x: t.x });
          }
          g.dialogue.close();
          npcs++;
        }
      }
      const card = g.dialogue.cardRect;
      return { card, rows, npcs, firstRet, maxKids, modalBefore };
    });
    const firstRow = dia.rows[0];
    const padFromTree = firstRow ? firstRow.x - dia.card.x : null;
    const avail = padFromTree === null ? null : dia.card.w - padFromTree * 2;
    const BAD_START = '，。、！？：；）」』】》〉〗·…—～%℃′″';
    const BAD_END = '（「『【《〈〖';
    const over = avail === null ? [] : dia.rows.filter((r) => r.w > avail);
    const badStart = dia.rows.filter((r) => BAD_START.includes(r.text[0]));
    const badEnd = dia.rows.filter((r) => BAD_END.includes(r.text[r.text.length - 1]));
    const widest = dia.rows.reduce((m, r) => Math.max(m, r.w), 0);
    check(
      `A15 对话折行：${dia.npcs} 个 NPC / ${dia.rows.length} 行全部落在卡片内宽（最宽 ${widest}px ≤ ${avail}px）、无标点顶行首`,
      dia.npcs >= 40 && dia.rows.length > 0 && over.length === 0 && badStart.length === 0 && badEnd.length === 0,
      dia.npcs < 40 || dia.rows.length === 0
        ? `只采到 ${dia.npcs} 个 NPC / ${dia.rows.length} 行（最多一次长出 ${dia.maxKids} 个正文 Text），` +
          `前提不成立 —— 开始采样时 modal=${dia.modalBefore}，首次搭话返回「${dia.firstRet}」`
        : over.length
          ? `${over.length} 行超出 ${avail}px：` +
            over.slice(0, 2).map((r) => `第${r.floor}层「${r.text}」(${r.w}px)`).join(' ')
          : badStart.length
            ? `${badStart.length} 行以收尾标点开头（中文行首禁则）：` +
              badStart.slice(0, 2).map((r) => `「${r.text}」`).join(' ')
            : `${badEnd.length} 行以开引号/开括号结尾：` +
              badEnd.slice(0, 2).map((r) => `「${r.text}」`).join(' ')
    );

    // ── A16 上下楼梯：两张不同形体，不是同一张图翻转 ──
    //
    // 旧写法是「下＝floor_ladder 原样，上＝同一张垂直翻转」。而 floor_ladder 近乎
    // 上下对称，翻转后肉眼读不出区别 —— 玩家在塔里分不清哪边往上走。
    // 这一版两张都手绘（下＝俯视竖井、上＝侧视梯段）。
    //
    // 断言**直接读发布出去的那张图集**：把 terrain.png 交给浏览器解码，按 MANIFEST
    // 的帧矩形切出两格，量各自的横剖面（每列平均亮度）走向。这样查的是真正落屏的
    // 像素，而不是构建脚本里的意图。判据四条：
    //   ① 两格不是同一张图；
    //   ② 上楼梯不是下楼梯的垂直翻转（旧写法正好卡在这一条）；
    //   ③ 下＝两端亮中间暗（井），上＝自左向右单调变亮（梯段）—— 形体走向相反；
    //   ④ MANIFEST 的 src 文案与「手绘」一致（防止改了脚本忘了重跑 assets）。
    const terrainPng = fs
      .readdirSync(path.join(DIST, 'assets'))
      .find((n) => /^terrain.*\.png$/.test(n));
    const tDown = MANIFEST.terrain['3'];
    const tUp = MANIFEST.terrain['4'];
    const atlasReady = (await page.evaluate(() => window.mota.game.__probe())).atlasReady;
    const stair = terrainPng
      ? await page.evaluate(
          async ({ b64, a, b }) => {
            const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
            const cv = new OffscreenCanvas(bmp.width, bmp.height);
            const ctx = cv.getContext('2d');
            ctx.drawImage(bmp, 0, 0);
            const all = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
            const lum = (i) => (0.2126 * all[i] + 0.7152 * all[i + 1] + 0.0722 * all[i + 2]) / 255;
            const cut = (r) => {
              const g = [];
              for (let y = 0; y < r.h; y++) {
                const row = [];
                for (let x = 0; x < r.w; x++) {
                  const i = ((r.y + y) * bmp.width + (r.x + x)) * 4;
                  row.push(all[i + 3] === 0 ? -1 : lum(i));
                }
                g.push(row);
              }
              return g;
            };
            const cols = (g) => {
              const out = [];
              for (let x = 0; x < g[0].length; x++) {
                let t = 0;
                let n = 0;
                for (let y = 0; y < g.length; y++) {
                  if (g[y][x] < 0) continue;
                  t += g[y][x];
                  n++;
                }
                out.push(n ? t / n : 0);
              }
              return out;
            };
            const same = (p, q) => JSON.stringify(p) === JSON.stringify(q);
            const up = cut(b);
            const down = cut(a);
            return {
              same: same(up, down),
              isFlip: same(up, down.slice().reverse()),
              downCols: cols(down),
              upCols: cols(up)
            };
          },
          {
            b64: fs.readFileSync(path.join(DIST, 'assets', terrainPng)).toString('base64'),
            a: { x: tDown.x, y: tDown.y, w: tDown.w, h: tDown.h },
            b: { x: tUp.x, y: tUp.y, w: tUp.w, h: tUp.h }
          }
        )
      : null;

    const stairBad = [];
    if (!atlasReady) stairBad.push('图集没加载成功，落屏的是程序化兜底图形 —— 这条断言无从谈起');
    if (!stair) stairBad.push('dist 里找不到 terrain 图集，无法核对落屏像素');
    if (stair) {
      const dc = stair.downCols;
      const uc = stair.upCols;
      // 下＝侧视下沉：自左向右单调变暗（越往右下越深）
      let worstDown = 0;
      for (let i = 0; i < dc.length - 1; i++) worstDown = Math.max(worstDown, dc[i + 1] - dc[i]);
      const fall = dc[0] - dc[dc.length - 1];
      // 上＝侧视上升：自左向右单调变亮（越往右上越接近出口）
      let worst = 0;
      for (let i = 0; i < uc.length - 1; i++) worst = Math.max(worst, uc[i] - uc[i + 1]);
      const rise = uc[uc.length - 1] - uc[0];
      if (stair.same) stairBad.push('上楼梯与下楼梯是同一张图 —— 玩家分不清方向');
      else if (stair.isFlip) {
        stairBad.push(
          '上楼梯正好是下楼梯的垂直翻转 —— 翻转在 32px 上等价于同一张图，' +
            '这正是要修掉的那种写法（两者必须是不同形体）'
        );
      }
      if (fall < 0.15 || worstDown > 0.02) {
        stairBad.push(
          `下楼梯不是自左向右单调变暗（${dc[0].toFixed(3)} → ${dc[dc.length - 1].toFixed(3)}，` +
            `落差 ${fall.toFixed(3)}，最大回弹 ${worstDown.toFixed(3)}）—— 它必须是「往右下沉」的梯段`
        );
      }
      if (rise < 0.15 || worst > 0.02) {
        stairBad.push(`上楼梯不是自左向右单调变亮（落差 ${rise.toFixed(3)}，最大回退 ${worst.toFixed(3)}）`);
      }
    }
    const srcText = `${tDown.src ?? ''}|${tUp.src ?? ''}`;
    if (/翻转/.test(srcText)) {
      stairBad.push(`MANIFEST 里两张楼梯的 src 仍写着「翻转」：${srcText} —— 改了构建脚本但没重跑 assets`);
    } else if (String(tDown.src) === String(tUp.src)) {
      stairBad.push(`两张楼梯的 src 完全一样：${tDown.src}`);
    }
    check(
      `A16 上下楼梯：下沉梯段（${stair ? (stair.downCols[0] ?? 0).toFixed(2) : '?'} → ` +
        `${stair ? (stair.downCols[stair.downCols.length - 1] ?? 0).toFixed(2) : '?'}）与上升梯段` +
        `（${stair ? (stair.upCols[0] ?? 0).toFixed(2) : '?'} → ${stair ? (stair.upCols[stair.upCols.length - 1] ?? 0).toFixed(2) : '?'}）走向相反`,
      stairBad.length === 0,
      stairBad.slice(0, 3).join(' | ') || `${tDown.src} ／ ${tUp.src}`
    );

    // ── A17 像素密度：网格翻倍，但落屏尺寸一点不变 ──
    //
    // 「画面更精细」有两条路，代价差一个量级，容易走错：
    //   ① 把设计稿放大 —— 五块面板全部重排，版面与断言跟着动一片；
    //   ② 把**素材网格**翻倍 —— 出图从 16 网格升到 32 网格，drawScale 相应减半，
    //      落屏的设计像素数不变（16×2 = 32×1）。
    // 这一版走 ②。所以这条断言要同时钉住两件事，缺一条就是假的：
    //   密 —— 图集帧的边长必须是原始素材的 supersample 倍（真的多画了像素）；
    //   不变 —— 帧边长 × drawScale 必须仍等于格子边长（否则版面全歪）。
    //
    // 光看画面分不出这两件事：32 网格的图按 1:1 画、和 16 网格的图按 2× 画，
    // 落屏**一模一样**。所以只能靠断言，不能靠眼看。
    const meta = MANIFEST.meta ?? {};
    const ss = Number(meta.supersample ?? 1);
    const rasterTile = Number(meta.rasterTile ?? meta.baseTile ?? 16);
    const cell = Number(meta.cell ?? 32);
    const densBad = [];
    if (ss < 2) densBad.push(`MANIFEST.supersample=${ss} —— 图集仍是绘制网格，没有超采样`);
    if (rasterTile !== Number(meta.baseTile) * ss) {
      densBad.push(`rasterTile(${rasterTile}) ≠ baseTile(${meta.baseTile}) × supersample(${ss})`);
    }
    // 逐条地形帧：边长 = rasterTile，且 drawScale = cell / rasterTile（落屏仍是一格）
    const wantScale = cell / rasterTile;
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    const thinTerrain = Object.entries(MANIFEST.terrain).filter(
      ([k, v]) => v && (v.w !== rasterTile || v.h !== rasterTile || !near(v.drawScale, wantScale))
    );
    if (thinTerrain.length) {
      densBad.push(
        `地形帧没有全部升到 ${rasterTile} 网格 / drawScale=${wantScale}：` +
          thinTerrain.slice(0, 3).map(([k, v]) => `${k}=${v.w}×${v.h}×${v.drawScale}`).join(' ')
      );
    }
    // 角色：走路帧宽 = rasterTile、drawScale = 1（勇者落屏必须还是 32×52）
    const heroNode = MANIFEST.actors?.hero;
    const heroFrame0 = heroNode?.walk?.down?.[0];
    if (!heroFrame0 || heroFrame0.w !== rasterTile || !near(heroNode.drawScale, wantScale)) {
      densBad.push(
        `勇者帧 ${heroFrame0?.w}×${heroFrame0?.h} × drawScale ${heroNode?.drawScale} —— ` +
          `应当是 ${rasterTile} 网格 × ${wantScale}`
      );
    }
    // 怪物：帧一律 = rasterTile 网格；落屏要么一格、要么「大家伙」1.5 格。
    // 大家伙以前靠「不超采样 + 整数倍」表达体型，现在改成同一网格 + 小数倍，
    // 所以判据从「维持 16 网格」改成「落屏仍是 1.5 格」。
    const monBad = [];
    for (const [id, node] of Object.entries(MANIFEST.monsters)) {
      if (!node) continue;
      const onScreen = node.frame.w * node.drawScale;
      if (node.frame.w !== rasterTile) {
        monBad.push(`${id} 帧 ${node.frame.w} 不是 ${rasterTile} 网格`);
      } else if (!near(onScreen, cell) && !near(onScreen, cell * 1.5)) {
        monBad.push(`${id} 落屏 ${onScreen} 既不是一格(${cell}) 也不是大家伙(${cell * 1.5})`);
      }
    }
    if (monBad.length) densBad.push(`怪物网格/落屏不对：${monBad.slice(0, 3).join(' ')}`);

    // 「密」的实证：拿发布出去的图集帧，和**第三方原始素材**比边长。
    // 只看 MANIFEST 的数字等于只信构建脚本的自述；这里量的是两张真图。
    // 地板、墙都已改成**手绘**（不再来自第三方位图），所以参照物换成仍在走
    // 超采样的岩浆：它的源 wall_goo 是 16×16，出图必须落到 16 × supersample。
    const rawLava = path.join(ROOT, 'assets/raw/0x72/frames/wall_goo.png');
    let rawCmp = null;
    if (fs.existsSync(rawLava) && terrainPng) {
      const rawB64 = fs.readFileSync(rawLava).toString('base64');
      const atlasB64 = fs.readFileSync(path.join(DIST, 'assets', terrainPng)).toString('base64');
      rawCmp = await page.evaluate(
        async ({ raw, atlas, rect }) => {
          const side = async (b64) => {
            const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
            return { w: bmp.width, h: bmp.height };
          };
          return { raw: await side(raw), frame: rect };
        },
        { raw: rawB64, atlas: atlasB64, rect: { w: MANIFEST.terrain['5'].w, h: MANIFEST.terrain['5'].h } }
      );
      if (rawCmp.frame.w !== rawCmp.raw.w * ss) {
        densBad.push(
          `岩浆帧 ${rawCmp.frame.w} ≠ 原始 wall_goo ${rawCmp.raw.w} × ${ss} —— 网格没有真的翻倍`
        );
      }
    } else {
      densBad.push(`找不到 ${path.relative(ROOT, rawLava)} 或发布图集，无法核对网格`);
    }

    // 「不变」的实证：量落屏的勇者。A14 已经量过形体，这里量的是**尺寸数值** ——
    // 网格翻倍若把落屏一起放大了，这里会立刻变成 64×104。
    const heroNow = await page.evaluate(() => window.mota.game.board.__hero());
    if (!heroNow || Math.round(heroNow.size.w) !== 32 || Math.round(heroNow.size.h) !== 52) {
      densBad.push(`勇者落屏 ${heroNow ? `${heroNow.size.w}×${heroNow.size.h}` : '?'} —— 应当是 32×52（与翻倍前一致）`);
    }

    check(
      `A17 像素密度：图集 ${rasterTile} 网格（原始 ${meta.baseTile} ×${ss}）、drawScale=${meta.drawScale}，` +
        `落屏勇者仍 ${heroNow ? `${Math.round(heroNow.size.w)}×${Math.round(heroNow.size.h)}` : '?'}`,
      densBad.length === 0,
      densBad.slice(0, 3).join(' | ') ||
        `岩浆 ${rawCmp ? `${rawCmp.raw.w} → ${rawCmp.frame.w}` : '?'}，格子 ${cell}px 不变`
    );

    // ── A18 文字光栅化分辨率跟随屏幕 ──
    //
    // 这一条以前是**写死 2**：手机 dpr=3，文字按 2× 光栅化后上屏还要再拉 1.5 倍。
    // 中文笔画细，这一道拉伸就是「面板文字发虚」的全部来源，而且它影响的是每一块面板。
    // 只在本页（dsf=2）断言会恒绿 —— 写死 2 也能过。所以**另开一个 dsf=3 的页面**：
    // 那里期望值必须是 3，写死 2 的实现会当场挂掉。
    const trBad = [];
    const main = await page.evaluate(() => window.mota.game.__probe());
    const expectMain = Math.min(3, Math.max(2, Math.round(main.resolution)));
    if (main.textResolution !== expectMain) {
      trBad.push(`dsf=${main.resolution}：文字分辨率 ${main.textResolution}，应为 ${expectMain}`);
    }
    const page3 = await browser.newPage({ viewport: { width: 420, height: 1024 }, deviceScaleFactor: 3 });
    let hi = null;
    try {
      await page3.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
      await page3.waitForFunction(() => !!(window.mota && window.mota.game), null, { timeout: 20000 });
      hi = await page3.evaluate(() => window.mota.game.__probe());
    } finally {
      await page3.close();
    }
    if (!hi) trBad.push('dsf=3 的页面没能起来，无法验证高像素比下的文字分辨率');
    else if (hi.resolution !== 3) trBad.push(`dsf=3 的页面报出的 resolution=${hi.resolution}，设备像素比没生效`);
    else if (hi.textResolution !== 3) {
      trBad.push(`dsf=3 时文字仍按 ${hi.textResolution}× 光栅化 —— 又被拉伸了 3/${hi.textResolution} 倍`);
    }
    check(
      `A18 文字分辨率跟随屏幕：dsf=${main.resolution} → ${main.textResolution}×，dsf=3 → ${hi ? hi.textResolution : '?'}×`,
      trBad.length === 0,
      trBad.slice(0, 3).join(' | ') || '两个像素比下都等于屏幕的 dpr'
    );

    // ── A19 墙是手绘错缝砌法，不是第三方位图的超采样 ──
    //
    // 墙是第二种满屏平铺的地形。它曾经直接取 0x72 的 wall_mid（16×16、三个颜色）
    // 再超采样 —— 超采样不产生新细节，量出来的「每 16 单元独立色数」几乎不动。
    // 这一版改成手绘错缝砌法。判据四条，全部直接读**发布出去的图集帧**：
    //   ① 调色板 ≥ 5 色 —— 第三方位图只有 3 色，超采样不会多出颜色，这条
    //      单独就能证明「不是那张位图」；
    //   ② 每一层砌层都有缝列（显著暗于砖身的整列）—— 没有 = 砌法没了；
    //   ③ **错缝**：第 0 层与第 2 层的缝列位置相同（同相）、与第 1 层不同
    //      （错开半块）—— 这正是 running bond 的定义，也是变体/平铺不露接缝的前提；
    //   ④ MANIFEST 的 src 写着「手绘」（防改了脚本没重跑 assets）。
    const wallTile = terrainPng
      ? await page.evaluate(
          async ({ b64, r }) => {
            const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
            const cv = new OffscreenCanvas(bmp.width, bmp.height);
            const ctx = cv.getContext('2d');
            ctx.drawImage(bmp, 0, 0);
            const all = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
            const cols = new Map();
            for (let y = 0; y < r.h; y++) {
              for (let x = 0; x < r.w; x++) {
                const i = ((r.y + y) * bmp.width + (r.x + x)) * 4;
                if (all[i + 3] === 0) continue;
                cols.set(`${x},${y}`, (0.2126 * all[i] + 0.7152 * all[i + 1] + 0.0722 * all[i + 2]) / 255);
              }
            }
            const palette = new Set();
            for (let y = 0; y < r.h; y++) {
              for (let x = 0; x < r.w; x++) {
                const i = ((r.y + y) * bmp.width + (r.x + x)) * 4;
                palette.add(`${all[i]},${all[i + 1]},${all[i + 2]},${all[i + 3]}`);
              }
            }
            const course = r.h / 4; // 一层砌层 = 瓦片的四分之一
            const jointsOf = (L) => {
              const per = [];
              for (let x = 0; x < r.w; x++) {
                let t = 0;
                let n = 0;
                for (let y = L * course; y < (L + 1) * course; y++) {
                  const v = cols.get(`${x},${y}`);
                  if (v === undefined) continue;
                  t += v;
                  n++;
                }
                per.push(n ? t / n : 1);
              }
              const mean = per.reduce((a, b) => a + b, 0) / per.length;
              return per.map((v) => v < mean - 0.04);
            };
            const j0 = jointsOf(0);
            const j1 = jointsOf(1);
            const j2 = jointsOf(2);
            const eq = (p, q) => p.every((v, i) => v === q[i]);
            return {
              palette: palette.size,
              n0: j0.filter(Boolean).length,
              n1: j1.filter(Boolean).length,
              same02: eq(j0, j2),
              diff01: !eq(j0, j1)
            };
          },
          {
            b64: fs.readFileSync(path.join(DIST, 'assets', terrainPng)).toString('base64'),
            r: { x: MANIFEST.terrain['1'].x, y: MANIFEST.terrain['1'].y, w: MANIFEST.terrain['1'].w, h: MANIFEST.terrain['1'].h }
          }
        )
      : null;
    const wallBad = [];
    if (!wallTile) wallBad.push('dist 里找不到 terrain 图集，无法核对墙的像素');
    else {
      if (wallTile.palette < 5) {
        wallBad.push(
          `墙的调色板只有 ${wallTile.palette} 色 —— 0x72 位图超采样恰好是 3 色，` +
            `少于 5 色说明还是那张位图而不是手绘`
        );
      }
      if (wallTile.n0 === 0 || wallTile.n1 === 0) {
        wallBad.push(
          `砌层里找不到缝列（第 0 层 ${wallTile.n0} 列 / 第 1 层 ${wallTile.n1} 列）—— ` +
            `没有缝就没有砌法，墙会读成一块平板`
        );
      }
      if (!wallTile.same02 || !wallTile.diff01) {
        wallBad.push(
          `竖缝不是错缝（第 0/2 层同相=${wallTile.same02}，第 0/1 层不同=${wallTile.diff01}）—— ` +
            `不是 running bond，平铺时会读出规则的方格`
        );
      }
    }
    if (!/手绘/.test(String(MANIFEST.terrain['1']?.src ?? ''))) {
      wallBad.push(`墙的 src 仍是「${MANIFEST.terrain['1']?.src}」—— 改了构建脚本但没重跑 assets`);
    }
    check(
      'A19 墙是手绘错缝砌法：调色板 ' +
        (wallTile ? wallTile.palette : '?') +
        ' 色，相邻砌层的竖缝错开半块',
      wallBad.length === 0,
      wallBad.slice(0, 3).join(' | ') || '不是 0x72 位图的超采样'
    );

    check('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '干净');
    if (VERBOSE) {
      console.log('\n  变体使用分布：');
      for (const k of ['0', '1']) {
        const m = variantUse[k];
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
})().catch((err) => {
  console.error(err);
  try {
    server.close();
  } catch {
    /* 已关 */
  }
  process.exit(1);
});
