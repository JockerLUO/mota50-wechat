/**
 * 评分系统 —— 道具 / 怪物 / NPC **各一套刻度**，全部由当前角色属性推出来。
 *
 * ## 为什么不是「全部折成 HP 当量」
 *
 * 这一版之前 `autoplay.ts` 用的是**一个** `Prices`：道具、怪物、商店报价
 * 全折成「HP 当量」再比大小。它有两个说不清的地方：
 *   · **量纲混了** —— 「去打这只怪」与「去拿这件道具」变成同一个数在比，
 *     而它们该不该比、按什么比，没有任何依据；
 *   · **属性变化进不去** —— `statPrices` 是从**商店价目表**推的，与「我现在打这只怪
 *     掉多少血」无关。攻击力越过某只怪防御的那一刻，1 点攻击的价值是**跳变**的，
 *     价目表看不见这个跳变。
 *
 * 所以按用户 2026-09-26 的口径重写成三套**互不通用**的刻度：
 *
 * | 类别 | 刻度 | 怎么来 |
 * |---|---|---|
 * | 道具 | **省下的血** | 拿它前后，「打全塔剩余怪」的期望掉血差 |
 * | 怪物 | **优先级**（可正可负） | 金币收益 − 掉血代价 + 守护/挡路加成 |
 * | NPC | **金币余量** | 手上多少金币、下一次成交要多少 |
 *
 * ⚠️ **三者不可相加、不可直接比大小**。`CATEGORY_ORDER` 是唯一允许的跨类依据，
 * 各类的入选门槛也各是各的（`thresholds()`）。
 *
 * ## 属性是怎么进去的（这一版的核心）
 *
 * `marginalStat()` 直接对**战斗模型**求差分：把攻击 +1 之后重新跑一遍全塔剩余怪的
 * `previewBattle`，看总掉血少了多少。于是「攻击力刚够破某只怪防御」会**自动**
 * 表现为一个巨大的边际价值，不需要任何手写门槛表。
 */

import type { GameData, ItemEffect, KeyId } from '../data';
import { shopCost, shopGain } from '../../core/shop.mjs';
import { shopOptions } from './engine/shop';
import { merchantOffers } from './engine/merchant';
import { previewBattle } from './engine/vitals';
import { DIRS, entityAt, tileAt, type GameState } from './state';
import { footprintAt, inFootprint } from './footprint';

// ── 分数：带明细，便于诊断与调参 ────────────────────────────────────

export type ScoreCategory = 'item' | 'monster' | 'npc';

export interface Score {
  category: ScoreCategory;
  /** **本类自己的刻度**。跨类比较没有意义（见文件头） */
  total: number;
  /** 构成明细 —— 调参看的是这一栏，不是 total */
  parts: { label: string; value: number }[];
  why: string;
  /**
   * 决策层要用的附加信息。
   *
   * `npcScore` 已经挑出了「最值的那一笔 / 最值的那项属性」，
   * 调用方**不要**再算一遍 —— 算两遍必然会在某次调参后对不上。
   */
  meta?: { offerIndex?: number; stat?: 'hp' | 'atk' | 'def' };
}

function mk(category: ScoreCategory, why: string, parts: { label: string; value: number }[]): Score {
  return { category, why, parts, total: parts.reduce((s, p) => s + p.value, 0) };
}

// ── traits 的两种形状 ───────────────────────────────────────────────
//
// `data/monsters.json` 里 traits 是混合数组：字符串（`"undead"` / `"crossVulnerable"`）
// 与对象（`{type:'aura',…}` / `{type:'flank',…}`）。读 `t.id` 会恒为 undefined —— 那种
// 「问不到就当成没有」的静默失败在这个项目里出现过多次（铁律 #23 一族）。
function traitName(t: unknown): string {
  if (typeof t === 'string') return t;
  if (t && typeof t === 'object' && typeof (t as { type?: unknown }).type === 'string') {
    return (t as { type: string }).type;
  }
  return '';
}

function hasTrait(mon: { traits?: unknown[] } | undefined, name: string): boolean {
  return Array.isArray(mon?.traits) && mon.traits.some((t) => traitName(t) === name);
}

// ── 剩余怪 / 战斗差分 ───────────────────────────────────────────────

