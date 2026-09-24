#!/usr/bin/env node
/**
 * 把参考源码 m8705/MAGIC-TOWER-JS 的三层数字阵列（地形/怪物/道具）
 * 转换成本项目的楼层 JSON 格式：地形字符画 + 实体对象数组。
 *
 * 用法：node tools/import-mota50.mjs [--check]
 *   --check  只做一致性检查，不写文件
 *
 * 设计取舍：
 *   地图保留「字符画」而不是原始数字二维数组 —— 地形在 JSON 里肉眼可见，
 *   改地图就是改字符串；实体单独成数组并带可读 id，避免「数字 ID 查表查半天」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'reference/mota50/source/mota50-data.js');
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const tiles = readJSON(path.join(ROOT, 'data/tiles.json'));
const monsters = readJSON(path.join(ROOT, 'data/monsters.json')).monsters;
const items = readJSON(path.join(ROOT, 'data/items.json')).items;
const npcs = readJSON(path.join(ROOT, 'data/npcs.json')).npcs;

const COLS = 11;
const ROWS = 11;
const CELLS = COLS * ROWS;

// ── 建立反查表：原版编码 → 本项目 id ──────────────────────────────
function buildLookup(table, idField) {
  const map = new Map();
  for (const [id, def] of Object.entries(table)) {
    const raw = def[idField];
    if (raw === undefined) continue;
    if (map.has(raw)) {
      throw new Error(`编码冲突：${idField}=${raw} 同时被 "${map.get(raw)}" 和 "${id}" 占用`);
    }
    map.set(raw, id);
  }
  return map;
}
const monsterByRoleId = buildLookup(monsters, 'roleId');
const itemBySourceId = buildLookup(items, 'sourceId');
const npcBySourceId = buildLookup(npcs, 'sourceId');
const terrainByCode = new Map(
  Object.entries(tiles.legend).map(([code, def]) => [Number(code), def])
);
const charByTerrain = new Map([...terrainByCode].map(([code, def]) => [code, def.char]));
const terrainCodeByChar = new Map([...terrainByCode].map(([code, def]) => [def.char, code]));
const terrainByChar = new Map([...terrainByCode].map(([code, def]) => [def.char, def]));

// ── 解析参考源码 ────────────────────────────────────────────────
function parseLayer(text, name, allNames) {
  const start = text.indexOf(`var ${name} = [`);
  if (start < 0) throw new Error(`在参考源码中找不到 var ${name} = [`);

  // 该层的结束位置 = 其余各层起点中最小的那个（大于自己的起点）
  let end = text.length;
  for (const other of allNames) {
    const i = text.indexOf(`var ${other} = [`);
    if (i > start && i < end) end = i;
  }

  const body = text.slice(start, end);
  const floors = new Map();
  const re = /\[\s*\/\/\s*(\d+)([\s\S]*?)\]/g;
  for (const m of body.matchAll(re)) {
    const nums = (m[2].match(/\d+/g) || []).map(Number);
    floors.set(Number(m[1]), nums);
  }
  return floors;
}

const raw = fs.readFileSync(SRC, 'utf8');
const LAYERS = ['floor', 'role', 'item'];
const terrainLayer = parseLayer(raw, 'floor', LAYERS);
const roleLayer = parseLayer(raw, 'role', LAYERS);
const itemLayer = parseLayer(raw, 'item', LAYERS);

// ── 结构自检：任何一处不合法就中止，避免产出坏数据 ──────────────
const problems = [];
const indices = [...terrainLayer.keys()].sort((a, b) => a - b);
for (const [name, layer] of [['floor', terrainLayer], ['role', roleLayer], ['item', itemLayer]]) {
  if (layer.size !== indices.length) {
    problems.push(`层数不一致：${name} 有 ${layer.size} 层，地形层有 ${indices.length} 层`);
  }
  for (const [idx, cells] of layer) {
    if (cells.length !== CELLS) {
      problems.push(`${name} 第 ${idx} 层单元格数 ${cells.length} ≠ ${CELLS}`);
    }
  }
}
if (problems.length) {
  console.error('参考数据自检失败，已中止：');
  problems.forEach((p) => console.error('  ✗ ' + p));
  process.exit(1);
}

// ── 人工偏离表 ──────────────────────────────────────────────────
//
// 目前只有一条，而且它是**玩法逼出来的**，不是审美：BOSS 在本项目里占 3×3 格
// （`data/constants.json` 的 `boss.footprintTiles`），撞上占位格即开战。
//
// 参考数据的第 50 层王座间是 5×5 外框（16 面墙）+ 3×3 内间，魔王站在正中心
// (5,5) —— 3×3 占位会把**整个内间占满**，玩家连落脚格都没有，更够不着它。
// 所以把外框扩到 7×7、内间扩到 5×5：占位仍是 3×3，外圈留出一整环落脚格。
//
// 这是本项目对参考地图的**唯一一处地形偏离**。判定它是「必要」的理由：
// 不改则第 50 层结构上无法通关（不再是数值难，而是够不着）。
const TERRAIN_OVERRIDES = {
  50: [
    {
      x: 2, y: 2, w: 7, h: 7,
      why: '王座间外框 5×5 → 7×7（内间 3×3 → 5×5），让 3×3 占位的魔王仍可被攻击',
      // 改之前这块长这样（含四周的星际空间）—— 对不上就说明参考数据变了
      expect: [
        '*******',
        '*#####*',
        '*#...#*',
        '*#...#*',
        '*#...#*',
        '*#####*',
        '*******',
      ],
      rows: [
        '#######',
        '#.....#',
        '#.....#',
        '#.....#',
        '#.....#',
        '#.....#',
        '#######',
      ],
    },
  ],
};

// ── 逐层转换 ────────────────────────────────────────────────────
const floors = [];
const placement = new Map();   // monsterId → [floorIndex...]
const terrainUsage = new Map(); // terrain code → 总出现次数
const unknownEntities = [];
const guardPairs = [];          // BOSS 与道具同格的「守护」组合
const appliedPatches = [];      // 实际生效的人工偏离（末尾汇报）

for (const idx of indices) {
  const terrain = terrainLayer.get(idx);
  const roles = roleLayer.get(idx);
  const itemCells = itemLayer.get(idx);

  const rows = [];
  for (let y = 0; y < ROWS; y++) {
    let line = '';
    for (let x = 0; x < COLS; x++) {
      const code = terrain[y * COLS + x];
      const ch = charByTerrain.get(code);
      if (ch === undefined) {
        problems.push(`第 ${idx} 层 (${x},${y}) 出现未知地形编码 ${code}`);
        line += '?';
      } else {
        line += ch;
      }
    }
    rows.push(line);
  }

  // ── 人工偏离：本项目**有意**与参考数据不同的那些格子 ────────────
  //
  // ## 为什么偏离必须写在导入器里，而不是直接改 data/floors/*.json
  //
  // 楼层文件是**本脚本生成的**（见文件末尾那句「已写出 N 个楼层文件」）。
  // 直接手改 floor-50.json 的后果是：谁哪天重跑一次导入器，改动就被无声回滚，
  // 而 `npm run validate` 只会看到「数据又变回参考版了」—— 这正是本项目
  // 反复吃过的那类亏（改动不在生成它的那条链上）。
  //
  // 所以偏离写在这里，而且**带 `expect`**：先核对「改之前这块长这样」，
  // 不符就抛。参考数据将来若变了，这里会当场报错，而不是照着旧假设
  // 打一块对不上的补丁（那会产出一种既不是参考版也不是本意版的地图）。
  const patches = TERRAIN_OVERRIDES[idx] ?? [];
  for (const p of patches) {
    const before = [];
    for (let y = p.y; y < p.y + p.h; y++) before.push(rows[y].slice(p.x, p.x + p.w));
    if (p.expect && before.join('|') !== p.expect.join('|')) {
      problems.push(
        `第 ${idx} 层的人工偏离补丁 (${p.x},${p.y},${p.w}×${p.h}) 与参考数据对不上：\n` +
          `      期望 ${p.expect.join('|')}\n      实际 ${before.join('|')}\n` +
          `      → 参考数据变了。请重新核对「${p.why}」这条偏离还成不成立，再更新 expect。`
      );
      continue;
    }
    p.rows.forEach((line, i) => {
      if (line.length !== p.w) {
        problems.push(`第 ${idx} 层补丁第 ${i} 行长度 ${line.length} ≠ 宽度 ${p.w}`);
        return;
      }
      rows[p.y + i] = rows[p.y + i].slice(0, p.x) + line + rows[p.y + i].slice(p.x + p.w);
    });
    appliedPatches.push(`第 ${idx} 层 (${p.x},${p.y}) ${p.w}×${p.h}：${p.why}`);
  }

  const entities = [];
  const stairs = { up: [], down: [] };
  const doorCount = { yellow: 0, blue: 0, red: 0 };

  // 楼梯 / 门 / 地形使用统计一律**从补丁之后的字符画推导**（不是从原始编码
  // 数组）—— 否则补丁新增或删掉的东西不会体现出来，两份真值当场分叉。
  // 这也解释了上面那个 rows 循环为什么不顺手统计：那时的 rows 还没打补丁。
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const ch = rows[y][x];
      const def = terrainByChar.get(ch);
      if (def?.stairs) stairs[def.stairs].push({ x, y });
      const code = terrainCodeByChar.get(ch);
      if (code !== undefined) terrainUsage.set(code, (terrainUsage.get(code) || 0) + 1);
      if (code === 7) doorCount.yellow++;
      if (code === 8) doorCount.blue++;
      if (code === 9) doorCount.red++;
    }
  }

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const i = y * COLS + x;
      const roleCode = roles[i];
      const itemCode = itemCells[i];

      if (roleCode) {
        if (monsterByRoleId.has(roleCode)) {
          const id = monsterByRoleId.get(roleCode);
          entities.push({ type: 'monster', id, x, y });
          if (!placement.has(id)) placement.set(id, []);
          placement.get(id).push(idx);
        } else if (npcBySourceId.has(roleCode)) {
          entities.push({ type: 'npc', id: npcBySourceId.get(roleCode), x, y });
        } else {
          unknownEntities.push(`第 ${idx} 层 (${x},${y}) 未知 role 编码 ${roleCode}`);
        }
      }

      if (itemCode) {
        if (itemBySourceId.has(itemCode)) {
          const t = terrainByCode.get(terrain[i]);
          const e = { type: 'item', id: itemBySourceId.get(itemCode), x, y };
          // 道具被直接放在不可通行的地形上 —— 原版是刻意设计的隐藏道具，
          // 必须先用铁锹挖开、或对本层使用地震卷轴才能取得。标记出来而不是报错。
          if (t && !t.passable && !t.stairs) {
            e.hidden = true;
            e.hiddenIn = t.name;
          }
          entities.push(e);
        } else {
          unknownEntities.push(`第 ${idx} 层 (${x},${y}) 未知 item 编码 ${itemCode}`);
        }
      }
    }
  }

  // 同格共存判定。
  // 「怪物 + 道具」同格是原版的合法设计（BOSS 守道具，击败后道具仍在），
  // 但同格出现两个同类实体一定是数据错误。
  const occupied = new Map();
  for (const e of entities) {
    const k = `${e.x},${e.y}`;
    if (occupied.has(k)) {
      const prev = occupied.get(k);
      if (prev.type === e.type) {
        problems.push(`第 ${idx} 层 (${e.x},${e.y}) 同类实体重叠：${prev.id} 与 ${e.id}`);
      } else {
        guardPairs.push({
          floor: idx, x: e.x, y: e.y,
          monster: prev.type === 'monster' ? prev.id : e.id,
          item: prev.type === 'item' ? prev.id : e.id
        });
      }
    } else {
      occupied.set(k, e);
    }
  }

  floors.push({
    id: `floor-${String(idx).padStart(2, '0')}`,
    index: idx,
    title: idx === 0 ? '主塔 0 层（地下）' : `主塔 ${idx} 层`,
    size: { cols: COLS, rows: ROWS },
    terrain: rows,
    stairs,
    doors: doorCount,
    entities
  });
}

if (unknownEntities.length) {
  problems.push(...unknownEntities);
}

// ── 楼梯补全：写明通向哪一层、落在哪一格 ────────────────────────
// 原版约定是「换层后坐标不变」。但直接沿用这个约定会让勇者落在墙里
// （参考数据中第 32 层的下楼梯就是这种情况），所以这里显式算出落点，
// 必要时就近修正到可站立格，并注明做了修正。
const floorAt = new Map(floors.map((f) => [f.index, f]));
const isStandable = (f, x, y) => {
  const def = terrainByChar.get(f.terrain[y][x]);
  return Boolean(def && (def.passable || def.stairs));
};

/** 从 (x,y) 出发广度优先找最近的可站立格 */
function nearestStandable(f, x, y) {
  const seen = new Set([`${x},${y}`]);
  let ring = [[x, y]];
  for (let depth = 0; depth < 12 && ring.length; depth++) {
    const next = [];
    for (const [cx, cy] of ring) {
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
        const k = `${nx},${ny}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (isStandable(f, nx, ny)) return { x: nx, y: ny, distance: depth + 1 };
        next.push([nx, ny]);
      }
    }
    ring = next;
  }
  return null;
}

const stairFixes = [];
for (const f of floors) {
  for (const dir of ['up', 'down']) {
    const to = dir === 'up' ? f.index + 1 : f.index - 1;
    const dest = floorAt.get(to);
    f.stairs[dir] = f.stairs[dir].map((s) => {
      const stair = { x: s.x, y: s.y, to };
      if (!dest) return stair;
      if (isStandable(dest, s.x, s.y)) {
        stair.arrive = { x: s.x, y: s.y };
      } else {
        const fix = nearestStandable(dest, s.x, s.y);
        if (fix) {
          stair.arrive = { x: fix.x, y: fix.y };
          stair.arriveAdjusted = true;
          stair.arriveNote = `原坐标 (${s.x},${s.y}) 在目标层是${terrainByChar.get(dest.terrain[s.y][s.x]).name}，已就近修正到可站立格`;
          stairFixes.push(`${f.id} ${dir === 'up' ? '上' : '下'}楼梯 (${s.x},${s.y}) → ${dest.id} 落点修正为 (${fix.x},${fix.y})`);
        } else {
          stair.arrive = null;
          stair.arriveNote = '目标层找不到可站立格';
          stairFixes.push(`${f.id} ${dir}楼梯 (${s.x},${s.y}) → ${dest.id} 完全无法落地`);
        }
      }
      return stair;
    });
  }
}

// ── 合并人工维护的楼层机制说明 ──────────────────────────────────
const floorNotes = readJSON(path.join(ROOT, 'data/floor-notes.json')).floorNotes;
let notesMerged = 0;
for (const f of floors) {
  const n = floorNotes[String(f.index)];
  if (n) { f.notes = n; notesMerged++; }
}
const orphanNotes = Object.keys(floorNotes).filter((k) => !floorAt.has(Number(k)));
if (orphanNotes.length) {
  problems.push(`floor-notes.json 中的楼层不存在：${orphanNotes.join(', ')}`);
}

// 没有任何楼梯出口、也没有说明原因的楼层 —— 实现时会卡死玩家
const exitGaps = floors.filter(
  (f) => f.stairs.up.length === 0 && f.index !== floors[floors.length - 1].index && !f.notes?.exit
);

// ── 输出 ────────────────────────────────────────────────────────
const checkOnly = process.argv.includes('--check');

const monsterCount = floors.reduce(
  (n, f) => n + f.entities.filter((e) => e.type === 'monster').length, 0);
const itemCount = floors.reduce(
  (n, f) => n + f.entities.filter((e) => e.type === 'item').length, 0);
const npcCount = floors.reduce(
  (n, f) => n + f.entities.filter((e) => e.type === 'npc').length, 0);

console.log('参考源码 → 本项目楼层格式');
console.log('─'.repeat(62));
console.log(`  楼层数        ${floors.length}  （索引 ${indices[0]} ~ ${indices[indices.length - 1]}）`);
console.log(`  尺寸          ${COLS} × ${ROWS}`);
console.log(`  怪物实体      ${monsterCount}`);
console.log(`  道具实体      ${itemCount}`);
console.log(`  NPC 实体      ${npcCount}`);
console.log();

console.log('地形使用统计');
for (const [code, count] of [...terrainUsage].sort((a, b) => a[0] - b[0])) {
  const def = terrainByCode.get(code);
  console.log(`  ${String(code).padStart(2)}  ${def.char}  ${def.name.padEnd(6)} ${String(count).padStart(4)} 格`);
}
const starCount = terrainUsage.get(6) || 0;
if (starCount > 0) {
  console.log();
  console.log(`  ⚠ 星际空间（编码 6）共 ${starCount} 格：参考实现 m8705 的 checkFloor 未把 6 列入`);
  console.log(`    阻挡分支，会把它当成可通行。本项目按原版语义判定为不可通行。`);
}
console.log();

// 怪物分布
console.log('怪物分布（出现层）');
const rowsOut = [...placement.entries()]
  .map(([id, list]) => {
    const uniq = [...new Set(list)].sort((a, b) => a - b);
    return { id, name: monsters[id].name, count: list.length, floors: uniq };
  })
  .sort((a, b) => a.floors[0] - b.floors[0] || b.count - a.count);

for (const r of rowsOut) {
  const range = r.floors.length <= 4
    ? r.floors.join(',')
    : `${r.floors[0]}~${r.floors[r.floors.length - 1]}（${r.floors.length} 层）`;
  console.log(`  ${r.name.padEnd(8, '　')} ×${String(r.count).padStart(3)}   层: ${range}`);
}
console.log();

const neverUsed = Object.keys(monsters).filter((id) => !placement.has(id));
if (neverUsed.length) {
  console.log('未被放置的怪物（参考实现中未使用）');
  for (const id of neverUsed) console.log(`  ${monsters[id].name}（${id}）`);
  console.log();
}

if (guardPairs.length) {
  console.log('BOSS 守道具（怪物与道具同格，属设计而非错误）');
  for (const g of guardPairs) {
    console.log(`  第 ${String(g.floor).padStart(2)} 层 (${g.x},${g.y})  ${monsters[g.monster].name} 守着 ${items[g.item].name}`);
  }
  console.log();
}

{
  const hidden = [];
  for (const f of floors) {
    for (const e of f.entities) if (e.hidden) hidden.push(`第 ${f.index} 层 ${items[e.id].name} 在${e.hiddenIn}内 (${e.x},${e.y})`);
  }
  if (hidden.length) {
    console.log(`墙内隐藏道具 ${hidden.length} 处（需铁锹或地震卷轴才能取得）`);
    hidden.forEach((h) => console.log('  ' + h));
    console.log();
  }
}

if (stairFixes.length) {
  console.log('楼梯落点修正（原版「换层后坐标不变」，但直接沿用会让勇者落进墙里）');
  stairFixes.forEach((s) => console.log('  ' + s));
  console.log();
}

if (exitGaps.length) {
  console.log('⚠ 既无上楼梯、又没有 exit 说明的楼层（实现时会卡死玩家）');
  exitGaps.forEach((f) => console.log(`  第 ${f.index} 层`));
  console.log();
} else {
  console.log('✓ 所有非顶层楼层都有向上出口：或走上楼梯，或已在 floor-notes.json 中注明依赖剧情/传送道具');
  console.log();
}

if (appliedPatches.length) {
  console.log('人工偏离（本项目有意不改回参考数据的格子）');
  appliedPatches.forEach((p) => console.log('  ' + p));
  console.log();
}

console.log(`✓ 已合并 ${notesMerged} 条楼层机制说明（来自 data/floor-notes.json）`);

if (problems.length) {
  console.error('发现数据问题：');
  problems.forEach((p) => console.error('  ✗ ' + p));
  process.exit(1);
}

if (checkOnly) {
  console.log('✓ 一致性检查通过（--check 模式，未写文件）');
  process.exit(0);
}

const outDir = path.join(ROOT, 'data/floors');
fs.mkdirSync(outDir, { recursive: true });
for (const f of floors) {
  fs.writeFileSync(path.join(outDir, `${f.id}.json`), JSON.stringify(f, null, 1) + '\n');
}

const LICENSE_NOTE = '本文件派生自 GPL-3.0 作品 m8705/MAGIC-TOWER-JS，' +
  '「转成另一种格式」不构成独立创作，按 GPL-3.0 通例应同样以 GPL-3.0 分发。' +
  '详见 reference/mota50/ATTRIBUTION.md §3（含闭源发布的替代路径）。';

fs.writeFileSync(path.join(ROOT, 'data/monster-placement.json'), JSON.stringify({
  $comment: '由 tools/import-mota50.mjs 自动生成，请勿手改。记录每只怪物在哪些楼层出现。',
  $license: LICENSE_NOTE,
  generatedFrom: 'reference/mota50/source/mota50-data.js',
  placement: Object.fromEntries(rowsOut.map((r) => [r.id, { name: r.name, count: r.count, floors: r.floors }])),
  neverPlaced: neverUsed
}, null, 2) + '\n');

fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({
  $comment: '楼层索引。坐标系统：零基，(x: 0~10, y: 0~10)，y 向下增长；数组下标 = y * 11 + x。',
  $license: LICENSE_NOTE,
  coordinateSystem: 'zero-based',
  cols: COLS,
  rows: ROWS,
  floorCount: floors.length,
  sourceCommit: 'm8705/MAGIC-TOWER-JS @ 0e09a59f7d223a267dab8a748aeaee0833de2c9c',
  floors: floors.map((f) => ({
    id: f.id,
    index: f.index,
    title: f.title,
    monsters: f.entities.filter((e) => e.type === 'monster').length,
    items: f.entities.filter((e) => e.type === 'item').length,
    npcs: f.entities.filter((e) => e.type === 'npc').length,
    doors: f.doors
  }))
}, null, 2) + '\n');

console.log(`✓ 已写出 ${floors.length} 个楼层文件到 data/floors/`);
console.log('✓ 已写出 data/monster-placement.json 与 data/floors/index.json');
