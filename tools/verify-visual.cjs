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
 *   A6 BOSS 与倍数：drawScale > 2 的必须是玩法上的 BOSS（不许有「巨大的杂兵」）
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
  const page = await browser.newPage({ viewport: { width: 420, height: 780 }, deviceScaleFactor: 2 });

  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) consoleErrors.push(m.text());
  });

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => !!(window.mota && window.mota.game), null, { timeout: 20000 });
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
    const bigIds = Object.keys(MANIFEST.monsters).filter((k) => MANIFEST.monsters[k].drawScale > 2);
    const fakeBoss = bigIds.filter((k) => !bossIds.includes(k));
    check(
      `A6 BOSS 与倍数：drawScale>2 的 ${bigIds.length} 只必须都是玩法 BOSS`,
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