/**
 * 「接下来要面对的怪」的窗口大小（层）。
 *
 * ⚠️ 这个窗口是**必须**的，不是优化。属性是永久的，所以「全塔求和」听起来更"正确"，
 * 但实测它会把**够不着、也不打算打**的怪一起算进去：
 * 第 1 层 atk10 时全塔有一百多只怪是「打不动」的，每只记一份破防期权 ⇒
 * 1 点攻击值 **11 万**血 ⇒ 金币汇率 1457 分/枚 ⇒ 打一只小蝙蝠得 8000 分，
 * 与「绕过可跳过的怪」正好相反。
 *
 * 决策要的是**近未来的边际值**：接下来几层要打什么，属性就值多少。
 * 代价是「为后期大门槛攒属性」这件事看不见了 —— 那个由阶段（walkthrough）负责，
 * 不该由这一层的一只怪的分数负责。
 */
export const RELEVANT_FLOORS = 6;

/** 接下来要面对的怪（含被 swap 过的真身）：只算当前层与之后 `RELEVANT_FLOORS` 层 */
function remainingMonsters(state: GameState, data: GameData): string[] {
  const out: string[] = [];
  const to = state.floor + RELEVANT_FLOORS;
  for (const [floor, f] of data.floors) {
    if (floor < state.floor || floor > to) continue;
    for (const e of f.entities) {
      if (e.type !== 'monster') continue;
      if (state.removed.has(`${floor}:${e.x}:${e.y}:monster:${e.id}`)) continue;
      out.push(state.monsterSwap[`${floor}:${e.x},${e.y}`] ?? e.id);
    }
  }
  return out;
}

/** 用「改过三围的 state」跑一次战斗预览，只要掉血量；打不动给 Infinity */
function lossWith(state: GameState, data: GameData, monId: string, patch: Partial<GameState>): number {
  const pv = previewBattle({ ...state, ...patch }, data, monId);
  return pv && Number.isFinite(pv.hpLoss) ? pv.hpLoss : Infinity;
}

/**
 * 「+1 攻击刚好让一只怪从打不动变成打得动」这份**期权**值多少血。
 *
 * 它是本文件里唯一一个人为定的数，理由见 `marginalStat` 里那段注释：
 * 破防的价值是「多了一个选项」，不是「少挨一条命的打」。
 * 量级取「一场普通高级怪的战斗代价」—— 明显低于一条命，明显高于零。
 */
export const PIERCE_VALUE = 800;

export interface MarginalStat {
  /** +1 攻击能省下多少血（对全塔剩余怪求和） */
  atk: number;
  /** +1 防御能省下多少血 */
  def: number;
  /** 1 点生命的**急迫系数**：血越少越值钱（生命本身的值恒为 1） */
  hp: number;
}

/**
 * 边际属性价值 —— 记忆化。
 *
 * 键把「影响它的东西」全列上：三围、被动、已清理实体数。
 * 少列一项的症状是「刚吃了宝石，AI 却还用旧价值看世界」。
 */
const marginalCache = new WeakMap<GameData, { key: string; value: MarginalStat }>();

export function marginalStat(state: GameState, data: GameData): MarginalStat {
  const key = `${state.atk}|${state.def}|${state.hp}|${state.passives.join(',')}|${state.removed.size}`;
  const hit = marginalCache.get(data);
  if (hit && hit.key === key) return hit.value;

  let atk = 0;
  let def = 0;
  for (const id of remainingMonsters(state, data)) {
    const now = lossWith(state, data, id, {});
    const a2 = lossWith(state, data, id, { atk: state.atk + 1 });
    const d2 = lossWith(state, data, id, { def: state.def + 1 });
    if (Number.isFinite(now)) {
      if (Number.isFinite(a2)) atk += Math.max(0, now - a2);
      if (Number.isFinite(d2)) def += Math.max(0, now - d2);
    } else if (Number.isFinite(a2)) {
      //
      // 现在打不动、+1 就能破防。
      //
      // ⚠️ 这里**不能**用 `state.hp − a2`（打完还剩多少血）当收益 ——
      // 那是把「本来可以不打的怪」当成「必须挨的损失」。实测这么写会让
      // 1 点攻击值 **111316**，进而把金币汇率抬到 1457 分/金币，
      // 于是「打一只小蝙蝠」的分数高达 8000+，与「绕过可跳过的怪」正好相反。
      //
      // 破防的真实意义是**期权**：这只怪从「不可战胜」变成「可选」。
      // 期权的价值取一个常数（≈ 一场普通高级怪的战斗代价），而不是一条命。
      atk += PIERCE_VALUE;
    }
  }

  // 生命没有「省的掉血」，它本身就是血 —— 但**急迫度**随当前血量走
  const hp = state.hp < 300 ? 2 : state.hp < 800 ? 1.4 : 1;

  const value: MarginalStat = { atk, def, hp };
  marginalCache.set(data, { key, value });
  return value;
}

