/**
 * 自动通关 —— 「不用玩家操作也能打通这座塔」的决策核心。
 *
 * ## 这个文件为什么是纯函数
 *
 * `decideAutoAction(state, data)` 只读状态与数据，返回一个**动作**。
 * 它不认识 Pixi、不认识 `Game`、也不自己执行任何东西。
 *
 * 这样定有两个直接好处：
 *  1. **可以脱离渲染整局跑完** —— `tools/autoplay-sim.mjs` 就是这么做的，
 *     于是「自动通关能不能真的通关」是一条**可断言的等式**，而不是靠人盯着屏幕看；
 *  2. 编排层（`src/app/game.ts`）只是「按一下走一步」的执行器，
 *     动画、输入互斥那些事不用污染决策逻辑。
 *
 * ## 决策模型：代价是 HP，收益折算成 HP
 *
 * 魔塔里真正稀缺的资源只有一个：**生命值**。金币、钥匙、属性最终都换算成
 * 「能少掉多少血 / 能多打多少怪」，所以这里统一用 **HP 当量**计价：
 *
 *   代价 = 战斗损失 + 开门的摩擦 + 巫师领域伤害
 *   收益 = 道具价值 + 怪物金币 × 金币汇率（见 `statPrices`）
 *
 * 于是「这一架该不该打」就是一道**减法**，而不是一堆 if。
 *
 * ## 为什么是「分层贪心」而不是全局最优解
 *
 * 魔塔的完整最优解是一个带资源约束的规划问题（钥匙 4 把对 11 扇红门、
 * 全塔只有约 17 次属性购买 —— 见 `constants.json.economy`），
 * 精确求解要搜索整棵决策树。这里用的是**分层贪心 + 回溯**：
 *
 *   ① 本层有净收益 > 0 的目标（道具 / 值得打的怪）→ 做最赚的那个
 *   ② 本层做完 → 走上楼梯推进
 *   ③ 走不动（打不动 / 没钥匙）→ 用楼层传送器**回退**到低层补强，再回来
 *
 * 第 ③ 步是这套策略能不能通关的关键：魔塔的标准玩法本来就是
 * 「上一区打不动了，回头把落下的宝石和怪清掉，攒够属性再上」。
 */

import type { GameData, KeyId, Stat } from '../data';
import { entityAt, livingMonsters, tileAt, type Dir, type GameState } from './state';
import { touchesFootprint } from './footprint';
import { previewBattle } from './engine/vitals';
import { auraStepDamage } from '../../core/combat.mjs';
import { hasAuraImmunity, shopCost, shopGain } from '../../core/shop.mjs';

// ── 动作 ────────────────────────────────────────────────────────────

export type AutoAction =
  /** 走一步（撞怪 / 开门 / 拾取 / 上下楼都由引擎的 `step()` 决定） */
  | { kind: 'step'; dir: Dir; goal: string }
  /** 用一件道具 */
  | { kind: 'useItem'; id: string; goal: string }
  /** 商店买属性 */
  | { kind: 'buy'; stat: Stat; goal: string }
  /** 商人成交（index 来自 `merchantOffers`） */
  | { kind: 'trade'; index: number; goal: string }
  /** 楼层传送器回溯 */
  | { kind: 'travel'; floor: number; goal: string }
  /** 停下：通关 / 阵亡 / 卡住。reason 会写进日志 */
  | { kind: 'stop'; reason: string };

// ── 策略参数 ────────────────────────────────────────────────────────
//
// 集中在这里是为了**可审计地调**：跑 `npm run autoplay` 会打印走到哪一层、
// 卡在哪，改策略时改的是这张表，不是散落的魔法数字。

export const POLICY = {
  /** 撞一次假墙的代价（几乎免费，但别让它变成「负代价」把路绕歪） */
  FAKE_WALL_COST: 2,
  /**
   * 单个动作最多付多少血：**当前生命的比例**与「留一条命」取小。
   *
   * 比例闸门两头都踩过，所以两个约束**都要**：
   *   · 只有比例 → 血掉到 258 时上限只剩几十，连杂兵都打不动，全塔无事可做
   *     （AI 开始 2→9→2 的大回环）；
   *   · 只有底线 → 902 血时肯为一件道具付 782 血，一层楼就见底。
   */
  MAX_SPEND_RATIO: 0.3,
  /** 打完 / 拿完至少还剩多少血 */
  SURVIVE_RESERVE: 120,
  /** 为「推进楼层」而战时留多少 —— 换层能换到新资源，所以比普通战斗敢赌一点 */
  ROAD_RESERVE: 60,
  /**
   * 一件事至少要**赚几倍**才做。
   *
   * 「收益 > 代价」这条看着对，实际上会放过利润率 1.02 的交易 —— 实测 AI 用
   * 782 点血去换一枚价值 800 的红宝石，一层楼就掉到 188 血。
   * 血量是**一次性存量**（补的药水远少于能花的），所以薄利多销在这里是错的。
   * 道具要求 2 倍：它是永久收益，但换来的强度要等很久才兑现；
   * 怪物要求 1.2 倍 —— 它主要的意义是开路，别为一点金币硬拼。
   */
  ITEM_PROFIT: 2.0,
  MONSTER_PROFIT: 1.2,
  /** 低于这个净收益就当作「不值得专程去」 */
  MIN_GAIN: 1,
  /** 生命低于这条线就喝圣水（HP 翻倍） */
  HOLY_WATER_BELOW: 500,
  /** 身上金币超过这么多就先消费掉再推进（另有 `hasWall` 强制触发） */
  SHOP_GOLD_TRIGGER: 400,
  /**
   * 「上楼缺这把钥匙」时给它的额外价值。
   *
   * 钥匙是**通行权**，价值取决于它能打开什么，而那要在规划时才知道。
   * 定死一个价（比如 80）会在第 7 层这种地方卡死 —— 实测：拿 (8,0) 那把
   * 黄钥匙要先开一扇门再打死挡路的骷髅，固定价刚好等于代价，AI 判「不值得」，
   * 于是永远凑不齐开门的钥匙。
   */
  KEY_URGENT: 4000,
  /** 钥匙的**底价**（HP 当量）。黄钥匙最多、红钥匙全塔只有几把，故单价递增 */
  KEY_BASE: { yellowKey: 300, blueKey: 900, redKey: 2500 } as Record<KeyId, number>,
  /**
   * 开一扇门的**摩擦成本**（HP 当量）。
   *
   * ⚠️ 它不等于钥匙的**价值** —— 那由 `keyValue()` 按稀缺度算，可以高到几千。
   * 这里只是「绕一下路」的量级，因为塔里的钥匙基本是「捡到就够用」，
   * 把开门记成「花掉一把稀缺钥匙」会让 AI 连眼前的门都不敢开（实测会卡死在第 1 层）。
   */
  DOOR_COST: { yellowKey: 40, blueKey: 120, redKey: 400 } as Record<KeyId, number>,
  /**
   * **1 金币折多少 HP —— 整套决策唯一的汇率旋钮。**
   *
   * 属性点折多少血不再另外拍脑袋，而是**从商店价目表推出来**：
   * 「买 1 点攻击要花多少金币」是 `shopCost(n) / shopGain(floor,'atk')`，
   * 乘以这个汇率就是 1 点攻击的 HP 当量。于是全塔只有这一个可调的数，
   * 而且它随楼层档位、已购买次数自动变化（后期钱更值钱 → 属性也更值钱）。
   *
   * 之前试过「把未来几百场战斗能省的血全折现到现在」那一套，结果算出
   * 1 金币 = 600 HP，AI 为 1 个金币去付 24 点血，23 场打光 1810 血。
   * 那是复利不是线性，拿来当线性汇率用必然过头。
   */
  GOLD_TO_HP: 25,
  /** 楼层传送器 / 飞行器这类「回溯与机动」能力的价值 —— 没有它就没有第 ④ 步 */
  MOBILITY: 2500,
  /** 免疫巫师领域（神圣盾）额外值多少 —— 领域伤害是后期最大的隐性支出 */
  AURA_IMMUNE: 3000
};

