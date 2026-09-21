/**
 * 游戏规则引擎 —— 纯逻辑，零渲染依赖。
 *
 * 所有规则都对齐参考源码与原版行为，关键判定在注释里标了出处：
 *  - 战斗：core/combat.mjs（公式源自标准引擎 mota-js，非参考实现的错误版）
 *  - 开门：撞门成功即消耗钥匙并**走上该格**（源码 event.js:386 清门后 player.x++）
 *  - 假墙：撞一次即变为空地并走上去（event.js:412）
 *  - 对称飞行器：0 基下目标为 (10−x, 10−y)
 *    （源码 1 基写 `player.x = 12 - player.x`，换算到 0 基即 10−x）
 *  - 楼层传送器：只能去**已到过**的楼层（action.js:90 起，按 wentFloor 过滤）
 */

import { simulateBattle, auraStepDamage, grade } from '../../core/combat.mjs';
import {
  countersFromItems,
  goldPerPoint,
  hasAuraImmunity,
  maxPurchasesFrom,
  shopCost,
  shopGain
} from '../../core/shop.mjs';
import type { GameData, ItemEffect, Monster, KeyId, Stat } from '../data';
import { floorOf, tierOf } from '../data';
import {
  DIRS,
  entityAt,
  entityKey,
  hasPassive,
  isAdjacent,
  livingMonsters,
  patchTile,
  pushLog,
  tileAt,
  type Dir,
  type GameState
} from './state';

/**
 * `core/combat.mjs` 是纯 JS（要同时能被 Node 校验器与浏览器引用），
 * 这里手写它的返回形状，让 TS 侧有类型可用。
 */
export interface BattlePreview {
  canWin: boolean;
  reason: string | null;
  execute: boolean;
  effectiveAtk: number;
  appliedCounters?: string[];
  perHit: number | null;
  perRound: number;
  rounds: number | null;
  enemyAttacks: number | null;
  flanked?: boolean;
  flankChance?: number;
  hpLoss: number;
  hpLossMin: number;
  hpLossMax: number;
  remainingHp: number;
}

// ── 结果类型 ────────────────────────────────────────────────────────

export type StepKind = 'move' | 'blocked' | 'battle' | 'pickup' | 'door' | 'stairs' | 'talk' | 'fakewall';

/**
 * 引擎请求 UI 打开的界面。
 * 引擎只**请求**，不知道界面长什么样 —— 它不持有任何渲染对象。
 */
export type UiKind = 'floorSelect' | 'monsterBook' | 'notebook' | 'merchant' | 'shop';

export interface StepResult {
  kind: StepKind;
  /** 勇者是否真的换了位置（渲染层据此播移动动画） */
  moved: boolean;
  /** 换层后的新楼层；未换层为 undefined */
  floorChanged?: number;
  message?: string;
  /** 撞上 NPC 时请求打开的界面（商人 / 商店） */
  openUi?: UiKind;
}

export interface UseResult {
  ok: boolean;
  message: string;
  /** 需要 UI 打开的界面 */
  openUi?: UiKind;
}

/** 持有即生效的效果算子 —— 拾取时同步进 `passives` */
const PERSISTENT_OPS = new Set(['traitCounter', 'immune', 'mulGoldGain']);
/** 可重复使用、不消耗的道具效果 */
const REUSABLE_OPS = new Set(['openFloorSelect', 'toggleUi']);

// ── 派生量 ──────────────────────────────────────────────────────────

export function heroStats(state: GameState): { hp: number; atk: number; def: number } {
  return { hp: state.hp, atk: state.atk, def: state.def };
}

/** 击杀一只怪物的金币收益（持大金币翻倍） */
export function goldMultiplier(state: GameState): number {
  return hasPassive(state, 'bigGold') ? 2 : 1;
}

/** 对某只怪物的战斗预判 —— 渲染层用它做 hover 提示与危险配色 */
export function previewBattle(
  state: GameState,
  data: GameData,
  monId: string
): (BattlePreview & { grade: string; monster: Monster }) | null {
  const monster = data.monsters[monId];
  if (!monster) return null;
  const counters = countersFromItems(state.passives, data.items);
  const preview = simulateBattle(heroStats(state), monster, { counters });
  return { ...preview, grade: grade(heroStats(state), preview), monster };
}

