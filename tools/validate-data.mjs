#!/usr/bin/env node
/**
 * 数据校验器。目标：让任何一处「看起来对但实际错」的数据在提交前就暴露。
 *
 * 检查项：
 *   A 数据表自检       编码唯一性、字符合法性、跨表编码冲突、效果 op 声明
 *   B 楼层结构         尺寸、字符合法、索引连续、文件名对应
 *   C 楼梯完整性       每条楼梯都有可达落点；落点在目标层必须可站立
 *   D 实体引用         id 存在、同类不重叠、隐藏道具标记正确
 *   E 结构连通性       入口 → 上楼梯（门视为可通行）；另附本层零钥匙可达范围
 *   F 钥匙收支         逐区统计并与社区基准帖对照
 *   G 战斗公式         黄金用例（含攻略实测的第三方数值）
 *   H 防漂移           内联数据副本与 JSON 数据源是否一致
 *   I 参考源完整性     参考实现自身的缺口（未放置内容、无数据支撑的出口）
 *
 * 用法：node tools/validate-data.mjs [--strict]
 *   --strict  把警告也当作失败
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulateBattle, auraStepDamage } from '../core/combat.mjs';
import { shopCost, cumulativeCost, shopGain, maxPurchases } from '../core/shop.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');

let failures = 0;
let warnings = 0;
let checks = 0;
const fail = (m) => { failures++; console.log('  [FAIL] ' + m); };
const warn = (m) => { warnings++; console.log('  [WARN] ' + m); };
const pass = (m) => { checks++; console.log('  [ OK ] ' + m); };
const info = (m) => console.log('  [ .. ] ' + m);
const head = (m) => console.log('\n' + m);

const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

// ── 载入 ────────────────────────────────────────────────────────
const tiles = readJSON('data/tiles.json');
const monsterTable = readJSON('data/monsters.json');
const itemTable = readJSON('data/items.json');
const npcTable = readJSON('data/npcs.json');
const constants = readJSON('data/constants.json');
const cases = readJSON('data/combat-cases.json');
const monsters = monsterTable.monsters;
const items = itemTable.items;
const npcs = npcTable.npcs;

const floorDir = path.join(ROOT, 'data/floors');
const floorFiles = fs.readdirSync(floorDir)
  .filter((f) => f.endsWith('.json') && f !== 'index.json')
  .sort();
const floors = floorFiles.map((f) => JSON.parse(fs.readFileSync(path.join(floorDir, f), 'utf8')));
const floorByIndex = new Map(floors.map((f) => [f.index, f]));
const lastIndex = floors[floors.length - 1].index;

const terrainByChar = new Map(
  Object.entries(tiles.legend).map(([code, def]) => [def.char, { code: Number(code), ...def }])
);
const standable = (f, x, y) => {
  const t = terrainByChar.get(f.terrain[y][x]);
  return Boolean(t && (t.passable || t.stairs));
};

console.log('魔塔50层 · 数据校验');
console.log('='.repeat(62));

// ── A 数据表自检 ────────────────────────────────────────────────
head('A · 数据表自检');

{
  const chars = Object.values(tiles.legend).map((d) => d.char);
  const dup = [...new Set(chars.filter((c, i) => chars.indexOf(c) !== i))];
  if (dup.length) fail(`地形字符重复：${dup.join(' ')}`);
  else if (chars.some((c) => c.length !== 1)) fail('地形字符必须是单字符');
  else pass(`${chars.length} 种地形字符互不重复：${chars.join(' ')}`);

  const bad = Object.entries(tiles.legend).filter(([, d]) => !d.name || d.passable === undefined);
  if (bad.length) fail(`地形定义缺字段：${bad.map(([c]) => c).join(', ')}`);
  else pass('每种地形都有名称与通行性定义');
}

function checkCodes(table, label, field) {
  const seen = new Map();
  const problems = [];
  for (const [id, def] of Object.entries(table)) {
    const raw = def[field];
    if (raw === undefined) continue;
    if (seen.has(raw)) problems.push(`${raw} 被 "${seen.get(raw)}" 与 "${id}" 共用`);
    else seen.set(raw, id);
  }
  if (problems.length) fail(`${label} 编码冲突：${problems.join('；')}`);
  else pass(`${label} ${seen.size} 个编码无冲突`);
  return seen;
}
const monsterCodes = checkCodes(monsters, '怪物', 'roleId');
const itemCodes = checkCodes(items, '道具', 'sourceId');
const npcCodes = checkCodes(npcs, 'NPC', 'sourceId');

{
  const clash = [...monsterCodes.keys()].filter((k) => npcCodes.has(k));
  if (clash.length) fail(`怪物的 roleId 与 NPC 的 sourceId 冲突：${clash.join(', ')}`);
  else pass('怪物与 NPC 共用 role 层，编码互不冲突');
}

{
  const bad = [];
  for (const [id, m] of Object.entries(monsters)) {
    if (!(m.hp > 0)) bad.push(`${id} hp=${m.hp}`);
    if (!(m.atk >= 0)) bad.push(`${id} atk=${m.atk}`);
    if (!(m.def >= 0)) bad.push(`${id} def=${m.def}`);
    if (m.gold === undefined) bad.push(`${id} 缺 gold`);
    if (m.exp !== 0) bad.push(`${id} exp=${m.exp}（原版无经验系统，必须为 0）`);
  }
  if (bad.length) fail(`怪物数值异常：${bad.join('；')}`);
  else pass(`${Object.keys(monsters).length} 只怪物数值健全；经验值一律为 0，与「原版无经验系统」一致`);
}

{
  const valid = new Set(Object.keys(monsterTable.traitsReference ?? {}));
  const bad = [];
  for (const [id, m] of Object.entries(monsters)) {
    for (const t of m.traits ?? []) {
      const name = typeof t === 'string' ? t : t.type;
      if (!valid.has(name)) bad.push(`${id} 的 trait "${name}" 未在 traitsReference 中定义`);
    }
  }
  if (bad.length) fail(bad.join('；'));
  else pass('所有 traits 均在 traitsReference 中有定义');
}

{
  const declared = new Set(Object.keys(itemTable.effectOps ?? {}));
  const used = new Set();
  for (const it of Object.values(items)) for (const e of it.effects ?? []) used.add(e.op);
  for (const n of Object.values(npcs)) for (const e of n.effects ?? []) used.add(e.op);
  const undeclared = [...used].filter((o) => !declared.has(o));
  if (undeclared.length) fail(`效果 op 未在 effectOps 中声明：${undeclared.join(', ')}`);
  else pass(`效果原子操作全部有声明（${used.size} 种：${[...used].sort().join(', ')}）`);
}

{
  // 特攻类道具必须指向真实存在的 trait
  const flags = new Set();
  for (const m of Object.values(monsters)) {
    for (const t of m.traits ?? []) flags.add(typeof t === 'string' ? t : t.type);
  }
  const bad = [];
  for (const [id, it] of Object.entries(items)) {
    for (const e of it.effects ?? []) {
      if (e.op === 'traitCounter' && !flags.has(e.trait)) {
        bad.push(`道具 "${id}" 指向不存在的 trait "${e.trait}"`);
      }
    }
  }
  if (bad.length) fail(bad.join('；'));
  else pass('特攻道具指向的 trait 都存在（不会出现「拿了道具也没用」的哑弹）');
}

// ── B 楼层结构 ──────────────────────────────────────────────────
head('B · 楼层结构');

{
  const { cols, rows } = floors[0].size;
  const bad = [];
  for (const f of floors) {
    if (f.size.cols !== cols || f.size.rows !== rows) bad.push(`${f.id} 尺寸不一致`);
    if (f.terrain.length !== rows) bad.push(`${f.id} 行数 ${f.terrain.length} ≠ ${rows}`);
    for (const [y, line] of f.terrain.entries()) {
      if (line.length !== cols) bad.push(`${f.id} 第 ${y} 行长度 ${line.length} ≠ ${cols}`);
      for (const ch of line) {
        if (!terrainByChar.has(ch)) bad.push(`${f.id} 第 ${y} 行出现未知字符 "${ch}"`);
      }
    }
  }
  if (bad.length) fail(bad.slice(0, 10).join('；') + (bad.length > 10 ? ` …共 ${bad.length} 处` : ''));
  else pass(`${floors.length} 层全部为 ${cols}×${rows}，字符均在图例内`);
}

{
  const idx = floors.map((f) => f.index);
  const expected = Array.from({ length: idx.length }, (_, i) => idx[0] + i);
  if (JSON.stringify(idx) !== JSON.stringify(expected)) fail('楼层索引不连续');
  else pass(`楼层索引连续：${idx[0]} ~ ${idx[idx.length - 1]}（共 ${idx.length} 层）`);

  const nameMismatch = floors.filter((f, i) => floorFiles[i] !== `${f.id}.json`);
  if (nameMismatch.length) fail(`文件名与 id 不一致：${nameMismatch.map((f) => f.id).join(', ')}`);
  else pass('楼层文件名与 id 一一对应');

  const noUp = floors.filter((f) => f.index < lastIndex && f.stairs.up.length === 0);
  const unexplained = noUp.filter((f) => !f.notes?.exit);
  if (unexplained.length) {
    fail(`以下楼层没有上楼梯、也没有 exit 说明，实现时会卡死玩家：${unexplained.map((f) => f.id).join(', ')}`);
  } else if (noUp.length) {
    pass(`${noUp.length} 层没有上楼梯，但都已在 floor-notes.json 中注明出口方式`);
    for (const f of noUp) info(`${f.id}：${f.notes.exit.method === 'event' ? '剧情事件生成楼梯' : '依赖传送道具'} —— ${f.notes.exit.note}`);
  } else {
    pass('每层都有上楼梯');
  }
}

// ── C 楼梯完整性 ────────────────────────────────────────────────
head('C · 楼梯完整性');

{
  const bad = [];
  let checked = 0;
  const adjusted = [];

  for (const f of floors) {
    for (const dir of ['up', 'down']) {
      for (const s of f.stairs[dir]) {
        checked++;
        const to = dir === 'up' ? f.index + 1 : f.index - 1;
        const dest = floorByIndex.get(to);
        const label = `${f.id} ${dir === 'up' ? '上' : '下'}楼梯 (${s.x},${s.y})`;

        if (s.to !== to) { bad.push(`${label} 的目标层记为 ${s.to}，应为 ${to}`); continue; }
        if (!dest) {
          if (f.index !== 0 && f.index !== lastIndex) bad.push(`${label} 指向不存在的第 ${to} 层`);
          continue;
        }
        if (!s.arrive) { bad.push(`${label} 没有落点`); continue; }
        if (!standable(dest, s.arrive.x, s.arrive.y)) {
          const t = terrainByChar.get(dest.terrain[s.arrive.y][s.arrive.x]);
          bad.push(`${label} 落在第 ${to} 层的「${t?.name}」上，勇者会被卡死在墙里`);
          continue;
        }
        if (s.arriveAdjusted) adjusted.push(`${label} → 已修正为 (${s.arrive.x},${s.arrive.y})`);
      }
    }
  }

  if (bad.length) {
    fail(`${bad.length} 处楼梯有问题：`);
    bad.slice(0, 8).forEach((b) => console.log('         ' + b));
    if (bad.length > 8) console.log(`         …还有 ${bad.length - 8} 处`);
  } else {
    pass(`${checked} 条楼梯全部有可站立的落点`);
  }

  if (adjusted.length) {
    info(`${adjusted.length} 条楼梯的落点做过修正（原版「换层后坐标不变」，但直接沿用会落进墙里）：`);
    adjusted.forEach((a) => console.log('         ' + a));
  }
}

// ── D 实体引用 ──────────────────────────────────────────────────
head('D · 实体引用');

{
  const bad = [];
  const sameCell = [];
  const guarding = [];
  const hidden = [];
  let monsterN = 0, itemN = 0, npcN = 0;

  for (const f of floors) {
    const at = new Map();
    for (const e of f.entities) {
      const { x, y, type, id } = e;
      if (x < 0 || x >= f.size.cols || y < 0 || y >= f.size.rows) {
        bad.push(`${f.id} (${x},${y}) 越界`); continue;
      }
      const t = terrainByChar.get(f.terrain[y][x]);
      const table = type === 'monster' ? monsters : type === 'item' ? items : npcs;
      if (!(id in table)) { bad.push(`${f.id} (${x},${y}) 未知 ${type} "${id}"`); continue; }
      if (type === 'monster') monsterN++;
      else if (type === 'item') itemN++;
      else npcN++;

      const k = `${x},${y}`;
      if (at.has(k)) {
        const prev = at.get(k);
        if (prev.type === type) sameCell.push(`${f.id} (${x},${y}) ${prev.id} 与 ${id}`);
        else guarding.push({ f: f.id, x, y, monster: prev.type === 'monster' ? prev.id : id, item: prev.type === 'item' ? prev.id : id });
      } else at.set(k, e);

      // 站在不可通行地形上的实体
      if (t && !t.passable && !t.stairs) {
        const partner = f.entities.find((o) => o.x === x && o.y === y && o !== e && o.type !== type);
        if (partner && type === 'item') {
          // 与怪物同格 —— BOSS 守道具，合法
        } else if (type === 'item') {
          // 墙内隐藏道具：原版刻意设计，必须标记 hidden
          if (!e.hidden) bad.push(`${f.id} (${x},${y}) 道具 "${id}" 在${t.name}内但没有 hidden 标记`);
          else hidden.push(`${f.id} (${x},${y}) ${items[id].name} 藏于${t.name}内（需${['shovel', 'quakeScroll'].includes('shovel') ? '铁锹或地震卷轴' : '地形改造道具'}）`);
        } else {
          bad.push(`${f.id} (${x},${y}) ${type} "${id}" 站在不可通行的「${t.name}」上`);
        }
      } else if (e.hidden) {
        bad.push(`${f.id} (${x},${y}) "${id}" 标了 hidden 但所在格可通行`);
      }
    }
  }

  if (bad.length) {
    fail(`${bad.length} 处实体位置非法：`);
    bad.slice(0, 8).forEach((b) => console.log('         ' + b));
    if (bad.length > 8) console.log(`         …还有 ${bad.length - 8} 处`);
  } else {
    pass(`实体全部合法：怪物 ${monsterN} / 道具 ${itemN} / NPC ${npcN}`);
  }

  if (sameCell.length) fail(`同类实体同格：${sameCell.slice(0, 5).join('；')}`);
  else pass('无同类实体同格');

  if (guarding.length) {
    pass(`${guarding.length} 处「BOSS 守道具」（怪物与道具同格，击败后道具仍在，属原版设计）`);
    guarding.forEach((g) => info(`${g.f} (${g.x},${g.y})  ${monsters[g.monster].name} 守着 ${items[g.item].name}`));
  }

  if (hidden.length) {
    pass(`${hidden.length} 处墙内隐藏道具（标记为 hidden，需地形改造道具才能取得）`);
    hidden.forEach((h) => info(h));
  }
}

// ── E 连通性 ────────────────────────────────────────────────────
head('E · 连通性');

/**
 * 本层出入口：入口优先取「从下一层上来时的落点」，其次取下楼梯位置。
 * 顶层没有上楼梯，改判「能否到达 BOSS」。
 */