// ── 钥匙 ────────────────────────────────────────────────────────────

const doorCache = new WeakMap<GameData, Record<KeyId, number>>();

export function doorTotals(data: GameData): Record<KeyId, number> {
  const hit = doorCache.get(data);
  if (hit) return hit;
  const out: Record<KeyId, number> = { yellowKey: 0, blueKey: 0, redKey: 0 };
  for (const f of data.floors.values()) {
    for (const row of f.terrain) {
      for (const ch of row) {
        const k = data.byChar[ch]?.key;
        if (k) out[k] += 1;
      }
    }
  }
  doorCache.set(data, out);
  return out;
}

/** 一把钥匙值多少血：按**稀缺度**缩放 —— 手里 30 把时第 31 把几乎不值钱 */
export function keyValue(state: GameState, data: GameData, key: KeyId): number {
  const total = doorTotals(data)[key];
  const scarcity = total > 0 ? Math.max(0, total - state.keys[key]) / total : 0;
  const base = key === 'redKey' ? 2500 : key === 'blueKey' ? 900 : 300;
  return base * (1 + 3 * scarcity);
}

/** 1 金币折多少分：按「一次商店购买能换回多少血」推，**随楼层档位与当前属性变化** */
export function goldWeight(state: GameState, data: GameData): number {
  const cost = shopCost(state.buyTimes);
  if (cost <= 0) return 0;
  const defPerPurchase = shopGain(state.floor, 'def');
  return (defPerPurchase * marginalStat(state, data).def) / cost;
}

// ── 道具分 ──────────────────────────────────────────────────────────

/** 效果 → 血当量（**随属性变化**：走 `marginalStat`） */
export function effectValue(state: GameState, data: GameData, effects: ItemEffect[]): number {
  const m = marginalStat(state, data);
  let v = 0;
  for (const eff of effects) {
    switch (eff.op) {
      case 'addStat': {
        const n = Number(eff.value ?? 0);
        if (eff.stat === 'hp') v += n * m.hp;
        else if (eff.stat === 'atk') v += n * m.atk;
        else if (eff.stat === 'def') v += n * m.def;
        break;
      }
      case 'mulStat':
        if (eff.stat === 'hp') v += state.hp * (Number(eff.value ?? 2) - 1) * m.hp;
        break;
      case 'addKey':
        v += keyValue(state, data, eff.key as KeyId) * Number(eff.value ?? 1);
        break;
      case 'immune':
        if (eff.to === 'aura') v += auraExposure(state, data);
        break;
      case 'openFloorSelect':
        v += 2500;
        break;
      case 'traitCounter':
        v += traitGain(state, data, String(eff.trait));
        break;
      case 'clearTerrain':
      case 'breakWall':
        v += unlockValue(state, data) * 0.6;
        break;
      case 'bomb':
        v += unlockValue(state, data) * 0.4;
        break;
      default:
        // `toggleUi`（怪物书）这类纯界面道具不折算 —— 明确写出来，
        // 免得下一个人以为「漏了一个分支」
        break;
    }
  }
  return v;
}

/** 还剩多少只带 aura 的怪 —— 神圣盾的价值来源 */
function auraExposure(state: GameState, data: GameData): number {
  let n = 0;
  const to = state.floor + RELEVANT_FLOORS;
  for (const [floor, f] of data.floors) {
    if (floor < state.floor || floor > to) continue;
    for (const e of f.entities) {
      if (e.type !== 'monster') continue;
      if (state.removed.has(`${floor}:${e.x}:${e.y}:monster:${e.id}`)) continue;
      if (hasTrait(data.monsters[e.id], 'aura')) n++;
    }
  }
  return n * 400;
}

/** 特攻道具（十字架之类）：只对**带该 trait 且还活着**的怪有效 */
function traitGain(state: GameState, data: GameData, trait: string): number {
  let gain = 0;
  const to = state.floor + RELEVANT_FLOORS;
  for (const [floor, f] of data.floors) {
    if (floor < state.floor || floor > to) continue;
    for (const e of f.entities) {
      if (e.type !== 'monster') continue;
      if (state.removed.has(`${floor}:${e.x}:${e.y}:monster:${e.id}`)) continue;
      if (!hasTrait(data.monsters[e.id], trait)) continue;
      const now = lossWith(state, data, e.id, {});
      const after = lossWith(state, data, e.id, { atk: state.atk * 2 });
      gain += Number.isFinite(now) && Number.isFinite(after)
        ? Math.max(0, now - after)
        : state.hp * 0.5; // 打不动的怪被特攻救活：收益按半条命封顶
    }
  }
  return gain;
}

