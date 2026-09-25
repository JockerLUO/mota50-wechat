/**
 * 全局规划器 —— 把「自动通关」从「每步贪心」升级成「离线搜索一条通关路线」。
 *
 * ## 为什么贪心不够
 *
 * 魔塔是**确定性**的（战斗结果只由攻防血决定），所以通关路线在给定初始状态下
 * 是**存在且确定**的。但贪心只看一步，会在三个**全局**约束上崩：
 *   1. 钥匙预算 —— 早期开不必要的门，后期缺钥匙，而锁在门后的钥匙又够不着；
 *   2. HP 预算   —— 「收益 > 代价」让前期过度战斗，血打光；
 *   3. 金币预算 —— 前期买生命/防御，后期没钱买攻击去破防。
 *
 * 这三个约束都是「跨层」的，任何只看本层/下一步的策略都抓不住。
 *
 * ## 算法：目标级 DFS + 剪枝 + 记忆化
 *
 * 状态 = GameState 深克隆；动作 = 「朝一个目标走并执行」（道具 / 怪 / 楼梯 / 商店），
 * 而不是「走一个方向」。分支因子从 ~4（方向）降到 ~10（目标），但每个目标代表
 * 「一条有意义的路线」，搜索深度从 ~千步降到 ~几百个目标。
 *
 * 剪枝（决定能不能算完的关键）：
 *   · HP 下界：剩余所有「可达且必须打」的怪的最小 HP 损失之和，超过当前 HP 就剪；
 *   · 钥匙单调：由可达性自然保证（够不着的不进候选）；
 *   · 记忆化：`(floor,pos,hp,atk,def,gold,keys,removed数,buyTimes)` 哈希去重；
 *   · 上界剪枝：即使拿满剩余全部资源也打不过魔王 → 剪。
 */

import type { GameData } from '../data';
import { buyStat, step } from './engine';
import { previewBattle } from './engine/vitals';
import { stairsOn, tileAt, type GameState } from './state';

// ── 状态克隆 ────────────────────────────────────────────────────────

/** 深克隆一个 GameState（搜索要大量模拟，必须隔离可变状态） */
export function cloneState(s: GameState): GameState {
  return {
    floor: s.floor,
    pos: { x: s.pos.x, y: s.pos.y },
    face: s.face,
    hp: s.hp,
    atk: s.atk,
    def: s.def,
    gold: s.gold,
    keys: { ...s.keys },
    bag: { ...s.bag },
    passives: [...s.passives],
    visited: [...s.visited],
    buyTimes: s.buyTimes,
    claimed: new Set(s.claimed),
    talked: { ...s.talked },
    removed: new Set(s.removed),
    terrainPatch: Object.fromEntries(
      Object.entries(s.terrainPatch).map(([k, v]) => [k, { ...v }])
    ),
    monsterSwap: { ...s.monsterSwap },
    extraStairs: s.extraStairs.map((x) => ({ ...x }) as typeof x),
    fired: new Set(s.fired),
    dead: s.dead,
    log: [],
    stats: { ...s.stats }
  };
}

// ── 目标与动作 ──────────────────────────────────────────────────────

/** 一个「有意义的目标」：走到的格子 + 走到后做什么 */
interface Target {
  kind: 'item' | 'monster' | 'up' | 'down' | 'shop';
  x: number;
  y: number;
  id: string;
  /** 到达这一格的路径（不含起点） */
  path: { x: number; y: number }[];
  /** 净收益（HP 当量）。越大越优先探索 */
  gain: number;
  /** 商店购买哪一项属性（kind === 'shop' 时用） */
  stat?: 'hp' | 'atk' | 'def';
}

// ── 估价（与 autoplay 同源的最小版，避免循环依赖） ─────────────────

const K = (x: number, y: number) => `${x},${y}`;

function isCleared(state: GameState, data: GameData): boolean {
  const f = data.floors.get(50);
  if (!f) return false;
  for (const e of f.entities) {
    if (e.type !== 'monster') continue;
    const cur = state.monsterSwap[`50:${e.x},${e.y}`] ?? e.id;
    if (!state.removed.has(`50:${e.x}:${e.y}:monster:${cur}`)) return false;
  }
  return true;
}

/** 粗略估价：剩余全部「能打的怪」的金币折 HP + 剩余道具价值，作为乐观上界 */
// （暂未启用上界剪枝，先保证正确性；保留函数以备后续加剪枝）