// ── 汇率：属性点 / 金币 折多少 HP ───────────────────────────────────
//
// 这是整套决策最容易拍错的地方，而**拍错的表现有两种，方向相反**：
//
//   · 估低了 → AI 一路冲塔什么都不捡（第一版手写价目表：红宝石 120，
//     而开门 + 打怪的代价是 200+，「专程去拿宝石」被判成亏本）；
//   · 估高了 → AI 为 1 个金币去付 24 点血，23 场战斗打光 1810 血。
//
// 两个都实测踩过，所以最后**不猜了**：属性与金币的汇率统一由商店价目表
// 推导（见 `statPrices`），全塔只留 `GOLD_TO_HP` 一个可调旋钮。

export interface Prices {
  /** +1 攻击折多少 HP */
  atkHp: number;
  /** +1 防御折多少 HP */
  defHp: number;
  /** 1 金币折多少 HP */
  goldHp: number;
}

/** 单个动作最多愿意付多少血：比例与「留一条命」取小（见 POLICY.MAX_SPEND_RATIO） */
function spendCap(state: GameState): number {
  return Math.max(0, Math.min(state.hp * POLICY.MAX_SPEND_RATIO, state.hp - POLICY.SURVIVE_RESERVE));
}

/**
 * 当前局势下的汇率。
 *
 * 三个数都由**商店价目表**推出来，不是拍的：
 *
 *   · 1 点攻击 = 「买 1 点攻击要花多少金币」× 金币汇率
 *              = `shopCost(n) / shopGain(floor,'atk')` × GOLD_TO_HP
 *   · 1 点防御 = 同上，用 def 那一档
 *   · 1 金币   = GOLD_TO_HP（唯一的旋钮）
 *
 * 于是它会**随楼层档位与已购买次数自动变化**：高楼层同样的钱能买到 5 倍的属性，
 * 于是属性相对金币变便宜，AI 会更愿意为金币付血 —— 这正是原版攻略
 * 「前期别买、把钱留到后面」的另一面。
 */
export function statPrices(state: GameState): Prices {
  const cost = shopCost(state.buyTimes + 1);
  const g = POLICY.GOLD_TO_HP;
  const atkHp = (g * cost) / shopGain(state.floor, 'atk');
  const defHp = (g * cost) / shopGain(state.floor, 'def');
  return { atkHp, defHp, goldHp: g };
}

/** 全塔各颜色门的总数（静态，只算一次） */
const doorCache = new WeakMap<GameData, Record<KeyId, number>>();

function doorTotals(data: GameData): Record<KeyId, number> {
  const cached = doorCache.get(data);
  if (cached) return cached;
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

/**
 * 一把钥匙现在值多少。
 *
 * 钥匙是**通行权**，它的价值取决于「还剩多少扇门、我手里有几把」——
 * 手里 30 把黄钥匙时第 31 把几乎不值钱，一把没有时它值一条命。
 * 所以按稀缺度缩放，而不是给一个固定价。
 */
function keyValue(state: GameState, data: GameData, key: KeyId): number {
  const total = doorTotals(data)[key];
  const held = state.keys[key];
  const shortage = Math.max(0, total - held);
  const scarcity = total > 0 ? shortage / total : 0;
  return POLICY.KEY_BASE[key] * (1 + 3 * scarcity);
}

/**
 * 一件道具值多少 HP。
 *
 * ⚠️ 这里**从 `data.items[id].effects` 反推**，不再手写价目表。
 * 手写表的下场是「加了一件新道具，AI 却按默认值 60 当垃圾」——
 * 那和判据里写死一份名单是同一种病（见铁律 #23）。
 */
function itemHpValue(state: GameState, data: GameData, id: string, p: Prices): number {
  const def = data.items[id];
  if (!def) return 0;
  let v = 0;
  for (const eff of def.effects ?? []) {
    switch (eff.op) {
      case 'addStat': {
        const n = Number(eff.value ?? 0);
        if (eff.stat === 'hp') v += n;
        else if (eff.stat === 'atk') v += n * p.atkHp;
        else if (eff.stat === 'def') v += n * p.defHp;
        break;
      }
      case 'mulStat':
        if (eff.stat === 'hp') v += state.hp * (Number(eff.value ?? 2) - 1);
        break;
      case 'addKey':
        v += keyValue(state, data, eff.key as KeyId);
        break;
      case 'mulGoldGain': {
        // 金币翻倍：值「剩下还没拿到的金币」× 汇率
        let left = 0;
        for (const [idx, f] of data.floors) {
          for (const e of f.entities) {
            if (e.type !== 'monster') continue;
            if (state.removed.has(`${idx}:${e.x}:${e.y}:monster:${e.id}`)) continue;
            left += data.monsters[e.id]?.gold ?? 0;
          }
        }
        v += left * p.goldHp;
        break;
      }
      case 'immune':
        if (eff.to === 'aura') v += POLICY.AURA_IMMUNE;
        break;
      case 'openFloorSelect':
        v += POLICY.MOBILITY; // 回溯能力 —— 第 ④ 步全靠它
        break;
      case 'changeFloor':
        v += POLICY.MOBILITY * 0.4;
        break;
      case 'teleportSymmetric':
        v += POLICY.MOBILITY * 0.3;
        break;
      case 'traitCounter':
        v += 800; // 对特定怪攻击翻倍：中后期是破 BOSS 的关键
        break;
      case 'clearTerrain':
        v += 500;
        break;
      case 'breakWall':
        v += 400;
        break;
      case 'bomb':
        v += 300;
        break;
      default:
        v += 30;
    }
  }
  // 已经持有的被动道具（大金币、怪物书…）再拿一份没有意义
  if (def.kind === 'passive' && state.passives.includes(id)) v = 0;
  return v;
}

// ── 可达性：加权 Dijkstra ───────────────────────────────────────────

const DIRS: Record<Dir, { dx: number; dy: number }> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 }
};