/** 破障道具能开出多少东西 —— 只看**当前层**还够不着的道具（跨层不可判定） */
function unlockValue(state: GameState, data: GameData): number {
  let v = 0;
  for (const e of data.floors.get(state.floor)?.entities ?? []) {
    if (e.type !== 'item') continue;
    if (state.removed.has(`${state.floor}:${e.x}:${e.y}:item:${e.id}`)) continue;
    v += rawItemWorth(state, data, e.id);
  }
  return v;
}

/** 一件道具的「面值」—— 只看效果，不看拿它的代价 */
export function rawItemWorth(state: GameState, data: GameData, itemId: string): number {
  const def = data.items[itemId];
  if (!def) return 0;
  if (def.kind === 'passive' && state.passives.includes(itemId)) return 0;
  let v = effectValue(state, data, def.effects ?? []);
  if (def.effects?.some((e) => e.op === 'mulGoldGain')) {
    v += remainingGold(state, data) * goldWeight(state, data);
  }
  return v;
}

/** 窗口内还没拿到的怪物金币（大金币「金币翻倍」的价值来源，与 `remainingMonsters` 同口径） */
function remainingGold(state: GameState, data: GameData): number {
  let g = 0;
  const to = state.floor + RELEVANT_FLOORS;
  for (const [floor, f] of data.floors) {
    if (floor < state.floor || floor > to) continue;
    for (const e of f.entities) {
      if (e.type !== 'monster') continue;
      if (state.removed.has(`${floor}:${e.x}:${e.y}:monster:${e.id}`)) continue;
      g += data.monsters[e.id]?.gold ?? 0;
    }
  }
  return g;
}

/** 守护收益的转移比例：一半记到怪头上（见 `itemScore` 与 `monsterScore`） */
export const GUARD_SHARE = 0.5;

export interface ItemScoreInput {
  itemId: string;
  /** 拿到它的路上要掉多少血（调用方沿路径算好） */
  costHp: number;
  /**
   * 路上**顺手打掉的怪**给的金币（调用方沿路径求和）。
   *
   * 为什么必须有这一项：路上打怪既是掉血（记在 `costHp`）**也是收入**。
   * 不记收入时，第 1 层那颗蓝宝石会显示成「面值 1164 − 路上代价 982 = 182」，
   * 而让这条路上那些怪变便宜的机会又被排在道具之后（`CATEGORY_ORDER`）
   * —— 于是 AI 永远迈不出第一步，那颗宝石一辈子不拿。
   * 实测症状：跑到 2 万步、攻 26，防御**一直是 10**（一颗防御宝石都没捡）。
   */
  pathGold?: number;
  /** 是否有怪守着它 */
  guarded?: boolean;
}

/**
 * 道具分：**血当量**。
 *
 * 用户明确要求的两条都在这里：
 *   · 「怪物守护道具时…相应道具分数降低」—— 守护的那部分价值**转移**给怪，
 *     否则同一份收益会被算两遍（道具一次、怪一次）；
 *   · 「根据角色属性的变化」—— 面值全走 `marginalStat`，攻击刚够破防时道具会突然值钱。
 */
export function itemScore(state: GameState, data: GameData, input: ItemScoreInput): Score {
  const worth = rawItemWorth(state, data, input.itemId);
  const parts = [{ label: '面值', value: worth }];
  if (input.guarded) parts.push({ label: '守卫转移', value: -worth * GUARD_SHARE });
  parts.push({ label: '路上代价', value: -input.costHp });
  if (input.pathGold) {
    parts.push({ label: '路上掉落', value: input.pathGold * goldWeight(state, data) });
  }
  return mk('item', `道具「${data.items[input.itemId]?.name ?? input.itemId}」`, parts);
}

/**
 * 这只怪守着哪件道具（同格、或落在它的占位块内）。
 *
 * 同格的判定与引擎一致：`entities` 里怪排在道具之前，所以踏上那一格先开战、
 * 打完道具还在 —— 「BOSS 守道具」在数据里就是这么摆的（第 15 层大乌贼守铁锹）。
 */