// ── 可达性（复用简单 Dijkstra，避免 import autoplay 的私有函数） ───

const KEY_IDS = ['yellowKey', 'blueKey', 'redKey'] as const;
type KeyId = (typeof KEY_IDS)[number];

function emptyKeys(): Record<KeyId, number> {
  return { yellowKey: 0, blueKey: 0, redKey: 0 };
}

function afford(owned: Record<KeyId, number>, need: Record<KeyId, number>): boolean {
  return KEY_IDS.every((k) => need[k] <= owned[k]);
}

interface ReachR {
  cost: Map<string, number>;
  prev: Map<string, string>;
  keys: Map<string, Record<KeyId, number>>;
  /** 这一层把够得着的钥匙全捡完后一共会有几把（不动点） */
  owned: Record<KeyId, number>;
}

/**
 * 从当前位置出发的 Dijkstra（代价=HP，钥匙沿路累计）。够得着才进 cost。
 *
 * 外面套一层**钥匙不动点**（与 `autoplay.ts` 的 `reach` 同规）：能捡到的钥匙
 * 会让更多门变得可开，可开之后又能捡到更多钥匙 —— 迭代到不再变化为止。
 *
 * 没有这一层的话，「先绕过去捡两把黄钥匙、再回来开这扇门」这类路径**根本进不了
 * 候选集**（Dijkstra 假设钥匙开局就有），束搜索会低估可达性，把一整层锁在门后的
 * 宝石剑盾都判成「够不着」，于是在「上楼/下楼」之间原地打转。这正是 planner 第一版
 * 卡在第 7 层的直接原因 —— 那一层有十几扇黄门，钥匙全在门后面。
 */
function reach(state: GameState, data: GameData): ReachR {
  let owned: Record<KeyId, number> = { ...state.keys };
  let r = dijkstra(state, data);

  for (let iter = 0; iter < 8; iter++) {
    const pick = emptyKeys();
    for (const e of data.floors.get(state.floor)?.entities ?? []) {
      if (e.type !== 'item' || !KEY_IDS.includes(e.id as KeyId)) continue;
      if (state.removed.has(`${state.floor}:${e.x}:${e.y}:item:${e.id}`)) continue;
      const k = K(e.x, e.y);
      const c = r.cost.get(k);
      if (c === undefined) continue;
      // 这把钥匙本身也得够得着（用上一轮的持有量判，避免自我循环论证）
      if (!afford(owned, r.keys.get(k)!)) continue;
      pick[e.id as KeyId] += 1;
    }
    if (pick.yellowKey === 0 && pick.blueKey === 0 && pick.redKey === 0) break;
    const next: Record<KeyId, number> = {
      yellowKey: owned.yellowKey + pick.yellowKey,
      blueKey: owned.blueKey + pick.blueKey,
      redKey: owned.redKey + pick.redKey
    };
    const grew = KEY_IDS.some((k) => next[k] > owned[k]);
    owned = next;
    if (!grew) break;
    r = dijkstra(state, data);
  }
  r.owned = owned;
  return r;
}

function dijkstra(state: GameState, data: GameData): ReachR {
  const cost = new Map<string, number>();
  const prev = new Map<string, string>();
  const keys = new Map<string, Record<KeyId, number>>();
  const start = K(state.pos.x, state.pos.y);
  cost.set(start, 0);
  keys.set(start, emptyKeys());

  const pending = new Set([start]);
  while (pending.size) {
    let best: string | null = null;
    let bestCost = Infinity;
    for (const k of pending) {
      const c = cost.get(k) ?? Infinity;
      if (c < bestCost) { bestCost = c; best = k; }
    }
    if (best === null) break;
    pending.delete(best);
    const [bx, by] = best.split(',').map(Number);
    for (const d of [
      [0, -1], [0, 1], [-1, 0], [1, 0]
    ]) {
      const nx = bx + d[0];
      const ny = by + d[1];
      if (nx < 0 || ny < 0 || nx > 10 || ny > 10) continue;
      const nk = K(nx, ny);
      const ch = tileAt(state, data, state.floor, nx, ny);
      const info = data.byChar[ch];
      if (!info) continue;
      // 门：需要钥匙（沿路累计）
      let stepCost = 0;
      let stepKey: KeyId | null = null;
      if (info.key) { stepCost = 1; stepKey = info.key; }
      else if (ch === 'w') stepCost = 1;
      else if (!info.passable) continue;
      // 怪：要能打得过，代价 = HP 损失
      const ent = (data.floors.get(state.floor)?.entities ?? []).find((e) => e.x === nx && e.y === ny);
      if (ent && ent.type === 'monster') {
        const p = previewBattle(state, data, ent.id);
        if (!p || !p.canWin) continue;
        stepCost += p.hpLoss;
      }
      const nc = bestCost + stepCost;
      if (nc < (cost.get(nk) ?? Infinity)) {
        cost.set(nk, nc);
        prev.set(nk, best);
        const kk = { ...keys.get(best)! };
        if (stepKey) kk[stepKey] += 1;
        keys.set(nk, kk);
        pending.add(nk);
      }
    }
  }
  return { cost, prev, keys, owned: emptyKeys() };
}