const K = (x: number, y: number) => `${x},${y}`;

/**
 * 站在 (x,y) 时，相邻巫师领域会扣多少血。
 *
 * 判定必须与 `applyAura` 同规 —— 都走 `touchesFootprint`（贴到**占位块**）。
 * 写成「到怪物**坐标**的曼哈顿距离 ≤ 1」会漏掉 BOSS 的 3×3 边缘，
 * 于是 AI 会以为「从魔王头顶走过去不吃领域伤害」，把路选死。
 */
function auraAt(state: GameState, data: GameData, x: number, y: number, floor = state.floor): number {
  const mons = livingMonsters(state, data, floor)
    .filter((m) => touchesFootprint(m.fp, x, y))
    .map((m) => data.monsters[m.id])
    .filter(Boolean);
  if (mons.length === 0) return 0;
  return auraStepDamage(mons, { auraImmune: hasAuraImmunity(state.passives, data.items) });
}

interface Enter {
  /** HP 当量代价；null = 走不进去 */
  cost: number | null;
  /** 需要消耗的钥匙 */
  key: KeyId | null;
  /** 这一格是不是怪（进入即开战） */
  monster: string | null;
  hpLoss: number;
}

/**
 * 进入某格的代价。
 *
 * ⚠️ `fight` 为 false 时怪被当成墙 —— 这是「**不打架能拿到什么**」那一层规划用的。
 * 两层规划是这个决策器的骨架：先看免费的，再看要付血才能拿的。
 */
function enterCost(state: GameState, data: GameData, x: number, y: number, fight: boolean, floor = state.floor): Enter {
  if (x < 0 || y < 0 || x > 10 || y > 10) return { cost: null, key: null, monster: null, hpLoss: 0 };
  const ch = tileAt(state, data, floor, x, y);
  const info = data.byChar[ch];
  if (!info) return { cost: null, key: null, monster: null, hpLoss: 0 };

  const ent = entityAt(state, data, floor, x, y);
  if (ent && ent.type === 'monster') {
    if (!fight) return { cost: null, key: null, monster: ent.id, hpLoss: 0 };
    const p = previewBattle(state, data, ent.id);
    if (!p || !p.canWin) return { cost: null, key: null, monster: ent.id, hpLoss: 0 };
    return { cost: p.hpLoss, key: null, monster: ent.id, hpLoss: p.hpLoss };
  }
  //
  // NPC 一律当成**墙**。
  //
  // ⚠️ 这不是保守，是**必须与引擎同规**：撞 NPC 触发的是「搭话」（`step.ts` 的
  // `bumpTalk`），勇者**不会走上去**，`moved` 是 false。把它算成可通行
  // （第一版给它 8 点代价，本意只是「别反复从它身上碾过去」）的后果是：
  // 最短路穿过 NPC → 勇者走到它面前原地搭话 → 同一个动作重复几百步，
  // 而日志里既没有 blocked 也没有报错，看起来完全不像卡住。
  // 实测卡在第 9 层 (10,3) 智者这里，805 步后才被死循环探针抓到。
  //
  // 真要找 NPC（商店、商人）走 `neighborSpot`：站到旁边再撞过去。
  if (ent && ent.type === 'npc') return { cost: null, key: null, monster: null, hpLoss: 0 };

  if (info.key) return { cost: POLICY.DOOR_COST[info.key], key: info.key, monster: null, hpLoss: 0 };
  if (ch === 'w') return { cost: POLICY.FAKE_WALL_COST, key: null, monster: null, hpLoss: 0 };
  // 'a' 自动门 / 'D' 牢门由事件开启，'~' 岩浆要雪花 —— 都当作走不进去
  if (!info.passable) return { cost: null, key: null, monster: null, hpLoss: 0 };

  return { cost: auraAt(state, data, x, y, floor), key: null, monster: null, hpLoss: 0 };
}

interface Reach {
  cost: Map<string, number>;
  prev: Map<string, string>;
  keys: Map<string, Record<KeyId, number>>;
  /**
   * 把这一层的钥匙捡完以后一共会有几把（不动点）。
   *
   * ⚠️ 判「够不够开门」必须用**这个**而不是 `state.keys`。
   * 用当前持有量的话，「先绕过去拿两把黄钥匙、再回来开这扇门」这种路径
   * **根本不会进入候选** —— Dijkstra 假设钥匙是开局就有的。
   * 实测后果：勇者揣着 1 把黄钥匙开了一扇门就上路，第 1 层 11 件道具
   * 全锁在剩下的门后面，从此再也没拿过，第 5 层就打不动了。
   */
  owned: Record<KeyId, number>;
}

function emptyKeys(): Record<KeyId, number> {
  return { yellowKey: 0, blueKey: 0, redKey: 0 };
}

function affordWith(owned: Record<KeyId, number>, need: Record<KeyId, number>): boolean {
  return KEY_IDS.every((k) => need[k] <= owned[k]);
}

/**
 * 从勇者当前位置出发的加权最短路。
 *
 * 代价是 HP 当量，所以用 Dijkstra（BFS 只在代价全相等时才对）。
 * 钥匙需求沿路径累计，最后用来判「这趟路走不走得起」。
 *
 * 外面再套一层**钥匙不动点**：能捡到的钥匙会让更多门变得可开，
 * 可开之后又能捡到更多钥匙 —— 迭代到不再变化为止（层数有限，必然收敛）。
 */
function reach(state: GameState, data: GameData, fight: boolean, from?: { x: number; y: number }, floor = state.floor): Reach {
  let owned: Record<KeyId, number> = { ...state.keys };
  let r = dijkstra(state, data, fight, from, floor);
  for (let iter = 0; iter < 8; iter++) {
    const pick = emptyKeys();
    for (const e of data.floors.get(floor)?.entities ?? []) {
      if (e.type !== 'item' || !isKeyId(e.id)) continue;
      if (state.removed.has(`${floor}:${e.x}:${e.y}:item:${e.id}`)) continue;
      const k = K(e.x, e.y);
      const c = r.cost.get(k);
      if (c === undefined) continue;
      // 这把钥匙本身也得够得着（用**上一轮**的持有量判，避免自我循环论证）
      if (!affordWith(owned, r.keys.get(k)!)) continue;
      pick[e.id] += 1;
    }
    if (pick.yellowKey === 0 && pick.blueKey === 0 && pick.redKey === 0) break;
    const next: Record<KeyId, number> = {
      yellowKey: state.keys.yellowKey + pick.yellowKey,
      blueKey: state.keys.blueKey + pick.blueKey,
      redKey: state.keys.redKey + pick.redKey
    };
    const grew = KEY_IDS.some((k) => next[k] > owned[k]);
    owned = next;
    if (!grew) break;
    r = dijkstra(state, data, fight, from, floor);
  }
  r.owned = owned;
  return r;
}

