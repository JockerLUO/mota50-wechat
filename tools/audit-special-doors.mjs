/**
 * 锐利判据：本项目地图里每一格**没有钥匙能开**的门（机关门 `a` / 牢门 `D`），
 * 都必须有事件去开它 —— 否则那一格就是**永久死路**（第 20 层整塔断掉就是这个病）。
 *
 * 为什么单独写一条而不是并进 `audit-event-gaps.mjs`：
 *   · 那条是**跨源对账**（依赖 deluxe 的坐标能对上），只能提示「可能缺」；
 *   · 这条只用**本项目自己的数据**（`data/floors/*.json` + `data/events.json`），
 *     结论是确定的 —— 「这格门没有任何事件会开」是事实，不是推断。
 *
 * `--behind` 再加一层：把那格门当成**永远打不开**做一次可达性，看它到底挡住了什么
 * （上楼梯 / 道具 / 怪）。这一层决定「这条事件是致命缺口还是补齐演出」——
 * 两种都要写，但报告里必须说得出哪一种是哪一种。
 *
 * `--solved` 是**真死路判据**（2026-09-28 新增）：把 `data/events.json` 当成一套
 * 「条件 → 开门」的规则，从初始状态反复应用直到不动点，再看还剩哪些门没开、
 * 哪些上楼梯够不着。`--behind` 换成不动点是因为它有**方向性错误**：
 * 它一次只把被测那一扇门当作已开、其余每一扇都当成关着的，于是「经别的门绕过去」
 * 会被报成切断（实测第 45 层 (3,9)：报 ❌ 切断 darkKnight(4,8)(4,10)，而真实
 * 拓扑是 A—(3,9)—B—(6,9)—C—(8,9)y—D 串联，从右路进来能一路打通）。
 * ⇒ `--behind` 只用来**排优先级**（哪些门看着最要命），`--solved` 才用来**判死路**。
 *
 * ⚠️ `verify:autoplay` 的 C 段★判据（「每层上楼梯都够得着」）**抓不到这一类**：
 *    它的口径是「只把 `#`/`*` 当阻挡，钥匙门/牢门/假墙全当能过」——
 *    机关门被当成能过的，所以「一扇没人开的机关门」在它眼里是通的。
 *    那条守的是**地形本身**断没断，这条守的是**门有没有人来开**，各管一段。
 *
 * 用法：
 *   node tools/audit-special-doors.mjs            # 列出没人开的门
 *   node tools/audit-special-doors.mjs --behind   # 附「这扇门挡住了什么」（单门 BFS，只排优先级）
 *   node tools/audit-special-doors.mjs --solved   # 不动点：把所有事件应用完，还剩哪些门开不了
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const withBehind = process.argv.includes('--behind');
const withSolved = process.argv.includes('--solved');

/** 「没有钥匙能开」的门字符 —— 只能靠事件开 */
const EVENT_ONLY_DOORS = { a: '机关门', D: '牢门' };

/**
 * **故意打不开**的门 —— 原版设计，不是缺口。
 *
 * 判据必须能区分「漏了」与「本来就不该有」。这两者的症状在报告上一模一样
 * （都表现为「没有任何事件会开」），混在一起会让真正的缺口淹在噪音里。
 * 每条都必须写清**凭什么说它是故意的**，且这条理由要能指向一份可查的原文。
 *
 * ⚠️ 豁免不是「免检」：**已经被事件打开的门不允许留在豁免表里** ——
 * 那种情况说明豁免过期了（有人后来补了事件，或者门被改成了别的字符），
 * 留着会让后来的人以为那扇门还是坏的。下面有一条专门的过期检查。
 */
const INTENTIONAL = new Map([
  [
    '48:7,7',
    '第 48 层圣剑房：原版明说「存放圣剑的房间的门坏了，你必须用铁锹破墙而入」' +
      '（data/npcs.json 智者第 38 条 / data/floor-notes.json 第 48 层）。正解不是开门，' +
      '而是站在 (8,6) 用 `shovel` 的 `breakWall`（相邻 4 格）挖掉 (8,7) 那面墙再走进去 —— ' +
      '所以这一格**不该有开门事件**。'
  ]
]);