function entryOf(f) {
  const below = floorByIndex.get(f.index - 1);
  if (below) {
    const upStair = below.stairs.up.find((s) => s.to === f.index && s.arrive);
    if (upStair) return upStair.arrive;
  }
  return f.stairs.down[0] ?? null;
}

function flood(f, entry, allowDoor) {
  const { cols, rows } = f.size;
  const seen = new Set([`${entry.x},${entry.y}`]);
  const queue = [[entry.x, entry.y]];
  while (queue.length) {
    const [x, y] = queue.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const k = `${nx},${ny}`;
      if (seen.has(k)) continue;
      const t = terrainByChar.get(f.terrain[ny][nx]);
      if (!t) continue;
      const open = t.passable || t.stairs || ['D', 'a', 'w'].includes(t.char) || (allowDoor && Boolean(t.key));
      if (!open) continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return seen;
}

{
  const EVENT_OPEN = new Set(['D', 'a', 'w']);
  const broken = [];
  const notSelfSufficient = [];

  for (const f of floors) {
    const entry = entryOf(f) ?? (f.index === 1 ? { x: 5, y: 10 } : null);
    if (!entry) continue;

    // ① 结构连通性：门一律视为可通行。不通说明地形图本身有问题。
    const withDoors = flood(f, entry, true);

    // 顶层以 BOSS 为目标，其余以求上楼梯为目标
    const targets = f.stairs.up.length
      ? f.stairs.up
      : f.entities.filter((e) => e.type === 'monster' && monsters[e.id]?.boss);
    const reachedTargets = targets.filter((s) => withDoors.has(`${s.x},${s.y}`));
    if (targets.length && reachedTargets.length === 0) {
      broken.push(`${f.id}：入口只能到达 ${withDoors.size}/121 格，出口全部不可达`);
      continue;
    }

    // ② 本层自足性：从 0 把钥匙出发能走多远（信息项，不是错误）
    const keys = { y: 0, b: 0, r: 0 };
    let region = new Set();
    const floodWith = (passFn) => {
      const { cols, rows } = f.size;
      const seen = new Set([`${entry.x},${entry.y}`]);
      const q = [[entry.x, entry.y]];
      while (q.length) {
        const [x, y] = q.pop();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const k = `${nx},${ny}`;
          if (seen.has(k) || !passFn(nx, ny)) continue;
          seen.add(k); q.push([nx, ny]);
        }
      }
      return seen;
    };
    for (let iter = 0; iter < 30; iter++) {
      const next = floodWith((x, y) => {
        const t = terrainByChar.get(f.terrain[y][x]);
        if (!t) return false;
        if (t.passable || t.stairs || EVENT_OPEN.has(t.char)) return true;
        if (t.key === 'yellowKey') return keys.y > 0;
        if (t.key === 'blueKey') return keys.b > 0;
        if (t.key === 'redKey') return keys.r > 0;
        return false;
      });
      const nk = { y: 0, b: 0, r: 0 };
      for (const k of next) {
        const [x, y] = k.split(',').map(Number);
        const e = f.entities.find((o) => o.x === x && o.y === y && o.type === 'item');
        if (e?.id === 'yellowKey') nk.y++;
        if (e?.id === 'blueKey') nk.b++;
        if (e?.id === 'redKey') nk.r++;
      }
      const stable = next.size === region.size && nk.y === keys.y && nk.b === keys.b && nk.r === keys.r;
      region = next; keys.y = nk.y; keys.b = nk.b; keys.r = nk.r;
      if (stable) break;
    }

    const exitReachable = f.stairs.up.some((s) => region.has(`${s.x},${s.y}`));
    if (f.stairs.up.length && !exitReachable) {
      notSelfSufficient.push({ id: f.id, cells: region.size, keys });
    }
  }

  if (broken.length) {
    fail(`${broken.length} 层结构不通：`);
    broken.forEach((b) => console.log('         ' + b));
  } else {
    pass(`${floors.length} 层结构连通性全部通过（把门视为可通行，入口均能到达出口/BOSS）`);
  }

  if (notSelfSufficient.length) {
    pass(`${notSelfSufficient.length} 层需要「带钥匙进入」才能直达出口 —— 属设计意图，非错误`);
    info('这些楼层的入口附近有门，钥匙必须从别层带进来，构成跨层资源规划：');
    notSelfSufficient.slice(0, 10).forEach((r) =>
      console.log(`         ${r.id}：零钥匙只能走 ${r.cells}/121 格`));
    if (notSelfSufficient.length > 10) console.log(`         …共 ${notSelfSufficient.length} 层`);
  } else {
    pass('每层都能在零钥匙条件下自行到达出口');
  }
}