export function guardedItemAt(
  state: GameState,
  data: GameData,
  floor: number,
  ent: { type: string; id: string; x: number; y: number }
): string | null {
  // 用 `footprintAt` 而不是 `entityFootprint`：调用方可能只给 `{type,id,x,y}`
  const fp = footprintAt(data, ent.x, ent.y, ent.type === 'monster' && !!data.monsters[ent.id]?.boss);
  for (const e of data.floors.get(floor)?.entities ?? []) {
    if (e.type !== 'item') continue;
    if (state.removed.has(`${floor}:${e.x}:${e.y}:item:${e.id}`)) continue;
    if (inFootprint(fp, e.x, e.y)) return e.id;
  }
  return null;
}

/**
 * 这件道具**被谁**守着（同一格 / 占位块内有怪）。
 *
 * `guardedItemAt` 的反面，两个必须成对使用：道具侧据此**降低**分数、
 * 怪物侧据此**抬高**分数，转移的是同一份价值（`GUARD_SHARE`）。
 */
export function guardianAt(
  state: GameState,
  data: GameData,
  floor: number,
  x: number,
  y: number
): string | null {
  const ent = entityAt(state, data, floor, x, y);
  return ent && ent.type === 'monster' ? ent.id : null;
}

// ── 怪物分 ──────────────────────────────────────────────────────────

/** 不掉血的怪：优先级**为负**（用户明确要求），由决策层的「同层顺便清理」处理 */
export const NO_THREAT_SCORE = -1000;
/** 挡在通往下一层必经之路上的怪 */
export const BLOCK_BONUS = 2500;
/** 打不动 */
export const UNREACHABLE_SCORE = -1e9;

export interface MonsterContext {
  /** 它守着哪件道具（不给就自己算） */
  guards?: string | null;
  /** 是否堵在通往本层上楼梯的必经之路上 */
  blocks?: boolean;
  /** 除打它之外的沿路掉血 */
  approachHp?: number;
}

/**
 * 怪物分：**优先级**（可正可负）。**与道具分不是同一个刻度。**
 *
 * 逐条对应你的口径：
 *   · 金币收益 × 金价              —— 打它拿到什么；
 *   · − 掉血 × 血急迫度            —— 打它要付什么（这部分随攻防变化）；
 *   · **不掉血 ⇒ 分数为负**         —— 没有威胁的怪不值得专程去（同层顺路才清）；
 *   · + 守护加成                   —— 守着道具 ⇒ 上升（道具那边同步降低）；
 *   · + 挡路加成                   —— 挡在去下一层的路上 ⇒ 上升；
 *   · 打不动 ⇒ 极负                —— 不可选。
 */
export function monsterScore(state: GameState, data: GameData, monId: string, ctx: MonsterContext = {}): Score {
  const mon = data.monsters[monId];
  const name = mon?.name ?? monId;
  if (!mon) return mk('monster', `未知怪 ${monId}`, [{ label: '未知', value: UNREACHABLE_SCORE }]);

  const pv = previewBattle(state, data, monId);
  const hpLoss = pv && Number.isFinite(pv.hpLoss) ? pv.hpLoss : Infinity;
  const m = marginalStat(state, data);
  const gold = mon.gold * (state.passives.includes('bigGold') ? 2 : 1);
  const goldScore = gold * goldWeight(state, data);
  //
  // ★ 不掉血的怪：**经济项整体作废**（金币不再构成「专程去打」的理由）。
  //
  // ⚠️ 注意是「经济项作废」，不是「总分封顶」—— 后者会把**守护 / 挡路**这两项
  // 战略加分一起吞掉，而那两项恰恰是「该不该打它」的真正理由：
  // 一只守着道具、又打不动你的怪，杀它是**免费**的，还解锁道具，当然该打。
  // 实测（S4 断言）：封顶写法下，守铁锹的大乌贼在 def 999 时总分恒为 -1000，
  // 与不守护时一模一样 —— 守护这件事在分数里等于没发生。
  const noThreatPeek = (() => {
    const pv = previewBattle(state, data, monId);
    return !!pv && Number.isFinite(pv.hpLoss) && pv.hpLoss === 0;
  })();
  const parts: { label: string; value: number }[] = [
    { label: noThreatPeek ? '金币（不构成理由）' : '金币', value: noThreatPeek ? 0 : goldScore }
  ];

  const guards = ctx.guards !== undefined ? ctx.guards : null;
  // 守护 / 挡路两项**先算**，即使现在打不动也要出现在明细里 ——
  // 它们正是「以后值不值得为它练到能打」的依据，被 `打不动` 的早退吞掉就看不见了。
  if (guards) {
    parts.push({
      label: `守护「${data.items[guards]?.name ?? guards}」`,
      value: rawItemWorth(state, data, guards) * GUARD_SHARE
    });
  }
  if (ctx.blocks) parts.push({ label: '挡路（通往下一层）', value: BLOCK_BONUS });

  if (!Number.isFinite(hpLoss)) {
    parts.push({ label: '打不动', value: UNREACHABLE_SCORE });
    return mk('monster', `怪「${name}」打不动（攻 ${state.atk} ≤ 防 ${mon.def}）`, parts);
  }

  const noThreat = hpLoss === 0;
  if (noThreat) {
    parts.push({ label: '无威胁（不掉血）', value: NO_THREAT_SCORE });
  } else {
    parts.push({ label: '掉血代价', value: -hpLoss * m.hp });
  }
  if (ctx.approachHp) parts.push({ label: '路上代价', value: -ctx.approachHp * m.hp });

  const s = mk(
    'monster',
    ctx.blocks
      ? `怪「${name}」挡在通往下一层的路上`
      : guards
        ? `怪「${name}」守着「${data.items[guards]?.name ?? guards}」`
        : `怪「${name}」`,
    parts
  );
  //
  // 「不掉血的怪分数为负」的**硬保证**已经在上面落到了经济项上（金币记 0、
  // 无威胁记 `NO_THREAT_SCORE`），所以这里不再对总分封顶 —— 见那段注释。
  void noThreat;
  return s;
}