/** 地形数字编号 → 字符（`setTerrain` 用字符、`clearTerrain` 用编号，两边都要认） */
const legend = JSON.parse(fs.readFileSync(path.join(DATA, 'tiles.json'), 'utf8')).legend;
const charOfNumber = (n) => legend[String(n)]?.char ?? null;
/** 按**字符**索引的地形表。⚠️ `legend` 的键是数字编号，别写 `legend['w']`（永远 undefined）。 */
const byChar = new Map(Object.values(legend).map((t) => [t.char, t]));


/**
 * 可达性分析里「算阻挡」的地形。
 *
 * ⚠️ **不是** `legend.passable`。这里要的是「不花任何事件就过不去」的格子：
 *   · 墙 / 星际空间 / 岩浆 —— 过不去（岩浆要铁锹，那也是一件道具）；
 *   · 机关门 `a` / 牢门 `D` —— **本判据的主角**，没事件就是死路；
 *   · **钥匙门 `y`/`b`/`r` 不算阻挡** —— 有钥匙就能开，是资源问题不是死路问题。
 * 第一版直接用了 `legend.passable`，于是 F49 的 BFS 被入口那扇红门挡住，
 * 走不进地图深处 ⇒ 17 格门全部误报「不挡任何东西」。
 */
const BLOCKING = new Set(['#', '*', '~', 'a', 'D']);
const blocks = (ch) => BLOCKING.has(ch);

const events = JSON.parse(fs.readFileSync(path.join(DATA, 'events.json'), 'utf8')).events ?? [];

/**
 * 事件能开到的格。
 *
 * 两种写法都要认，漏一种就会误报「这格门没人开」：
 *   · `setTerrain(floor,x,y,'.')` —— 精确开一格（F20 那两扇）；
 *   · `clearTerrain(floor, terrain:N)` —— **按编号清全层**（F2 牢门 / F8 机关门用的是它）。
 * 后者不列坐标，所以要知道 `N` 是哪个字符（查 `data/tiles.json` 的 legend）。
 */
const opened = new Map();
for (const ev of events) {
  for (const e of ev.effects ?? []) {
    if (e.op === 'setTerrain' && e.terrain === '.') opened.set(`${e.floor}:${e.x},${e.y}`, ev.id);
    else if (e.op === 'clearTerrain') {
      const ch = charOfNumber(e.terrain);
      if (ch) opened.set(`#clear:${e.floor}:${ch}`, ev.id);
    }
  }
}
const clearedByKind = (floor, ch) => opened.get(`#clear:${floor}:${ch}`) ?? null;

const floorDir = path.join(DATA, 'floors');
const files = fs.readdirSync(floorDir).filter((f) => /^floor-\d+\.json$/.test(f));

/** 读一层（--behind 要用地形与实体） */
const loadFloor = (file) => JSON.parse(fs.readFileSync(path.join(floorDir, file), 'utf8'));
const floorFileOf = (n) => `floor-${String(n).padStart(2, '0')}.json`;

/**
 * 这一层的**入口格** —— 玩家从上一层走上来时站在哪儿。
 *
 * ⚠️ 不能只用「本层的下楼梯」：第 30 层**两座都是上楼梯、没有下楼梯**，
 *    起点为空 ⇒ 可达集为空 ⇒ 每一格门都报「不挡任何东西」（实测第二次假阴性）。
 *    回退顺序：① 本层 `stairs.down` 的格子；② 上一层 `stairs.up` 里 `to === 本层`
 *    的那条的 `arrive`（那正是玩家落地的地方）；③ 实在没有才用本层所有楼梯。
 */