function dijkstra(state: GameState, data: GameData, fight: boolean, from?: { x: number; y: number }, floor = state.floor): Reach {
  const cost = new Map<string, number>();
  const prev = new Map<string, string>();
  const keys = new Map<string, Record<KeyId, number>>();
  const start = K(from?.x ?? state.pos.x, from?.y ?? state.pos.y);
  cost.set(start, 0);
  keys.set(start, emptyKeys());

  // 11×11=121 格，线性取最小就够，不必上堆
  const pending = new Set([start]);
  while (pending.size) {
    let best: string | null = null;
    let bestCost = Infinity;
    for (const k of pending) {
      const c = cost.get(k) ?? Infinity;
      if (c < bestCost) {
        bestCost = c;
        best = k;
      }
    }
    if (best === null) break;
    pending.delete(best);
    const [bx, by] = best.split(',').map(Number);
    for (const d of Object.values(DIRS)) {
      const nx = bx + d.dx;
      const ny = by + d.dy;
      const nk = K(nx, ny);
      const e = enterCost(state, data, nx, ny, fight, floor);
      if (e.cost === null) continue;
      const nc = bestCost + e.cost;
      if (nc < (cost.get(nk) ?? Infinity)) {
        cost.set(nk, nc);
        prev.set(nk, best);
        const kk = { ...keys.get(best)! };
        if (e.key) kk[e.key] += 1;
        keys.set(nk, kk);
        pending.add(nk);
      }
    }
  }
  return { cost, prev, keys, owned: emptyKeys() };
}

function pathOf(r: Reach, tx: number, ty: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  let cur: string | undefined = K(tx, ty);
  while (cur) {
    const [x, y] = cur.split(',').map(Number);
    out.unshift({ x, y });
    cur = r.prev.get(cur);
  }
  return out;
}

const KEY_IDS: KeyId[] = ['yellowKey', 'blueKey', 'redKey'];

function isKeyId(id: string): id is KeyId {
  return (KEY_IDS as string[]).includes(id);
}

// ── 目标 ────────────────────────────────────────────────────────────

interface Goal {
  kind: 'item' | 'monster' | 'stairs' | 'npc';
  x: number;
  y: number;
  id: string;
  /** 净收益（价值 − 代价）。越大越优先 */
  gain: number;
  /** 到达这一格的路（不含起点） */
  path: Array<{ x: number; y: number }>;
  /** 撞上去的方向（NPC 用：站到旁边再撞） */
  bump?: Dir;
  note: string;
}

/** 朝目标走一步：路径第一步；已经在目标格上（楼梯常见）就先挪开，下一步再踩回来 */
function stepToward(
  state: GameState,
  data: GameData,
  r: Reach,
  path: Array<{ x: number; y: number }>,
  bump: Dir | undefined,
  goal: string
): AutoAction | null {
  if (path.length > 1) {
    const next = path[1];
    for (const [d, v] of Object.entries(DIRS) as [Dir, { dx: number; dy: number }][]) {
      if (state.pos.x + v.dx === next.x && state.pos.y + v.dy === next.y) {
        return { kind: 'step', dir: d, goal };
      }
    }
    return null;
  }
  if (bump) return { kind: 'step', dir: bump, goal };
  //
  // 已经站在目标格上（典型是「落点正好是楼梯」—— 换层的落点修正会把勇者
  // 放在最近的可站格，而那常常就是楼梯本身）。楼梯只在**走上**时触发，
  // 站着不动不会换层，所以必须先挪开一格再踩回来。
  for (const [d, v] of Object.entries(DIRS) as [Dir, { dx: number; dy: number }][]) {
    const nx = state.pos.x + v.dx;
    const ny = state.pos.y + v.dy;
    if (!r.cost.has(K(nx, ny))) continue;
    const ch = tileAt(state, data, state.floor, nx, ny);
    if (ch !== '.') continue; // 别踩进另一条楼梯或门里
    return { kind: 'step', dir: d, goal: `${goal}（先挪开一格再踩回来）` };
  }
  return null;
}

/**
 * 目标路线要开的门、手上的钥匙不够时，先去把缺的那把捡来。
 *
 * 为什么 `reach()` 的钥匙不动点**不够**：不动点只回答「把本层钥匙全捡完、
 * 最终凑不凑得齐」，它**不规定顺序**。于是会出现「路径需要开 2 扇黄门，
 * 手上只有 1 把黄钥匙，而另一把黄钥匙就在路线旁边没捡」—— 不动点判得过
 * （全捡完就有 2 把），但真正走的时候第一步就撞在第二扇黄门上，卡死。
 *
 * 这一条在**走之前**先把缺口补上：比较「**现在手上**」的钥匙和「沿路要开」
 * 的门，只要某一种钥匙 `need[k] > state.keys[k]`（开的门比手里的多），
 * 就先朝本层最近的一把那种钥匙走一步，捡到再回来。
 * 返回「朝那把钥匙走一步」；没有缺口（或缺口捡不到）就返回 null。
 */
function keyDetour(
  state: GameState,
  data: GameData,
  r: Reach,
  targetKey: string,
  floor: number
): AutoAction | null {
  const need = r.keys.get(targetKey);
  if (!need) return null;
  // 找出「现在手上」不够开沿路门的那种钥匙，优先补它
  for (const k of KEY_IDS) {
    if (state.keys[k] >= need[k]) continue;
    // 本层有能捡到的这种钥匙吗？（用不动点后的 owned 判「最终够得着」）
    for (const e of data.floors.get(floor)?.entities ?? []) {
      if (e.type !== 'item' || e.id !== k) continue;
      if (state.removed.has(`${floor}:${e.x}:${e.y}:item:${e.id}`)) continue;
      const kk = K(e.x, e.y);
      const c = r.cost.get(kk);
      if (c === undefined) continue;
      if (!affordWith(r.owned, r.keys.get(kk)!)) continue;
      const a = stepToward(state, data, r, pathOf(r, e.x, e.y), undefined, `先捡 ${k}（去 ${targetKey} 缺它）`);
      if (a) return a;
    }
  }
  return null;
}

// ── 决策 ────────────────────────────────────────────────────────────

