/**
 * 期望值：在 Node 侧**独立重实现**一遍渲染规则。
 *
 * ## 为什么要重实现，而不是 import 渲染层的函数
 *
 * 这个测试的价值全在「两个独立来源对撞」：
 *   · 期望值：从 `data/floors/*.json` + `assets/MANIFEST.json` 按规则**重算**一遍
 *   · 实测值：浏览器里跑起来之后，从渲染树读回真正落屏的东西
 * 两边都派生自源码，但**派生路径不同** —— 所以能抓到「改了 A 忘了改 B」。
 * 一旦这里改成 import 渲染层的 `terrainKeyFor`，这个测试就退化成
 * 「X 等于 X」，恒真。
 *
 * ⚠️ 因此 `CHAR_TO_KEY` / `variantIndex` 与 `src/render/atlas.ts` **必须手工保持同步**。
 * 不一致会立刻暴露成 A1 大面积失败 —— 那正是这个测试的作用。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * ⚠️ 本文件在 `tools/verify/` 下，比原来的 `tools/verify-visual.cjs` **多一层**，
 * 所以这里要上溯两级。这是拆目录唯一会真正改变语义的地方（与
 * `tools/assetlib/config.py` 的 `ROOT` 同一回事）—— 别照抄别处的层数。
 */
const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');

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

// ── 实体与 BOSS 占位块 ──────────────────────────────────────────────
//
// 与 `src/game/footprint.ts` 的 `footprintTiles` **同一套规则**（只允许奇数，
// 非法回落 1）—— 照样是独立重实现，不 import 渲染层。两边不一致会立刻表现成
// A5（精灵没盖住它宣称占的那几格）或 A17（帧尺寸与占位格数对不上）红。

const MONSTERS = (() => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/monsters.json'), 'utf8'));
  return j.monsters ?? j;
})();

const CONSTANTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/constants.json'), 'utf8'));

/** 玩法 BOSS 的 id —— 「谁的落屏尺寸可以超过一格」由它决定（A6/A17 共用） */
const BOSS_IDS = Object.keys(MONSTERS).filter((k) => MONSTERS[k] && MONSTERS[k].boss);

/**
 * BOSS 的占位块边长（格）。
 *
 * 这是**玩法 / 渲染 / 素材三方共用的同一个数字**：`data/constants.json` 的
 * `boss.footprintTiles`。素材侧的 `tools/assetlib/bosses/common.py` 读它算绘制网格
 * （`CELL × 本值`），渲染层与引擎读它算落屏尺寸与阻挡，构建期有一条断言钉住
 * 「素材网格 == 格子 × 本值」。所以断言也读同一个数，而不是写死 3。
 */
const BOSS_TILES = (() => {
  const n = CONSTANTS.boss?.footprintTiles;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return 1;
  const k = Math.floor(n);
  // 偶数边长没有整数中心，居中会引入半格偏移 → 与 footprint.ts 一样退到相邻奇数
  return k % 2 === 1 ? k : Math.max(1, k - 1);
})();

/**
 * 居中的 `n × n` 占位块（靠边放不下时**整体平移**进棋盘，不平缩）。
 * 与 `footprintAt` 同一套规则 —— 第 40 层的骑士长在 (5,0)，居中会让第一行落到 -1。
 */
function bossBlock(x, y, n = BOSS_TILES) {
  const BOARD = 11;
  if (n <= 1) return { x0: x, y0: y, x1: x, y1: y };
  const half = (n - 1) >>> 1;
  const clamp = (v) => Math.max(0, Math.min(v, BOARD - n));
  const x0 = clamp(x - half);
  const y0 = clamp(y - half);
  return { x0, y0, x1: x0 + n - 1, y1: y0 + n - 1 };
}

/**
 * 每层的实体清单。`loadFloors()` 只给地形，而 A5 要数「这层该有几只 BOSS」——
 * 没有这个数，「BOSS 精灵对齐占位块」那条断言就可能在**没有任何 BOSS 样本**时
 * 静默通过（label / 字段一改名就永远为空）。
 */
function loadFloorEntities() {
  const dir = path.join(ROOT, 'data/floors');
  const out = new Map();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'index.json')) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (typeof j.index !== 'number' || !Array.isArray(j.entities)) continue;
    out.set(j.index, j.entities);
  }
  return out;
}

module.exports = {
  ROOT,
  DIST,
  CHAR_TO_KEY,
  RENDER_ALIAS,
  renderChar,
  isWallChar,
  terrainKeyFor,
  variantIndex,
  loadFloors,
  MANIFEST,
  VARIANT_COUNT,
  MONSTERS,
  CONSTANTS,
  BOSS_IDS,
  BOSS_TILES,
  bossBlock,
  loadFloorEntities
};
