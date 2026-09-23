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
  VARIANT_COUNT
};
