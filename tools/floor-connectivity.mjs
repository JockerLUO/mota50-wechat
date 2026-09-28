/**
 * 地形连通性体检 —— 回答「**把战斗和钥匙都拿掉之后，这塔的地形通不通**」。
 *
 * ## 为什么需要它
 *
 * 「自动通关器跑不通」有两种完全不同的病根，而 `SimReport` 长得一模一样：
 *   ① **塔本身走不通**（地形/事件缺了东西）⇒ 改数据；
 *   ② **AI 选错了路**（决策 / 估价 / 可达性建模有洞）⇒ 改 AI。
 * 两者的修法相反，只看模拟报告分不开。
 *
 * 这里的判据是「假设勇者无敌」：所有怪都打得动、所有门都开得起（钥匙无限）、
 * 所有能触发的事件都触发过。剩下的**只有地形**，于是「通不通」变成一个
 * 纯几何问题，可以像等式一样复算，而且**与 AI 无关**。
 *
 * ## 逐层体检，不是从头走一遍
 *
 * 关键设计：**每一层从「别人把你送进来」的那些格子出发各做一次连通性**，
 * 再看这一层的上楼梯够不够得着。好处是**顺序无关** —— 从头链式走的话，
 * 第一个堵点之后的所有层都查不到，「后面还有几个堵点」永远看不见。
 *
 * ## 通行规则（**全部来自数据，没有一条写死在这里**）
 *
 *  · 地块通行性读 `data/tiles.json` 的 `legend[].passable`（与引擎同源）；
 *  · 带 `key` 的地块（门）算可开 —— 前提正是「钥匙无限」；
 *  · 假墙 `w` 算可走（撞一次即变空地，`step.ts` 有专门分支）；
 *  · **一次性 NPC 算可走**（撞一次搭话后从地图上消失）、**常驻 NPC 算墙**
 *    （它永远在那儿，引擎里撞它是搭话、不会走上去）；
 *  · 事件开的地块算开：`clearTerrain`（按地形 id 整层清）+ `setTerrain`（单格改写）；
 *  · 事件加的楼梯算存在：`addStair`。
 *
 * ⚠️ 规则里「一次性 NPC 算可走」这一条**只对玩家成立**：`autoplay.reach`
 *    把所有 NPC 一律当墙（见 `autoplay.ts` 那段注释）。所以本工具报「通」
 *    而模拟器报「够不着」时，差值就是**AI 的可达性建模**，不是塔。
 *
 * 用法：`node tools/floor-connectivity.mjs [--verbose] [--floor N]`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), 'utf8'));

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const onlyFloor = (() => {
  const i = argv.indexOf('--floor');
  return i >= 0 ? Number(argv[i + 1]) : null;
})();

const tilesRaw = readJson('tiles.json');
const npcsRaw = readJson('npcs.json');
const eventsRaw = readJson('events.json');
const npcs = npcsRaw.npcs ?? npcsRaw;
const events = Array.isArray(eventsRaw) ? eventsRaw : (eventsRaw.events ?? []);

// ── 地块表：char → { id, passable, key } ──────────────────────────────
const tileByChar = new Map();
for (const [idStr, v] of Object.entries(tilesRaw.legend ?? {})) {
  tileByChar.set(v.char, { id: Number(idStr), passable: v.passable === true, key: v.key });
}

// ── 楼层 ─────────────────────────────────────────────────────────────
const floors = new Map();
for (const f of fs.readdirSync(path.join(DATA, 'floors')).sort()) {
  const m = /^floor-(\d+)\.json$/.exec(f);
  if (!m) continue;
  floors.set(Number(m[1]), readJson(path.join('floors', f)));
}

// ── 事件：哪些地块会被打开、哪些楼梯会出现 ────────────────────────────
const clearedTerrain = new Map();
const patchedTiles = new Map();
const addedStairs = new Map();
const pushTo = (map, key, v) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(v);
};
for (const ev of events) {
  for (const e of ev.effects ?? []) {
    if (e.op === 'clearTerrain') pushTo(clearedTerrain, e.floor, e.terrain);
    else if (e.op === 'setTerrain') {
      if (!patchedTiles.has(e.floor)) patchedTiles.set(e.floor, new Map());
      patchedTiles.get(e.floor).set(`${e.x},${e.y}`, e.terrain);
    } else if (e.op === 'addStair') pushTo(addedStairs, e.floor, { x: e.x, y: e.y, to: e.to, arrive: e.arrive ?? null });
  }
}

const terrainAt = (floor, x, y) => {
  const f = floors.get(floor);
  const patched = patchedTiles.get(floor)?.get(`${x},${y}`);
  if (patched) return patched;
  if (!f || y < 0 || y >= f.terrain.length) return '#';
  const row = f.terrain[y];
  return x < 0 || x >= row.length ? '#' : row[x];
};

/** 这一格能不能走过去（理由一并返回 —— 报错时要能说清是谁挡的） */
function passableAt(floor, x, y) {
  const f = floors.get(floor);
  if (!f) return { ok: false, why: '没有这一层' };
  const ent = (f.entities ?? []).find((e) => e.x === x && e.y === y);
  if (ent?.type === 'npc') {
    return npcs[ent.id]?.lifecycle === 'once'
      ? { ok: true, why: '一次性 NPC（搭话后消失）' }
      : { ok: false, why: `常驻 NPC ${ent.id}（永远在场）` };
  }
  const ch = terrainAt(floor, x, y);
  const info = tileByChar.get(ch);
  if (!info) return { ok: false, why: `未知地形 ${JSON.stringify(ch)}` };
  if (clearedTerrain.get(floor)?.includes(info.id)) return { ok: true, why: `事件已清（地形 id ${info.id}）` };
  if (ch === 'w') return { ok: true, why: '假墙（撞一次变空地）' };
  if (info.key) return { ok: true, why: `${info.key} 门（钥匙无限）` };
  if (info.passable) return { ok: true, why: '空地' };
  return { ok: false, why: `地形 ${JSON.stringify(ch)}（id ${info.id}）不可通行` };
}

