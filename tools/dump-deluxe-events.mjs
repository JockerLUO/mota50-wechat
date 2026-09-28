/**
 * 把 `reference/mota50-deluxe/source/mota-data.js`（h5mota 官方原版复刻数据）
 * 里的**全部剧情触发点**倒出来 —— 只读，不写任何文件。
 *
 * 为什么要有它：`data/events.json` 是本项目的事件表，而「本项目少搬了哪些事件」
 * 这件事**只能对着原版数据数**。凭印象补必然漏（铁律 #23）。
 *
 * ## 五类触发源（2026-09-28 第十轮补齐）
 *
 * 第一版只读了 `floors[N].step`，于是审计两次都没看见 `after` —— 而**原版所有的
 * 「打死这一格的怪才开的门」全在 `after` 里**（44 条，含第 20 层吸血鬼那场）。
 * 一张只覆盖 1/5 触发源的审计表就是「失效的地图」（铁律 #27），所以现在五类都读：
 *
 * | 键 | 触发时机 | 形状 | 条数 |
 * |---|---|---|---|
 * | `step`  | 走到某格 | `{"x,y": [op…]}`（`sticky` 表示可重复踩） | 73 |
 * | `talk`  | 撞某格上的 NPC | `{"x,y": [op…]}`（`t:'oldman'/'trader'/'shop'`） | 13 |
 * | `after` | **打死那一格的怪之后** | `{"x,y": [op…]}` | 44 |
 * | `auto`  | 条件式（`dead`/`alive` 按格） | `[{cond, act, once}]` | 4 |
 * | `first` | 首次进入本层 | `[op…]` | 1 |
 *
 * ⚠️ `after` 的键就是**怪自己那一格**，要拿 `f.map[y][x]` 反查是谁（见 `monsterAt`）。
 * ⚠️ 原版坐标是 **1-based**，本项目是 **0-based**（转写时统一 `-1`，见 known-gaps §2）。
 * ⚠️ 原版的地形/怪物用**数字 id**（`set n:206`），要查 `data.tiles` / `data.monsters` 才知道是谁。
 *
 * 用法：
 *   node tools/dump-deluxe-events.mjs              # 汇总：每层每个触发格、各自调什么
 *   node tools/dump-deluxe-events.mjs --all        # 逐条展开（含 cutscene 的每一步）
 *   node tools/dump-deluxe-events.mjs --floor 20   # 只看某层（原版坐标，1-based）
 *   node tools/dump-deluxe-events.mjs --cut mt20win
 *   node tools/dump-deluxe-events.mjs --ops        # 只列出现过的算子（决定引擎要支持什么）
 *   node tools/dump-deluxe-events.mjs --impact     # 只列**有玩法后果**的触发（门 / 地形 / 怪）
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'reference/mota50-deluxe/source/mota-data.js');

export function loadDeluxe() {
  const src = fs.readFileSync(DATA_FILE, 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: DATA_FILE });
  return sandbox.window.MOTA_DATA;
}

/** 操作/动作的名字 —— 原版数据统一用短键 `t`（`{t:'set', ...}`） */
function opName(op) {
  if (!op || typeof op !== 'object') return String(op);
  return op.t ?? op.type ?? op.op ?? op.act ?? Object.keys(op)[0];
}

/** 把一个 op 里除 `t` 以外的字段紧凑打印 */
function opRest(op) {
  const rest = { ...op };
  delete rest.t;
  const s = JSON.stringify(rest);
  return s === '{}' ? '' : s.slice(1, -1);
}

/** 一步触发（`{acts:[...], sticky:bool}`）展开了是什么 */
function actsOf(step) {
  if (Array.isArray(step)) return step;
  return step?.acts ?? [];
}

/** 统一展开：数组原样，`{acts}` 取 acts，别的当空 */
const asOps = (v) => (Array.isArray(v) ? v : actsOf(v));