function entriesOf(f) {
  const out = [];
  for (let y = 0; y < f.terrain.length; y++)
    for (let x = 0; x < f.terrain[y].length; x++) if (f.terrain[y][x] === 'v') out.push({ x, y });
  if (out.length) return out;
  const prev = fs.existsSync(path.join(floorDir, floorFileOf(f.index - 1))) ? loadFloor(floorFileOf(f.index - 1)) : null;
  for (const s of prev?.stairs?.up ?? []) if (s.to === f.index && s.arrive) out.push({ x: s.arrive.x, y: s.arrive.y });
  if (out.length) return out;
  for (const dir of ['down', 'up']) for (const s of f.stairs?.[dir] ?? []) out.push({ x: s.x, y: s.y });
  return out;
}

function reachOn(f, extra = new Set(), forcedOpen = new Set()) {
  const h = f.terrain.length;
  const w = f.terrain[0].length;
  const starts = entriesOf(f).map((p) => `${p.x},${p.y}`);
  const seen = new Set(starts.filter((k) => {
    const [x, y] = k.split(',').map(Number);
    return f.terrain[y]?.[x] !== undefined;
  }));
  const q = [...seen];
  while (q.length) {
    const [x, y] = q.shift().split(',').map(Number);
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const k = `${nx},${ny}`;
      if (seen.has(k) || extra.has(k)) continue;
      // `forcedOpen` 是「这一格的门已经被打开」——没有它，「开」与「关」两次 BFS
      // 会把门都当墙，差值恒为空（实测第一版 17 格全是假阴性）。
      if (!forcedOpen.has(k) && blocks(f.terrain[ny][nx])) continue;
      seen.add(k);
      q.push(k);
    }
  }
  return seen;
}

let total = 0;
const dead = [];
const exempt = [];
for (const file of files) {
  const f = loadFloor(file);
  for (let y = 0; y < f.terrain.length; y++) {
    for (let x = 0; x < f.terrain[y].length; x++) {
      const ch = f.terrain[y][x];
      if (!EVENT_ONLY_DOORS[ch]) continue;
      total++;
      const hasEvent = opened.has(`${f.index}:${x},${y}`) || clearedByKind(f.index, ch);
      const why = INTENTIONAL.get(`${f.index}:${x},${y}`);
      if (hasEvent) {
        // 豁免过期检查：已经有人开它了，却还留在豁免表里 ⇒ 后来的人会以为它还是坏的
        if (why) exempt.push({ floor: f.index, x, y, ch, kind: EVENT_ONLY_DOORS[ch], stale: true });
        continue;
      }
      if (why) exempt.push({ floor: f.index, x, y, ch, kind: EVENT_ONLY_DOORS[ch], why });
      else dead.push({ floor: f.index, x, y, ch, kind: EVENT_ONLY_DOORS[ch], file });
    }
  }
}

// ── 不动点：把 `data/events.json` 当成「前置格够得着 → 开门」的规则跑到底 ──
/**
 * 一条会开门的规则：`needs` = 触发条件要求玩家**已经能走到**的格（本层坐标），
 * `opens` = 它把哪一格变成通路（或 `#clear:<字符>` = 按地形清全层）。
 *
 * ⚠️ `needs` 只覆盖「能表达成坐标」的四种触发（defeated / allDefeated.at / enterTile /
 *    talked）；`allDefeated.ids` 展开成「本层静态表里这种怪所在的每一格」——
 *    对 F2 牢门 / F8 自动门 / F49 封印这三条成立。
 * ⚠️ 逐层独立求可达：跨楼层往返会引入「上楼后再回来」的长链，那属于**自动通关**
 *    的验证范围（`verify:autoplay` 的整局模拟），不是这里要守的东西（铁律 #38）。
 */