const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]];

function flood(floor, starts) {
  const seen = new Set();
  const q = [];
  for (const [x, y] of starts) {
    const k = `${x},${y}`;
    if (seen.has(k) || !passableAt(floor, x, y).ok) continue;
    seen.add(k);
    q.push([x, y]);
  }
  /** 只记录「贴着可达边界、又走不进去」的格子 —— 那才是堵点的候选 */
  const edge = new Map();
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const k = `${nx},${ny}`;
      if (seen.has(k)) continue;
      if (nx < 0 || nx > 10 || ny < 0 || ny > 10) continue;
      const p = passableAt(floor, nx, ny);
      if (!p.ok) {
        if (!edge.has(k)) edge.set(k, { why: p.why, ch: terrainAt(floor, nx, ny) });
        continue;
      }
      seen.add(k);
      q.push([nx, ny]);
    }
  }
  return { seen, edge };
}

/** 某一层的全部楼梯（数据里的 + 事件加的） */
function stairsOf(floor) {
  const out = [];
  const f = floors.get(floor);
  for (const kind of ['up', 'down']) {
    for (const s of f?.stairs?.[kind] ?? []) out.push({ kind, x: s.x, y: s.y, to: s.to, arrive: s.arrive });
  }
  for (const s of addedStairs.get(floor) ?? []) out.push({ kind: 'up', ...s });
  return out;
}

// ── 每一层的「入口格」= **从下一层上来**时落在哪 ──────────────────────
//
// ⚠️ 只认「从 F−1 上到 F」这一个方向。把「从 F+1 下来」的落点也塞进入口集合
//    是**循环论证**：你是先到过 F 才可能站在 F+1 上的。实测这么写的后果是
//    F20 报「✅ 通」—— 因为 F21 的下楼梯落点正好就是 F20 的上楼梯本身，
//    于是「刚进门就站在出口上」，什么堵点都测不出来。
const entries = new Map();
for (const f of floors.keys()) entries.set(f, []);
const fallbackSpot = (to) =>
  floors.get(to)?.stairs?.down?.[0] ?? floors.get(to)?.stairs?.up?.[0] ?? null;

// 第 1 层：开局落点（数据里第 1 层没有下楼梯，用上楼梯兜底）
{
  const s = floors.get(1)?.stairs?.up?.[0];
  if (s) entries.get(1).push([s.x, s.y]);
}
// 数据里的楼梯：只认「F−1 → F」这一条
for (const [from, f] of floors) {
  for (const s of f.stairs?.up ?? []) {
    if (s.to !== from + 1 || !entries.has(s.to)) continue;
    const target = s.arrive ?? fallbackSpot(s.to);
    if (target) entries.get(s.to).push([target.x, target.y]);
  }
}
// 事件加的楼梯（含第 24 层 → 第 50 层那条跨层电梯）
for (const [from, list] of addedStairs) {
  for (const s of list) {
    if (!entries.has(s.to)) continue;
    const target = s.arrive ?? fallbackSpot(s.to);
    if (target) entries.get(s.to).push([target.x, target.y]);
  }
}