// ── 短期记忆 ────────────────────────────────────────────────────────
//
// 决策本身是纯函数，但「这一层是不是白来」「刚才是从哪一层过来的」属于**过程**，
// 不记下来就会在两层之间反复横跳 —— 实测第 7 ⇄ 第 8 层来回走了 40 多步：
// 第 8 层缺钥匙进不去，下到第 7 层；第 7 层已经榨干，于是**立刻又上第 8 层**。
// 两层各自看来都「没别的选」，合起来就是死循环。
//
// 记忆由调用方持有（模拟与游戏各持一份），`decideAutoAction` 只往里写，
// 不依赖任何模块级状态 —— 于是它仍然可以脱离渲染整局跑完。

export interface AutoMemory {
  /** 上一次进入的是哪一层（用来检测换层） */
  currentFloor: number | null;
  /**
   * 上一次换层：从哪来、到哪去，**以及换层那一刻的进展与实力**。
   *
   * 后两个字段是「掉头」这条规则能不能工作的关键。只记 from/to 的话，
   * 规则只能写成「不许回到来时的那一层」—— 那就把**补完货再回去**这条
   * 正经路线也一起堵死了（魔塔的标准玩法正是「下来变强、再上去」）。
   * 记下进展后，规则就变成了「**空着手**不许回去」，这才是对的那一刀。
   */
  lastHop: { from: number; to: number; progress: number; strength: number } | null;
  /** 进入每层时的进展计数（拾取 + 击杀） */
  atEntry: Map<number, number>;
  /** 离开每层时的进展计数 —— 与 atEntry 相等就是「白来一趟」 */
  atExit: Map<number, number>;
  /** 离开每层时的实力快照：白来一趟但**实力长了**，再去一次可能就通了 */
  strength: Map<number, number>;
}

export function createAutoMemory(): AutoMemory {
  return {
    currentFloor: null,
    lastHop: null,
    atEntry: new Map(),
    atExit: new Map(),
    strength: new Map()
  };
}

/** 进展：拾取与击杀都算。步数不算 —— 它只会一直涨，量不出「有没有收获」 */
function progressOf(state: GameState): number {
  return state.removed.size + state.stats.kills;
}

/** 换层记账。必须在决策**之前**跑，否则「这一层白来」永远读不到 */
function observe(mem: AutoMemory, state: GameState): void {
  if (mem.currentFloor !== null && mem.currentFloor !== state.floor) {
    mem.atExit.set(mem.currentFloor, progressOf(state));
    mem.strength.set(mem.currentFloor, strengthOf(state));
    mem.lastHop = {
      from: mem.currentFloor,
      to: state.floor,
      progress: progressOf(state),
      strength: strengthOf(state)
    };
  }
  if (!mem.atEntry.has(state.floor)) mem.atEntry.set(state.floor, progressOf(state));
  mem.currentFloor = state.floor;
}

/**
 * 回到 `target` 层算不算「刚从那儿来、又空着手回去」。
 *
 * 只有**既没进展、实力也没长**时才算 —— 补完货再上去是魔塔的正经玩法，
 * 不能一刀切地禁掉（详见 `AutoMemory.lastHop` 的注释）。
 */
function bounced(mem: AutoMemory, state: GameState, target: number): boolean {
  const h = mem.lastHop;
  if (!h || h.from !== target) return false;
  return progressOf(state) <= h.progress && strengthOf(state) <= h.strength;
}

/**
 * 下一件事做什么。
 *
 * 返回 `stop` 表示这一局已经结束（通关 / 阵亡 / 走投无路）。
 */
