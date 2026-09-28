/**
 * 对账：原版 deluxe 那些**会改变地图**的触发（门 / 地形 / 怪 / 道具），
 * 本项目 `data/events.json` 覆盖了哪些、还缺哪些。只读，不写任何文件。
 *
 * ## 为什么要有它
 *
 * 「完善所有事件」这句话**没有终点**（原版 151 个触发点、25 种算子）。
 * 能验收的只有一件事：**每一个会改变「能不能走下去 / 能不能拿到东西」的触发，
 * 在本项目里都有对应物**。纯演出的 `text` / `sfx` / `sleep` / `tip` 不算 ——
 * 少了它们画面少一句话；少了前者玩家会卡死。
 *
 * ## 三层判据（每层都必须过，缺一不可）
 *
 * ① **原版做了什么**：把触发（`after` / `auto` / `step` / `first`，含 `cutscene` 展开）
 *    里的 `open` / `close` / `set` / `hide` 展开成「目标格 + 期望改变」。
 *    `set n:X` 是地形还是实体，看 `deluxe.tiles[X].kind`（`item`/`enemy` → 实体，
 *    `door`/`wall`/… → 地形）—— 原版把**道具也当图块**，不看 `kind` 会把
 *    「放一把红钥匙」误判成「改地形」。
 * ② **这一格在本项目里是不是本来就是那样**（no-op 过滤）：
 *    `open` 到一格而本项目那格早就是空地 ⇒ **不是缺口**，原版那句话在本项目
 *    本来就成立。缺了这一层，报告会拿「原版 88 格 vs 本项目 3 格」吓人，
 *    而其中大部分是本来就对上的（实测第一版就是 3/88，全是假缺口）。
 * ③ **本项目有没有对等产物**：同层同格有没有 `setTerrain` / `spawn` / `remove`，
 *    或**同层按地形编号的 `clearTerrain`**（F2 牢门 / F8、F30 机关门用的是它）。
 * ④ **「set 完又 hide」的是演出，不是缺口**（2026-09-28 第十轮补，第四类假缺口）：
 *    原版的军团经常**在同一个 cutscene 里先 `set` 出来、末尾再 `hide` 掉** ——
 *    `intro3f`（魔王开场宣言，随后 `setHero` + `goto MT2`）、`mt42story`（魔王处决骑士队长）、
 *    `mt50reveal`（真魔王登场）都是这种。它们在**地图上不留任何痕迹**，
 *    报成「缺 5 只魔王」会把缺口数从 27 虚报成 38，并且把读者的注意力全引到「剧情演出」
 *    这件**本项目根本没有的表现层能力**上（没有 cutscene 播放器）。
 *    ⇒ 判据：目标格若在**同一段展开后的 op 列表**里被 `hide`，归入「演出」单列。
 *    ⚠️ 只对 `spawn` 生效：`hide` 移除的是**实体**，`set` 的地形不会被 `hide` 撤掉。
 *    ⚠️ 「同一段」是关键词：`mt49win` 的 `hide` 撤的是**另一条触发**（step@6,6）放进来的
 *    9 个分身 —— 那是**真的**把敌人从地图上拿掉，属于缺口，不能算演出。
 *
 * ⚠️ 判据**故意只比坐标**，不比实体 id：两个源的怪物命名不同（原版 `blueGuard`
 *    在本项目叫 `midGuard`）。要抓「id 写错」得靠 `npm run validate` 与
 *    `verify:autoplay` 的地形体检 —— 判据之间要各管一段（铁律 #38）。
 *
 * ⚠️ 「覆盖」只说明**有一件产物落在同一格**，不说明条件对得上（谁来触发）。
 *    条件对不对由 `audit-special-doors.mjs`（有没有人开）与自动通关实测（开不开得了）守。
 *
 * 用法：
 *   node tools/audit-event-gaps.mjs            # 只列**真缺口**
 *   node tools/audit-event-gaps.mjs --all      # 连 no-op 掉的一起列（看全貌）
 *   node tools/audit-event-gaps.mjs --verbose  # 附原版 op 原文
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iterTriggers, loadDeluxe } from './dump-deluxe-events.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const showAll = process.argv.includes('--all');
const verbose = process.argv.includes('--verbose');

const deluxe = loadDeluxe();
const events = JSON.parse(fs.readFileSync(path.join(DATA, 'events.json'), 'utf8')).events ?? [];

/**
 * 地形数字编号 → 字符（`setTerrain` 用字符、`clearTerrain` 用编号，两边都要认）。
 *
 * ⚠️ `legend` 的键是**数字编号**（`legend["2"].char === 'D'`），不是字符 ——
 * 2026-09-28 实测踩过：写成 `legend['w'].passable` 永远 `undefined`，
 * 于是「假墙算不算已经能过去」这条判据**恒为 false**，第 15/19/29 层三条
 * `open` 假缺口又回来了（铁律 #16：探针 0 要报红，别静默当「不存在」）。
 * 所以这里显式建一份**按字符**的索引。
 */