/**
 * 把 `cutscene` 就地展开成 `{t:'cutscene', id, body:[…]}`。
 *
 * **必须展开**：原版 13 个 cutscene 里藏着门 —— 第 10 层**两扇机关门全在
 * `mt10ambush` 里**、第 20 层那扇在 `mt20win` 里。不展开的审计表只能看见
 * `{t:'cutscene', id:'mt10ambush'}`，看不见后面 `open` 了什么 —— 那就是
 * 「失效的地图」（铁律 #27）。
 *
 * 2026-09-28 实测（第三次「只覆盖了一部分触发源」）：`audit-event-gaps` 报
 * F10 (3,3)/(7,3) 两扇门「原版没有任何触发会开」，而原版写得明明白白
 * `floors[10].step["6,5"] → cutscene mt10ambush → open(4,4)(8,4)(5,6)(7,6)`。
 * 与第一版漏掉 `after` 是同一族病：**读触发源要读全，包括间接那一层**。
 */
export function expandCutscenes(ops, data) {
  if (!data) return ops;
  return ops.map((op) => {
    if (opName(op) !== 'cutscene') return op;
    return { ...op, body: data.cutscenes?.[op.id] ?? [] };
  });
}

/**
 * 一层的**全部触发源**，统一成 `{kind, key, ops, cond?, once?, sticky?}`。
 *
 * 这是「五类都读到」的唯一实现 —— 别再各自写一遍 `Object.entries(f.step)`，
 * 那正是第一版漏掉 `after` 的原因（铁律 #23：名单写死在多处必漏）。
 *
 * 传 `data` 时顺带展开 cutscene（见 `expandCutscenes`）；不传则保持纯五类读取，
 * 供算子普查用（普查另有一遍 `Object.values(cuts)`，展开会重复计数）。
 */
export function iterTriggers(floor, data) {
  const out = [];
  const add = (kind, key, ops, extra) => out.push({ kind, key, ops: expandCutscenes(ops, data), ...extra });
  for (const [key, v] of Object.entries(floor.step ?? {})) add('step', key, asOps(v), { sticky: !!v?.sticky });
  for (const [key, v] of Object.entries(floor.talk ?? {})) add('talk', key, asOps(v));
  for (const [key, v] of Object.entries(floor.after ?? {})) add('after', key, asOps(v));
  for (const v of floor.auto ?? []) add('auto', '-', v.act ?? [], { cond: v.cond, once: v.once });
  for (const v of floor.first ?? []) if (v) add('first', '-', asOps(v));
  return out;
}

/** 原版 `"x,y"`（1-based）→ 本项目 `(x-1, y-1)`。**全项目唯一的换算点。** */
function toProject(loc) {
  const [x, y] = String(loc).split(',').map(Number);
  return { x: x - 1, y: y - 1 };
}

/** 原版 `f.map[y][x]` 反查某一格上是哪个数字 id（loc 是 1-based，直接用） */
function tileIdAt(floor, loc) {
  const [x, y] = String(loc).split(',').map(Number);
  return floor.map?.[y]?.[x];
}

/** 数字 id → 名字（先查 tiles 再查 monsters） */
function nameOfId(n, data) {
  const t = data.tiles?.[String(n)];
  if (t) return t.name ?? t.id ?? `tile#${n}`;
  const m = data.monsters?.[String(n)] ?? data.monsters?.[n];
  if (m) return m.name ?? `monster#${n}`;
  return `#${n}`;
}

/** `after` 那一格上站的是谁（原版语义：打死它才触发） */
function monsterAt(floor, loc, data) {
  return nameOfId(tileIdAt(floor, loc), data);
}

function summarizeAct(act, data) {
  const n = opName(act);
  if (n === 'cutscene') return `cutscene(${act.id})`;
  if (n === 'text') return `text(${String(act.who ?? '')}：${String(act.text ?? '').replace(/\n/g, ' ').slice(0, 40)})`;
  if (n === 'if') return `if(${JSON.stringify(act.cond).slice(0, 50)})`;
  if (n === 'shop') return `shop(${act.id})`;
  if (n === 'choice') return `choice(${(act.options ?? []).length} 项)`;
  if (n === 'set') return `set(${describeTile(act.n, data)} @${JSON.stringify(act.loc)})`;
  if (n === 'open') return `open(@${JSON.stringify(act.loc)})`;
  if (n === 'close') return `close(@${JSON.stringify(act.loc)})`;
  if (n === 'hide') return `hide(@${JSON.stringify(act.loc)})`;
  return `${n}(${opRest(act).slice(0, 50)})`;
}

