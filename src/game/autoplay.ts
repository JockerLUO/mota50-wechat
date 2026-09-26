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
import { footprintAt, inFootprint, touchesFootprint } from './footprint';
import {
  CATEGORY_ORDER,
  THRESHOLD,
  blockingMonsters,
  guardedItemAt,
  guardianAt,
  itemScore,
  monsterScore,
  npcScore,
  type Category,
  type Score
} from './score';
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
   * 一件事至少要**赚几倍**才做 —— 三个调用方都读它（贪心的道具 / 贪心的怪物 /
   * 规划器的「可以绕过的怪」），**别在某一处另写一个倍数**。
   *
   * 「收益 > 代价」这条看着对，实际上会放过利润率 1.02 的交易 —— 实测 AI 用
   * 782 点血去换一枚价值 800 的红宝石，一层楼就掉到 188 血。
   * 血量是**一次性存量**（补的药水远少于能花的），所以薄利多销在这里是错的。
   * 道具要求 2 倍：它是永久收益，但换来的强度要等很久才兑现。
   *
   * ⚠️ **2026-09-26 的教训，值得记在这里**：换成 `score.ts` 的三套刻度那一轮，
   * 门槛被改成了「两类分数各自 ≥ 0」——**利润率这一档整个丢了**，而分数本身的
   * 量级同时被抬高了 10 倍以上（边际战斗价值 vs 商店价目表）。
   * 两个改动叠起来 = 「多烂的交易都做」：贪心每次肯付 30% 的血
   * （`MAX_SPEND_RATIO`），连付六次就掉到保命线，然后在两三层之间无限横跳
   * （20000 步里 19605 步是白走的），最远层从 **F9 掉到 F6**。
   * ⇒ **换刻度时必须同步问「原来的那条闸门现在是谁在读」**（与铁律 #13/#40 同族：
   *   改了产出方，却没问消费方还认不认这个量纲）。
   */
  ITEM_PROFIT: 2.0,
  /**
   * 「**只为金币**而战」的怪的收益门槛（守道具 / 守门的怪不走这一条）。
   *
   * ⚠️ 从 1.2 提到 3.0（2026-09-26，用户口径）：爬楼途中可以绕过的怪应当绕过去，
   * 别为几枚金币掉血；等攻防涨上来（→ 每场战斗的掉血变小）比值自然过线，
   * 那时再回头清怪才是划算的。
   *
   * 1.2 的病是「勉强不亏就开打」：一场赚 25 点血当量的战斗，代价是路上多挨
   * 两下 —— 而魔塔里血是**一次性存量**，补药远少于能花的。
   */
  MONSTER_PROFIT: 3.0,
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
export function keyValue(state: GameState, data: GameData, key: KeyId): number {
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
export function itemHpValue(state: GameState, data: GameData, id: string, p: Prices): number {
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

// ── 商人（sourceId 33）─────────────────────────────────────────────
//
// ⚠️ 这块是补上的缺口：在此之前 `decideAutoAction` **从不与商人交易**
//    （`sim.ts` 的 `case 'trade'` 只有一句「还没启用」）。
//    症状是可复算的：AI 在第 8 层要开两扇黄门（(2,0)(3,0)）上第 9 层，
//    手上 0 把黄钥匙，于是「下楼补货 → 下层已榨干 → 再上楼」空转 8000 步；
//    而第 6 层商人卖蓝钥匙（50 金币）、第 7 层商人卖黄钥匙 ×5（50 金币），
//    两个商人它都路过过。
//
//    根子在数据里：全塔 **193 把钥匙 vs 289 扇门**（`npm run validate` F 段），
//    钥匙是硬约束，只靠地上捡必然不够 —— 商人正是唯一的补给渠道。



// ── 「这怪该不该打」的两个硬判据 ────────────────────────────────────
//
// 用户口径（2026-09-26）：爬楼途中可以绕过的怪直接绕过；只有**它守着的东西**
// 值回票价时才硬打。所以「打不打」先问两件事，而不是先问金币：
//   ① 打它**会不会触发事件**（守门怪：开牢门 / 开自动门 / 开启区域通路）；
//   ② 它**是不是守着道具**（同格或占位块内有道具，如大乌贼守铁锹）。

/** 击败后会触发事件的怪 + 所有 BOSS —— 这些不是「可以跳过的怪」 */
const gateCache = new WeakMap<GameData, Set<string>>();

/**
 * 守门怪名单 —— **从 `data/events` 反推**，不手写。
 *
 * 手写名单的必然结局是「加了新事件忘了加名字」，而那不会报错，
 * 只会让 AI 把守门的怪当成普通杂兵绕过去、永远卡在门口（铁律 #23）。
 */
export function gateMonsters(data: GameData): Set<string> {
  const cached = gateCache.get(data);
  if (cached) return cached;
  const out = new Set<string>();
  for (const ev of data.events) {
    if (ev.trigger.op === 'defeated') out.add(ev.trigger.id);
    else if (ev.trigger.op === 'allDefeated') for (const id of ev.trigger.ids) out.add(id);
  }
  for (const [id, m] of Object.entries(data.monsters)) if (m.boss) out.add(id);
  gateCache.set(data, out);
  return out;
}

/** 这只怪是否**守着道具**（道具与它同格，或落在它的占位块内） */
export function guardsItem(
  state: GameState,
  data: GameData,
  floor: number,
  ent: { type: string; id: string; x: number; y: number }
): boolean {
  // 用 `footprintAt` 而不是 `entityFootprint`：调用方传进来的可能只是
  // `{type,id,x,y}`（planner 的 `entitiesOn` 就只给这四样），不需要完整 FloorEntity
  const fp = footprintAt(data, ent.x, ent.y, ent.type === 'monster' && !!data.monsters[ent.id]?.boss);
  for (const e of data.floors.get(floor)?.entities ?? []) {
    if (e.type !== 'item') continue;
    if (state.removed.has(`${floor}:${e.x}:${e.y}:item:${e.id}`)) continue;
    if (inFootprint(fp, e.x, e.y)) return true;
  }
  return false;
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
  let r = dijkstra(state, data, fight, from, floor);
  //
  // ⚠️ 必须记「已经算过哪些钥匙」，否则持有量会被**反复累加**。
  //
  // 旧版每轮把「当前够得着的全部钥匙」加到 `owned` 上，而 `owned` 是跨轮累加的
  // —— 同一把钥匙被数了 3~4 遍。高点位放行实际开不起的门，`stepToward` 走到
  // 门前被引擎拒绝，于是出现「决策器反复生成一条走不通的路」而日志里什么都没有。
  //
  // 正确的不动点：`owned = 起手持有 + 每一把**新**够得着的钥匙`（各算一次）。
  const counted = new Set<string>();
  const gained = emptyKeys();

  for (let iter = 0; iter < 8; iter++) {
    const pick = emptyKeys();
    for (const e of data.floors.get(floor)?.entities ?? []) {
      if (e.type !== 'item' || !isKeyId(e.id)) continue;
      if (state.removed.has(`${floor}:${e.x}:${e.y}:item:${e.id}`)) continue;
      const k = K(e.x, e.y);
      if (counted.has(k)) continue;
      const c = r.cost.get(k);
      if (c === undefined) continue;
      // 这把钥匙本身也得够得着（用**上一轮**的持有量判，避免自我循环论证）
      if (!affordWith(ownedWith(state.keys, gained), r.keys.get(k)!)) continue;
      counted.add(k);
      pick[e.id] += 1;
    }
    if (pick.yellowKey === 0 && pick.blueKey === 0 && pick.redKey === 0) break;
    for (const k of KEY_IDS) gained[k] += pick[k];
    r = dijkstra(state, data, fight, from, floor);
  }
  r.owned = ownedWith(state.keys, gained);
  return r;
}

/**
 * 本层「到每一格要掉多少血」的可达性代价表 —— 诊断用（`--scores` 的「路上代价」）。
 *
 * 单列一个导出是为了让**诊断与实际决策用同一个 `reach`**：
 * 诊断里自己再写一遍 Dijkstra 的话，两边会在某次改动后悄悄分叉，
 * 而分叉的表现是「分数看起来对、AI 却不是照它走的」——最难查的一类。
 */
export function reachCosts(state: GameState, data: GameData): Map<string, number> {
  return reach(state, data, true).cost;
}

/** 起手持有 + 本层能捡到的（逐把计一次） */
function ownedWith(base: Record<KeyId, number>, extra: Record<KeyId, number>): Record<KeyId, number> {
  const out = emptyKeys();
  for (const k of KEY_IDS) out[k] = base[k] + extra[k];
  return out;
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
  /** 分数所属的类别 —— **跨类只能按 `CATEGORY_ORDER` 排，不能比分数** */
  cat: Category;
  /** 「同层顺便清理」的免费怪（不掉血）：不看分数，排在最前 */
  free?: boolean;
  x: number;
  y: number;
  id: string;
  /** 给人看的一行名字（`道具「红宝石」(5,4)`）—— 只用于诊断输出与 `Decision.chosen` */
  label?: string;
  /** 净收益（价值 − 代价）。越大越优先 */
  gain: number;
  /** 到达这一格的路（不含起点） */
  path: Array<{ x: number; y: number }>;
  /** 撞上去的方向（NPC 用：站到旁边再撞） */
  bump?: Dir;
  /** `merchantOffers()` 里的报价下标 —— 商人目标专用（成交时要原样回传） */
  offerIndex?: number;
  /** 商店要买的属性 —— 由 `npcScore` 按边际价值挑好，这里不再重算 */
  stat?: 'hp' | 'atk' | 'def';
  note: string;
}

/**
 * 「这条路径真正要走到的那一格」的 key。
 *
 * 与 `K(g.x, g.y)`（目标**实体**的坐标）的区别只在 NPC 类目标上：
 * 商店/商人是「走到旁边再撞」，所以实体那一格是墙、不在可达图里。
 * 补钥匙要先知道「这条路上要开几扇门」，那只有路径末格答得上来。
 */
function pathEndKey(g: Goal): string {
  const last = g.path.length ? g.path[g.path.length - 1] : { x: g.x, y: g.y };
  return K(last.x, last.y);
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
  //
  // `targetKey` 必须是**路径真正要走到的那一格**，不能是「目标实体的坐标」。
  //
  // ⚠️ 这里踩过一次，症状是「站在商店门口反复撞门 13 次」：
  // 商店/商人的目标是「走到**旁边**再撞」，所以 `g.x,g.y` 是 **NPC 自己那一格**，
  // 而 NPC 在 `enterCost` 里被当成墙 —— 它**永远不会进可达图**，
  // `r.keys.get(NPC格)` 恒为 undefined，于是这个函数在第一行就 return null，
  // 「先去补钥匙」这一整套从来没触发过。调用方现在统一传路径末格。
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

/**
 * 进展：拾取与击杀都算。步数不算 —— 它只会一直涨，量不出「有没有收获」。
 *
 * 导出是因为**模拟器的循环探针也要用它**：判别「局势有没有变过」必须与决策层
 * 用同一个进度口径（写两份的话，一边改了另一边照样安静地绿 —— 铁律 #23）。
 */
export function progressOf(state: GameState): number {
  return state.removed.size + state.stats.kills;
}

/**
 * 钥匙数量的紧凑写法（`蓝1` / `黄2 蓝1` / `无`）。
 *
 * 只列非零的：诊断报告里满屏 `黄0 蓝0 红0` 反而看不出「缺的是哪一把」——
 * 而「缺哪一把」正是这些记录要回答的问题。
 */
function keysText(k: Record<KeyId, number>): string {
  const parts: string[] = [];
  if (k.yellowKey) parts.push(`黄${k.yellowKey}`);
  if (k.blueKey) parts.push(`蓝${k.blueKey}`);
  if (k.redKey) parts.push(`红${k.redKey}`);
  return parts.length ? parts.join(' ') : '无';
}

/** NPC 的一行名字（诊断用；id 与坐标都带上，因为同一个 id 在不同层有不同作用） */
function npcLabel(data: GameData, id: string, x: number, y: number): string {
  return `NPC「${data.npcs[id]?.name ?? id}」(${x},${y})`;
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
 * 「这个候选为什么没被选」的一条记录。
 *
 * ## 为什么必须有它
 *
 * 决策器有 **六段**（①保命 ②本层收割 ③上楼 ④传送器回溯 ⑤下楼补货 ⑥掉头兜底），
 * 段与段之间靠「上一段没给出动作」串起来，而每一段内部又有 4~6 个 `continue`
 * 闸门（够不着 / 钥匙不够 / 打不动 / 代价超上限 / 利润率不够 / 白来过…）。
 *
 * 于是「AI 不动了」这一句话对应十几种完全不同的病，**而报告里它们长得一样**。
 * 2026-09-26 追那条「同一局势重复 31 次」的红判据时，只能靠 `--scores` 的分数、
 * `--reach` 的 ASCII 格子图、`--verbose` 的日志三样东西**手工反推**，
 * 花掉的力气比写这段代码多得多 —— 而且推出来的结论还不敢打包票
 * （因为 `--reach` 走的是 `planner.reach`，贪心走的是另一份 `autoplay.reach`）。
 *
 * `Rejection` 把那段推理变成**机器输出**：挡在哪一段、挡的是谁、具体哪个数不够。
 */
/**
 * 被挡掉的**原因种类**（机器可归并的短标签）。
 *
 * `why` 那句话里带着具体数字（`路上代价 120 > 行动上限 20`），所以它**不能当键**：
 * 同一类病在不同局面下数字不同，归并出来的 Top-N 全是散条。
 * 而「整局里被挡得最多的是哪一类」恰恰是最有用的那个问题 ——
 * 2026-09-26 那一局 5000 步，答案就是「② 道具：代价超上限」这一个桶。
 */
export type RejectKind =
  | 'unreachable'
  | 'keys'
  | 'cost'
  | 'profit'
  | 'cantwin'
  | 'score'
  | 'stale'
  | 'bounce'
  | 'nopath'
  | 'nowork'
  | 'nobacktrack'
  | 'none';

export interface Rejection {
  /** 哪一段的哪一关挡的（`② 道具` / `③ 上楼` / `⑤ 下楼` …） */
  stage: string;
  /** 原因种类 —— 归并统计用的键（见 `RejectKind`） */
  kind: RejectKind;
  /** 被挡掉的那个候选（`道具「红宝石」(5,4)`） */
  what: string;
  /** 具体原因，尽量带数字（`路上代价 120 > 行动上限 20`） */
  why: string;
}

/** 一次决策的完整交代 —— 只有 `explainDecision()` 会去填它 */
export interface Decision {
  /** 与 `decideAutoAction()` 返回的**同一个**动作（同一套代码，不是第二份实现） */
  action: AutoAction;
  /** 选中了什么；`stop` 时就是停止原因 */
  chosen: string;
  /** 每一处被挡掉的候选 + 原因，按检查顺序排列 */
  rejected: Rejection[];
}

/**
 * 下一件事做什么。
 *
 * 返回 `stop` 表示这一局已经结束（通关 / 阵亡 / 走投无路）。
 *
 * ⚠️ 想知道**为什么不是别的**，用 `explainDecision()` —— 它就是在这里多带一个
 *    `rejected` 数组进来的，**不是第二份实现**（写两份的话，某次改动之后
 *    诊断说的和实际做的是两件事，而两边各自都对得上自己的期望值 —— 铁律 #23）。
 */
export function decideAutoAction(state: GameState, data: GameData, mem: AutoMemory = createAutoMemory()): AutoAction {
  return decide(state, data, mem, null).action;
}

/** 与 `decideAutoAction()` 完全同路，但额外交代每一处被挡掉的候选 */
export function explainDecision(state: GameState, data: GameData, mem: AutoMemory = createAutoMemory()): Decision {
  const rejected: Rejection[] = [];
  const d = decide(state, data, mem, rejected);
  return { action: d.action, chosen: d.chosen, rejected };
}

function decide(
  state: GameState,
  data: GameData,
  mem: AutoMemory,
  rej: Rejection[] | null
): { action: AutoAction; chosen: string } {
  /** 记一条「被这一关挡掉」。`rej === null`（正常决策）时是零开销 */
  const block = (stage: string, kind: RejectKind, what: string, why: string) => {
    rej?.push({ stage, kind, what, why });
  };
  /** 选定了 —— 顺手把「选的是什么」写下来，免得报告与动作两处各说各话 */
  const pick = (action: AutoAction, chosen: string) => ({ action, chosen });

  observe(mem, state);
  if (state.dead) return pick({ kind: 'stop', reason: '勇者阵亡' }, 'stop：勇者阵亡');
  if (isCleared(state, data)) return pick({ kind: 'stop', reason: '通关：真魔王已被击败' }, 'stop：通关');

  const floor = state.floor;

  // ── ① 保命：血线过低且身上有圣水就喝（HP 翻倍，越晚喝越亏，但先活着） ──
  if ((state.bag.holyWater ?? 0) > 0 && state.hp <= POLICY.HOLY_WATER_BELOW) {
    return pick(
      { kind: 'useItem', id: 'holyWater', goal: '生命过低，喝圣水翻倍' },
      `① 保命：喝圣水（hp ${state.hp} ≤ ${POLICY.HOLY_WATER_BELOW}）`
    );
  }

  // ── ② 本层做什么：三类分数各按自己的刻度算，再按类别次序决定先后 ──────
  //
  // ⚠️ 三个分数**不能放在一张榜上排**（刻度不通用，见 `score.ts` 的文件头）。
  // 允许的跨类依据只有 `CATEGORY_ORDER`：**类别次序为准，同类内按分数降序**。
  //
  // 唯一的例外是「同层顺便清理」：不掉血的怪分数为负（用户口径），
  // 但清掉它是**免费**的（不掉血、可达、同层），所以单独拎出来排在最前面 ——
  // 这不是分数比较，是一条明确的规则。
  const r = reach(state, data, true);
  const blocking = blockingMonsters(state, data, floor);
  const goals: Goal[] = [];
  const freeKills: Goal[] = [];

  // ── 道具（刻度：省下的血）──
  //
  // 判据本身在 `gateItem()`：**⑤/⑥ 的 `floorHasWork()` 读的是同一个函数**
  // （见「闸门」那一节的文件头注释）。这里只负责把 `kind`/`why` 变成报告的一行。
  for (const e of data.floors.get(floor)?.entities ?? []) {
    if (e.type !== 'item') continue;
    if (state.removed.has(`${floor}:${e.x}:${e.y}:item:${e.id}`)) continue;
    const label = `道具「${data.items[e.id]?.name ?? e.id}」(${e.x},${e.y})`;
    const g = gateItem(state, data, floor, e, r);
    if (!g.ok) {
      block('② 道具', g.kind, label, g.why);
      continue;
    }
    const { sc, path } = g.value;
    goals.push({
      label,
      kind: 'item',
      cat: 'item',
      x: e.x,
      y: e.y,
      id: e.id,
      gain: sc.total,
      path,
      note: `${sc.why}｜${sc.parts.map((x) => `${x.label} ${Math.round(x.value)}`).join(' · ')}`
    });
  }

  // ── 怪物（刻度：优先级，可正可负）──
  for (const e of data.floors.get(floor)?.entities ?? []) {
    if (e.type !== 'monster') continue;
    if (state.removed.has(`${floor}:${e.x}:${e.y}:monster:${e.id}`)) continue;
    const monName = data.monsters[e.id]?.name ?? e.id;
    const label = `怪「${monName}」(${e.x},${e.y})`;
    const g = gateMonster(state, data, floor, e, r, blocking);
    if (!g.ok) {
      block('② 怪物', g.kind, label, g.why);
      continue;
    }
    const v = g.value;
    if (v.free) {
      // 同层顺便清理：不掉血、可达 ⇒ 免费，排在最前（规则，不是分数比较）
      freeKills.push({
        kind: 'monster',
        cat: 'monster',
        free: true,
        x: e.x,
        y: e.y,
        id: e.id,
        label,
        gain: 0,
        path: v.path,
        note: `顺便清理 ${monName}（不掉血，免费）`
      });
      continue;
    }
    const sc = v.sc;
    goals.push({
      label,
      kind: 'monster',
      cat: 'monster',
      x: e.x,
      y: e.y,
      id: e.id,
      gain: sc.total,
      path: v.path,
      note: `${sc.why}｜${sc.parts.map((x) => `${x.label} ${Math.round(x.value)}`).join(' · ')}`
    });
  }

  // ── NPC（刻度：金币余量）──
  for (const e of data.floors.get(floor)?.entities ?? []) {
    if (e.type !== 'npc') continue;
    const g = gateNpc(state, data, floor, e, r);
    if (!g.ok) {
      block('② NPC', g.kind, npcLabel(data, e.id, e.x, e.y), g.why);
      continue;
    }
    const { sc, spot } = g.value;
    goals.push({
      label: npcLabel(data, e.id, e.x, e.y),
      kind: 'npc',
      cat: 'npc',
      x: e.x,
      y: e.y,
      id: e.id,
      gain: sc.total,
      path: pathOf(r, spot.x, spot.y),
      bump: spot.dir,
      offerIndex: sc.meta?.offerIndex,
      stat: sc.meta?.stat,
      note: `${sc.why}｜${sc.parts.map((x) => `${x.label} ${Math.round(x.value)}`).join(' · ')}`
    });
  }

  const ranked = [...freeKills, ...goals].sort(
    (a, b) =>
      Number(b.free ?? false) - Number(a.free ?? false) ||
      CATEGORY_ORDER.indexOf(a.cat) - CATEGORY_ORDER.indexOf(b.cat) ||
      b.gain - a.gain
  );
  if (ranked.length === 0) {
    block('② 本层', 'none', `第 ${floor} 层`, '一个候选都没通过闸门（逐条原因见上）');
  }
  for (const g of ranked) {
    const what = g.label ?? `${g.kind} ${g.id} (${g.x},${g.y})`;
    if (g.kind === 'npc' && g.id === 'shop' && g.path.length <= 1) {
      // 已经站在商店旁边 → 撞上去开商店
      // 买哪一项由 `npcScore` 按边际价值挑好（`g.stat`），这里不再重算
      return pick({ kind: 'buy', stat: g.stat ?? pickShopStat(state, data), goal: g.note }, `② 买属性：${what}`);
    }
    if (g.kind === 'npc' && g.offerIndex !== undefined && g.path.length <= 1) {
      // 已经站在商人旁边 → 直接把这一笔成交掉（报价下标就是这里那个）
      return pick({ kind: 'trade', index: g.offerIndex, goal: g.note }, `② 商人成交：${what}`);
    }
    const detour = keyDetour(state, data, r, pathEndKey(g), floor);
    if (detour) return pick(detour, `② 先去补钥匙（为了 ${what}）`);
    const a = stepToward(state, data, r, g.path, g.bump, g.note);
    if (a) return pick(a, `② 走向 ${what}`);
    block('② 本层', 'nopath', what, `路径第一步走不动（path ${g.path.length}，可能是换层落点或路径陈旧）`);
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
    const what = `上楼 → 第 ${s.to} 层（楼梯 ${s.x},${s.y}）`;
    const k = K(s.x, s.y);
    const c = r.cost.get(k);
    if (c === undefined) {
      block('③ 上楼', 'unreachable', what, '楼梯够不着（不在可达图里 —— 中间隔着开不起的门或打不动的怪）');
      continue;
    }
    if (!affordWith(r.owned, r.keys.get(k)!)) {
      block('③ 上楼', 'keys', what, `钥匙不够：路上要 ${keysText(r.keys.get(k)!)}，本层捡完只有 ${keysText(r.owned)}`);
      continue;
    }
    if (bounced(mem, state, s.to)) {
      block('③ 上楼', 'bounce', what, '空着手掉头（刚从这一层下来，且进展与实力都没长）');
      continue;
    }
    if (isStale(mem, s.to, state)) {
      block('③ 上楼', 'stale', what, '这一层上次白来过（进去没收获、实力也没长）');
      continue;
    }
    // 这一趟不能把自己走死，也不能为了上楼把血打光
    if (c > state.hp - POLICY.ROAD_RESERVE) {
      block('③ 上楼', 'cost', what, `路上代价 ${c} > hp ${state.hp} − 路上储备 ${POLICY.ROAD_RESERVE}`);
      continue;
    }
    const g: Goal = {
      kind: 'stairs',
      cat: 'stairs',
      x: s.x,
      y: s.y,
      id: `up:${s.to}`,
      label: what,
      gain: 1e6 - c,
      path: pathOf(r, s.x, s.y),
      note: `上楼前往第 ${s.to} 层`
    };
    if (!upGoal || g.gain > upGoal.gain) upGoal = g;
  }
  if (upGoal) {
    // 同上：手里钥匙不够就先去捡 —— 楼梯路线常常要开好几扇门
    const detour = keyDetour(state, data, r, pathEndKey(upGoal), floor);
    if (detour) return pick(detour, `③ 先去补钥匙（为了 ${upGoal.label ?? upGoal.id}）`);
    const a = stepToward(state, data, r, upGoal.path, upGoal.bump, upGoal.note);
    if (a) return pick(a, `③ ${upGoal.label ?? upGoal.id}`);
    block('③ 上楼', 'nopath', upGoal.label ?? upGoal.id, '路径第一步走不动');
  }

  // ── ④ 上不去：回头补强 ──────────────────────────────────────────────
  //
  // 打不动 / 没钥匙时，正确玩法是回低层把落下的东西清掉、把属性买上去再回来。
  // 楼层传送器是唯一的回溯工具（只能去到过的层）。
  const back = pickBacktrack(state, data);
  if (back !== null) return pick({ kind: 'travel', floor: back, goal: `回第 ${back} 层补强` }, `④ 传送器回第 ${back} 层`);
  block('④ 传送器回溯', 'nobacktrack', '楼层传送器', '未持有，或没有「还有活干」的层可回');

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
    const what = `下楼 → 第 ${s.to} 层（楼梯 ${s.x},${s.y}）`;
    const k = K(s.x, s.y);
    const c = r.cost.get(k);
    if (c === undefined) {
      block('⑤ 下楼', 'unreachable', what, '楼梯够不着（不在可达图里）');
      continue;
    }
    if (!affordWith(r.owned, r.keys.get(k)!)) {
      block('⑤ 下楼', 'keys', what, `钥匙不够：路上要 ${keysText(r.keys.get(k)!)}`);
      continue;
    }
    if (isStale(mem, s.to, state)) {
      block('⑤ 下楼', 'stale', what, '这一层上次白来过（进去没收获、实力也没长）');
      continue;
    }
    if (!floorHasWork(state, data, s.to)) {
      block('⑤ 下楼', 'nowork', what, '这一层「没有够得着的活干」（floorHasWork 为假）');
      continue;
    }
    const a = stepToward(state, data, r, pathOf(r, s.x, s.y), undefined, `下楼到第 ${s.to} 层补货`);
    if (a) return pick(a, `⑤ 下楼到第 ${s.to} 层补货`);
    block('⑤ 下楼', 'nopath', what, '路径第一步走不动');
  }

  // ── ⑥ 兜底：走投无路时把「不掉头」放开 ────────────────────────────
  //
  // 到了这里说明 ③④⑤ 全都没给出动作。此时掉头是唯一能换到另一层
  // （也就换到另一批资源）的办法 —— 但**不能无条件放开**，否则它就是
  // 第 ③⑤ 步的镜像副本，两层之间无限横跳（实测 3227 步仍在第 2 层）。
  // 所以兜底仍然要过「这一趟有意义吗」这一关：上楼看 `isStale`，下楼看 `floorHasWork`。
  for (const s of ups) {
    const what = `上楼 → 第 ${s.to} 层（掉头兜底）`;
    const k = K(s.x, s.y);
    const c = r.cost.get(k);
    if (c === undefined) {
      block('⑥ 兜底', 'unreachable', what, '楼梯够不着（不在可达图里）');
      continue;
    }
    if (!affordWith(r.owned, r.keys.get(k)!)) {
      block('⑥ 兜底', 'keys', what, `钥匙不够：路上要 ${keysText(r.keys.get(k)!)}`);
      continue;
    }
    if (isStale(mem, s.to, state)) {
      block('⑥ 兜底', 'stale', what, '这一层上次白来过');
      continue;
    }
    const a = stepToward(state, data, r, pathOf(r, s.x, s.y), undefined, `上楼到第 ${s.to} 层（掉头兜底）`);
    if (a) return pick(a, `⑥ 掉头上楼到第 ${s.to} 层`);
    block('⑥ 兜底', 'nopath', what, '路径第一步走不动');
  }
  for (const s of downs) {
    const what = `下楼 → 第 ${s.to} 层（掉头兜底）`;
    const k = K(s.x, s.y);
    const c = r.cost.get(k);
    if (c === undefined) {
      block('⑥ 兜底', 'unreachable', what, '楼梯够不着（不在可达图里）');
      continue;
    }
    if (!affordWith(r.owned, r.keys.get(k)!)) {
      block('⑥ 兜底', 'keys', what, `钥匙不够：路上要 ${keysText(r.keys.get(k)!)}`);
      continue;
    }
    if (!floorHasWork(state, data, s.to)) {
      block('⑥ 兜底', 'nowork', what, '这一层「没有够得着的活干」（floorHasWork 为假）');
      continue;
    }
    const a = stepToward(state, data, r, pathOf(r, s.x, s.y), undefined, `下楼到第 ${s.to} 层（掉头兜底）`);
    if (a) return pick(a, `⑥ 掉头下楼到第 ${s.to} 层`);
    block('⑥ 兜底', 'nopath', what, '路径第一步走不动');
  }

  return pick({ kind: 'stop', reason: `第 ${floor} 层无路可走` }, `stop：第 ${floor} 层无路可走`);
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

/**
 * 一条路径上「顺手能打掉的怪」的金币合计。
 *
 * 与 `itemScore` 的 `pathGold` 配对：路上打怪既掉血（路径代价）也进账（金币），
 * 只记前者会让「顺路拿一颗宝石」看起来永远亏本（见 `ItemScoreInput.pathGold`）。
 */
function pathGoldAlong(
  state: GameState,
  data: GameData,
  floor: number,
  path: { x: number; y: number }[]
): number {
  let g = 0;
  for (const cell of path) {
    const ent = entityAt(state, data, floor, cell.x, cell.y);
    if (!ent || ent.type !== 'monster') continue;
    if (state.removed.has(`${floor}:${ent.x}:${ent.y}:monster:${ent.id}`)) continue;
    g += data.monsters[ent.id]?.gold ?? 0;
  }
  return g;
}

/**
 * 找一格「可达且紧邻 (tx,ty)」的落脚点，用来撞 NPC。
 *
 * ⚠️ `floor` 必须显式传：本函数会被 `floorHasWork()` 拿去问**别的层**
 * （⑤ 下楼补货、`pickBacktrack` 回溯），而「相邻格能不能站」要查的是
 * **那一层**的地形与实体。第一版写死了 `state.floor` ⇒ 问第 4 层商店时
 * 查的是当前层的地图 —— 与铁律 #36 那个「记账必须用实体自己那一格」同族。
 */
function neighborSpot(
  state: GameState,
  data: GameData,
  r: Reach,
  tx: number,
  ty: number,
  floor = state.floor
): { x: number; y: number; dir: Dir } | null {
  for (const [d, v] of Object.entries(DIRS) as [Dir, { dx: number; dy: number }][]) {
    const x = tx - v.dx;
    const y = ty - v.dy;
    if (x < 0 || y < 0 || x > 10 || y > 10) continue;
    if (!r.cost.has(K(x, y))) continue;
    if (!affordWith(r.owned, r.keys.get(K(x, y))!)) continue;
    // 相邻格必须真的能站：不能有实体（NPC / 怪 / 道具），也不能是门或楼梯
    if (entityAt(state, data, floor, x, y)) continue;
    const ch = tileAt(state, data, floor, x, y);
    if (ch !== '.') continue;
    return { x, y, dir: d };
  }
  return null;
}

// ── 闸门：② 与 ⑤/⑥ 共用的**同一份**判据 ─────────────────────────────
//
// 为什么必须共用（2026-09-26 定，铁律 #23 / #54 / #58）：
//
//   ② 决定「本层哪个目标值得做」，⑤ 下楼 / ⑥ 掉头 决定「值不值得去某一层」，
//   两者问的其实是**同一个问题**：「到了那儿，真的会有东西可做吗？」
//
//   历史病：`floorHasWork()` 只查 `affordWith`（钥匙够不够），而 ② 还要查
//   `spendCap` 与利润率 ⇒ 它说「够得着，下楼吧」，落到楼下 ② 说
//   「路上代价 100 > 行动上限 20」⇒ 空手而归 ⇒ 上楼 ⇒ 再下楼 ……
//   实测 20000 步里 19605 步是这种往返（`SimReport.maxCycle = 31`）。
//   ⇒ **「够得着」与「真的会拿」是同一个概念的两处口径**，分开写就迟早不是
//     同一件事，而表现是「安静的原地打转」而不是报错（铁律 #23 的老病）。
//
// 于是三类目标的闸门**收在这里**：`kind`/`why` 同时就是 `--why` 报告里的那两列
// （`RejectKind` 是闭集，W4 守）。想改判据只有这一个地方可改 —— 这正是重点。

/**
 * 一道闸门的结论。
 *
 * `ok: false` 时给的是**可归并的 `kind`**（累计表的键）+ **一句人话**（给人看的）。
 */
type Gate<T> = { ok: true; value: T } | { ok: false; kind: RejectKind; why: string };

/**
 * 怪物闸门的两种成功形态。
 *
 * 写成**联合类型**（`free` 上的判别式）而不是「`sc: Score | null`」：
 * 后者要求每个消费点自己写 `!` 或再判一次空 —— 而「免费怪没有分数」
 * 是这条规则的一部分，不该让消费点各自记一遍。
 */
type MonsterGateValue =
  | { c: number; free: true; path: Array<{ x: number; y: number }> }
  | { c: number; free: false; sc: Score; path: Array<{ x: number; y: number }> };

/**
 * 道具闸门：可达 → 钥匙够 → 代价 ≤ 上限 → 利润率达标。
 *
 * 顺序即 `--why` 报告里的顺序：先报「够不着」，再报「钥匙不够」，
 * 再报「代价太高」，最后才是「不划算」—— 越靠前越接近物理事实。
 */
function gateItem(
  state: GameState,
  data: GameData,
  floor: number,
  e: { x: number; y: number; id: string },
  r: Reach
): Gate<{ c: number; sc: Score; path: Array<{ x: number; y: number }> }> {
  const k = K(e.x, e.y);
  const c = r.cost.get(k);
  if (c === undefined) return { ok: false, kind: 'unreachable', why: '够不着（不在可达图里）' };
  if (!affordWith(r.owned, r.keys.get(k)!)) {
    return {
      ok: false,
      kind: 'keys',
      why: `钥匙不够：需 ${keysText(r.keys.get(k)!)}，本层捡完只有 ${keysText(r.owned)}`
    };
  }
  if (c > spendCap(state)) {
    return { ok: false, kind: 'cost', why: `路上代价 ${c} > 行动上限 ${spendCap(state)}（hp ${state.hp}）` };
  }
  // 被怪守着的道具：分数**降低**（另一半记到怪头上，见 `GUARD_SHARE`）
  const path = pathOf(r, e.x, e.y);
  const sc = itemScore(state, data, {
    itemId: e.id,
    costHp: c,
    pathGold: pathGoldAlong(state, data, floor, path),
    guarded: guardianAt(state, data, floor, e.x, e.y) !== null
  });
  // ★ 利润率闸门（`POLICY.ITEM_PROFIT`，血的经济学，不是数值微调）。
  //   阈值与倍数取 `max`：`THRESHOLD` 是**本类刻度的下限**（三类各一个，不可合并）。
  const need = Math.max(THRESHOLD.item, c * (POLICY.ITEM_PROFIT - 1));
  if (sc.total < need) {
    return {
      ok: false,
      kind: 'profit',
      why: `利润率不够：得分 ${Math.round(sc.total)} < 需要 ${Math.round(need)}（代价 ${c} × 倍数 ${POLICY.ITEM_PROFIT}）`
    };
  }
  return { ok: true, value: { c, sc, path } };
}

/**
 * 怪物闸门：可达 → 钥匙够 → 打得动 → **免费怪先放行** → 代价 ≤ 上限 → 利润率达标。
 *
 * ⚠️ 「同层顺便清理」（不掉血 + 可达 ⇒ 免费）必须在这一份里判：
 * 它在 ② 是「不看分数直接做」的规则，在 ⑤/⑥ 是「这层还有活干」的证据。
 * 两边各写一次的话，「免费怪算不算活」会各答一遍，而答案迟早会分叉。
 */
function gateMonster(
  state: GameState,
  data: GameData,
  floor: number,
  e: { type: string; x: number; y: number; id: string },
  r: Reach,
  blocking: Set<string>
): Gate<MonsterGateValue> {
  const k = K(e.x, e.y);
  const c = r.cost.get(k);
  if (c === undefined) return { ok: false, kind: 'unreachable', why: '够不着（不在可达图里）' };
  if (!affordWith(r.owned, r.keys.get(k)!)) {
    return {
      ok: false,
      kind: 'keys',
      why: `钥匙不够：需 ${keysText(r.keys.get(k)!)}，本层捡完只有 ${keysText(r.owned)}`
    };
  }
  const pv = previewBattle(state, data, e.id);
  if (!pv) return { ok: false, kind: 'cantwin', why: '战斗预估拿不到（怪 id 或数据有问题）' };

  // ★ 同层顺便清理：不掉血 + 可达 ⇒ 免费，直接做（不看分数、不看利润率）
  if (pv.canWin && pv.hpLoss === 0) {
    return { ok: true, value: { c, free: true, path: pathOf(r, e.x, e.y) } };
  }
  if (!pv.canWin) return { ok: false, kind: 'cantwin', why: '打不动（会打死自己）' };
  if (pv.hpLoss > spendCap(state)) {
    return {
      ok: false,
      kind: 'cost',
      why: `掉血 ${pv.hpLoss} > 行动上限 ${spendCap(state)}（hp ${state.hp}）`
    };
  }
  const sc = monsterScore(state, data, e.id, {
    guards: guardedItemAt(state, data, floor, e),
    blocks: blocking.has(`${e.x},${e.y}`)
  });
  // ★ 同一道理：为金币而战要赚够 3 倍（`POLICY.MONSTER_PROFIT`）。
  //   守道具 / 挡路的怪由分数里的战略项负责，不靠放低这道闸门。
  const need = Math.max(THRESHOLD.monster, c * (POLICY.MONSTER_PROFIT - 1));
  if (sc.total < need) {
    return {
      ok: false,
      kind: 'profit',
      why: `利润率不够：得分 ${Math.round(sc.total)} < 需要 ${Math.round(need)}（代价 ${c} × 倍数 ${POLICY.MONSTER_PROFIT}）`
    };
  }
  return { ok: true, value: { c, sc, free: false, path: pathOf(r, e.x, e.y) } };
}

/**
 * NPC 闸门：分数够门槛 → 旁边有一格站得住。
 *
 * ⚠️ 这里**不查 `spendCap`**：NPC 是「走过去撞一下」，不花血（买属性花的是金币，
 * 而金币在 `npcScore` 里已经折进去了）。全局闸门都得是**这一类目标真的在乎的东西**，
 * 把道具的闸门照抄过来只会让无害的目标消失。
 */
function gateNpc(
  state: GameState,
  data: GameData,
  floor: number,
  e: { x: number; y: number; id: string },
  r: Reach
): Gate<{ sc: Score; spot: { x: number; y: number; dir: Dir } }> {
  const sc = npcScore(state, data, e.id, floor);
  if (sc.total < THRESHOLD.npc) {
    return {
      ok: false,
      kind: 'score',
      why: `分数 ${Math.round(sc.total)} < 门槛 ${THRESHOLD.npc}（${sc.why}）`
    };
  }
  const spot = neighborSpot(state, data, r, e.x, e.y, floor);
  if (!spot) return { ok: false, kind: 'nopath', why: '四周没有站得住的格子（走不过去撞）' };
  return { ok: true, value: { sc, spot } };
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
 * 这一层（或顺着它的下楼梯往下）还有没有**② 真的会做**的活干。
 *
 * 注意措辞：**不是「够得着」，是「② 真的会拿」**。这两者曾经是两处口径：
 *   · `floorHasWork` 只查 `affordWith`（钥匙够不够）；
 *   · ② 还查 `spendCap`（路上代价 ≤ 行动上限）与利润率闸门。
 * 于是它说「够得着，下楼吧」，落到楼下 ② 说「路上代价 100 > 行动上限 20」
 * ⇒ 空手而归 ⇒ 上楼 ⇒ 再下楼 …… 实测 20000 步里 **19605 步**是这种往返
 * （`SimReport.maxCycle = 31`；停下那一刻的报告里
 * 「② 道具 · cost」累计 12112 次、居首位 —— 就是这个病的指纹）。
 *
 * ⇒ 现在直接调 `gateItem` / `gateMonster` / `gateNpc`（**与 ② 同一份实现**）。
 *   想改判据只有那三个函数一个地方可改，两边不可能再分叉（铁律 #23 / #54）。
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
  const blocking = blockingMonsters(state, data, floor);
  for (const e of f.entities) {
    if (e.type === 'item') {
      if (state.removed.has(`${floor}:${e.x}:${e.y}:item:${e.id}`)) continue;
      if (gateItem(state, data, floor, e, r).ok) return true;
      continue;
    }
    if (e.type === 'monster') {
      if (state.removed.has(`${floor}:${e.x}:${e.y}:monster:${e.id}`)) continue;
      if (gateMonster(state, data, floor, e, r, blocking).ok) return true;
      continue;
    }
    if (e.type === 'npc') {
      // 商店层：门槛（金币够不够买一次）也在 `npcScore` 里，不再另写一遍
      if (gateNpc(state, data, floor, e, r).ok) return true;
    }
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