/** 领域伤害：移动后与带 aura 的怪物相邻则扣血 */
function applyAura(state: GameState, data: GameData): number {
  const monsters = livingMonsters(state, data, state.floor)
    .filter((m) => isAdjacent(state.pos.x, state.pos.y, m.x, m.y))
    .map((m) => data.monsters[m.id])
    .filter(Boolean);
  if (monsters.length === 0) return 0;
  const immune = hasAuraImmunity(state.passives, data.items);
  const dmg = auraStepDamage(monsters, { auraImmune: immune });
  if (dmg <= 0) return 0;
  state.hp -= dmg;
  state.stats.hpLost += dmg;
  const names = monsters.map((m) => m.name).join('、');
  pushLog(state, `巫师领域：${names} 相邻，损失 ${dmg} HP${immune ? '（免疫）' : ''}`, 'warn');
  checkDeath(state);
  return dmg;
}

function checkDeath(state: GameState): void {
  if (state.hp <= 0) {
    state.hp = 0;
    state.dead = true;
    pushLog(state, '勇者阵亡。', 'warn');
  }
}

/** 找最近的、可站立且无实体的格子（换层落点修正用） */
export function nearestStandable(state: GameState, data: GameData, floor: number, x: number, y: number): { x: number; y: number } {
  const ok = (cx: number, cy: number) => {
    if (cx < 0 || cy < 0 || cx > 10 || cy > 10) return false;
    const info = data.byChar[tileAt(state, data, floor, cx, cy)];
    if (!info?.passable) return false;
    return !entityAt(state, data, floor, cx, cy);
  };
  if (ok(x, y)) return { x, y };
  const seen = new Set<string>([`${x},${y}`]);
  const q: { x: number; y: number }[] = [{ x, y }];
  while (q.length) {
    const cur = q.shift()!;
    for (const d of Object.values(DIRS)) {
      const nx = cur.x + d.dx;
      const ny = cur.y + d.dy;
      const k = `${nx},${ny}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (ok(nx, ny)) return { x: nx, y: ny };
      if (nx >= 0 && ny >= 0 && nx <= 10 && ny <= 10) q.push({ x: nx, y: ny });
    }
  }
  return { x, y };
}

// ── 效果执行 ────────────────────────────────────────────────────────

export interface EffectContext {
  /** 效果作用所在楼层（clearTerrain 的 scope 是 currentFloor） */
  floor: number;
  /** 用于日志与 UI 反馈的道具 / NPC 名 */
  source: string;
}

export function applyEffects(state: GameState, data: GameData, effects: ItemEffect[], ctx: EffectContext): { log: string[]; openUi?: UseResult['openUi'] } {
  const lines: string[] = [];
  let openUi: UseResult['openUi'];

  for (const e of effects) {
    switch (e.op) {
      case 'addStat': {
        // 金币也走 addStat：第 2 层商人赠礼就是 `{op:'addStat', stat:'gold', value:1000}`
        const stat = String(e.stat);
        const value = e.value as number;
        if (stat === 'gold') {
          state.gold += value;
          lines.push(`金币 +${value}`);
        } else {
          state[stat as Stat] += value;
          lines.push(`${statName(stat as Stat)} +${value}`);
        }
        break;
      }
      case 'mulStat': {
        const stat = e.stat as Stat;
        const value = e.value as number;
        const before = state[stat];
        state[stat] = Math.floor(before * value);
        lines.push(`${statName(stat)} ${before} → ${state[stat]}（×${value}）`);
        break;
      }
      case 'addKey': {
        const key = e.key as KeyId;
        const value = e.value as number;
        state.keys[key] += value;
        lines.push(`${keyName(key)} +${value}`);
        break;
      }
      case 'mulGoldGain':
      case 'traitCounter':
      case 'immune':
        // 持有即生效，由 `passives` 承载；此处不产生即时效果
        break;
      case 'clearTerrain': {
        const code = e.terrain as number;
        let n = 0;
        for (let y = 0; y < 11; y++) {
          for (let x = 0; x < 11; x++) {
            if (data.codeOf[tileAt(state, data, ctx.floor, x, y)] === code) {
              patchTile(state, ctx.floor, x, y, '.');
              n++;
            }
          }
        }
        lines.push(`清除本层 ${n} 格 ${terrainName(data, code)}`);
        break;
      }
      case 'breakWall': {
        let n = 0;
        for (const d of Object.values(DIRS)) {
          const x = state.pos.x + d.dx;
          const y = state.pos.y + d.dy;
          if (tileAt(state, data, ctx.floor, x, y) === '#') {
            patchTile(state, ctx.floor, x, y, '.');
            n++;
          }
        }
        lines.push(n ? `挖开相邻 ${n} 面墙` : '相邻没有可挖的墙');
        break;
      }
      case 'bomb': {
        const ex = (e.exclude ?? {}) as { roleIds?: number[]; roleIdAtLeast?: number };
        let n = 0;
        for (const d of Object.values(DIRS)) {
          const x = state.pos.x + d.dx;
          const y = state.pos.y + d.dy;
          const ent = entityAt(state, data, ctx.floor, x, y);
          if (!ent || ent.type !== 'monster') continue;
          const m = data.monsters[ent.id];
          if (!m) continue;
          if (ex.roleIdAtLeast !== undefined && m.roleId >= ex.roleIdAtLeast) continue;
          if (ex.roleIds?.includes(m.roleId)) continue;
          state.removed.add(entityKey(ctx.floor, x, y, 'monster', ent.id));
          n++;
        }
        lines.push(n ? `炸掉相邻 ${n} 只怪物` : '相邻没有可炸的怪物');
        break;
      }
      case 'teleportSymmetric': {
        // 源码 1 基 `player.x = 12 - player.x` → 0 基 10 − x
        const tx = 10 - state.pos.x;
        const ty = 10 - state.pos.y;
        const info = data.byChar[tileAt(state, data, ctx.floor, tx, ty)];
        if (info?.passable && !entityAt(state, data, ctx.floor, tx, ty)) {
          state.pos = { x: tx, y: ty };
          lines.push(`对称传送到 (${tx}, ${ty})`);
          applyAura(state, data);
        } else {
          lines.push(`对称点 (${tx}, ${ty}) 不是空位，传送失败`);
          return { log: lines, openUi };
        }
        break;
      }
      case 'changeFloor': {
        const delta = e.delta as number;
        const target = state.floor + delta;
        if (!data.floors.has(target)) {
          lines.push(`第 ${target} 层不存在，无法前往`);
          break;
        }
        const drop = nearestStandable(state, data, target, state.pos.x, state.pos.y);
        arriveOnFloor(state, data, target, drop.x, drop.y);
        lines.push(`前往第 ${target} 层`);
        break;
      }
      case 'openFloorSelect':
        openUi = 'floorSelect';
        break;
      case 'toggleUi':
        openUi = e.ui === 'notebook' ? 'notebook' : 'monsterBook';
        break;
      default:
        lines.push(`未实现的算子：${e.op}`);
    }
  }
  return { log: lines, openUi };
}

function statName(s: Stat): string {
  return { hp: '生命', atk: '攻击', def: '防御' }[s];
}
function keyName(k: KeyId): string {
  return { yellowKey: '黄钥匙', blueKey: '蓝钥匙', redKey: '红钥匙' }[k];
}
function terrainName(data: GameData, code: number): string {
  const info = data.tiles.find((t) => data.codeOf[t.char] === code);
  return info?.name ?? `地形${code}`;
}

// ── 道具发放 / 扣除 ─────────────────────────────────────────────────
//
// 拾取和商人买入走的是同一套语义，所以抽在这里。分成两处写的话，
// 迟早会出现「地上捡的蓝钥匙进背包、买来的蓝钥匙进 keys」这种撕裂。

/** items.json 里钥匙类道具的 id 恰好就是 KeyId；钥匙不进背包，直接进 state.keys */
const KEY_ITEM_IDS = new Set<string>(['yellowKey', 'blueKey', 'redKey']);

/**
 * 把道具发给勇者，返回给玩家看的说明行。
 *   - 钥匙 → 直接进 `state.keys`
 *   - 可使用 → 进背包（不立刻结算，否则地震卷轴会在买入瞬间清掉本层地图）
 *   - 拾取即生效 / 持有即生效 → 立刻结算效果，并登记被动
 */
export function grantItem(state: GameState, data: GameData, id: string, count = 1, floor = state.floor): string[] {
  const item = data.items[id];
  if (!item) return [`未知道具「${id}」`];

  if (KEY_ITEM_IDS.has(id)) {
    const key = id as KeyId;
    state.keys[key] += count;
    return [`${keyName(key)} +${count}`];
  }

  if (item.kind === 'usable') {
    state.bag[id] = (state.bag[id] ?? 0) + count;
    return [`获得 ${item.name} ×${count}（可使用）`];
  }

  const persistent = (item.effects ?? []).some((e) => PERSISTENT_OPS.has(e.op));
  if (item.kind === 'passive' || persistent) {
    if (!state.passives.includes(id)) state.passives.push(id);
  }
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(...applyEffects(state, data, item.effects ?? [], { floor, source: item.name }).log);
  }
  return lines;
}

/** 勇者当前持有多少个该道具（钥匙看 keys，其余看背包） */
export function heldCount(state: GameState, id: string): number {
  if (KEY_ITEM_IDS.has(id)) return state.keys[id as KeyId];
  return state.bag[id] ?? 0;
}

/** 扣除道具。数量不足时返回 false，且不留下任何半途改动。 */
function takeItem(state: GameState, id: string, count: number): boolean {
  if (heldCount(state, id) < count) return false;
  if (KEY_ITEM_IDS.has(id)) {
    state.keys[id as KeyId] -= count;
  } else {
    state.bag[id] -= count;
    if (state.bag[id] <= 0) delete state.bag[id];
  }
  return true;
}

// ── 换层 ────────────────────────────────────────────────────────────

export function arriveOnFloor(state: GameState, data: GameData, floor: number, x: number, y: number): void {
  state.floor = floor;
  state.pos = { x, y };
  if (!state.visited.includes(floor)) {
    state.visited.push(floor);
    state.visited.sort((a, b) => a - b);
  }
  const f = floorOf(data, floor);
  pushLog(state, `进入第 ${floor} 层 · ${f.title}`, 'floor');
  state.stats.steps++;
  applyAura(state, data);
}

/** 楼层传送器：只能去已到过的楼层 */
export function travelTo(state: GameState, data: GameData, floor: number): UseResult {
  if (!state.visited.includes(floor)) {
    return { ok: false, message: `第 ${floor} 层还没去过，楼层传送器无法直达。` };
  }
  if (floor === state.floor) {
    return { ok: false, message: '已经在这一层了。' };
  }
  const drop = nearestStandable(state, data, floor, state.pos.x, state.pos.y);
  arriveOnFloor(state, data, floor, drop.x, drop.y);
  return { ok: true, message: `传送到第 ${floor} 层。` };
}

// ── 主步骤：向某方向走一步 ──────────────────────────────────────────

export function step(state: GameState, data: GameData, dir: Dir): StepResult {
  if (state.dead) return { kind: 'blocked', moved: false, message: '勇者已阵亡' };
  state.face = dir;

  const d = DIRS[dir];
  const nx = state.pos.x + d.dx;
  const ny = state.pos.y + d.dy;
  if (nx < 0 || ny < 0 || nx > 10 || ny > 10) {
    return { kind: 'blocked', moved: false, message: '塔墙挡住了去路' };
  }

  const floor = state.floor;
  const ent = entityAt(state, data, floor, nx, ny);

  // ① 怪物：先打，打赢才走上去
  if (ent && ent.type === 'monster') {
    const p = previewBattle(state, data, ent.id);
    if (!p) return { kind: 'blocked', moved: false, message: `未知怪物 ${ent.id}` };
    if (p.reason === 'unpierceable') {
      const msg = `${p.monster.name}：防御 ${p.monster.def} ≥ 攻击 ${state.atk}，完全打不动`;
      pushLog(state, msg, 'battle');
      return { kind: 'battle', moved: false, message: msg };
    }
    if (p.reason === 'heroDies') {
      const msg = `${p.monster.name}：预计损失 ${p.hpLoss} HP，超过当前生命 ${state.hp}，禁止硬拼`;
      pushLog(state, msg, 'warn');
      return { kind: 'battle', moved: false, message: msg };
    }

    state.hp -= p.hpLoss;
    state.stats.hpLost += p.hpLoss;
    state.stats.battles++;
    state.stats.kills++;
    const gain = p.monster.gold * goldMultiplier(state);
    // 原版金币即经验：击杀只加金币，不加经验值（progression.hasExperience = false）
    state.gold += gain;
    state.stats.goldEarned += gain;
    state.removed.add(entityKey(floor, nx, ny, 'monster', ent.id));
    const exec = p.execute ? '（一击必杀）' : '';
    const cnt = p.appliedCounters?.length ? '（特攻生效）' : '';
    pushLog(
      state,
      `击败 ${p.monster.name}${exec}${cnt}：损失 ${p.hpLoss} HP，获得 ${gain} 金币`,
      'battle'
    );
    checkDeath(state);
    if (state.dead) return { kind: 'battle', moved: false, message: '勇者阵亡' };
    return moveOnto(state, data, floor, nx, ny, 'battle');
  }

  // ② 道具 / NPC
  if (ent) {
    if (ent.type === 'item') {
      const item = data.items[ent.id];
      if (!item) return { kind: 'blocked', moved: false, message: `未知道具 ${ent.id}` };
      state.removed.add(entityKey(floor, nx, ny, 'item', ent.id));

      const got = grantItem(state, data, ent.id, 1, floor);
      const detail = got.length ? `（${got.join('，')}）` : '';
      pushLog(state, `拾得 ${item.name}${detail}`, 'loot');
      checkDeath(state);
      return moveOnto(state, data, floor, nx, ny, 'pickup');
    }
    if (ent.type === 'npc') {
      const npc = data.npcs[ent.id];

      /** 取 NPC 当前该说的台词：楼层特定 > 通用 talk > note > 兜底 */
      const npcLine = (n: typeof npc): string => {
        if (!n) return `${ent.id} 站在这里。`;
        const floorLine = n.talkByFloor?.[String(floor)];
        if (floorLine) return floorLine;
        if (n.talk) return n.talk;
        if (n.note) return n.note;
        return `${n.name} 站在这里。`;
      };

      // 商店（sourceId 39）：三选一买属性，走 core/shop.mjs 的递增定价
      if (npc?.sourceId === SHOP_SOURCE_ID) {
        const msg = `${npc.name}：${npcLine(npc)}`;
        pushLog(state, msg, 'talk');
        return { kind: 'talk', moved: false, message: msg, openUi: 'shop' };
      }

      // 商人（sourceId 33）：只有本层配了商品才开交易界面，否则按普通 NPC 处理
      if (npc?.sourceId === MERCHANT_SOURCE_ID) {
        const offers = merchantOffers(state, data, floor);
        if (offers.length > 0) {
          const msg = `${npc.name}：${npcLine(npc)}`;
          pushLog(state, msg, 'talk');
          return { kind: 'talk', moved: false, message: msg, openUi: 'merchant' };
        }
      }

      const msg = `${npc?.name ?? ent.id}：${npcLine(npc)}`;
      pushLog(state, msg, 'talk');
      // NPC 不可踩踏：对话后勇者留在原地
      return { kind: 'talk', moved: false, message: msg };
    }
  }

  // ③ 地形
  const ch = tileAt(state, data, floor, nx, ny);
  const info = data.byChar[ch];
  if (!info) return { kind: 'blocked', moved: false, message: `未知地形 ${ch}` };

  if (ch === 'w') {
    patchTile(state, floor, nx, ny, '.');
    pushLog(state, '撞破了一面假墙。', 'info');
    return moveOnto(state, data, floor, nx, ny, 'fakewall');
  }

  if (info.key) {
    if (state.keys[info.key] <= 0) {
      const msg = `没有${keyName(info.key)}，打不开${info.name}`;
      pushLog(state, msg, 'warn');
      return { kind: 'blocked', moved: false, message: msg };
    }
    state.keys[info.key] -= 1;
    patchTile(state, floor, nx, ny, '.');
    pushLog(state, `用掉 1 把${keyName(info.key)}打开${info.name}`, 'info');
    return moveOnto(state, data, floor, nx, ny, 'door');
  }

  if (!info.passable) {
    const msg = `${info.name}无法通行`;
    return { kind: 'blocked', moved: false, message: msg };
  }

  return moveOnto(state, data, floor, nx, ny, 'move');
}

/** 走上某格，并按需触发楼梯 / 领域 */
function moveOnto(state: GameState, data: GameData, floor: number, x: number, y: number, kind: StepKind): StepResult {
  state.pos = { x, y };
  state.stats.steps++;

  const stair = [...floorOf(data, floor).stairs.up, ...floorOf(data, floor).stairs.down].find(
    (s) => s.x === x && s.y === y
  );

  if (stair) {
    const target = stair.to;
    const adjusted = stair.arriveAdjusted ? nearestStandable(state, data, target, stair.arrive.x, stair.arrive.y) : stair.arrive;
    arriveOnFloor(state, data, target, adjusted.x, adjusted.y);
    return { kind: 'stairs', moved: true, floorChanged: target, message: `前往第 ${target} 层` };
  }

  applyAura(state, data);
  return { kind, moved: true };
}

// ── 使用道具 ────────────────────────────────────────────────────────

export function useItem(state: GameState, data: GameData, id: string): UseResult {
  const item = data.items[id];
  if (!item) return { ok: false, message: `未知道具 ${id}` };
  if ((state.bag[id] ?? 0) <= 0) return { ok: false, message: `没有${item.name}` };

  const effects = item.effects ?? [];
  const res = applyEffects(state, data, effects, { floor: state.floor, source: item.name });

  const reusable = effects.some((e) => REUSABLE_OPS.has(e.op));
  if (!reusable) {
    state.bag[id] -= 1;
    if (state.bag[id] <= 0) delete state.bag[id];
  }

  const detail = res.log.length ? `：${res.log.join('，')}` : '';
  pushLog(state, `使用 ${item.name}${detail}`, 'loot');
  checkDeath(state);

  return { ok: true, message: `${item.name}${detail}`, openUi: res.openUi };
}

// ── 商店（第 45 层商人也卖属性，但常规来源是 sourceId 39 的商店） ──────

export function shopQuote(state: GameState, stat: Stat): { n: number; cost: number; gain: number; affordable: boolean } {
  const n = state.buyTimes;
  return {
    n,
    cost: shopCost(n),
    gain: shopGain(state.floor, stat),
    affordable: state.gold >= shopCost(n)
  };
}

export function buyStat(state: GameState, stat: Stat): UseResult {
  const q = shopQuote(state, stat);
  if (!q.affordable) {
    return { ok: false, message: `需要 ${q.cost} 金币，当前只有 ${state.gold}` };
  }
  state.gold -= q.cost;
  state[stat] += q.gain;
  state.buyTimes += 1;
  const msg = `花费 ${q.cost} 金币：${statName(stat)} +${q.gain}（下次价格 ${shopCost(state.buyTimes)}）`;
  pushLog(state, msg, 'loot');
  return { ok: true, message: msg };
}

// ── 给 UI 的说明性数据 ──────────────────────────────────────────────

export function currentTier(data: GameData, floor: number): { mul: number; hp: number; atk: number; def: number } {
  return tierOf(data, floor);
}

export function keyNameOf(k: KeyId): string {
  return keyName(k);
}

export function statNameOf(s: Stat): string {
  return statName(s);
}

// ── 商人交易（sourceId 33） ─────────────────────────────────────────
//
// 数据形态见 data/npcs.json → npcs.merchant.goodsByFloor：
//   6 层  买蓝钥匙 50 金币     12 层 买红钥匙 800 金币
//   28 层 **卖**黄钥匙 100 金币（唯一的反向条目）
//   45 层 买生命 +2000 / 1000 金币（唯一由商人出售属性的层）
//   47 层 买地震卷轴 3000 金币（该道具全塔唯一来源）
//   2 层  没有 goods，只有一次性剧情赠礼

/** 参考源码 role 层的取值 */
const MERCHANT_SOURCE_ID = 33;
const SHOP_SOURCE_ID = 39;

/**
 * 商人在某层的原始条目。字段随 op 变化，故全部可选。
 * 索引签名是为了让它能直接当 ItemEffect 喂给 applyEffects（赠礼条目就是这么用的）。
 */
interface RawTrade extends Record<string, unknown> {
  op: string;
  item?: string;
  count?: number;
  price?: number;
  stat?: string;
  value?: number;
  key?: string;
}

export interface MerchantOffer {
  /** 在报价列表中的稳定下标 —— 成交时原样回传给 `tradeAccept` */
  index: number;
  op: 'buyItem' | 'sellItem' | 'buyStat' | 'gift';
  /** 按钮上的动词：购买 / 出售 / 兑换 / 领取 */
  verb: string;
  /** 主标题，如「蓝钥匙 ×1」 */
  title: string;
  /** 副标题：这笔交易会做什么 */
  detail: string;
  /** 价格；赠礼为 0 */
  price: number;
  /** 金币收支，支出为负 —— UI 可直接用它做「成交后余额」预览 */
  goldDelta: number;
  /** 不能成交的原因；null 表示可以成交 */
  blocked: string | null;
  /** 一次性条目的领取标记，成交后写入 `state.claimed` */
  claimKey?: string;
  raw: RawTrade;
}

function merchantRow(
  data: GameData,
  floor: number
): { goods?: RawTrade[]; gifts?: RawTrade[]; note?: string } | undefined {
  const npc = Object.values(data.npcs).find((n) => n.sourceId === MERCHANT_SOURCE_ID);
  const rows = npc?.goodsByFloor as
    | Record<string, { goods?: RawTrade[]; gifts?: RawTrade[]; note?: string }>
    | undefined;
  return rows?.[String(floor)];
}

/**
 * 商人某层的备注。几条都不只是说明 —— 28 层是**反向**条目（玩家卖钥匙），
 * 45 层是全塔唯一由商人出售属性的层，47 层是地震卷轴唯一来源。
 * 不看这句，玩家会以为自己在 28 层也能买到钥匙。
 */
export function merchantNote(data: GameData, floor: number): string | null {
  return merchantRow(data, floor)?.note ?? null;
}

function itemLabel(data: GameData, id: string, count: number): string {
  const name = data.items[id]?.name ?? id;
  // 数量始终写出来：「买后 黄钥匙 ×1」比「买后 黄钥匙」明确，
  // 而且和「买后 黄钥匙 ×6」排在一起时，格式一致才不会看漏
  return `${name} ×${count}`;
}

/** 原始条目 → 一句中文。赠礼条目与商品条目共用这套描述。 */
function describeRaw(data: GameData, g: RawTrade): string {
  switch (g.op) {
    case 'buyItem':
      return `${itemLabel(data, String(g.item), Number(g.count ?? 1))}，${g.price} 金币`;
    case 'sellItem':
      return `交出 ${itemLabel(data, String(g.item), Number(g.count ?? 1))}，换 ${g.price} 金币`;
    case 'buyStat':
      return `${statName(g.stat as Stat)} +${g.value}，${g.price} 金币`;
    case 'addStat':
      return String(g.stat) === 'gold' ? `金币 +${g.value}` : `${statName(g.stat as Stat)} +${g.value}`;
    case 'addKey':
      return `${keyName(g.key as KeyId)} +${g.value}`;
    default:
      return g.op;
  }
}

/**
 * 商人在当前楼层的报价。本层没配商品就返回空数组 —— 调用方据此决定
 * 是开交易界面还是走普通对话。
 */
export function merchantOffers(state: GameState, data: GameData, floor: number): MerchantOffer[] {
  const row = merchantRow(data, floor);
  if (!row) return [];
  const out: MerchantOffer[] = [];

  (row.gifts ?? []).forEach((g, i) => {
    const claimKey = `gift:merchant:${floor}:${i}`;
    const claimed = state.claimed.has(claimKey);
    out.push({
      index: out.length,
      op: 'gift',
      verb: '领取',
      title: describeRaw(data, g),
      detail: '剧情赠礼，只能领一次',
      price: 0,
      goldDelta: g.op === 'addStat' && String(g.stat) === 'gold' ? Number(g.value) : 0,
      blocked: claimed ? '已领取' : null,
      claimKey,
      raw: g
    });
  });

  for (const g of row.goods ?? []) {
    const price = Number(g.price ?? 0);
    if (g.op === 'buyItem') {
      const id = String(g.item);
      const count = Number(g.count ?? 1);
      const have = heldCount(state, id);
      out.push({
        index: out.length,
        op: 'buyItem',
        verb: '购买',
        title: itemLabel(data, id, count),
        detail: `买后 ${itemLabel(data, id, have + count)}`,
        price,
        goldDelta: -price,
        blocked: state.gold < price ? `金币不足（还差 ${price - state.gold}）` : null,
        raw: g
      });
    } else if (g.op === 'sellItem') {
      const id = String(g.item);
      const count = Number(g.count ?? 1);
      const have = heldCount(state, id);
      out.push({
        index: out.length,
        op: 'sellItem',
        verb: '出售',
        title: itemLabel(data, id, count),
        detail: `卖后 ${itemLabel(data, id, Math.max(0, have - count))}`,
        price,
        goldDelta: price,
        blocked: have < count ? `没有足够的${data.items[id]?.name ?? id}（持有 ${have}）` : null,
        raw: g
      });
    } else if (g.op === 'buyStat') {
      const stat = String(g.stat) as Stat;
      const value = Number(g.value ?? 0);
      out.push({
        index: out.length,
        op: 'buyStat',
        verb: '兑换',
        title: `${statName(stat)} +${value}`,
        // 与商店的关键差别：这里是数据里写死的固定价，不推进全局购买次数
        detail: `买后 ${statName(stat)} ${state[stat]} → ${state[stat] + value}（固定价，不涨价）`,
        price,
        goldDelta: -price,
        blocked: state.gold < price ? `金币不足（还差 ${price - state.gold}）` : null,
        raw: g
      });
    }
    // 其余 op 一律跳过：宁可少显示一条，也不替数据猜一个交易语义
  }
  return out;
}

/** 成交。`index` 必须来自最近一次 `merchantOffers` 的返回。 */
export function tradeAccept(state: GameState, data: GameData, floor: number, index: number): UseResult {
  if (state.dead) return { ok: false, message: '勇者已阵亡，无法交易' };

  const offer = merchantOffers(state, data, floor).find((o) => o.index === index);
  if (!offer) return { ok: false, message: '这笔交易已经不存在了' };
  if (offer.blocked) return { ok: false, message: offer.blocked };

  // 先把要交出去的东西扣掉；扣不动就整笔取消，绝不留半成品状态
  if (offer.op === 'sellItem') {
    const id = String(offer.raw.item);
    const count = Number(offer.raw.count ?? 1);
    if (!takeItem(state, id, count)) return { ok: false, message: '数量不足，交易取消' };
  }

  let line = '';
  switch (offer.op) {
    case 'gift': {
      const res = applyEffects(state, data, [offer.raw], { floor, source: offer.title });
      if (offer.claimKey) state.claimed.add(offer.claimKey);
      line = `领取「${offer.title}」${res.log.length ? `：${res.log.join('，')}` : ''}`;
      break;
    }
    case 'buyItem': {
      state.gold -= offer.price;
      const got = grantItem(state, data, String(offer.raw.item), Number(offer.raw.count ?? 1), floor);
      line = `买入 ${offer.title}：花 ${offer.price} 金币${got.length ? `，${got.join('，')}` : ''}`;
      break;
    }
    case 'sellItem': {
      state.gold += offer.price;
      line = `卖出 ${offer.title}，得到 ${offer.price} 金币`;
      break;
    }
    case 'buyStat': {
      state.gold -= offer.price;
      const stat = String(offer.raw.stat) as Stat;
      const before = state[stat];
      state[stat] += Number(offer.raw.value ?? 0);
      line = `兑换 ${offer.title}：花 ${offer.price} 金币，${statName(stat)} ${before} → ${state[stat]}`;
      break;
    }
  }

  pushLog(state, line, 'loot');
  checkDeath(state);
  return { ok: true, message: line };
}

// ── 商店三选一（sourceId 39） ───────────────────────────────────────

export interface ShopOption {
  stat: Stat;
  /** 生命 / 攻击 / 防御 */
  label: string;
  /** 本次增量 —— 随楼层档位放大 */
  gain: number;
  /** 本次价格 —— 只随购买次数上涨，与楼层无关 */
  cost: number;
  /** 每点属性花多少金币，越小越划算。这是判断「该不该现在买」的直接指标。 */
  goldPerPoint: number;
  affordable: boolean;
  /** 买下之后该属性会变成多少 */
  after: number;
}

export interface ShopView {
  /** 这是第几次购买（从 1 起，全局共享） */
  n: number;
  cost: number;
  /** 本层收益倍率 */
  tierMul: number;
  /** 档位说明，如「第 40–49 层档位 · 收益 ×5」 */
  tierNote: string;
  /** 现有金币最多还能买几次 */
  remaining: number;
  /** 勇者当前金币 */
  gold: number;
  /** 买完这一次之后，下一次的价格 */
  nextCost: number;
  options: ShopOption[];
  /** 一句策略提示 */
  advice: string;
}

/**
 * 商店当前报价。定价与增量公式都在 `core/shop.mjs`，这里只组织成 UI 能直接画的结构，
 * **不重新实现一遍公式** —— 那样 Node 校验器和浏览器就会各算一套。
 */
export function shopOptions(state: GameState, data: GameData): ShopView {
  const n = state.buyTimes;
  const cost = shopCost(n);
  const tier = tierOf(data, state.floor);
  const tierDef = data.constants.shop.tiers.find((t) => state.floor >= t.floorFrom && state.floor <= t.floorTo);

  const options: ShopOption[] = (['hp', 'atk', 'def'] as Stat[]).map((stat) => {
    const gain = shopGain(state.floor, stat);
    return {
      stat,
      label: statName(stat),
      gain,
      cost,
      goldPerPoint: goldPerPoint(state.floor, stat, n),
      affordable: state.gold >= cost,
      after: state[stat] + gain
    };
  });

  return {
    n,
    cost,
    tierMul: tier.mul,
    tierNote: tierDef ? `第 ${tierDef.floorFrom}–${tierDef.floorTo} 层档位 · 收益 ×${tierDef.mul}` : `收益 ×${tier.mul}`,
    remaining: maxPurchasesFrom(state.gold, n),
    gold: state.gold,
    nextCost: shopCost(n + 1),
    options,
    advice: shopAdvice(tier.mul)
  };
}

/**
 * 商店策略提示。原版最优解「前期别买、把钱留到高楼层」不是玄学 ——
 * 它直接来自「价格只与购买次数有关、增量随楼层放大」这个设计。
 */
function shopAdvice(mul: number): string {
  if (mul >= 4) {
    return `高层档位（×${mul}）。价格只随购买次数涨、与楼层无关 —— 同样的钱在这里买最划算。`;
  }
  if (mul >= 3) {
    return `收益 ×${mul}，中档。再往上走档位更高，但每买一次后续价格都会涨，要权衡。`;
  }
  return `收益只有 ×${mul}。价格与楼层无关、只随购买次数上涨 —— 现在买是用最贵的钱换最少的属性，原版攻略「1–10 层不进商店」正是这个结论。`;
}