function buildRules() {
  const rules = [];
  for (const ev of events) {
    const t = ev.trigger ?? {};
    const floor = t.floor;
    const needs = [];
    if (t.op === 'defeated' && t.x !== undefined) needs.push(`${t.x},${t.y}`);
    else if (t.op === 'allDefeated') {
      for (const p of t.at ?? []) needs.push(`${p.x},${p.y}`);
      if ((t.at ?? []).length === 0 && t.ids) {
        const f = floor !== undefined && fs.existsSync(path.join(floorDir, floorFileOf(floor))) ? loadFloor(floorFileOf(floor)) : null;
        for (const e of f?.entities ?? []) if (t.ids.includes(e.id)) needs.push(`${e.x},${e.y}`);
      }
    } else if (t.op === 'enterTile' || t.op === 'talked') {
      if (t.x !== undefined) needs.push(`${t.x},${t.y}`);
    }
    const opens = [];
    for (const e of ev.effects ?? []) {
      if (e.floor === undefined) continue;
      // ⚠️ 只有**改成可通行地形**才算「开」。`setTerrain ... 'a'` 是**关门**
      //    （第 10 层埋伏那一步就在关 (5,2)(5,6)），把它当「开」会让求解器
      //    以为那两扇门已经通了。关门不参与求解 —— 这个求解器的口径是
      //    「能开多少开多少」，关门的后果由 `verify:autoplay` 的整局模拟守。
      if (e.op === 'setTerrain' && byChar.get(e.terrain)?.passable === true)
        opens.push({ floor: e.floor, cell: `${e.x},${e.y}` });
      else if (e.op === 'clearTerrain') {
        const ch = charOfNumber(e.terrain);
        if (ch) opens.push({ floor: e.floor, clear: ch });
      }
    }
    if (!opens.length) continue;
    // 前置格缺坐标又缺 ids（比如 `start`）⇒ 开局即生效，`needs` 空 = 永真
    if (floor === undefined && needs.length === 0 && t.op !== 'start') continue;
    rules.push({ id: ev.id, floor: floor ?? null, needs, needFloor: floor, opens });
  }
  return rules;
}

function solve() {
  const rules = buildRules();
  const openCells = new Map(); // floor → Set('x,y')
  const openKinds = new Map(); // floor → Set(字符)
  const applied = new Set();
  const reachOf = new Map();
  const bump = (m, k) => (m.has(k) ? m.get(k) : (m.set(k, new Set()), m.get(k)));
  const forcedOf = (f) => {
    const s = new Set(openCells.get(f.index) ?? []);
    const kinds = openKinds.get(f.index);
    if (kinds) for (let y = 0; y < f.terrain.length; y++) for (let x = 0; x < f.terrain[y].length; x++) if (kinds.has(f.terrain[y][x])) s.add(`${x},${y}`);
    return s;
  };
  for (;;) {
    reachOf.clear();
    for (const file of files) {
      const f = loadFloor(file);
      reachOf.set(f.index, reachOn(f, new Set(), forcedOf(f)));
    }
    let changed = false;
    for (const r of rules) {
      if (applied.has(r.id)) continue;
      // 前置格散落在多层时（罕见），要求每一层各自都够得着
      const ok = r.needs.every((k) => (reachOf.get(r.needFloor) ?? new Set()).has(k));
      if (!ok) continue;
      applied.add(r.id);
      for (const o of r.opens) {
        if (o.clear) bump(openKinds, o.floor).add(o.clear);
        else bump(openCells, o.floor).add(o.cell);
      }
      changed = true;
    }
    if (!changed) break;
  }
  return { rules, openCells, openKinds, applied, reachOf, forcedOf };
}

console.log(`地图上「没有钥匙能开」的门：${total} 格（机关门 + 牢门）`);