/**
 * 不战斗时的可达性（怪与未开的门都当墙）。`ignore` 里的怪视为**已击败**。
 *
 * 返回可达格子的 `"x,y"` 集合。
 */
function reachNoFight(state: GameState, data: GameData, floor: number, ignore: Set<string>): Set<string> {
  const seen = new Set<string>([`${state.pos.x},${state.pos.y}`]);
  const q = [{ x: state.pos.x, y: state.pos.y }];
  while (q.length) {
    const cur = q.shift()!;
    for (const d of Object.values(DIRS)) {
      const x = cur.x + d.dx;
      const y = cur.y + d.dy;
      if (x < 0 || y < 0 || x > 10 || y > 10) continue;
      const k = `${x},${y}`;
      if (seen.has(k)) continue;
      const info = data.byChar[tileAt(state, data, floor, x, y)];
      if (!info?.passable) continue;
      const ent = entityAt(state, data, floor, x, y);
      // 怪与 NPC 都过不去；`ignore` 里的怪算已经打掉了
      if (ent && ent.type !== 'item' && !(ent.type === 'monster' && ignore.has(k))) continue;
      seen.add(k);
      q.push({ x, y });
    }
  }
  return seen;
}

/**
 * 本层哪些怪**真的挡在通往下一层的路上** —— 返回的是**格子**（`"x,y"`），不是怪 id。
 *
 * ## 判据：只杀这一只，上楼梯就通了
 *
 * 对每只怪单独做一次「把它当已击败」的可达性测试，能通到上楼梯的才算挡路。
 * 一只怪一个 BFS（本层 ≤ 20 只），代价可以忽略。
 *
 * ⚠️ 这里改过一版，值得记下来：第一版的定义是「不战斗时到不了上楼梯，
 * 且这只怪贴在可达区域的边界上」。它**太宽** —— 第 1 层上楼梯在 (0,0)，
 * 不战斗时确实到不了，于是**整层每一只贴着边界的怪都被标成挡路**，
 * 各拿一份 +2500 加成，全都越过了入选门槛。实测症状：AI 在第 1 层
 * 一只一只地去撞史莱姆，把「绕过可跳过的怪」做成了「清光整层」。
 *
 * 返回**格子**而不是 id 也不是可选的：同一层可能有三只绿史莱姆，只有一只堵路，
 * 按 id 标记会把三只一起算进去 —— 那正是上面那个症状的另一半。
 */
export function blockingMonsters(state: GameState, data: GameData, floor: number): Set<string> {
  const out = new Set<string>();
  const ups = data.floors.get(floor)?.stairs.up ?? [];
  if (ups.length === 0) return out;
  const open = reachNoFight(state, data, floor, new Set());
  if (ups.some((s) => open.has(`${s.x},${s.y}`))) return out; // 不打架就上得去 ⇒ 没有挡路的

  for (const e of data.floors.get(floor)?.entities ?? []) {
    if (e.type !== 'monster') continue;
    const k = `${e.x},${e.y}`;
    if (state.removed.has(`${floor}:${e.x}:${e.y}:monster:${e.id}`)) continue;
    if (reachNoFight(state, data, floor, new Set([k])).has(`${ups[0].x},${ups[0].y}`)) out.add(k);
  }
  return out;
}