function pathOf(r: ReachR, tx: number, ty: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let cur: string | undefined = K(tx, ty);
  while (cur) {
    const [x, y] = cur.split(',').map(Number);
    out.unshift({ x, y });
    cur = r.prev.get(cur);
  }
  return out;
}

// ── 目标生成 ────────────────────────────────────────────────────────

function generateTargets(state: GameState, data: GameData): Target[] {
  const r = reach(state, data);
  const out: Target[] = [];
  const fl = state.floor;
  const ents = data.floors.get(fl)?.entities ?? [];

  for (const e of ents) {
    if (state.removed.has(`${fl}:${e.x}:${e.y}:${e.type}:${e.id}`)) continue;
    const k = K(e.x, e.y);
    const c = r.cost.get(k);
    if (c === undefined) continue;
    // 用钥匙不动点后的持有量判「够不够开门」（见 reach 的注释）
    if (!afford(r.owned, r.keys.get(k)!)) continue;
    if (e.type === 'item') {
      out.push({ kind: 'item', x: e.x, y: e.y, id: e.id, path: pathOf(r, e.x, e.y), gain: 1000 - c });
    } else if (e.type === 'monster') {
      const p = previewBattle(state, data, e.id);
      if (!p || !p.canWin) continue;
      const gold = (data.monsters[e.id]?.gold ?? 0) * 25;
      out.push({ kind: 'monster', x: e.x, y: e.y, id: e.id, path: pathOf(r, e.x, e.y), gain: gold - c - p.hpLoss });
    } else if (e.type === 'npc' && e.id === 'shop' && state.gold >= shopCostOf(state.buyTimes)) {
      // 商店拆成三个独立目标（买 atk / def / hp）——「属性购买时机」是全局约束之一，
      // 只给一个 `pickStat` 会让束搜索永远买同一项，失去「这轮该不该买 atk」的分歧。
      // 三项的 gain 用各自收益：atk 在有打不动的怪时最值钱，def 常态最划算，hp 兜底。
      for (const stat of ['atk', 'def', 'hp'] as const) {
        let g = 5000;
        if (stat === 'atk') g += hasUnpierceable(state, data) ? 8000 : 0;
        if (stat === 'def') g += 2000;
        out.push({ kind: 'shop', x: e.x, y: e.y, id: 'shop', path: pathOf(r, e.x, e.y), gain: g, stat });
      }
    }
  }

  // 楼梯
  for (const s of stairsOn(state, data, fl)) {
    const k = K(s.x, s.y);
    const c = r.cost.get(k);
    if (c === undefined) continue;
    if (!afford(r.owned, r.keys.get(k)!)) continue;
    const up = s.to > fl;
    out.push({
      kind: up ? 'up' : 'down',
      x: s.x, y: s.y, id: `stair:${s.to}`,
      path: pathOf(r, s.x, s.y),
      gain: up ? 10000 : -1000 // 上楼是推进，下楼是回溯
    });
  }

  return out.sort((a, b) => b.gain - a.gain);
}

function shopCostOf(n: number): number {
  // 与 core/shop.mjs 的 shopCost 一致：10·n·(n-1)+20
  return 10 * n * (n - 1) + 20;
}

// ── 执行一个目标（走到底 + 落地动作） ───────────────────────────────