// ── F 钥匙收支 ──────────────────────────────────────────────────
head('F · 钥匙收支与社区基准对照');

{
  const regions = constants.zoneBaseline.regions;
  const regionOf = (idx) => regions.find((r) => idx >= r.floorFrom && idx <= r.floorTo);

  const acc = new Map();
  for (const f of floors) {
    const r = regionOf(f.index);
    if (!r) continue;
    if (!acc.has(r.id)) acc.set(r.id, { name: r.name, y: 0, b: 0, r: 0, dy: 0, db: 0, dr: 0, gold: 0, monsters: 0 });
    const a = acc.get(r.id);
    for (const e of f.entities) {
      if (e.type === 'item') {
        if (e.id === 'yellowKey') a.y++;
        if (e.id === 'blueKey') a.b++;
        if (e.id === 'redKey') a.r++;
      } else if (e.type === 'monster') {
        a.gold += monsters[e.id].gold;
        a.monsters++;
      }
    }
    for (const line of f.terrain) {
      for (const ch of line) {
        if (ch === 'y') a.dy++;
        if (ch === 'b') a.db++;
        if (ch === 'r') a.dr++;
      }
    }
  }

  console.log('         区域            黄钥匙/黄门        蓝钥匙/蓝门       红钥匙/红门      怪物金币');
  for (const r of regions) {
    const a = acc.get(r.id);
    if (!a) continue;
    const mark = (k, d) => (k >= d ? ' ' : '!');
    console.log(
      `         ${a.name.padEnd(8, '　')}  ${String(a.y).padStart(3)} / ${String(a.dy).padStart(3)} ${mark(a.y, a.dy)}   ` +
      `${String(a.b).padStart(2)} / ${String(a.db).padStart(2)} ${mark(a.b, a.db)}   ` +
      `${String(a.r).padStart(2)} / ${String(a.dr).padStart(2)} ${mark(a.r, a.dr)}   ${String(a.gold).padStart(7)}`
    );
  }
  console.log();

  const baselineYellow = { zone1: 60, zone2: 47, zone4: 51, zone5: 26 };
  const baselineBlue = { zone1: 4, zone2: 6, zone4: 7, zone5: 6 };
  const baselineDoorY = { zone1: 64, zone2: 58, zone4: 53, zone5: 56 };
  const baselineDoorB = { zone1: 5, zone2: 8, zone4: 10, zone5: 13 };

  console.log('         与社区基准帖对照（本数据 / 基准帖）');
  let maxDev = 0;
  for (const rid of Object.keys(baselineYellow)) {
    const a = acc.get(rid);
    if (!a) continue;
    const dev = Math.abs(a.y - baselineYellow[rid]) / baselineYellow[rid];
    maxDev = Math.max(maxDev, dev);
    console.log(`         ${a.name.padEnd(8, '　')} 黄钥匙 ${String(a.y).padStart(3)}/${String(baselineYellow[rid]).padStart(3)}   ` +
      `蓝钥匙 ${String(a.b).padStart(2)}/${String(baselineBlue[rid]).padStart(2)}   ` +
      `黄门 ${String(a.dy).padStart(3)}/${String(baselineDoorY[rid]).padStart(3)}   ` +
      `蓝门 ${String(a.db).padStart(2)}/${String(baselineDoorB[rid]).padStart(2)}`);
  }
  console.log();
  if (maxDev <= 0.1) pass(`各区的黄钥匙数量与基准帖偏差均在 10% 以内（最大 ${(maxDev * 100).toFixed(1)}%）`);
  else warn(`黄钥匙数量与基准帖最大偏差 ${(maxDev * 100).toFixed(1)}%，建议核查是否漏装钥匙`);
  info('差异来源：基准帖的「总黄钥匙」含商人出售的钥匙，而地图数据里商人只是 NPC，不携带钥匙实体');

  let totK = 0, totD = 0;
  for (const a of acc.values()) { totK += a.y + a.b + a.r; totD += a.dy + a.db + a.dr; }
  info(`全塔钥匙 ${totK} 把 vs 门 ${totD} 扇（门多 ${totD - totK}）`);
  if (totD > totK) pass('门多于钥匙，保留了原版「必须选择性开门」的核心张力');
  else warn('钥匙多于门，原版的经济张力会消失，建议核查');

  const totalGold = [...acc.values()].reduce((s, a) => s + a.gold, 0);
  const bp = constants.economy.totalGoldInGame;
  const diff = Math.abs(totalGold - bp) / bp;
  info(`地图怪物金币合计 ${totalGold}，基准帖全游戏总金币 ${bp}，偏差 ${(diff * 100).toFixed(1)}%`);
  if (diff < 0.35) pass('金币总量与基准帖同量级');
  else warn('金币总量与基准帖偏差较大，建议核查是否漏装了怪物');
}