export function decideAutoAction(state: GameState, data: GameData, mem: AutoMemory = createAutoMemory()): AutoAction {
  observe(mem, state);
  if (state.dead) return { kind: 'stop', reason: '勇者阵亡' };
  if (isCleared(state, data)) return { kind: 'stop', reason: '通关：真魔王已被击败' };

  const floor = state.floor;

  // ── ① 保命：血线过低且身上有圣水就喝（HP 翻倍，越晚喝越亏，但先活着） ──
  if ((state.bag.holyWater ?? 0) > 0 && state.hp <= POLICY.HOLY_WATER_BELOW) {
    return { kind: 'useItem', id: 'holyWater', goal: '生命过低，喝圣水翻倍' };
  }

  // ── ② 本层有净收益的目标就先做（道具 / 值得打的怪 / 买属性） ──────────
  const r = reach(state, data, true);
  const p = statPrices(state);
  const goals: Goal[] = [];

  // 道具：不打架能拿到的最好；要打架才能拿的也算，代价已经在 cost 里
  //
  // 底线用 SURVIVE_RESERVE：见 POLICY 里那条长注释（比例闸门两头都踩过）。
  const itemCap = spendCap(state);
  for (const e of data.floors.get(floor)?.entities ?? []) {
    if (e.type !== 'item') continue;
    if (state.removed.has(`${floor}:${e.x}:${e.y}:item:${e.id}`)) continue;
    const k = K(e.x, e.y);
    const c = r.cost.get(k);
    if (c === undefined) continue;
    if (!affordWith(r.owned, r.keys.get(k)!)) continue;
    if (c > itemCap) continue;
    // 钥匙：只要这种钥匙还没过剩，就给一档**额外的**抢购价值。
    //
    // 为什么必须额外加一档：`keyValue()` 算的是稀缺度（几百到一千出头），
    // 而开门的摩擦价只有 40 —— 于是在「眼前这只怪值几千血」的对比下，
    // AI 会先去打怪，把钥匙留到最后。但钥匙是**通行权**：
    // 没它，门后的宝石和剑盾根本进不了候选集。实测第一版就是这么死的 ——
    // 揣着 1 把黄钥匙开了门就上路，第 1 层 11 件道具全锁在剩下的门后。
    const hunger = isKeyId(e.id) && state.keys[e.id] < doorTotals(data)[e.id] ? POLICY.KEY_URGENT : 0;
    const v = itemHpValue(state, data, e.id, p) + hunger;
    if (v < c * POLICY.ITEM_PROFIT) continue;
    goals.push({
      kind: 'item',
      x: e.x,
      y: e.y,
      id: e.id,
      gain: v - c,
      path: pathOf(r, e.x, e.y),
      note: `拾取 ${data.items[e.id]?.name ?? e.id}（价值 ${v.toFixed(0)}，代价 ${c.toFixed(0)}）`
    });
  }

  // 怪物：金币折算成 HP 再减损失。为开路而战由第 ③ 步兜底，这里只管「划不划算」
  for (const e of data.floors.get(floor)?.entities ?? []) {
    if (e.type !== 'monster') continue;
    if (state.removed.has(`${floor}:${e.x}:${e.y}:monster:${e.id}`)) continue;
    const mon = data.monsters[e.id];
    if (!mon) continue;
    const pv = previewBattle(state, data, e.id);
    if (!pv || !pv.canWin) continue;
    if (pv.hpLoss > spendCap(state)) continue;
    const k = K(e.x, e.y);
    const c = r.cost.get(k);
    if (c === undefined) continue;
    if (!affordWith(r.owned, r.keys.get(k)!)) continue;
    const gold = mon.gold * (state.passives.includes('bigGold') ? 2 : 1);
    const worth = gold * p.goldHp;
    if (worth < c * POLICY.MONSTER_PROFIT) continue;
    const gain = worth - c;
    goals.push({
      kind: 'monster',
      x: e.x,
      y: e.y,
      id: e.id,
      gain,
      path: pathOf(r, e.x, e.y),
      note: `击败 ${mon.name}（金币 ${gold} 折 ${(gold * p.goldHp).toFixed(0)}，代价 ${c.toFixed(0)}）`
    });
  }

  const bestOther = goals.filter((g) => g.gain > POLICY.MIN_GAIN).sort((a, b) => b.gain - a.gain)[0];

  // 商店：金币攒够了就消费。档位越高越划算（价格只随次数涨、收益随楼层放大）
  //
  // ⚠️ 「前期别买」是原版最优解，但它是**有选择时**的最优解 ——
  // 一旦本层没别的赚头、或眼前有打不动的怪，手里的金币就只剩「换属性」这一条路。
  // 死守「30 层以上才买」会让 AI 拿着 71 金币在第 8 层干瞪眼（实测如此）。
  const shopNpc = (data.floors.get(floor)?.entities ?? []).find((e) => e.type === 'npc' && e.id === 'shop');
  if (shopNpc && state.gold >= shopCost(state.buyTimes)) {
    const worthIt =
      state.floor >= 30 || state.gold >= POLICY.SHOP_GOLD_TRIGGER || !bestOther || hasWall(state, data);
    const spot = worthIt ? neighborSpot(state, data, r, shopNpc.x, shopNpc.y) : null;
    if (spot) {
      const stat = pickShopStat(state, data);
      goals.push({
        kind: 'npc',
        x: shopNpc.x,
        y: shopNpc.y,
        id: 'shop',
        gain: 5000 + state.gold * p.goldHp * 0.5,
        path: pathOf(r, spot.x, spot.y),
        bump: spot.dir,
        note: `到商店买${stat === 'hp' ? '生命' : stat === 'atk' ? '攻击' : '防御'}（金币 ${state.gold}）`
      });
    }
  }

  //
  // ⚠️ 必须**按收益降序逐个试**，不能只试第一名就放弃。
  // `stepToward` 在「路径算得出来、但第一步走不通」时返回 null（例如勇者正好
  // 站在目标格上、而四周没有可挪的空地）。只试第一名会让 AI 直接掉到第 ③ 步
  // 「上楼」—— 于是本层明明还有一堆东西没拿，它却走了。
  const ranked = goals.filter((g) => g.gain > POLICY.MIN_GAIN).sort((a, b) => b.gain - a.gain);
  for (const g of ranked) {
    if (g.kind === 'npc' && g.id === 'shop' && g.path.length <= 1) {
      // 已经站在商店旁边 → 撞上去开商店
      return { kind: 'buy', stat: pickShopStat(state, data), goal: g.note };
    }
    const detour = keyDetour(state, data, r, K(g.x, g.y), floor);
    if (detour) return detour;
    const a = stepToward(state, data, r, g.path, g.bump, g.note);
    if (a) return a;
  }

  // ── ③ 本层没得赚了：往上走 ──────────────────────────────────────────
  //
  // 上楼梯本身不值钱，但它是唯一的推进手段，所以只要「付得起」就走：
  // 上楼之后会遇到新一层的道具与怪，那些才是收益。
  //
  // 两个例外都必须有，否则会原地打转：
  //   · 不掉头 —— 刚从 X 层下来又上 X 层，两层各自「没别的选择」，合起来是死循环；
  //   · 不白来 —— 上次到 X 层什么都没拿到，而且实力也没长进，再去还是白去。
  const ups = stairsOf(state, data, floor, 'up');
  let upGoal: Goal | null = null;
  for (const s of ups) {
    if (bounced(mem, state, s.to)) continue;
    if (isStale(mem, s.to, state)) continue;
    const k = K(s.x, s.y);
    const c = r.cost.get(k);
    if (c === undefined) continue;
    if (!affordWith(r.owned, r.keys.get(k)!)) continue;
    // 这一趟不能把自己走死，也不能为了上楼把血打光
    if (c > state.hp - POLICY.ROAD_RESERVE) continue;
    const g: Goal = {
      kind: 'stairs',
      x: s.x,
      y: s.y,
      id: `up:${s.to}`,
      gain: 1e6 - c,
      path: pathOf(r, s.x, s.y),
      note: `上楼前往第 ${s.to} 层`
    };
    if (!upGoal || g.gain > upGoal.gain) upGoal = g;
  }
  if (upGoal) {
    // 同上：手里钥匙不够就先去捡 —— 楼梯路线常常要开好几扇门
    const detour = keyDetour(state, data, r, K(upGoal.x, upGoal.y), floor);
    if (detour) return detour;
    const a = stepToward(state, data, r, upGoal.path, upGoal.bump, upGoal.note);
    if (a) return a;
  }

  // ── ④ 上不去：回头补强 ──────────────────────────────────────────────
  //
  // 打不动 / 没钥匙时，正确玩法是回低层把落下的东西清掉、把属性买上去再回来。
  // 楼层传送器是唯一的回溯工具（只能去到过的层）。
  const back = pickBacktrack(state, data);
  if (back !== null) return { kind: 'travel', floor: back, goal: `回第 ${back} 层补强` };

  // ── ⑤ 用下楼梯继续往下找活干（没有传送器时的回溯） ──────────────────
  //
  // 它排在「传送器回溯」之后，因为传送器能一步到位；但对前 30 层来说
  // （那时还没拿到传送器）这是唯一的回头路。
  //
  // ⚠️ 条件必须是「目标层**还有活干**」，不能是「不掉头」。
  // 第一版写成了后者，后果是：勇者刚从第 1 层上来，第 1 层的楼层传送器
  // 还没拿，而「不掉头」把回头路也堵死了 —— 于是 AI 永远没有回溯能力，
  // 卡死在 8 层再也上不去。这条是「不掉头」与「能回头」的分界线：
  //   · 上楼 = 推进，用 `isStale`（去过且没收获就不必再去）把关；
  //   · 下楼 = 补货，用 `floorHasWork`（下面确实还有东西）把关。
  const downs = stairsOf(state, data, floor, 'down');
  for (const s of downs) {
    if (isStale(mem, s.to, state)) continue;
    if (!floorHasWork(state, data, s.to)) continue;
    const k = K(s.x, s.y);
    const c = r.cost.get(k);
    if (c === undefined) continue;
    if (!affordWith(r.owned, r.keys.get(k)!)) continue;
    const a = stepToward(state, data, r, pathOf(r, s.x, s.y), undefined, `下楼到第 ${s.to} 层补货`);
    if (a) return a;
  }

  // ── ⑥ 兜底：走投无路时把「不掉头」放开 ────────────────────────────
  //
  // 到了这里说明 ③④⑤ 全都没给出动作。此时掉头是唯一能换到另一层
  // （也就换到另一批资源）的办法 —— 但**不能无条件放开**，否则它就是
  // 第 ③⑤ 步的镜像副本，两层之间无限横跳（实测 3227 步仍在第 2 层）。
  // 所以兜底仍然要过「这一趟有意义吗」这一关：上楼看 `isStale`，下楼看 `floorHasWork`。
  for (const s of ups) {
    if (isStale(mem, s.to, state)) continue;
    const k = K(s.x, s.y);
    const c = r.cost.get(k);
    if (c === undefined) continue;
    if (!affordWith(r.owned, r.keys.get(k)!)) continue;
    const a = stepToward(state, data, r, pathOf(r, s.x, s.y), undefined, `上楼到第 ${s.to} 层（掉头兜底）`);
    if (a) return a;
  }
  for (const s of downs) {
    if (!floorHasWork(state, data, s.to)) continue;
    const k = K(s.x, s.y);
    const c = r.cost.get(k);
    if (c === undefined) continue;
    if (!affordWith(r.owned, r.keys.get(k)!)) continue;
    const a = stepToward(state, data, r, pathOf(r, s.x, s.y), undefined, `下楼到第 ${s.to} 层（掉头兜底）`);
    if (a) return a;
  }

  return { kind: 'stop', reason: `第 ${floor} 层无路可走` };
}