const legend = JSON.parse(fs.readFileSync(path.join(DATA, 'tiles.json'), 'utf8')).legend;
const charOfNumber = (n) => legend[String(n)]?.char ?? null;
const byChar = new Map(Object.values(legend).map((t) => [t.char, t]));


// ── 本项目：楼层地形与实体（缓存）────────────────────────────────────
const floorCache = new Map();
function ourFloor(n) {
  if (!floorCache.has(n)) {
    const p = path.join(DATA, 'floors', `floor-${String(n).padStart(2, '0')}.json`);
    floorCache.set(n, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
  }
  return floorCache.get(n);
}
const ourTile = (n, x, y) => ourFloor(n)?.terrain?.[y]?.[x] ?? null;
const ourEntity = (n, x, y) => (ourFloor(n)?.entities ?? []).find((e) => e.x === x && e.y === y) ?? null;

// ── 本项目 events.json 的产物索引：`层:格` → Set(effectOp) ──────────
// 两种「开一格门」的写法都要认，漏一种就会误报：
//   · `setTerrain(floor,x,y,'.')` —— 精确开一格（F20 那两扇）；
//   · `clearTerrain(floor, terrain:N)` —— **按编号清全层**（F2 牢门 / F8、F30 机关门）。
//     它不列坐标，所以要知道 `N` 是哪个字符（查 `data/tiles.json` 的 legend），
//     再回头看本项目那一格的地形是不是这个字符。
const index = new Map();
const clearedKinds = new Map(); // `层:字符` → Set(effectOp)
for (const ev of events) {
  for (const e of ev.effects ?? []) {
    if (e.op === 'clearTerrain') {
      const ch = charOfNumber(e.terrain);
      if (ch) {
        const k = `${e.floor}:${ch}`;
        if (!clearedKinds.has(k)) clearedKinds.set(k, new Set());
        clearedKinds.get(k).add('setTerrain');
      }
      continue;
    }
    if (e.floor === undefined || e.x === undefined) continue;
    const k = `${e.floor}:${e.x},${e.y}`;
    if (!index.has(k)) index.set(k, new Set());
    index.get(k).add(e.op);
  }
}

/** 某一格有没有被事件覆盖成 `want`（含 `clearTerrain` 的间接覆盖） */
function covered(floor, tg) {
  if (index.get(`${floor}:${tg.x},${tg.y}`)?.has(tg.want)) return true;
  const here = ourTile(floor, tg.x, tg.y);
  return !!here && clearedKinds.get(`${floor}:${here}`)?.has(tg.want);
}

// ── 原版侧：解析目标格 ───────────────────────────────────────────────
/** 原版 `loc` 两种形状：单对 `[5,6]` / 多对 `[[5,7],[7,7]]`。不归一化会 `not iterable`。 */
const pairs = (loc) => (Array.isArray(loc) && typeof loc[0] === 'number' ? [loc] : loc ?? []);
const tileKind = (n) => deluxe.tiles?.[String(n)]?.kind ?? '?';
const tileName = (n) => deluxe.tiles?.[String(n)]?.name ?? `#${n}`;

/** 一个 op → 它要改的「目标格 + 期望结果」。`kind` 是**动作语义**，不是算子名。 */
function targetsOf(op) {
  const out = [];
  const t = op.t;
  if (t === 'open' || t === 'close') {
    for (const [x, y] of pairs(op.loc)) out.push({ x: x - 1, y: y - 1, kind: t, want: 'setTerrain', label: t });
  } else if (t === 'set') {
    const k = tileKind(op.n);
    const want = k === 'item' || k === 'enemy' ? 'spawn' : 'setTerrain';
    const kind = want === 'spawn' ? (k === 'enemy' ? 'set-enemy' : 'set-item') : 'set-terrain';
    for (const [x, y] of pairs(op.loc)) out.push({ x: x - 1, y: y - 1, kind, want, label: `set ${tileName(op.n)}(${k})` });
  } else if (t === 'hide') {
    for (const [x, y] of pairs(op.loc)) out.push({ x: x - 1, y: y - 1, kind: 'hide', want: 'remove', label: 'hide' });
  }
  return out;
}

/** 递归展开 `if` 与 `cutscene`，收集所有会改地图的 op（原版 48 个 `if` 里藏着门，
 *  13 个 `cutscene` 里也藏着门 —— F10 那两扇就在 `mt10ambush` 里） */
function flatten(ops, out = []) {
  for (const op of ops) {
    const t = op.t ?? op.type;
    if (t === 'if') { flatten(op.act ?? op.then ?? [], out); flatten(op.else ?? [], out); }
    else if (t === 'cutscene') flatten(op.body ?? [], out);
    else out.push(op);
  }
  return out;
}

/**
 * 这一格在本项目里**本来就已经是原版想要的样子**吗？
 *
 * 这是整套对账里最容易被漏的一层：原版写「开门」，而本项目那格早就是空地 ——
 * 少一条事件完全没影响。不滤掉的话报告里绝大多数是假缺口。
 *
 * ⚠️ 「已经是那个样子」的判据是**能不能通过**，不是**字符一不一样**（2026-09-28 修）：
 *   · `open` 到一格而那里已经是假墙 `w`（legend.passable = true）⇒ 本来就是通的，no-op。
 *     不加这条会把第 15 / 19 / 29 层的三条 `open (7,0)/(5,2)` 报成缺口 —— 而原版那一步
 *     的**真正内容**是同时 `set` 一件道具上去，我们那边早就有了。
 *   · `close` 到一格而那里已经是墙 `#` ⇒ 本来就过不去，no-op。不加这条会把第 33 / 41 / 43
 *     层那几条「把一堵墙变成机关门」报成缺口，而两者对玩家是同一件事。
 * ⇒ 判据要绑**语义**（通不通），别绑会变的中间量（地形字符）。铁律 #12。
 */
function isNoop(floor, tg) {
  const T = ourTile(floor, tg.x, tg.y);
  if (T === null) return false; // 本项目没这一层 ⇒ 不算 no-op
  const passable = byChar.get(T)?.passable === true;
  if (tg.want === 'setTerrain') {
    if (tg.kind === 'open') return passable;             // 已经能过去
    if (tg.kind === 'close') return !passable;           // 已经过不去（墙 / 星际空间 / 岩浆）
    if (tg.kind === 'set-terrain') return T !== '.';     // 已经摆了别的地形（墙 / 门 / 楼梯）
    return false;
  }
  if (tg.want === 'spawn') return ourEntity(floor, tg.x, tg.y) !== null;
  if (tg.want === 'remove') return ourEntity(floor, tg.x, tg.y) === null;
  return false;
}

// ── 跑对账 ───────────────────────────────────────────────────────────
let statTrig = 0;
let statTgt = 0;
let statNoop = 0;
let statScenery = 0;
let statHit = 0;
let statMiss = 0;
const rows = [];

for (const [fid, f] of Object.entries(deluxe.floors ?? {})) {
  const floor = Number(fid);
  if (floor === 0) continue; // F0 是开场（本项目的 intro 属于另一套，不在塔内）
  for (const trig of iterTriggers(f, deluxe)) {
    if (trig.kind === 'talk') continue; // NPC 搭话走 data/npcs.json，不在本对账范围
    const ops = flatten(trig.ops);
    const raw = ops.flatMap(targetsOf);
    if (raw.length === 0) continue;
    statTrig++;

    // ④ 同一段里「set 出来的实体又被**后来的** hide 掉」= 演出（见文件头）
    //    ⚠️ 必须按**先后顺序**算，不能只看「这段里有没有 hide 这一格」：
    //    `mt49win` 是 **先 `hide` 掉 3×3 的九宫格、再 `set` 红钥匙/小刀进去** ——
    //    只看集合会把这两件**真的留在场上**的奖励误判成演出（第一版就是这么错的）。
    const alive = new Set();
    for (const op of ops) {
      if (op.t === 'set') {
        const k = tileKind(op.n);
        if (k === 'item' || k === 'enemy') for (const [x, y] of pairs(op.loc)) alive.add(`${x - 1},${y - 1}`);
      } else if (op.t === 'hide') {
        for (const [x, y] of pairs(op.loc)) alive.delete(`${x - 1},${y - 1}`);
      }
    }

    const noop = [];
    const scenery = [];
    const real = [];
    for (const tg of raw) {
      if (tg.want === 'spawn' && !alive.has(`${tg.x},${tg.y}`)) scenery.push(tg);
      else (isNoop(floor, tg) ? noop : real).push(tg);
    }
    statTgt += raw.length;
    statNoop += noop.length;
    statScenery += scenery.length;

    const miss = real.filter((tg) => !covered(floor, tg));
    statHit += real.length - miss.length;
    statMiss += miss.length;

    if (miss.length) rows.push({ floor, f, kind: trig.kind, key: trig.key, cond: trig.cond, once: trig.once, raw, noop, scenery, real, miss, ops });
  }
}

const whoOf = (r) => {
  if (r.kind !== 'after') return '';
  const [x, y] = String(r.key).split(',').map(Number);
  const id = r.f.map?.[y]?.[x];
  // 原版把**怪也当图块**（`tiles[245]` = redKing，`kind: 'enemy'`），所以 `map[y][x]`
  // 读出来的可能是怪、也可能是地形（第 49 层的 `after` 键就落在一格 `whiteWall2` 上）。
  // 不分这两种会把地形说成「打死这一格上的怪」，读者会去找一只不存在的怪。
  const tile = deluxe.tiles?.[String(id)];
  const what = tile ? `${tile.name}（kind=${tile.kind}）` : '?';
  const ours = ourEntity(r.floor, x - 1, y - 1);
  return `  ← 原版这一格的图块 #${id} = ${what}；本项目 ${ours ? `${ours.type}:${ours.id}` : '（空）'}`;
};

/** 目标格在本项目里现在是什么（`[#]`＝墙、`[a]`＝机关门、`[.]`＝空地）
 *  ⚠️ 触发键是**原版 1 基**，目标格已经换成**本项目 0 基** —— 同一行里两套坐标，
 *  所以两边都显式标出来（踩过一次「按原版坐标去本项目地图上找那一格」）。 */
const atOf = (r, t) => `@(本项目 ${t.x},${t.y})[${ourTile(r.floor, t.x, t.y) ?? '?'}]`;

console.log(`原版会改地图的触发 ${statTrig} 个，目标格 ${statTgt} 个：`);
console.log(`  · ${statNoop} 格本来就对上（no-op，本项目那格早就是原版想要的样子）`);
console.log(`  · ${statScenery} 格是**演出**（同一段里 set 完又 hide，地图上不留痕迹）`);
console.log(`  · ${statHit} 格已由 data/events.json 覆盖（含 clearTerrain 按编号清全层）`);
console.log(`  · ${statMiss} 格是**真缺口**（分布在 ${rows.length} 个触发里）`);
console.log('');
if (statMiss === 0) console.log('✅ 没有真缺口');
else console.log('=== 真缺口 ===');
for (const r of rows) {
  console.log(`— F${r.floor} · ${r.kind}@原版(${r.key})${whoOf(r)}${r.once ? ` once=${r.once}` : ''}`);
  if (r.kind === 'auto') console.log(`    条件 ${JSON.stringify(r.cond).slice(0, 220)}`);
  console.log(`    缺：  ${r.miss.map((t) => `${t.want}${atOf(r, t)} [${t.label}]`).join('  ')}`);
  if (showAll && r.scenery.length) console.log(`    (演出：${r.scenery.map((t) => `${t.label}@(${t.x},${t.y})`).join(' ')}）`);
  if (showAll && r.noop.length) console.log(`    (no-op：${r.noop.map((t) => `${t.want}@(${t.x},${t.y})`).join(' ')}）`);
  if (verbose) for (const op of r.ops) console.log(`      op ${JSON.stringify(op).slice(0, 220)}`);
}