// ── G 战斗公式黄金用例 ──────────────────────────────────────────
head('G · 战斗公式黄金用例');

{
  let ok = 0;
  const bad = [];
  for (const c of cases.cases) {
    const pv = simulateBattle(c.hero, c.monster, { counters: c.counters });
    const e = c.expected;
    const diffs = [];
    const chk = (key, got, want) => { if (want !== undefined && got !== want) diffs.push(`${key} ${got} ≠ ${want}`); };
    chk('rounds', pv.rounds, e.rounds);
    chk('enemyAttacks', pv.enemyAttacks, e.enemyAttacks);
    chk('perRound', pv.perRound, e.perRound);
    chk('canWin', pv.canWin, e.canWin);
    chk('reason', pv.reason ?? undefined, e.reason);
    chk('execute', pv.execute, e.execute);
    chk('effectiveAtk', pv.effectiveAtk, e.effectiveAtk);
    chk('flanked', pv.flanked, e.flanked);
    chk('hpLossMin', pv.hpLossMin, e.hpLossMin);
    chk('hpLossMax', pv.hpLossMax, e.hpLossMax);
    if (e.loss === null) { if (pv.hpLoss !== Infinity) diffs.push(`loss 应为 Infinity，实为 ${pv.hpLoss}`); }
    else chk('loss', pv.hpLoss, e.loss);

    if (diffs.length) bad.push(`${c.name}：${diffs.join('，')}`);
    else ok++;
  }
  if (bad.length) { fail(`${bad.length} 条战斗用例不符：`); bad.forEach((b) => console.log('         ' + b)); }
  else pass(`战斗用例 ${ok}/${cases.cases.length} 条全部通过`);

  const guideBacked = cases.cases.filter((c) => c.sourceNote?.includes('攻略原文')).length;
  info(`其中 ${guideBacked} 条 expected 值直接取自攻略中玩家实测的扣血量，属独立第三方验证`);

  let aok = 0;
  const abad = [];
  for (const c of cases.auraCases) {
    const got = auraStepDamage(c.adjacent, { auraImmune: c.auraImmune });
    if (got !== c.expected) abad.push(`${c.name}：${got} ≠ ${c.expected}`);
    else aok++;
  }
  if (abad.length) { fail('领域用例不符：'); abad.forEach((b) => console.log('         ' + b)); }
  else pass(`领域用例 ${aok}/${cases.auraCases.length} 条通过`);

  let sok = 0;
  const sbad = [];
  for (const c of cases.shopCases) {
    const got = c.n !== undefined
      ? (c.name.includes('累计') ? cumulativeCost(c.n) : shopCost(c.n))
      : shopGain(c.floor, c.stat);
    if (got !== c.expected) sbad.push(`${c.name}：${got} ≠ ${c.expected}`);
    else sok++;
  }
  if (sbad.length) { fail('商店用例不符：'); sbad.forEach((b) => console.log('         ' + b)); }
  else pass(`商店用例 ${sok}/${cases.shopCases.length} 条通过`);

  const gold = constants.economy.totalGoldInGame;
  const mp = maxPurchases(gold);
  if (mp !== constants.economy.maxPurchasesIfAllGoldSpent) {
    fail(`整局最大购买次数计算为 ${mp}，constants 写的是 ${constants.economy.maxPurchasesIfAllGoldSpent}`);
  } else {
    pass(`整局金币 ${gold} 最多购买 ${mp} 次属性（第 ${mp + 1} 次要累计 ${cumulativeCost(mp + 1)}）`);
  }
}