// ── 辅助 ────────────────────────────────────────────────────────────

/**
 * 这一层是不是「白来过一趟」：上次进去什么都没拿到，而且实力也没长进。
 *
 * 只看进展不够 —— 实力（攻击 / 防御 / 钥匙）变了的话，同一个门这次也许就开得了。
 */
function isStale(mem: AutoMemory, floor: number, state: GameState): boolean {
  const enter = mem.atEntry.get(floor);
  const exit = mem.atExit.get(floor);
  if (enter === undefined || exit === undefined) return false; // 还没去过
  if (exit > enter) return false; // 上次去有收获
  const last = mem.strength.get(floor);
  return last === undefined || strengthOf(state) <= last; // 实力也没长进 → 再去还是白去
}

/**
 * 实力快照：只认 **攻击 / 防御 / 被动**。
 *
 * ⚠️ 钥匙和金币**不能**算进来。第一版把它们算进去了，后果是 `isStale()`
 * 几乎永远返回 false —— 捡一把黄钥匙就叫「实力长了」，于是「这层白来过」
 * 永远判不出来，AI 在第 4⇄第 5 层之间无限补货（实测）。
 * 而真正决定「上次打不动的怪这次打不打得动」的只有攻防与特攻道具。
 */
function strengthOf(state: GameState): number {
  return state.atk * 10000 + state.def * 1000 + state.passives.length * 100;
}

/**
 * 诊断用：把「为什么停在这儿」摊开。
 *
 * 没有它，模拟只报一句「第 N 层无路可走」，而这句话至少对应四种完全不同的病：
 * 走不到楼梯 / 钥匙不够 / 打得动但太亏 / 根本没找到目标。
 * 判据与调策略都要看这里。
 */
export function explainStop(state: GameState, data: GameData): string[] {
  const out: string[] = [];
  const r = reach(state, data, true);
  out.push(`位置：第 ${state.floor} 层 (${state.pos.x},${state.pos.y})，可达 ${r.cost.size} 格`);
  out.push(`钥匙：黄 ${state.keys.yellowKey} / 蓝 ${state.keys.blueKey} / 红 ${state.keys.redKey}`);
  for (const kind of ['up', 'down'] as const) {
    for (const s of stairsOf(state, data, state.floor, kind)) {
      const k = K(s.x, s.y);
      if (!r.cost.has(k)) {
        out.push(`${kind} 楼梯 (${s.x},${s.y}) → ${s.to}：**不可达**`);
        continue;
      }
      const need = r.keys.get(k)!;
      const ok = affordWith(r.owned, need);
      out.push(
        `${kind} 楼梯 (${s.x},${s.y}) → ${s.to}：代价 ${(r.cost.get(k) ?? 0).toFixed(0)}，` +
          `需钥匙 黄${need.yellowKey}/蓝${need.blueKey}/红${need.redKey}` +
          `${ok ? '' : '（**钥匙不够**）'}` +
          `${(r.cost.get(k) ?? 0) > state.hp - POLICY.ROAD_RESERVE ? '（**代价超过血线**）' : ''}`
      );
    }
  }
  const alive = (data.floors.get(state.floor)?.entities ?? []).filter(
    (e) => e.type === 'monster' && !state.removed.has(`${state.floor}:${e.x}:${e.y}:monster:${e.id}`)
  );
  const cannot = alive
    .map((e) => ({ e, p: previewBattle(state, data, e.id) }))
    .filter((x) => x.p && !x.p.canWin)
    .map((x) => `${data.monsters[x.e.id]?.name}(${x.p?.reason})`);
  if (cannot.length) out.push(`打不动的怪：${cannot.join('、')}`);
  out.push(`传送器：${(state.bag.floorTeleporter ?? 0) > 0 ? '持有' : '未持有'}`);
  return out;
}

/** 是否已通关：第 50 层的魔王（封印解除后是真魔王）已被击败 */
export function isCleared(state: GameState, data: GameData): boolean {
  const f = data.floors.get(50);
  if (!f) return false;
  for (const e of f.entities) {
    if (e.type !== 'monster') continue;
    // 封印解除后这一格被 swap 成真魔王；否则还是假魔王。通关 = 「当前这一格的魔王」已被击败。
    const cur = state.monsterSwap[`50:${e.x},${e.y}`] ?? e.id;
    if (!state.removed.has(`50:${e.x}:${e.y}:monster:${cur}`)) return false;
  }
  return true;
}

/** 某层的楼梯（数据里的 + 事件生成的） */
function stairsOf(state: GameState, data: GameData, floor: number, kind: 'up' | 'down') {
  const f = data.floors.get(floor);
  if (!f) return [];
  const out = f.stairs[kind].map((s) => ({ x: s.x, y: s.y, to: s.to }));
  for (const s of state.extraStairs) {
    // 事件生成的楼梯一律是「上」（通往下一区 / 终点）
    if (s.floor === floor && kind === 'up') out.push({ x: s.x, y: s.y, to: s.to });
  }
  return out;
}