function describeTile(n, data) {
  const t = data.tiles?.[String(n)];
  if (!t) return `#${n}`;
  return `${t.name ?? t.id ?? '?'}#${n}`;
}

/**
 * 这条触发**有没有玩法后果**。
 *
 * 判据 = 它的 ops 里有「改变可通行 / 改变地图内容 / 直接开战 / 换层」的算子。
 * 纯 `text` / `sfx` / `sleep` / `tip` 只是演出，不影响能不能走下去 ——
 * `--impact` 用它筛出「必须转写」的那一批（铁律 #38：筛集合的判据要能说出为什么）。
 */
const IMPACT_OPS = new Set(['open', 'close', 'set', 'hide', 'monsterOverride', 'battle', 'goto', 'setHero', 'win']);
function hasImpact(ops) {
  for (const a of ops) {
    const n = opName(a);
    if (IMPACT_OPS.has(n)) return true;
    if (n === 'if') {
      if (hasImpact(a.act ?? a.then ?? [])) return true;
      if (hasImpact(a.else ?? [])) return true;
    }
    // `cutscene` 展开出来的 `body` 也要看 —— 第 10 层两扇门就在里面（见 expandCutscenes）
    if (n === 'cutscene' && hasImpact(a.body ?? [])) return true;
  }
  return false;
}

/** 条件式 `auto` 的可读化：`dead`/`alive` 的格子在项目坐标下也标出来 */
function condText(cond) {
  if (!cond) return '';
  const parts = [];
  const walk = (c) => {
    if (!c) return;
    if (c.k === 'and' || c.k === 'or') { for (const o of c.of ?? []) walk(o); return; }
    if (c.k === 'not') { walk(c.of); return; }
    if (c.k === 'dead' || c.k === 'alive') {
      const cells = (c.locs ?? []).map(([x, y]) => `${x},${y}→(${x - 1},${y - 1})`);
      parts.push(`${c.k}[${cells.join(' ')}]`);
      return;
    }
    if (c.k === 'flag') { parts.push(`flag(${c.name}==${c.v})`); return; }
    parts.push(JSON.stringify(c));
  };
  walk(cond);
  return parts.join(' + ');
}