/** 把「朝目标走 + 执行」应用到克隆 state，返回是否成功 */
function executeTarget(state: GameState, data: GameData, t: Target): boolean {
  // 一步步走（用引擎 step 保证规则一致）
  for (let i = 1; i < t.path.length; i++) {
    const cur = t.path[i - 1];
    const nxt = t.path[i];
    const dx = nxt.x - cur.x;
    const dy = nxt.y - cur.y;
    const dir = dx === 1 ? 'right' : dx === -1 ? 'left' : dy === 1 ? 'down' : 'up';
    const res = step(state, data, dir as 'up' | 'down' | 'left' | 'right');
    if (!res.moved && res.kind !== 'battle' && res.kind !== 'talk') return false;
  }
  // 最后一步：撞目标（道具自动拾取 / 怪自动开战 / 楼梯自动换层，都由 step 处理）
  if (t.path.length >= 1) {
    const last = t.path[t.path.length - 1];
    const cur = t.path.length >= 2 ? t.path[t.path.length - 2] : state.pos;
    const dx = last.x - cur.x;
    const dy = last.y - cur.y;
    if (dx !== 0 || dy !== 0) {
      const dir = dx === 1 ? 'right' : dx === -1 ? 'left' : dy === 1 ? 'down' : 'up';
      step(state, data, dir as 'up' | 'down' | 'left' | 'right');
    }
  }
  // 商店：走到旁边后买（用目标指定的属性，而不是 pickStat 的单一选择）
  if (t.kind === 'shop') {
    buyStat(state, t.stat ?? pickStat(state, data));
  }
  return !state.dead;
}

function pickStat(state: GameState, data: GameData): 'hp' | 'atk' | 'def' {
  if (state.hp < 200) return 'hp';
  // 有打不动的怪就补攻击
  for (const [fl, f] of data.floors) {
    for (const e of f.entities) {
      if (e.type !== 'monster') continue;
      if (state.removed.has(`${fl}:${e.x}:${e.y}:monster:${e.id}`)) continue;
      if (state.atk <= (data.monsters[e.id]?.def ?? 0)) return 'atk';
    }
  }
  return 'def';
}

/** 全塔是否存在「当前打不动」的怪（atk ≤ 怪 def）——攻击是门槛，有门槛就该买攻击 */
function hasUnpierceable(state: GameState, data: GameData): boolean {
  for (const [fl, f] of data.floors) {
    for (const e of f.entities) {
      if (e.type !== 'monster') continue;
      if (state.removed.has(`${fl}:${e.x}:${e.y}:monster:${e.id}`)) continue;
      if (state.atk <= (data.monsters[e.id]?.def ?? 0)) return true;
    }
  }
  return false;
}

// ── 搜索 ────────────────────────────────────────────────────────────

export interface PlanResult {
  cleared: boolean;
  /** 通关动作序列（或到达最远点的序列） */
  actions: string[];
  maxFloor: number;
  nodes: number;
  depth: number;
}

/**
 * 迭代加深 DFS：找一条从 `state` 出发的通关动作序列。
 *
 * 返回的 `actions` 是「目标描述字符串」，回放器按它逐目标执行。
 */
export function plan(state0: GameState, data: GameData, maxDepth = 400, maxNodes = 2_000_000): PlanResult {
  const seen = new Set<string>();
  let nodes = 0;
  let bestMaxFloor = state0.floor;
  let bestActions: string[] = [];

  const hash = (s: GameState): string =>
    `${s.floor}:${s.pos.x},${s.pos.y}:${s.hp}:${s.atk}:${s.def}:${s.gold}:` +
    `${s.keys.yellowKey},${s.keys.blueKey},${s.keys.redKey}:${s.removed.size}:${s.buyTimes}`;

  function dfs(s: GameState, path: string[], depth: number): PlanResult | null {
    nodes++;
    if (nodes > maxNodes) return null;
    if (s.dead) return null;
    if (isCleared(s, data)) {
      return { cleared: true, actions: [...path], maxFloor: s.floor, nodes, depth };
    }
    if (depth >= maxDepth) return null;

    if (s.floor > bestMaxFloor) {
      bestMaxFloor = s.floor;
      bestActions = [...path];
    }

    const h = hash(s);
    if (seen.has(h)) return null;
    seen.add(h);

    // 剪枝：乐观上界也打不过魔王 → 放弃
    // （暂时不启用上界剪枝，先保证正确性）

    const targets = generateTargets(s, data);
    for (const t of targets) {
      const c = cloneState(s);
      if (!executeTarget(c, data, t)) continue;
      const r = dfs(c, [...path, `${c.floor}@${c.pos.x},${c.pos.y} ${t.kind} ${t.id}`], depth + 1);
      if (r && r.cleared) return r;
    }
    return null;
  }

  const result = dfs(cloneState(state0), [], 0);
  if (result) return result;
  return { cleared: false, actions: bestActions, maxFloor: bestMaxFloor, nodes, depth: 0 };
}