/**
 * 商店买哪一项。
 *
 * 顺序不是固定的：
 *  · 眼前（本层或下一层）还有**打不动**的怪（atk ≤ 怪 def）→ 攻击是门槛，先补攻击；
 *  · 否则防御最划算 —— 一次买 def 的增量是 atk 的两倍（4×tier vs 2×tier），
 *    而且它减的是**每一回合**的掉血；
 *  · 血量见底才买生命。
 */
/**
 * 眼前是不是有「打不动」的怪（本层或下一层）。
 *
 * 攻击力是**门槛**而不是数值：atk ≤ 怪的 def 时损失是无限大，
 * 再多的血也没用。这道门槛过不去就应该把金币换成攻击。
 */
function hasWall(state: GameState, data: GameData): boolean {
  for (const f of [state.floor, state.floor + 1]) {
    const fd = data.floors.get(f);
    if (!fd) continue;
    for (const e of fd.entities) {
      if (e.type !== 'monster') continue;
      if (state.removed.has(`${f}:${e.x}:${e.y}:monster:${e.id}`)) continue;
      const m = data.monsters[e.id];
      if (m && state.atk <= m.def) return true;
    }
  }
  return false;
}

function pickShopStat(state: GameState, data: GameData): Stat {
  //
  // ⚠️ 生命是**最差的一档**，不能当成常规选项。
  // 同一次购买：hp+100×tier 对 atk+2×tier / def+4×tier —— 属性是**永久复利**
  // （每一点防御在之后每一场战斗的每一回合都省血），血只是一次性的存量。
  // 第一版写成 `hp < 400 就买血`，结果 AI 在 4、7、9 层连买三次生命（20+40+80
  // 金币），攻防一直停在 12/12，到第 7 层就再也打不动任何东西。
  // 只有「下一仗就会死」才值得拿钱换血。
  if (state.hp < POLICY.SURVIVE_RESERVE * 1.5) return 'hp';
  if (hasWall(state, data)) return 'atk';
  return 'def';
}

/** 找一格「可达且紧邻 (tx,ty)」的落脚点，用来撞 NPC */
function neighborSpot(
  state: GameState,
  data: GameData,
  r: Reach,
  tx: number,
  ty: number
): { x: number; y: number; dir: Dir } | null {
  for (const [d, v] of Object.entries(DIRS) as [Dir, { dx: number; dy: number }][]) {
    const x = tx - v.dx;
    const y = ty - v.dy;
    if (x < 0 || y < 0 || x > 10 || y > 10) continue;
    if (!r.cost.has(K(x, y))) continue;
    if (!affordWith(r.owned, r.keys.get(K(x, y))!)) continue;
    // 相邻格必须真的能站：不能有实体（NPC / 怪 / 道具），也不能是门或楼梯
    if (entityAt(state, data, state.floor, x, y)) continue;
    const ch = tileAt(state, data, state.floor, x, y);
    if (ch !== '.') continue;
    return { x, y, dir: d };
  }
  return null;
}

/**
 * 该回哪一层补强。
 *
 * 判据很土但有效：**回「最高那一层里还有净收益目标」的层**。
 * 只看已到过的层（传送器去不了没到过的地方），且排除当前层。
 */
function pickBacktrack(state: GameState, data: GameData): number | null {
  if (!(state.bag.floorTeleporter ?? 0)) return null;
  const cands: number[] = [];
  for (const f of state.visited) {
    if (f === state.floor) continue;
    if (!data.floors.has(f)) continue;
    cands.push(f);
  }
  // 从高到低试：高层剩下的收益通常更大（怪更值钱、宝石更好）
  cands.sort((a, b) => b - a);
  for (const f of cands) {
    if (floorHasWork(state, data, f)) return f;
  }
  return null;
}

/**
 * 这一层（或顺着它的下楼梯往下）还有没有**够得着**的活干。
 *
 * 为什么「够得着」三个字必须加：第一版只判「道具/怪还在不在」，于是低层那些
 * **锁在黄门后、当前钥匙够不着**的黄钥匙也被算成「有活干」，AI 兴冲冲下楼，
 * 到了发现「要开黄门、没黄钥匙」，空手而归又上楼 —— 这是「缺黄钥匙上楼 →
 * 盲目下楼 → 空手而归 → 再上楼」死循环的最后一环（实测跑满 12 万步）。
 * 现在从该层的**落地位置**做一次 reach，够不着的就不算活。
 *
 * `from` 是勇者到达这一层时的落脚点（上一层 down 楼梯的 arrive）。
 * 递归时传给下一层；入口（当前层）不传，用勇者当前位置。
 */
function floorHasWork(
  state: GameState,
  data: GameData,
  floor: number,
  depth = 0,
  seen: Set<number> = new Set(),
  from?: { x: number; y: number }
): boolean {
  if (depth > 50 || seen.has(floor)) return false;
  seen.add(floor);
  const f = data.floors.get(floor);
  if (!f) return false;
  // 从落地位置做一次可达性：锁在够不着的门后的东西不算「活」
  const r = reach(state, data, true, from, floor);
  for (const e of f.entities) {
    if (e.type === 'item' && !state.removed.has(`${floor}:${e.x}:${e.y}:item:${e.id}`)) {
      const k = K(e.x, e.y);
      if (r.cost.get(k) === undefined) continue; // 够不着
      if (!affordWith(r.owned, r.keys.get(k)!)) continue; // 钥匙不够
      return true;
    }
    if (e.type === 'monster' && !state.removed.has(`${floor}:${e.x}:${e.y}:monster:${e.id}`)) {
      const k = K(e.x, e.y);
      if (r.cost.get(k) === undefined) continue;
      const p = previewBattle(state, data, e.id);
      // 打不动的怪不算「有活干」—— 回去也拿它没办法
      if (p && p.canWin && p.hpLoss <= spendCap(state)) return true;
    }
  }
  // 商店层：只要还能买一次就值得回去
  if (f.entities.some((e) => e.type === 'npc' && e.id === 'shop') && state.gold >= shopCost(state.buyTimes)) {
    return true;
  }
  // 往下递归：用 down 楼梯的 arrive 作为下一层落地位置
  for (const s of f.stairs.down) {
    if (floorHasWork(state, data, s.to, depth + 1, seen, s.arrive ?? { x: s.x, y: s.y })) return true;
  }
  return false;
}

/**
 * 一次购买的收益（给日志用）。
 *
 * 单独导出是因为「自动通关到底买了几次、花了多少」要能在模拟报告里读出来，
 * 而这个数必须与 `shop.ts` 同源 —— 这里直接调 `core/shop.mjs`，不重算一遍。
 */
export function shopGainOf(floor: number, stat: Stat): number {
  return shopGain(floor, stat);
}