// ── 逐层体检 ─────────────────────────────────────────────────────────
//
// ⚠️ 第 0 层跳过：`data/floors/floor-00.json` 是导入器留下的「第 0 层」（一块空地 +
//    通往第 1 层的上楼梯），**游戏里进不去**（第 1 层没有下楼梯）。把它算进来只会
//    多出一条「可达 0 格」的噪声，而噪声会让真的堵点淹没在里面。
/**
 * 逐层体检（不打印）—— 判据（`verify:autoplay` 的 C 段）与本工具共用**同一份**实现。
 *
 * 复用而不是让判据自己再走一遍 BFS：两份实现各自都能跑通，而「体检说通、判据说堵」
 * 那种分叉永远查不出来（铁律 #66 那一族）。
 *
 * @returns {{ rows: Array<object>, firstBlock: number|null, blocked: number[] }}
 */
export function scanConnectivity() {
  const rows = [];
  let firstBlock = null;
  for (const floor of [...floors.keys()].filter((f) => f >= 1).sort((a, b) => a - b)) {
    const starts = entries.get(floor) ?? [];
    const { seen, edge } = flood(floor, starts);
    const ups = stairsOf(floor).filter((s) => s.to > floor && floors.has(s.to));
    const okUp = ups.filter((s) => seen.has(`${s.x},${s.y}`));
    // 「上不去」有两种：这一层根本没有向上的出口（第 50 层、以及靠事件接上的第 49 层），
    // 还是「有出口但够不着」。只有后者是堵点。
    const blocked = ups.length > 0 && okUp.length === 0;
    if (blocked && firstBlock === null) firstBlock = floor;
    rows.push({ floor, starts, size: seen.size, ups, okUp, blocked, edge });
  }
  return { rows, firstBlock, blocked: rows.filter((r) => r.blocked).map((r) => r.floor) };
}

// ── 命令行入口 ───────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { rows, firstBlock } = scanConnectivity();
  const targets = onlyFloor ? rows.filter((r) => r.floor === onlyFloor) : rows;

  for (const r of targets) {
    if (!verbose && !onlyFloor) continue;
    console.log(`\n=== F${r.floor}  入口 ${r.starts.map((s) => `(${s.join(',')})`).join(' ') || '（无）'}`);
    console.log(`    可达 ${r.size} 格　up 楼梯 ${r.ups.length} 个 / 够得着 ${r.okUp.length} 个` +
      (r.okUp.length ? `　→ ${r.okUp.map((s) => `F${s.to}`).join('、')}` : r.ups.length ? '　← ❌ 上不去' : '　（本层没有向上的出口）'));
    if (r.blocked) {
      // 按地形字符归并：一眼看出是哪种门/墙在挡，而不是一串坐标
      const byCh = new Map();
      for (const [, v] of r.edge) byCh.set(v.ch, (byCh.get(v.ch) ?? 0) + 1);
      console.log(`    出口够不着。可达边界上的障碍： ${[...byCh].map(([c, n]) => `${JSON.stringify(c)}×${n}`).join('  ')}`);
    }
  }

  console.log(`\n地形连通性体检（无视战斗与钥匙）`);
  console.log('─'.repeat(64));
  for (const r of targets) {
    const mark = r.ups.length === 0 ? '·' : r.blocked ? '❌' : '✅';
    const tail = r.ups.length === 0
      ? '（本层没有向上的出口）'
      : r.blocked
        ? `← 上不去（可达 ${r.size} 格）`
        : `→ ${r.okUp.map((s) => `F${s.to}`).join('、')}`;
    console.log(`${mark} F${String(r.floor).padStart(2)}  ${tail}`);
  }
  console.log(
    firstBlock === null
      ? '\n结论：**每一层的上楼梯都够得着** —— 地形上没有堵点。'
      : `\n结论：地形在 **F${firstBlock}** 断掉 —— 那一层的上楼梯够不着。`
  );
}