// ── NPC 分 ──────────────────────────────────────────────────────────

/**
 * NPC 分：**金币余量**刻度（与前两者都不同）。
 *
 * 用户口径：「商店的分数根据所持有金币定」。主项就是 `手上金币 − 下一次成交价`：
 * 买得起才有正分，买不起是负分（不该专程跑一趟）。属性收益只作为**同层并列时的次序**。
 */
export function npcScore(state: GameState, data: GameData, npcId: string, floor: number): Score {
  //
  // ⚠️ 只给**能成交的** NPC 打分，纯对话的一律负分。
  //
  // 智者（`sage`）只是念台词：「打到它旁边搭个话」既不掉血也不给东西，
  // 于是它会变成一条**永远达不成的目标** —— 决策器每轮都返回同一个「撞上去」的
  // step，而引擎返回 `talk`（不移动），死循环。实测：AI 在第 1 层 (6,10)
  // 反复撞智者 13 次被探针抓住，一步都没走出去。
  if (npcId !== 'shop' && npcId !== 'merchant') {
    return mk('npc', `${npcId} 是纯对话 NPC（没有可成交的东西）`, [{ label: '不可成交', value: -1 }]);
  }
  if (npcId === 'shop') {
    const next = shopCost(state.buyTimes);
    const opt = shopOptions(state, data);
    //
    // ★ 买不起 ⇒ **一定是负分**（用户口径：「商店的分数根据所持有金币定」）。
    //
    // 不加这道硬门时，属性收益那一项能把总分顶成正的 —— 于是 AI 走到商店、
    // 每轮都发一个 `buy`，而 `buyStat` 因为金币不够直接失败，原地卡 13 次。
    // 「值不值得买」与「买不买得起」是两件事，后者是**前提**，不能被前者抵消。
    if (state.gold < next) {
      return mk('npc', `商店（金币 ${state.gold} < 起价 ${next}，买不起）`, [
        { label: '金币不足', value: -1 }
      ]);
    }
    //
    // 买哪一项：**按边际价值**（`marginalStat`），不是手写顺序。
    // 攻击越过某只怪的防御时它的价值会跳变，所以「该买攻击还是防御」本来就该是算出来的。
    const m = marginalStat(state, data);
    const gains: Record<'hp' | 'atk' | 'def', number> = {
      hp: shopGain(floor, 'hp') * m.hp,
      atk: shopGain(floor, 'atk') * m.atk,
      def: shopGain(floor, 'def') * m.def
    };
    const bestStat = (Object.keys(gains) as ('hp' | 'atk' | 'def')[]).reduce((a, b) =>
      gains[b] > gains[a] ? b : a
    );
    const sc = mk('npc', `商店（第 ${opt.n} 次起价 ${next} 金币，最值的是${bestStat === 'hp' ? '生命' : bestStat === 'atk' ? '攻击' : '防御'}）`, [
      { label: '金币余量', value: state.gold - next },
      { label: `一次${bestStat}收益`, value: gains[bestStat] * 0.1 }
    ]);
    sc.meta = { stat: bestStat };
    return sc;
  }

  const offers = merchantOffers(state, data, floor);
  if (offers.length === 0) return mk('npc', `${npcId} 本层无货`, [{ label: '无货', value: -1 }]);

  let best: Score | null = null;
  for (const o of offers) {
    if (o.blocked) continue;
    const sc = npcOfferScore(state, data, o);
    if (!best || sc.total > best.total) best = sc;
  }
  return best ?? mk('npc', '商人（无可成交报价）', [{ label: '无', value: -1 }]);
}

/**
 * 商人**单笔报价**的分（刻度同上：金币余量）。
 *
 * 单列出来是因为两个调用方要的不一样，但**算的必须是同一套**：
 *   · 贪心（`decideAutoAction`）要「最好那一笔」→ 用 `npcScore`；
 *   · 规划器（`generateTargets`）要把每一笔都当**独立分支**展开 → 用这个。
 * 写在两处就会出现「贪心觉得该买、规划器觉得不该买」这种自相矛盾。
 */