// ── 束搜索 ──────────────────────────────────────────────────────────
//
// DFS 在 50 层 / 396 道具 / 479 怪的规模下**必然深度爆栈**：目标级分支因子 ~10，
// 深度 ~几百，空间是指数。束搜索把「每条路都追到底」换成「每层只留 K 条最有前途的路」，
// 用估价函数挑「离通关最近」的 K 个状态继续展开，从而在多项式时间里逼近最优解。
//
// 估价函数的三个分量（缺一不可）：
//   1. 进度 —— 到达的最高楼层 + 击杀/拾取总数。这是「离终点还有多远」的直接量；
//   2. 实力 —— atk 逼近破防阈值（真魔王 def 190）、def、HP 存量。光有进度没实力，
//      上到 50 层也打不过真魔王，所以实力必须和进度一起涨才叫「好」；
//   3. 资源 —— 钥匙（通行权）+ 金币（未来购买力）。
//
// 束搜索与贪心的本质区别：贪心每一步只留 1 个状态（K=1），一旦走错（比如早期
// 开了不该开的门、把钥匙花光）就再也回不了头；束搜索同时保留 K 条**分歧**的路，
// 其中一条不依赖「那扇门」也能走到终点。

/** 束节点：一个「走到这里」的完整状态 + 来的路 */
interface BeamNode {
  state: GameState;
  path: string[];
  score: number;
  maxFloor: number;
}

/** 真魔王破防阈值 —— 估价用它判断「现在是不是已经具备击败最终 BOSS 的资格」 */
const TRUE_BOSS_DEF = 190;

/** 全塔最终 BOSS 的「及格线」攻击力（能对真魔王造成伤害的最低值） */
function bossReachable(state: GameState): boolean {
  return state.atk > TRUE_BOSS_DEF;
}

/**
 * 关键「质变道具」清单 —— 束搜索的**里程碑引导**。
 *
 * 纯搜索（无论贪心/DFS/束搜索）都卡在前 10 层，根因是「拿圣剑（F13，atk+100）」
 * 这类质变收益是**全局、延迟兑现**的：拿到之前看不出价值，拿到之后 atk 翻好几倍。
 * 局部估价（atk × 权重）虽然能体现「已经拿到的剑」，但**不能引导「朝 F13 推进去拿它」**。
 *
 * 解法：把「拿到某件质变道具」本身设成一个里程碑，每个里程碑给固定加分。
 * 这样束搜索会主动保留「正在朝圣剑推进」的分支，而不是被低层的宝石短视吸引。
 */
const MILESTONES: { id: string; bonus: number; note: string }[] = [
  { id: 'ironSword', bonus: 2e6, note: '铁剑 F5，atk+10，前期第一道门槛' },
  { id: 'sacredSword', bonus: 1e7, note: '圣剑 F13，atk+100，全局最大质变' },
  { id: 'cross', bonus: 3e6, note: '十字架 F19，克制亡灵系' },
  { id: 'knightSword', bonus: 3e6, note: '骑士剑 F33，atk+40' },
  { id: 'holySword', bonus: 3e6, note: '圣剑 F48，atk+50' },
  { id: 'sacredShield', bonus: 5e6, note: '神圣盾 F44，免疫领域伤害' }
];

/** 某件道具是否已被拾取（进过 removed 集合） */
function itemTaken(state: GameState, id: string): boolean {
  for (const key of state.removed) {
    if (key.endsWith(`:item:${id}`)) return true;
  }
  return false;
}

/** 里程碑加成：已拿到的质变道具越多，越接近通关 */
function milestoneBonus(state: GameState): number {
  let sum = 0;
  for (const m of MILESTONES) {
    if (itemTaken(state, m.id)) sum += m.bonus;
  }
  return sum;
}