function main() {
  const argv = process.argv.slice(2);
  const data = loadDeluxe();
  const all = argv.includes('--all');
  const onlyOps = argv.includes('--ops');
  const onlyImpact = argv.includes('--impact');
  const fi = argv.indexOf('--floor');
  const onlyFloor = fi >= 0 ? Number(argv[fi + 1]) : null;
  const ci = argv.indexOf('--cut');
  const onlyCut = ci >= 0 ? argv[ci + 1] : null;

  const floors = data.floors ?? {};
  const cuts = data.cutscenes ?? {};

  // ── 算子普查（决定引擎要支持哪些 `t`）──────────────────────────────
  // ⚠️ 必须走 `iterTriggers`（五类），只数 `f.step` 会漏掉 `after` 里的 open/set ——
  //    而「引擎要不要支持 set / hide」正是靠这个普查决定的。
  const opTypes = new Map();
  const bump = (n) => opTypes.set(n, (opTypes.get(n) ?? 0) + 1);
  const bumpOps = (ops) => {
    for (const a of ops) {
      bump(opName(a));
      if (opName(a) === 'if') { bumpOps(a.act ?? a.then ?? []); bumpOps(a.else ?? []); }
    }
  };
  for (const c of Object.values(cuts)) for (const op of c) bump(opName(op));
  for (const f of Object.values(floors)) for (const t of iterTriggers(f)) bumpOps(t.ops);

  if (onlyOps) {
    console.log('=== 全部算子（cutscene + 五类层触发，按次数）===');
    for (const [n, c] of [...opTypes.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}: ${c}`);
    return;
  }

  // ── 层触发点（五类）────────────────────────────────────────────────
  const rows = [];
  for (const [fid, f] of Object.entries(floors)) {
    for (const t of iterTriggers(f)) rows.push({ fid: Number(fid), ...t });
  }
  rows.sort((a, b) => a.fid - b.fid || a.kind.localeCompare(b.kind) || String(a.key).localeCompare(String(b.key)));

  if (onlyFloor === null && !all && !onlyImpact) {
    console.log(`原版数据：${Object.keys(floors).length} 层，${Object.keys(cuts).length} 个 cutscene，${rows.length} 个触发点`);
    console.log('');
    let cur = null;
    for (const r of rows) {
      if (r.fid !== cur) { cur = r.fid; console.log(`F${String(cur).padStart(2)}`); }
      const who = r.kind === 'after' ? ` 打死 ${monsterAt(floors[String(r.fid)], r.key, data)}` : '';
      const sum = r.ops.map((a) => summarizeAct(a, data)).join(' → ');
      const tail = r.kind === 'auto' ? `  [条件 ${condText(r.cond)}${r.once ? ` · once=${r.once}` : ''}]` : '';
      console.log(`   ${r.kind.padEnd(5)} @${r.key}${who}${r.sticky ? ' [常驻]' : ''}  ${sum}${tail}`);
    }
    console.log('');
    console.log('=== 算子（按次数）===');
    for (const [n, c] of [...opTypes.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}: ${c}`);
    return;
  }

  // ── `--impact`：只列有玩法后果的 ────────────────────────────────────
  if (onlyImpact) {
    const hit = rows.filter((r) => hasImpact(r.ops));
    console.log(`=== 有玩法后果的触发（${hit.length} / ${rows.length}）—— 门 / 地形 / 怪 / 换层 ===`);
    console.log('');
    let cur = null;
    for (const r of hit) {
      if (r.fid !== cur) { cur = r.fid; console.log(`F${String(cur).padStart(2)}`); }
      const who = r.kind === 'after' ? ` 打死 ${monsterAt(floors[String(r.fid)], r.key, data)}` : '';
      const pj = r.key !== '-' ? ` → 项目 (${toProject(r.key).x},${toProject(r.key).y})` : '';
      const sum = r.ops.map((a) => summarizeAct(a, data)).join(' → ');
      const tail = r.kind === 'auto' ? `  [条件 ${condText(r.cond)}${r.once ? ` · once=${r.once}` : ''}]` : '';
      console.log(`   ${r.kind.padEnd(5)} @${r.key}${pj}${who}  ${sum}${tail}`);
    }
    return;
  }

  // ── 单层 ────────────────────────────────────────────────────────────
  if (onlyFloor !== null) {
    const f = floors[String(onlyFloor)];
    if (!f) { console.log(`没有第 ${onlyFloor} 层`); return; }
    console.log(`=== 第 ${onlyFloor} 层（原版 1-based）全部触发点 ===`);
    for (const t of iterTriggers(f)) {
      const who = t.kind === 'after' ? `  ← 打死 ${monsterAt(f, t.key, data)}` : '';
      const cond = t.kind === 'auto' ? `  条件 ${condText(t.cond)}${t.once ? ` once=${t.once}` : ''}` : '';
      console.log(`  ${t.kind.padEnd(5)} @${t.key}${who}${t.sticky ? ' [常驻]' : ''}${cond}`);
      for (const a of t.ops) {
        const n = opName(a);
        console.log(`      ${n} ${opRest(a).slice(0, 160)}`);
        if (n === 'cutscene' && cuts[a.id]) {
          for (const op of cuts[a.id]) console.log(`        ↓ ${opName(op)} ${opRest(op).slice(0, 140)}`);
        }
      }
    }
  }

  if (onlyCut) {
    console.log(`=== cutscene ${onlyCut} ===`);
    for (const op of cuts[onlyCut] ?? []) console.log(`  ${opName(op)} ${opRest(op).slice(0, 200)}`);
  }

  if (all) {
    console.log(`\n=== 全部 cutscene（${Object.keys(cuts).length} 个）===`);
    for (const [cid, ops] of Object.entries(cuts)) {
      console.log(`\n--- ${cid}（${ops.length} 步）---`);
      for (const op of ops) console.log(`  ${opName(op)} ${opRest(op).slice(0, 200)}`);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