export function npcOfferScore(
  state: GameState,
  data: GameData,
  o: { index: number; op: string; title: string; price: number; goldDelta: number; raw: Record<string, unknown> }
): Score {
  const parts: { label: string; value: number }[] = [];
  if (o.op === 'gift') {
    parts.push({
      label: `赠礼「${o.title}」`,
      value: o.goldDelta > 0 ? o.goldDelta : rawItemWorth(state, data, String(o.raw.item ?? '')) || 800
    });
  } else if (o.op === 'buyItem') {
    const id = String(o.raw.item);
    const count = Number(o.raw.count ?? 1);
    const isKey = (['yellowKey', 'blueKey', 'redKey'] as string[]).includes(id);
    const worth = isKey ? keyValue(state, data, id as KeyId) * count : rawItemWorth(state, data, id) * count;
    parts.push({ label: `买「${o.title}」`, value: worth - o.price });
    parts.push({ label: '金币余量', value: state.gold - o.price });
  } else if (o.op === 'buyStat') {
    const v = effectValue(state, data, [
      { op: 'addStat', stat: String(o.raw.stat), value: Number(o.raw.value ?? 0) }
    ]);
    parts.push({ label: `换「${o.title}」`, value: v - o.price });
    parts.push({ label: '金币余量', value: state.gold - o.price });
  } else {
    // 回收（第 28 层卖黄钥匙）：金币进来，钥匙出去 —— 净额就是售价
    parts.push({ label: `出售「${o.title}」`, value: o.price });
  }
  const sc = mk('npc', `商人：${o.title}`, parts);
  sc.meta = { offerIndex: o.index };
  return sc;
}

// ── 决策层的门槛与类别次序 ──────────────────────────────────────────
//
// ⚠️ 三个刻度不通用 ⇒ **门槛也必须是三个**，跨类必须走 `CATEGORY_ORDER`，
// 不能拿三个数直接比大小。这一段就是「不通用」这句话的落点。

export type Category = ScoreCategory | 'stairs';

/**
 * 类别次序 —— 同类内先按分数排序，再按这个次序决定先做哪一类。
 *
 * 按「代价从小到大」排：
 *   1. `item`    永久收益，顺路拿通常不花血；
 *   2. `npc`     金币换永久属性，花的是钱不是血；
 *   3. `monster` 花血，最后做；
 *   4. `stairs`  上面都没得做才推进。
 */
export const CATEGORY_ORDER: Category[] = ['item', 'npc', 'monster', 'stairs'];

/**
 * 各类的入选门槛（各自刻度）。
 *
 * 道具/怪物/商店三条线**故意不共用一个数** —— 它们量纲不同，
 * 用一个数就是在偷偷把它们当同一个刻度用。
 */
export const THRESHOLD = {
  /** 道具：血当量至少为正（拿它比路上代价值） */
  item: 0,
  /** 怪物：优先级为正才**专程**打；≤0 只在同层顺路时清 */
  monster: 0,
  /** NPC：金币余量 ≥0 才值得跑一趟 */
  npc: 0
} as const;

// ── 诊断 ────────────────────────────────────────────────────────────

/** 把当前层能看到的道具 / 怪 / NPC 的分数全算出来（`npm run autoplay:plan -- --scores` 用它） */
export function scoreDump(
  state: GameState,
  data: GameData,
  /** 「走到这一格要掉多少血」——由调用方给（用**同一个** `reach`，别在这里重写一遍） */
  costAt?: (x: number, y: number) => number | undefined
): Score[] {
  const out: Score[] = [];
  const floor = state.floor;
  const blocking = blockingMonsters(state, data, floor);
  for (const e of data.floors.get(floor)?.entities ?? []) {
    if (state.removed.has(`${floor}:${e.x}:${e.y}:${e.type}:${e.id}`)) continue;
    if (e.type === 'item') {
      out.push(
        itemScore(state, data, {
          itemId: e.id,
          // ⚠️ 这里曾经硬编码成 0 —— 于是诊断里每件道具都显示「路上代价 0」，
          // 分数看着漂亮，而 AI 实际按带代价的分数行动。诊断与实际**必须**同一个数。
          costHp: costAt?.(e.x, e.y) ?? 0,
          guarded: guardianAt(state, data, floor, e.x, e.y) !== null
        })
      );
    } else if (e.type === 'monster') {
      out.push(
        monsterScore(state, data, e.id, {
          guards: guardedItemAt(state, data, floor, e),
          blocks: blocking.has(`${e.x},${e.y}`)
        })
      );
    } else if (e.type === 'npc') {
      out.push(npcScore(state, data, e.id, floor));
    }
  }
  return out.sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || b.total - a.total
  );
}