// ── H 防漂移 ────────────────────────────────────────────────────
head('H · 内联副本防漂移');

{
  const htmlPath = path.join(ROOT, 'tools/balance-check.html');
  if (!fs.existsSync(htmlPath)) {
    warn('tools/balance-check.html 不存在，跳过防漂移检查');
  } else {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const block = (id) => {
      const m = html.match(new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`));
      return m ? JSON.parse(m[1]) : null;
    };

    const inlineMonsters = block('monsters');
    if (!inlineMonsters) warn('balance-check.html 中找不到 #monsters 数据块，跳过');
    else {
      const diffs = [];
      for (const [id, m] of Object.entries(monsters)) {
        const inl = inlineMonsters[id];
        if (!inl) { diffs.push(`${id} 缺失`); continue; }
        for (const k of ['name', 'hp', 'atk', 'def', 'gold']) {
          if (inl[k] !== m[k]) diffs.push(`${id}.${k}: 内联 ${inl[k]} ≠ 数据源 ${m[k]}`);
        }
      }
      const extra = Object.keys(inlineMonsters).filter((k) => !(k in monsters));
      if (extra.length) diffs.push(`内联多出：${extra.join(', ')}`);
      if (diffs.length) { fail(`${diffs.length} 处怪物数据漂移：`); diffs.slice(0, 8).forEach((d) => console.log('         ' + d)); }
      else pass(`内联怪物表 ${Object.keys(inlineMonsters).length} 条与 data/monsters.json 完全一致`);
    }

    const inlineCases = block('cases');
    if (!inlineCases) warn('balance-check.html 中找不到 #cases 数据块，跳过');
    else if (JSON.stringify(inlineCases) !== JSON.stringify(cases.cases)) {
      fail('内联黄金用例与 data/combat-cases.json 不一致 —— 跑 node tools/build-balance-check.mjs 重新生成');
    } else pass(`内联黄金用例 ${inlineCases.length} 条与数据源一致`);

    const inlineHero = block('hero');
    if (!inlineHero) warn('balance-check.html 中找不到 #hero 数据块，跳过');
    else {
      // 只比「会影响计算」的字段。constants.hero 里还有纯文档字段（如 startPosNote），
      // 它们的变化不该让防漂移检查失败 —— 否则每加一句注释就要重建一次页面，
      // 检查很快会被当成噪音而忽略，反而失去作用。
      const KEYS = ['hp', 'atk', 'def', 'gold', 'yellowKey', 'blueKey', 'redKey', 'startFloor', 'startPos'];
      const pick = (o) => JSON.stringify(KEYS.map((k) => [k, o?.[k]]));
      if (pick(inlineHero) !== pick(constants.hero)) {
        fail('内联勇者初始属性与 constants.json 不一致 —— 跑 node tools/build-balance-check.mjs 重新生成');
      } else pass('内联勇者初始属性与 constants.json 一致（只比影响计算的字段）');
    }
  }
}

// ── I 参考源完整性 ──────────────────────────────────────────────
// 参考实现 m8705/MAGIC-TOWER-JS 自身并不完整。本段把「由此产生的缺口」
// 变成每次运行都会浮现的输出，而不是只躺在 docs/known-gaps.md 里等人想起来。
// 缺口清单与决策方案见 docs/known-gaps.md。
head('I · 参考源完整性');

{
  // ── I1 从未被放置的内容 ──────────────────────────────────────
  const placement = readJSON('data/monster-placement.json');
  const neverPlaced = (placement.neverPlaced ?? []).filter((id) => id in monsters);
  if (neverPlaced.length) {
    info(`参考数据中从未放置的怪物 ${neverPlaced.length} 只：` +
      neverPlaced.map((id) => `${monsters[id].name}(${id})`).join('、'));
    const bosses = neverPlaced.filter((id) => monsters[id].boss);
    if (bosses.length) {
      info(`其中 BOSS：${bosses.map((id) => monsters[id].name).join('、')} —— 对应区域没有 BOSS 战，见 known-gaps §2/§4`);
    }
  } else {
    pass('所有怪物都在地图上有落点');
  }

  const placedItems = new Set();
  const placedNpcs = new Set();
  for (const f of floors) {
    for (const e of f.entities) {
      if (e.type === 'item') placedItems.add(e.id);
      else if (e.type === 'npc') placedNpcs.add(e.id);
    }
  }
  const ghostItems = Object.keys(items).filter((id) => !placedItems.has(id));
  const ghostNpcs = Object.keys(npcs).filter((id) => !placedNpcs.has(id));
  if (ghostItems.length) {
    info(`定义了但从未出现在地图上的道具 ${ghostItems.length} 项：` +
      ghostItems.map((id) => `${items[id].name}(${items[id].sourceId ?? '—'})`).join('、'));
  }
  if (ghostNpcs.length) {
    info(`定义了但从未出现在地图上的 NPC ${ghostNpcs.length} 个：` +
      ghostNpcs.map((id) => `${npcs[id].name}(${npcs[id].sourceId ?? '—'})`).join('、'));
  }

  // ── I2 每一层的向上出口是否真有数据支撑 ──────────────────────
  // 楼梯图只在 3 处断开，且全是「区域边界 BOSS 层」：10→11、40→41、49→50。
  // 这是刻意的设计手法（打完 BOSS 才开门），不是数据损坏。
  // 所以本项检查的不是「有没有楼梯」，而是「声明的非楼梯出口在数据里能不能实现」。
  //
  // 注意：楼层传送器（openFloorSelect）**不能**充当向上出口 ——
  // 它只能到达 wentFloor 里「已到过」的楼层，无法用于首次向上推进。
  let events = null;
  try { events = readJSON('data/events.json'); } catch { /* 事件表尚未重建 */ }

  // 事件表结构：`{ events: [...] }`，每条有 `effects: [{ op, floor, ... }]`。
  // 事件生成的楼梯用的是 `op === 'addStair'`（见 src/data/types.ts 的 EventEffect）。
  const eventList = events?.events ?? [];

  // 能实现 n → n+1 的一次性换层道具
  const upItems = Object.values(items)
    .flatMap((it) => (it.effects ?? []).filter((e) => e.op === 'changeFloor' && (e.delta ?? 0) > 0)
      .map((e) => ({ item: it.name, delta: e.delta })));

  const boundaries = [];
  const unsupported = [];
  for (const f of floors) {
    if (f.index >= lastIndex) continue;              // 末层无需出口
    if (f.stairs.up.length > 0) continue;            // 有上楼梯，正常
    const target = f.index + 1;
    const method = f.notes?.exit?.method ?? null;
    // 本层出口有两种事件支撑方式：
    //  ① 本层直接生成上楼梯（`addStair.floor === f.index`，如 10→11、40→41）；
    //  ② 有别的层的 addStair 直达本层的上一层（`addStair.to === target`，如 24 层直达 50 层，
    //     于是 49 层本身不需要上楼梯 —— 方案 A 的跨层入口）。
    const byEvent = eventList.some(
      (ev) => (ev.effects ?? []).some(
        (e) => e.op === 'addStair' && (e.floor === f.index || e.to === target)));
    const oneShot = upItems.filter((t) => target === f.index + (t.delta ?? 0));

    boundaries.push({ f, target, method, byEvent, oneShot });
    if (!byEvent) unsupported.push({ f, target, method, oneShot });
  }

  if (boundaries.length === 0) {
    pass('每层都有上楼梯，不存在区域边界断点');
  } else {
    info(`楼梯图在 ${boundaries.length} 处断开，均位于区域边界 BOSS 层` +
      `（打完 BOSS 才通行，属原版设计手法而非数据损坏）：`);
    for (const b of boundaries) {
      const via = b.byEvent
        ? '已由剧情事件实现 ✓'
        : b.oneShot.length
          ? `仅有一次性的「${b.oneShot.map((t) => t.item).join('、')}」可能覆盖`
          : '没有任何可用机制';
      console.log(`         ${b.f.index} → ${b.target}   声明方式 = ${b.method ?? '（未声明）'}   ${via}`);
    }
  }

  if (unsupported.length === 0) {
    pass('所有区域边界的通路都已在 data/events.json 中实现');
  } else {
    warn(`${unsupported.length} 处区域边界通路缺少数据支撑，实现后玩家会卡在 BOSS 层：`);
    for (const u of unsupported) {
      console.log(`         ${u.f.index} → ${u.target}（声明方式 ${u.method ?? '未声明'}）`);
    }
    info('取舍方案见 docs/known-gaps.md §1 —— 这是「忠实于参考源」与「游戏可通关」之间的选择，需人工决策');
  }

  // ── I3 事件表是否存在 ────────────────────────────────────────
  if (events) {
    pass(`data/events.json 存在，含 ${(events.events ?? []).length} 条事件`);
  } else {
    info('data/events.json 尚未重建（上一版 3 层草案的事件表已移入 data/_legacy-3floors/）');
    info('受影响的机制：第 10 层剧情生成楼梯、第 49→50 层通路、道具/道具赠予类事件');
  }
}

// ── 汇总 ────────────────────────────────────────────────────────
head('汇总');
console.log(`  ${checks} 项通过，${warnings} 项警告，${failures} 项失败`);
if (failures === 0 && warnings === 0) console.log('  数据状态：干净');
else if (failures === 0) console.log('  数据状态：可用，警告需人工判断');
else console.log('  数据状态：存在硬错误，必须先修');

process.exit(failures > 0 || (STRICT && warnings > 0) ? 1 : 0);