if (withSolved) {
  const { rules, applied, reachOf, forcedOf } = solve();
  const unapplied = rules.filter((r) => !applied.has(r.id));
  console.log(`\n=== 不动点（--solved）===`);
  console.log(`开门规则 ${rules.length} 条：生效 ${applied.size} 条，未生效 ${unapplied.length} 条`);
  for (const r of unapplied) {
    console.log(`  ⚠️ 事件未生效：${r.id}（F${r.needFloor}）—— 前置格 ${r.needs.join(' ') || '（无）'} 够不着`);
  }
  let bad = 0;
  for (const file of files) {
    const f = loadFloor(file);
    const F = forcedOf(f);
    const R = reachOf.get(f.index);
    const shut = [];
    for (let y = 0; y < f.terrain.length; y++)
      for (let x = 0; x < f.terrain[y].length; x++)
        if (EVENT_ONLY_DOORS[f.terrain[y][x]] && !F.has(`${x},${y}`) && !INTENTIONAL.has(`${f.index}:${x},${y}`))
          shut.push(`(${x},${y})${f.terrain[y][x]}`);
    const noStair = [];
    for (let y = 0; y < f.terrain.length; y++)
      for (let x = 0; x < f.terrain[y].length; x++)
        if (f.terrain[y][x] === '^' && !R.has(`${x},${y}`)) noStair.push(`(${x},${y})`);
    if (!shut.length && !noStair.length) continue;
    bad++;
    console.log(`  F${f.index}：${shut.length ? `仍有 ${shut.length} 扇特殊门没开 ${shut.slice(0, 6).join(' ')}` : ''}${noStair.length ? `  ❌ 上楼梯够不着 ${noStair.join(' ')}` : ''}`);
  }
  console.log(bad === 0 ? '  ✅ 所有事件应用完之后，每一层都能走到上楼梯' : `  ❌ ${bad} 层有问题`);
}

if (exempt.length) {
  console.log(`\n=== 已知豁免（原版设计，不是缺口）${exempt.length} 格 ===`);
  for (const e of exempt) {
    if (e.stale) console.log(`   ⚠️ F${e.floor} (${e.x},${e.y}) 的豁免**已过期** —— 它已经被事件打开了，请从 INTENTIONAL 里删掉`);
    else console.log(`   F${e.floor} (${e.x},${e.y}) ${e.kind}：${e.why}`);
  }
}

const stale = exempt.filter((e) => e.stale);
if (dead.length === 0) {
  console.log(`\n✅ 每一格都有事件去开它（或已登记为故意打不开）—— 塔上没有永久死路`);
  process.exit(stale.length ? 1 : 0);
}

console.log(`\n❌ ${dead.length} 格没有任何事件会开：`);
for (const d of dead) {
  let behind = '';
  if (withBehind) {
    const f = loadFloor(d.file);
    const cell = `${d.x},${d.y}`;
    const open = reachOn(f, new Set(), new Set([cell])); // 门开着
    const shut = reachOn(f, new Set()); // 门关着
    const cut = [...open].filter((k) => !shut.has(k));
    const ents = (f.entities ?? []).filter((e) => cut.includes(`${e.x},${e.y}`));
    const stairs = [];
    for (let y = 0; y < f.terrain.length; y++)
      for (let x = 0; x < f.terrain[y].length; x++)
        if ((f.terrain[y][x] === '^' || f.terrain[y][x] === 'v') && cut.includes(`${x},${y}`))
          stairs.push(f.terrain[y][x] === '^' ? `上楼梯(${x},${y})` : `下楼梯(${x},${y})`);
    const bits = [];
    if (stairs.length) bits.push(`❌ 切断楼梯 ${stairs.join(' ')}`);
    if (ents.length) bits.push(`切断 ${ents.length} 个实体：${ents.slice(0, 6).map((e) => `${e.id}(${e.x},${e.y})`).join(' ')}${ents.length > 6 ? ' …' : ''}`);
    if (!bits.length) bits.push('—— 不挡任何东西（纯装饰门）');
    behind = `\n        ${bits.join('  ·  ')}`;
  }
  console.log(`   F${d.floor} (${d.x},${d.y}) ${d.ch} ${d.kind}${behind}`);
}
process.exit(1);