/**
 * 状态估价：越高越「接近通关」。
 *
 * 三层结构（从粗到细）：
 *   1. **里程碑**（主导）—— 拿到质变道具 = 质变加分，引导束搜索朝它们推进；
 *   2. **楼层 + 实力** —— 楼层推进解锁更高档资源（量变），atk/def 是硬门槛；
 *   3. **资源** —— 钥匙（通行权）+ 金币（购买力）+ HP（存活）。
 *
 * ⚠️ 楼层用 `state.floor`（当前层）而不是历史最高：否则「冲上高层又退回」的
 * 残血状态背着虚高分，把「稳步推进」的分支挤掉。
 */
function beamScore(state: GameState, _maxFloor: number): number {
  const milestone = milestoneBonus(state);
  const progress = state.floor * 2e5 + state.removed.size * 1e3;
  const power = state.atk * 5e2 + state.def * 5e1 + state.hp * 0.5;
  const res = state.gold * 5 + state.keys.yellowKey * 10 + state.keys.blueKey * 50 + state.keys.redKey * 500;
  const bossBonus = bossReachable(state) ? 1e8 : 0;
  return milestone + progress + power + res + bossBonus;
}

/**
 * 束搜索：从 `state0` 出发找一条通关动作序列。
 *
 * 迭代加深束宽 K：K 从小到大递增，找到解立即返回。K=1 退化成贪心，
 * K 越大保留的分歧越多、越接近最优解，但每步展开的成本也越高。
 *
 * 状态去重：同一束内若两个状态哈希相同，只留 score 更高者，避免「走同一条路
 * 但步数不同」的两个节点挤占束位。
 */
export function planBeam(
  state0: GameState,
  data: GameData,
  opts: {
    maxBeam?: number;
    maxIter?: number;
    maxNodes?: number;
    /** 阶段目标谓词。默认通关（击败真魔王）。分阶段规划时传入「阶段完成」判据 */
    goal?: (state: GameState, data: GameData) => boolean;
  } = {}
): PlanResult {
  const maxBeam = opts.maxBeam ?? 64;
  const maxIter = opts.maxIter ?? 1000;
  const maxNodes = opts.maxNodes ?? 20_000_000;
  const goal = opts.goal ?? isCleared;

  let nodes = 0;
  let bestMaxFloor = state0.floor;
  let bestActions: string[] = [];
  let bestScore = -Infinity;

  const hash = (s: GameState): string =>
    `${s.floor}:${s.pos.x},${s.pos.y}:${s.hp}:${s.atk}:${s.def}:${s.gold}:` +
    `${s.keys.yellowKey},${s.keys.blueKey},${s.keys.redKey}:${s.removed.size}:${s.buyTimes}`;

  const root: BeamNode = {
    state: cloneState(state0),
    path: [],
    score: beamScore(state0, state0.floor),
    maxFloor: state0.floor
  };

  // 迭代加深束宽：从 1 开始，直到 maxBeam
  for (let K = 1; K <= maxBeam; K++) {
    let beam: BeamNode[] = [root];
    let found: PlanResult | null = null;
    let iter = 0;

    while (beam.length > 0 && iter < maxIter && nodes < maxNodes) {
      iter++;
      const seen = new Map<string, BeamNode>();

      for (const node of beam) {
        if (node.state.dead) continue;
        if (goal(node.state, data)) {
          found = { cleared: true, actions: [...node.path], maxFloor: node.maxFloor, nodes, depth: node.path.length };
          break;
        }
        for (const t of generateTargets(node.state, data)) {
          if (nodes >= maxNodes) break;
          nodes++;
          const c = cloneState(node.state);
          if (!executeTarget(c, data, t)) continue;
          const mf = Math.max(node.maxFloor, c.floor);
          const child: BeamNode = {
            state: c,
            path: [...node.path, `${c.floor}@${c.pos.x},${c.pos.y} ${t.kind} ${t.id}`],
            score: beamScore(c, mf),
            maxFloor: mf
          };
          // 记录全局最优（即使没通关，也报告最远走到哪）
          if (child.score > bestScore) {
            bestScore = child.score;
            bestMaxFloor = mf;
            bestActions = [...child.path];
          }
          const h = hash(c);
          const existing = seen.get(h);
          if (!existing || child.score > existing.score) seen.set(h, child);
        }
        if (found) break;
      }

      if (found) return found;

      // 束内去重后取 top-K
      beam = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, K);
    }

    // 这一轮 K 没找到，下一轮增大 K 保留更多分歧
    if (nodes >= maxNodes) break;
  }

  return { cleared: false, actions: bestActions, maxFloor: bestMaxFloor, nodes, depth: bestActions.length };
}
