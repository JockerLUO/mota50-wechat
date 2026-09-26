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
import { buyStat, step, tradeAccept, useItem } from './engine';
import { merchantOffers } from './engine/merchant';
import { previewBattle } from './engine/vitals';
import { entityAt, stairsOn, tileAt, type GameState } from './state';
//
// ⚠️ 估价函数**只有一份**（在 `autoplay.ts`）。这里刻意 import 它而不是另写一份
// 「最小的同源版」：两份价目表的必然结局是「改了一边、另一边静默用默认值」，
// 而那正是铁律 #23 说的「名单写死在多处必漏」。
// 依赖方向是 planner → autoplay（反向没有），所以不构成循环。
// ⚠️ 估价**只有一份**，在 `score.ts`（道具 / 怪物 / NPC 各一套刻度）。
// 这里刻意 import 它而不是另写一份「最小的同源版」：两份价目表的必然结局是
// 「改了一边、另一边静默用默认值」，而那正是铁律 #23 说的「名单写死在多处必漏」。
//
// 从 `autoplay` 只取 `POLICY` —— 那是**参数与闸门**（倍数 / 上限 / 保留量），
// 不是刻度。依赖方向 planner → { score, autoplay }，两者都不反向依赖 planner。
//
// 2026-09-27：迁移前这里 import 的是 `autoplay` 的**第一代估价**
// （`statPrices` / `itemHpValue` / 重名 `keyValue` / `gateMonsters` / `guardsItem`），
// 于是同一个项目里跑着两套刻度：贪心用第二代（三套刻度），planner 用第一代
// （全部折成 HP 当量）。这一条把它们统一到 `score.ts` —— 见 docs/ui-prototype.md §34。
import { POLICY } from './autoplay';
import {
  CATEGORY_ORDER,
  blockingMonsters,
  gateMonsters,
  goldWeight,
  guardedItemAt,
  guardianAt,
  itemScore,
  keyValue,
  monsterScore,
  npcOfferScore,
  type Category
} from './score';

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
  kind: 'item' | 'monster' | 'up' | 'down' | 'shop' | 'merchant' | 'use';
  x: number;
  y: number;
  id: string;
  /** 到达这一格的路径（不含起点） */
  path: { x: number; y: number }[];
  /**
   * 净收益 —— ⚠️ **刻度的含义随 `category` 变**（见 `score.ts` 文件头）：
   *   · `item`    → 血当量（道具刻度）；
   *   · `monster` → 优先级（怪物刻度）；
   *   · `npc`     → 金币余量（NPC 刻度）。
   *
   * 三者**不可直接比大小**，所以排序必须先看 `category`（`CATEGORY_ORDER`），
   * 同类内才比 `gain`。这就是「统一到一套刻度」在目标排序上的落点 ——
   * 与贪心（`autoplay.ts` 的目标排序）逐字同构。
   *
   * ⚠️ `up` / `down` / `use` 以及商店的 `gain` 是**搜索启发式**（推进 / 保命 /
   * 买哪项属性），不是估价 —— 它们没有对应的 `Score`，也不参与三套刻度的比较。
   */
  gain: number;
  /** 跨类次序依据 —— 与贪心同一张表（`score.ts` 的 `CATEGORY_ORDER`） */
  category: Category;
  /** 商店购买哪一项属性（kind === 'shop' 时用） */
  stat?: 'hp' | 'atk' | 'def';
  /** 商人报价下标（kind === 'merchant' 时用，成交要原样回传） */
  offerIndex?: number;
  /** 商人这一笔买的是什么（kind === 'merchant' 且买道具时用；钥匙硬约束要读它） */
  buyItem?: string;
}

/**
 * 阶段提示 —— 只保留「目标在哪一层、目标是什么道具」两件对生成目标有用的事。
 *
 * `null` 表示「没有阶段」（整局规划），此时退化成原来的行为。
 */
export interface PhaseHint {
  floor: number | null;
  itemId: string | null;
  /**
   * 阶段要击败的怪（`defeat` 类目标）。
   *
   * 估价用它算「**现在打不打得动**」—— 这是本版最关键的一项。
   * 没有它的时候，束搜索只看「离目标楼层还有几层」，于是会一路空手冲到
   * 第 10 层、站在骷髅队长面前才发现 atk 不够，而**回头补强的分支在束里排不上号**
   * （它们离目标楼层更远）。实测症状：z1-boss 阶段烧掉 12 万节点，停在 F9。
   */
  defeatId: string | null;
  /**
   * **下一个**要击败的 BOSS（本次阶段自己不是 defeat 类时也带着）。
   *
   * 为什么要往前看一格：`z1-power`（拿铁剑）自己不是 BOSS 阶段，但它结束时
   * 的那份状态就是 `z1-boss`（打骷髅队长）的起点。只看本阶段的估价会让它
   * 「拿到铁剑就算赢」—— 实测 18 个动作拿到剑、只剩 284 血 0 把钥匙，
   * 下一阶段从残局开始，怎么搜都补不回来。
   *
   * 带上下一个 BOSS 之后，估价里始终有「**按现在的三围去打它会掉多少血**」
   * 这一项（见 `beamScore` 的 ready），于是「拿剑」与「拿完还能打」不再是一回事。
   */
  futureBossId: string | null;
  /**
   * 从本阶段往后**所有**要打的 BOSS（按顺序）。
   *
   * 为什么不能只看「下一个」：下一个可能**当前根本打不动**（`def` 高于攻击力），
   * 此时 `previewBattle` 给的 `hpLoss = Infinity`，就绪度整项恒为 0 ——
   * 梯度消失，搜索退化成「乱走」。实测：把 `z1-guards`（打初级卫兵 def22）
   * 插进阶段表之后，`z1-power` 的 `futureBossId` 从骷髅队长（def15）
   * 变成了初级卫兵（def22），第一阶段立刻退化 —— 结束血量从 1062 掉到 **12**。
   * 有整条阶梯之后，`beamScore` 可以挑「第一个打得动的」当就绪度基准。
   */
  futureBossIds?: string[];
  /**
   * **抵达本阶段目标楼层时**手上至少要有的钥匙（来自 `walkthrough.json` 的 `arriveKeys`）。
   *
   * 为什么需要它：有些层的**落点是个被门围死的口袋** —— 第 9 层从 (5,0) 落地时，
   * 带 0 把钥匙只有 **6 格**可达（实测 `--reach 9 y0b0r0 500 30 14`），
   * 带 1 把黄钥匙变成约 50 格。而「朝目标楼层的楼梯」是 goal-serving 的，
   * 会被硬约束放行 —— 于是 AI 花掉最后一把钥匙爬上来，落地即被关住，阶段走不完。
   *
   * ⚠️ 两条设计约束都是实测换来的，别改：
   *   ① **只在目标楼层生效**（`state.floor >= phase.floor`）。全局生效会在
   *      爬楼的每一层都扣分，把「该花的钥匙」也拦下来 —— 实测直接让搜索卡死在 F5。
   *   ② **扣分，不剪枝**。剪枝在「所有路线都要花一把钥匙」时把搜索判死
   *      （实测把 z1-shield 从 F9 退回 F8）；扣分只是让「先多带一把再上路」
   *      在束里排得更靠前，走投无路时仍能照走。
   */
  arriveKeys?: Record<string, number>;
}

// ── 估价（与 autoplay 同源的最小版，避免循环依赖） ─────────────────

const K = (x: number, y: number) => `${x},${y}`;

/**
 * 当前楼层上还活着的实体 —— **逐格问 `entityAt`**，不自己遍历 `data.floors`。
 *
 * 为什么不能自己遍历：`entityAt` 是引擎侧「命中判定」的唯一收口（铁律 #36），
 * 它同时处理三件这里的搜索必须知道的事：
 *   · `removed` —— 打过 / 拿过的东西不再进候选；
 *   · `monsterSwap` —— 第 50 层的假魔王在封印解除后要按**真魔王**估价；
 *   · BOSS 占位块 —— 3×3 的魔王在 9 个格子上都命中，锚点仍是它自己那一格。
 * 自己遍历会漏掉后两条，于是 planner 算出的可通行性与引擎实际能走的不一致 ——
 * 那正是「搜索说打得过、真走一步却被拒」的来源。
 */
function entitiesOn(state: GameState, data: GameData, floor: number) {
  const out: { type: string; id: string; x: number; y: number }[] = [];
  const seen = new Set<string>();
  for (let y = 0; y < 11; y++) {
    for (let x = 0; x < 11; x++) {
      const e = entityAt(state, data, floor, x, y);
      if (!e) continue;
      // 按**实体自己那一格**去重（占位块有 9 格命中同一个实体）
      const key = `${e.type}:${e.x},${e.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: e.type, id: e.id, x: e.x, y: e.y });
    }
  }
  return out;
}

/**
 * 状态摘要 —— 去重用的「身份」。
 *
 * ⚠️ 旧版只写 `s.removed.size`（**个数**），于是「拿了铁剑」与「拿了等量垃圾道具」
 * 撞同一个哈希，束搜索会把唯一能通关的那条分支当成重复状态**静默剪掉**。
 * 个数换成集合内容是对的，但 `removed` 会长到 ~400 项、逐字符哈希太贵，
 * 所以这里取「**决定后续能力的那些量**」当身份：
 *   · `passives`（十字架 / 大金币 / 神圣盾…）× `bag`（圣水 / 铁锹 / 飞行器…）
 *     —— 这两样是**纯集合**，个数相同但内容不同时能力完全不同；
 *   · 三围 / 金币 / 钥匙 / 购买次数 —— 把「拿了多少属性、花了多少钱」折进去；
 *   · `removed.size` —— 单调量，兜住「杀了多少怪」。
 * 这三类合起来能区分所有**会影响后续决策**的差异，代价只有几十个字符。
 */
function stateDigest(s: GameState): string {
  const pass = s.passives.length ? [...s.passives].sort().join('+') : '';
  const bag = Object.keys(s.bag)
    .sort()
    .map((k) => `${k}${s.bag[k]}`)
    .join('+');
  return (
    `${s.floor}:${s.pos.x},${s.pos.y}:${s.hp}:${s.atk}:${s.def}:${s.gold}:` +
    `${s.keys.yellowKey},${s.keys.blueKey},${s.keys.redKey}:${s.buyTimes}:` +
    `${s.removed.size}:${pass}:${bag}`
  );
}

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
  //
  // ★ 一条路径的钥匙预算 = **起手持有 + 这条路上捡到的**，不含「绕路去别处捡的」。
  //
  // 这是与 `executeTarget` 对齐的唯一口径：目标执行时是**照着一条线性路径走**，
  // 路上捡不到的钥匙就是开不了那扇门。早先的版本给路径一个「本层能捡到的全部钥匙」
  // 的宽松预算（钥匙不动点），于是会生成「靠绕路钥匙才走得通」的路径 ——
  // 而 `executeTarget` 走到门前必然被引擎拒绝，分支静默消失。
  //
  // 「先绕过去捡钥匙、再回来开这扇门」并没有被牺牲：束搜索会先生成**捡钥匙**这个
  // 目标，执行完钥匙到手，下一轮迭代同一扇门自然就进了候选集。
  // 换句话说，**绕路是搜索层的事，不是单条路径的事**。
  const r = dijkstra(state, data, state.keys);
  r.owned = { ...state.keys };
  return r;
}

function dijkstra(state: GameState, data: GameData, budget: Record<KeyId, number>): ReachR {
  const cost = new Map<string, number>();
  const prev = new Map<string, string>();
  /** 沿路**开的门**（逐色累计） */
  const keys = new Map<string, Record<KeyId, number>>();
  /** 沿路**捡到的钥匙**（逐色累计）—— 判「后面那扇门开不开得起」要用它 */
  const picked = new Map<string, Record<KeyId, number>>();
  const start = K(state.pos.x, state.pos.y);
  cost.set(start, 0);
  keys.set(start, emptyKeys());
  picked.set(start, emptyKeys());

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
    //
    // 楼梯是**终点**，不是过道。
    //
    // 踩上楼梯引擎就换层了（`step` 的换层分支），于是「路径穿过楼梯」的剩余坐标
    // 全部失效 —— 那正是 `executeTarget` 里换层判定的由来。这里从生成侧就堵住：
    // 允许**走到**楼梯（它是目标），不允许**穿过**它。
    //
    // `best !== start` 的例外是必须的：换层的落点常常就是楼梯本身
    // （`travelTo` 用 `nearestStandable` 修正落点），起点若被当成不能展开，
    // 站在楼梯上的那一刻就判定「哪里都去不了」。
    if (best !== start) {
      const here = data.byChar[tileAt(state, data, state.floor, bx, by)];
      if (here?.stairs) continue;
    }
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

      const kb = keys.get(best)!;
      const pb = picked.get(best)!;
      // ★ 钥匙硬约束：按顺序付得起才允许进这扇门
      if (stepKey && kb[stepKey] + 1 > budget[stepKey] + pb[stepKey]) continue;

      // 怪：要能打得过，代价 = HP 损失
      // ⚠️ 走 `entityAt`（而不是自己按坐标在 entities 里找）—— 见 `entitiesOn` 的注释
      const ent = entityAt(state, data, state.floor, nx, ny);
      if (ent && ent.type === 'monster') {
        const p = previewBattle(state, data, ent.id);
        if (!p || !p.canWin) continue;
        stepCost += p.hpLoss;
      }
      const nc = bestCost + stepCost;
      if (nc < (cost.get(nk) ?? Infinity)) {
        cost.set(nk, nc);
        prev.set(nk, best);
        const kk = { ...kb };
        if (stepKey) kk[stepKey] += 1;
        keys.set(nk, kk);
        const pp = { ...pb };
        // 踩上去会先捡道具，所以这一格的钥匙对**之后**的门有效
        if (ent && ent.type === 'item' && KEY_IDS.includes(ent.id as KeyId)) {
          pp[ent.id as KeyId] += 1;
        }
        picked.set(nk, pp);
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

function generateTargets(state: GameState, data: GameData, phase?: PhaseHint): Target[] {
  const r = reach(state, data);
  const out: Target[] = [];
  const fl = state.floor;
  //
  // 两份「本层的事实」——目标生成期各算一次（都是本层规模的 BFS / 集合推导）：
  //   · `gates`    击败后会**触发事件**的怪（守门怪，事件口径）；
  //   · `blocking` 杀掉它就通往上楼梯的怪（**几何**口径，按格）。
  // 两者不可互相替代 —— 见 `score.ts` 的 `gateMonsters` 注释（第 8 层那两只初级卫兵
  // 不在通往楼梯的几何路径上，却挡着红钥匙；只按几何判断会把它们当可绕过的杂兵）。
  const gates = gateMonsters(data);
  const blocking = blockingMonsters(state, data, fl);
  // 阶段提示目前只用于「束搜索的估价」，目标生成本身不据此裁剪 ——
  // 裁掉的分支无法在后续轮次里回来，而「哪些门该开」的局部判断很容易裁错。
  void phase;

  for (const e of entitiesOn(state, data, fl)) {
    const k = K(e.x, e.y);
    const c = r.cost.get(k);
    if (c === undefined) continue;
    // 用钥匙不动点后的持有量判「够不够开门」（见 reach 的注释）
    if (!afford(r.owned, r.keys.get(k)!)) continue;
    if (e.type === 'item') {
      // 估价与贪心**同一个函数**（`score.itemScore`）—— 分数、明细、守卫转移全一致。
      // `costHp` 用到达这一格的路径代价 `c`（与 `executeTarget` 的实际走法同源）。
      const sc = itemScore(state, data, {
        itemId: e.id,
        costHp: c,
        guarded: guardianAt(state, data, fl, e.x, e.y) !== null
      });
      //
      // ⚠️ 这里**刻意不加**贪心那道利润率闸门（`POLICY.ITEM_PROFIT`）。
      //
      // 贪心是「每步只做一个动作」，必须挡掉薄利交易（否则一层楼把血花光）；
      // 而 planner 是**全局搜索**，分支越多越好，收敛交给 `beamScore` 与阶段目标。
      // 提前剪掉「利润薄」的道具会**永久**删掉一条分支（裁掉的分支回不来，
      // 见上面 `void phase` 的注释）。这是合并两代估价后**唯一保留的差异**。
      out.push({
        kind: 'item',
        category: 'item',
        x: e.x,
        y: e.y,
        id: e.id,
        path: pathOf(r, e.x, e.y),
        gain: sc.total
      });
    } else if (e.type === 'monster') {
      const pv = previewBattle(state, data, e.id);
      if (!pv || !pv.canWin) continue;
      //
      // 「可以绕过的怪」不当作目标 —— 与贪心同一个口径：
      // 爬楼途中绕过去，只有守门（事件） / 守道具的怪才专程去打。
      const guardsId = guardedItemAt(state, data, fl, e);
      const mustFight = gates.has(e.id) || guardsId !== null;
      //
      // ★ 闸门与排序是**两件事，都要**：
      //   ① 闸门 —— 「这笔划算吗」：金币收益 ≥ 代价 × 倍数（`POLICY.MONSTER_PROFIT`，
      //      与贪心读同一个常量）。**口径一字不改**，只把换算率从第一代的固定
      //      `GOLD_TO_HP = 25` 换成 `score.goldWeight()`（随楼层档位与当前属性变的那个）。
      //   ② 排序 —— 「先做哪一个」：`monsterScore` 给的优先级分数。
      //
      // ⚠️ 合并成一个数实测过会出事：「勉强不亏就开打」让爬楼途中一路清怪，
      // 血是**一次性存量**（铁律 #55 记的是同一个病）。
      const gold = (data.monsters[e.id]?.gold ?? 0) * (state.passives.includes('bigGold') ? 2 : 1);
      const worth = gold * goldWeight(state, data);
      if (!mustFight && worth < c * MONSTER_PROFIT_FOR_GOLD) continue;
      //
      // ⚠️ `c` 是 Dijkstra 代价，**进入怪物格时已经把 `pv.hpLoss` 记进去了**；
      // 而 `monsterScore` 也会自己算一遍战斗损失。所以把战斗那一份从 `c` 里
      // 剥出来当 `approachHp`（除打它之外的沿路掉血），否则战斗损失算两遍
      // —— 旧写法 `gold*p - c - pv.hpLoss` 就是这么系统性低估怪物目标的。
      const hpLoss = Number.isFinite(pv.hpLoss) ? pv.hpLoss : 0;
      const sc = monsterScore(state, data, e.id, {
        guards: guardsId,
        blocks: blocking.has(`${e.x},${e.y}`),
        approachHp: Math.max(0, c - hpLoss)
      });
      out.push({
        kind: 'monster',
        category: 'monster',
        x: e.x,
        y: e.y,
        id: e.id,
        path: pathOf(r, e.x, e.y),
        gain: sc.total + (mustFight ? 4000 : 0)
      });
    } else if (e.type === 'npc' && e.id === 'shop' && state.gold >= shopCostOf(state.buyTimes)) {
      // 商店拆成三个独立目标（买 atk / def / hp）——「属性购买时机」是全局约束之一，
      // 只给一个 `pickStat` 会让束搜索永远买同一项，失去「这轮该不该买 atk」的分歧。
      // 三项的 gain 用各自收益：atk 在有打不动的怪时最值钱，def 常态最划算，hp 兜底。
      for (const stat of ['atk', 'def', 'hp'] as const) {
        let g = 5000;
        if (stat === 'atk') g += hasUnpierceable(state, data) ? 8000 : 0;
        if (stat === 'def') g += 2000;
        //
        // ⚠️ 这里的 `g` 是**搜索启发式**（同一个商店拆成三项，让束搜索保留
        // 「这轮该不该买 atk」的分歧），**不是** `npcScore` 的金币余量刻度。
        // 两者的分工见 `score.ts` 的 `npcScore`：那个回答「值不值得买」，
        // 这个回答「先买哪一项」。`category: 'npc'` 只表达「它归 NPC 这一类」。
        out.push({
          kind: 'shop',
          category: 'npc',
          x: e.x,
          y: e.y,
          id: 'shop',
          path: pathOf(r, e.x, e.y),
          gain: g,
          stat
        });
      }
    }
  }

  //
  // 商人 —— 全塔唯一的钥匙补给渠道（`autoplay.ts` 的 `merchantGain` 有完整理由）。
  // 旧版 planner 完全没有这一类目标，于是它和贪心一样会卡在「缺钥匙但商人就在旁边」。
  const merchantNpc = (data.floors.get(fl)?.entities ?? []).find(
    (e) => e.type === 'npc' && e.id === 'merchant'
  );
  if (merchantNpc) {
    const spot = nearbySpot(state, data, r, merchantNpc.x, merchantNpc.y);
    if (spot) {
      for (const offer of merchantOffers(state, data, fl)) {
        if (offer.blocked) continue;
        const g = npcOfferScore(state, data, offer).total;
        if (!Number.isFinite(g) || g <= 0) continue;
        out.push({
          kind: 'merchant',
          category: 'npc',
          x: merchantNpc.x,
          y: merchantNpc.y,
          id: `merchant:${offer.index}`,
          path: pathOf(r, spot.x, spot.y),
          gain: g,
          offerIndex: offer.index,
          buyItem: String(offer.raw.item ?? '')
        });
      }
    }
  }

  // 保命：血线过低且身上有圣水（HP 翻倍，越晚喝越亏）
  if ((state.bag.holyWater ?? 0) > 0 && state.hp <= 500) {
    out.push({
      kind: 'use',
      // 归 `item` 类：它是道具刻度里最高的一档（`1e6`），排在首位不被别的类别抢。
      category: 'item',
      x: state.pos.x,
      y: state.pos.y,
      id: 'holyWater',
      path: [{ x: state.pos.x, y: state.pos.y }],
      gain: 1e6
    });
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
      // `stairs` 在 `CATEGORY_ORDER` 里排最后：上面三类都没得做才推进。
      category: 'stairs',
      x: s.x, y: s.y, id: `stair:${s.to}`,
      path: pathOf(r, s.x, s.y),
      gain: up ? 10000 : -1000 // 上楼是推进，下楼是回溯（启发式，不是估价）
    });
  }

  //
  // ⚠️ 出口处必须过滤掉「顺序不可行」的目标 —— 这是 2026-09-26 定位到的
  // 卡点直接原因。
  //
  // `reach()` 的钥匙不动点只说「把本层钥匙全捡完，最终够」，不规定顺序。
  // 于是它会生成一条「先撞黄门、而钥匙在门后」的楼梯路径；`executeTarget`
  // 走到门前被引擎拒绝 → 返回 false → 子节点不生成。**目标在、却永远走不到**，
  // 而报告里只表现为「阶段推进不上去」。
  //
  // 实测（第 5 层 (0,10)，0 把黄钥匙）：`up stair:6` 的顺序堵点是 (1,2)，
  // 连去 F9 的铁盾与 4 把黄钥匙都在门后 —— 21 个目标里只有 8 个真正走得到。
  // 过滤之后，束搜索的每一次展开都对应一条**真能走通**的路。
  return out
    .filter((t) => {
      if (!pathFeasible(state, data, t.path).ok) return false;
      //
      // ★ 钥匙硬约束（本版新增）。
      //
      // 软权重（`beamScore` 里按稀缺度给钥匙计价）挡不住这件事：花掉最后一把
      // 黄钥匙去开一扇只通向一枚宝石的门，在分数上只亏一点点，而**下一层的门
      // 直接开不了**。实测证据：z1-power 阶段结束时 0 把钥匙，紧接着的
      // z1-shield 阶段连第 5 层都出不去。
      //
      // 所以这里把它变成**硬条件**：阶段有明确目标楼层时，
      // **只有服务于该目标的行动才允许净消耗钥匙**，其余带门的目标一律不生成。
      if (phase && phase.floor !== null) {
        const net = netKeyCost(state, data, t.path);
        const spends = KEY_IDS.some((k) => net[k] > 0);
        // 只保留「目标服务」这一档。**储备刻意不做成剪枝** —— 见 `PhaseHint.reserveKeys`
        // 的注释：硬剪会把「所有通往目标的路线都要花一把钥匙」的处境直接判死，
        // 实测把 z1-shield 从 F9 退回到 F8。储备改在 `beamScore` 里扣分。
        if (spends && !goalServing(t, state.floor, phase)) return false;
      }
      return true;
    })
    //
    // ★ 排序必须**两级**：先类别（`CATEGORY_ORDER`），同类内才比 `gain`。
    //
    // 三个 `gain` 量纲不同（血当量 / 优先级 / 金币余量），直接比大小就是
    // 把它们偷偷当成同一个刻度用 —— 那正是第二代评分存在的理由
    // （见 `score.ts` 文件头）。这张表与贪心的目标排序是**同一张**，
    // 也就是「统一到一套刻度」在排序上的落点。
    .sort(
      (a, b) =>
        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
        b.gain - a.gain
    );
}

/**
 * 这条路径**按顺序**走得通吗（钥匙是沿路捡的）。
 *
 * ⚠️ `reach()` 的钥匙不动点只回答「把本层钥匙全捡完，最终够不够」，
 * 它**不规定顺序**：一条路径完全可能先撞上黄门、而它要用的那把黄钥匙
 * 还在门后面。`executeTarget` 走到门前会被引擎拒绝 → 返回 false →
 * 整条分支**静默消失**（目标生成了、却永远走不到）。
 *
 * 这里逐步重放：手里的钥匙 + 沿路捡到的钥匙，遇到门就扣一把，扣不动就是
 * 「顺序不可行」。返回第一个堵住的坐标，便于诊断输出。
 */
function pathFeasible(
  state: GameState,
  data: GameData,
  path: { x: number; y: number }[]
): { ok: boolean; at: string | null } {
  const keys: Record<KeyId, number> = { ...state.keys };
  //
  // ⚠️ 血量也要**沿路累计**，只查钥匙是不够的。
  //
  // `previewBattle` 是按**当前**血量判 `canWin` 的，所以一条路上 5 只怪可以
  // 「每只单看都打得过、合起来必死」。不累计的话会生成一批**幻影目标**：
  // `pathFeasible` 说可行、`executeTarget` 走到一半被引擎拒绝 ——
  // 表现是「搜索反复尝试一个到不了的怪，而日志里什么都没有」。
  //
  // 实测（`z1-redkey`，勇者 hp800/atk24/def22 在第 8 层）：两只初级卫兵
  // 都能单独打过（损失约 624），但去它们那儿的路要穿过骷髅和蝙蝠 ——
  // 走到跟前血已经不够了，于是「守门怪加分」恒为 0，看上去像那一项权重没生效。
  let hp = state.hp;
  for (let i = 1; i < path.length; i++) {
    const { x, y } = path[i];
    const ch = tileAt(state, data, state.floor, x, y);
    const info = data.byChar[ch];
    if (info?.key) {
      if (keys[info.key] <= 0) return { ok: false, at: `(${x},${y}) 需要 ${info.key}` };
      keys[info.key] -= 1;
    }
    // 踩上去会先捡道具（`step` 的拾取分支），所以钥匙要在**进门之前**计入
    const ent = entityAt(state, data, state.floor, x, y);
    if (ent && ent.type === 'item' && KEY_IDS.includes(ent.id as KeyId)) {
      keys[ent.id as KeyId] += 1;
    }
    if (ent && ent.type === 'monster') {
      const pv = previewBattle(state, data, ent.id);
      if (!pv || !Number.isFinite(pv.hpLoss)) return { ok: false, at: `(${x},${y}) 打不动 ${ent.id}` };
      if (pv.hpLoss >= hp) {
        return { ok: false, at: `(${x},${y}) 血不够打 ${ent.id}（需 ${pv.hpLoss}，剩 ${hp}）` };
      }
      hp -= pv.hpLoss;
    }
  }
  return { ok: true, at: null };
}

/**
 * 路径的**净**钥匙开销：沿路开的门 − 沿路捡到的钥匙（逐色，负数取 0）。
 *
 * 与 `pathFeasible` 是一对：后者问「顺序上走不走得通」，这一个问
 * 「走通之后，这种钥匙净少了几个」。钥匙是硬约束（全塔 193 把 vs 289 扇门），
 * 所以「净少几个」就是这次行动的**通行权代价**。
 */
function netKeyCost(
  state: GameState,
  data: GameData,
  path: { x: number; y: number }[]
): Record<KeyId, number> {
  const out: Record<KeyId, number> = { yellowKey: 0, blueKey: 0, redKey: 0 };
  for (let i = 1; i < path.length; i++) {
    const { x, y } = path[i];
    const info = data.byChar[tileAt(state, data, state.floor, x, y)];
    if (info?.key) out[info.key] += 1;
    const ent = entityAt(state, data, state.floor, x, y);
    if (ent && ent.type === 'item' && KEY_IDS.includes(ent.id as KeyId)) out[ent.id as KeyId] -= 1;
  }
  for (const k of KEY_IDS) out[k] = Math.max(0, out[k]);
  return out;
}

/**
 * 这个目标是不是**在为目标服务** —— 钥匙硬约束的判据。
 *
 * 「服务」只认三种，都是可判定的：
 *   · 它就是阶段目标（目标道具 / 目标怪）；
 *   · 它是朝目标楼层走的楼梯（严格缩短距离）；
 *   · 它是能**补充**钥匙的商人报价（买钥匙是解决钥匙问题的唯一手段）。
 *
 * 阶段没有明确目标楼层时（`phase.floor === null`）不设限 —— 没有目标就没有
 * 「值不值得花」的参照物，硬砍只会砍掉正确的探索。
 */
function goalServing(t: Target, floor: number, phase?: PhaseHint): boolean {
  if (!phase || phase.floor === null) return true;
  if (phase.itemId && t.kind === 'item' && t.id === phase.itemId) return true;
  if (phase.defeatId && t.kind === 'monster' && t.id === phase.defeatId) return true;
  if (t.kind === 'up' || t.kind === 'down') {
    const to = Number(String(t.id).split(':')[1]);
    if (Number.isFinite(to)) {
      // 严格朝目标楼层靠近（上楼方向就要求 to > floor，反之亦然）
      if (phase.floor > floor && to > floor) return true;
      if (phase.floor < floor && to < floor) return true;
    }
  }
  // 买钥匙是**解决**钥匙问题的唯一手段，任何阶段都允许（它净增加钥匙，不消耗）
  if (t.kind === 'merchant' && t.buyItem && (KEY_IDS as readonly string[]).includes(t.buyItem)) return true;
  return false;
}

/**
 * 诊断用：可达性格子图。
 *
 * 「搜索找不到路」有四种病（够不着 / 钥匙不够 / 打不动 / 根本没生成目标），
 * 目标清单只回答最后一种。这一支把 Dijkstra 的**前沿**画出来 ——
 * `·` 可达、`#` 不可达、`S` 起点、`X` 目标格，一眼看出是被门挡住还是被怪挡住。
 * 入口：`npm run autoplay:plan -- --reach N [yXbYrZ] [hp] [atk] [def]`。
 */
export function debugReach(state: GameState, data: GameData): { size: number; grid: string[] } {
  const r = reach(state, data);
  const grid: string[] = [];
  for (let y = 0; y < 11; y++) {
    let row = '';
    for (let x = 0; x < 11; x++) {
      if (x === state.pos.x && y === state.pos.y) row += 'S';
      else if (r.cost.has(K(x, y))) row += '·';
      else {
        const ch = tileAt(state, data, state.floor, x, y);
        row += data.byChar[ch]?.key ? 'D' : data.byChar[ch]?.passable ? 'x' : '#';
      }
    }
    grid.push(row);
  }
  return { size: r.cost.size, grid };
}

/**
 * 诊断用：列出当前状态下生成的目标。
 *
 * 存在的理由：搜索「找不到路」有至少四种病（够不着 / 钥匙不够 / 打不动 /
 * 根本没生成目标），而报告里它们长得一样。把生成结果摊开才分得清。
 * 入口：`npm run autoplay:plan -- --targets`。
 */
export function debugTargets(
  state: GameState,
  data: GameData,
  phase?: PhaseHint
): {
  kind: string;
  id: string;
  /**
   * 净收益。⚠️ **刻度的含义随 `category` 变**（血当量 / 优先级 / 金币余量），
   * 所以这一列不能跨类比大小 —— 判据与诊断都要先看 `category`。
   */
  gain: number;
  /** 跨类次序依据（`score.ts` 的 `CATEGORY_ORDER`）；诊断时按它分组看 */
  category: string;
  /** 目标格的坐标（同一层可能有同 id 的多件道具，坐标才分得清） */
  x: number;
  y: number;
  pathLen: number;
  orderOk: boolean;
  blockedAt: string | null;
  keyCost: string;
}[] {
  return generateTargets(state, data, phase).map((t) => {
    const f = pathFeasible(state, data, t.path);
    const net = netKeyCost(state, data, t.path);
    const spent = KEY_IDS.filter((k) => net[k] > 0).map((k) => `${k}×${net[k]}`);
    return {
      kind: t.kind,
      id: t.id,
      gain: Math.round(t.gain),
      category: t.category,
      x: t.x,
      y: t.y,
      pathLen: t.path.length,
      orderOk: f.ok,
      blockedAt: f.at,
      keyCost: spent.length ? spent.join(',') : '-'
    };
  });
}

/** 找一格「可达且紧邻 (tx,ty)」的落脚点，用来撞 NPC（商人 / 商店） */
function nearbySpot(
  state: GameState,
  data: GameData,
  r: ReachR,
  tx: number,
  ty: number
): { x: number; y: number } | null {
  const dirs = [
    { dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }
  ];
  for (const v of dirs) {
    const x = tx - v.dx;
    const y = ty - v.dy;
    if (x < 0 || y < 0 || x > 10 || y > 10) continue;
    if (!r.cost.has(K(x, y))) continue;
    if (!afford(r.owned, r.keys.get(K(x, y))!)) continue;
    if (entityAt(state, data, state.floor, x, y)) continue;
    if (tileAt(state, data, state.floor, x, y) !== '.') continue;
    return { x, y };
  }
  return null;
}

function shopCostOf(n: number): number {
  // 与 core/shop.mjs 的 shopCost 一致：10·n·(n-1)+20
  return 10 * n * (n - 1) + 20;
}

// ── 执行一个目标（走到底 + 落地动作） ───────────────────────────────

/**
 * 把「朝目标走 + 执行」应用到克隆 state，返回是否成功。
 *
 * ⚠️ 与旧版的两处差别都是**修 bug**，不是重构：
 *
 *  ① 旧版先循环走完整条 `path`，再单独补一次「最后一步」—— 于是最后一格
 *     **被走了两次**。对怪而言是重复开战；对楼梯而言更糟：第一次踩上去已经换层，
 *     第二次拿**旧楼层的坐标**在新楼层上又走一步。现在改成一趟走到底。
 *
 *  ② 换层必须显式判定。路径**跨过**楼梯（不是以它为终点）时引擎会中途换层，
 *     而剩下的路径坐标全都失效 —— 那会静默地把计划演成另一条路。
 *     现在：只有 `up` / `down` 目标允许换层，其余一律判失败。
 *     （`dijkstra` 侧也同步禁止「穿过楼梯」，见那里的注释。）
 */
function executeTarget(state: GameState, data: GameData, t: Target): boolean {
  const startFloor = state.floor;
  for (let i = 1; i < t.path.length; i++) {
    const cur = t.path[i - 1];
    const nxt = t.path[i];
    const dir: 'up' | 'down' | 'left' | 'right' =
      nxt.x - cur.x === 1 ? 'right' : nxt.x - cur.x === -1 ? 'left' : nxt.y - cur.y === 1 ? 'down' : 'up';
    const res = step(state, data, dir);
    if (state.floor !== startFloor) return t.kind === 'up' || t.kind === 'down';
    // 战斗（moved=false）与搭话（moved=false）都算「走到了」，其余不动就是失败
    if (!res.moved && res.kind !== 'battle' && res.kind !== 'talk') return false;
    if (state.dead) return false;
  }

  // 落地动作：商店买属性 / 商人成交 / 用道具
  if (t.kind === 'shop') {
    buyStat(state, t.stat ?? pickStat(state, data));
  } else if (t.kind === 'merchant' && t.offerIndex !== undefined) {
    // 成交的楼层必须是商人所在的那一层 —— 到这一步路径没换层，所以就是当前层
    tradeAccept(state, data, state.floor, t.offerIndex);
  } else if (t.kind === 'use') {
    useItem(state, data, t.id);
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
  /**
   * 找到解时的那份状态。
   *
   * 分阶段规划（`planPhases`）靠它把「上一阶段的终点」当成下一阶段的起点 ——
   * 只回放 `actions` 那些**人读的字符串**是不行的（那是给日志看的，
   * 不是可执行的指令，改一次排版就会静默错位）。
   */
  finalState?: GameState;
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

  const hash = (s: GameState): string => stateDigest(s);

  function dfs(s: GameState, path: string[], depth: number): PlanResult | null {
    nodes++;
    if (nodes > maxNodes) return null;
    if (s.dead) return null;
    if (isCleared(s, data)) {
      return { cleared: true, actions: [...path], maxFloor: s.floor, nodes, depth, finalState: s };
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

/**
 * 已击败的**守门怪**数量 —— 束搜索估价里的「解锁进度」。
 *
 * 为什么必须单列一项：守门怪（击败后触发事件的怪）挡着的是**事件**，不是金币。
 * 只靠 `mustFight` 那个 +4000 的 gain 完全不够 —— `gain` 只影响**目标排序**，
 * 而束搜索留谁不留谁看的是**子状态的分数**。实测：打一只初级卫兵掉 624 血，
 * 按 `ready` 的 150/点扣掉约 9 万分，而它带来的「离目标楼层近一点」几乎为零
 * —— 于是 32 宽的束里没有一条愿意去打它，红钥匙永远拿不到。
 *
 * `1.5e5 / 只` 的量级就是照这个算的：要能盖过一场几百点血的战斗。
 */
function gateProgress(state: GameState, data: GameData): number {
  const gates = gateMonsters(data);
  if (gates.size === 0) return 0;
  let n = 0;
  for (const key of state.removed) {
    const i = key.lastIndexOf(':monster:');
    if (i < 0) continue;
    if (gates.has(key.slice(i + ':monster:'.length))) n++;
  }
  return n;
}

/**
 * 只为金币而战」的怪的收益门槛 —— 与 `autoplay.ts` 的 `POLICY.MONSTER_PROFIT` 同值。
 *
 * 两处各写一份数字是**故意的重复吗？不是。**这里直接用同一个常量：
 * planner 已经 import 了 autoplay（估价函数只有一份的来源），所以这里读它的值。
 */
const MONSTER_PROFIT_FOR_GOLD = POLICY.MONSTER_PROFIT;

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
/**
 * 攻略骨架的类型 —— 与 `data/walkthrough.json` 一一对应。
 *
 * ⚠️ 清单**在数据里，不在这里**。旧版把 6 个里程碑连同 `bonus` 写死在这个文件里，
 * 而它天然会漏：项目有 18 件质变道具（`walkthrough.milestones`），
 * 写死的那份只有 6 件，漏掉的那些**不会报错**，只会让搜索对它们无动于衷
 * —— 与铁律 #23「名单写死在多处必漏」是同一种病。
 */
export interface WalkthroughMilestone {
  id: string;
  name: string;
  /** 该道具所在楼层（`planPhases` 用它算「阶段目标楼层」，估价据此给出梯度） */
  floor: number;
  /** 已取得时给束搜索的加分（搜索调参量，与 `why` 一起放在数据里便于审计） */
  bonus: number;
  why?: string;
}

export interface WalkthroughGoal {
  type: 'item' | 'floor' | 'defeat' | 'clear';
  /** `item` / `defeat` 用 */
  id?: string;
  /** `floor` 用；`defeat` 也可带上（用于估价的目标楼层） */
  floor?: number;
}

export interface WalkthroughPhase {
  id: string;
  goal: WalkthroughGoal;
  why?: string;
  /**
   * 抵达本阶段目标楼层时至少要留住的钥匙（见 `PhaseHint.arriveKeys`）。
   * **只在有实测依据**（某层落点是被门围死的口袋）时才写 —— 它不是通用调参旋钮。
   */
  arriveKeys?: Record<string, number>;
}

/**
 * 一幕（阶段分组）—— 用户按幕划范围（「先以第一个 BOSS 前为基准」）。
 *
 * 有它之后 `until` 就不会散落在调用方：判据、CLI、以后接界面读的是同一份。
 */
export interface WalkthroughAct {
  id: string;
  title: string;
  /** 本幕做到哪个阶段为止（含）—— 值是 `phases[].id` */
  until: string;
  why?: string;
}

export interface Walkthrough {
  milestones: WalkthroughMilestone[];
  phases: WalkthroughPhase[];
  checkpoints?: { floor: number; hp?: number; atk?: number; def?: number; why?: string }[];
  acts?: WalkthroughAct[];
}

/** 某件道具是否已被拾取（进过 removed 集合） */
export function itemTaken(state: GameState, id: string): boolean {
  for (const key of state.removed) {
    if (key.endsWith(`:item:${id}`)) return true;
  }
  return false;
}

/** 某个怪是否已被击败（第 49 层的「全灭」判据就是靠它做成阶段谓词的） */
function monsterDefeated(state: GameState, id: string): boolean {
  for (const key of state.removed) {
    if (key.endsWith(`:monster:${id}`)) return true;
  }
  return false;
}

/** 里程碑加成：已拿到的质变道具越多，越接近通关（清单与加分都来自 walkthrough） */
function milestoneBonus(state: GameState, milestones: WalkthroughMilestone[]): number {
  let sum = 0;
  for (const m of milestones) {
    if (itemTaken(state, m.id)) sum += m.bonus;
  }
  return sum;
}

/**
 * 阶段目标的达成判据。
 *
 * `floor` 用 `>=` 而不是 `===`：阶段一旦达成，`planPhases` 就换下一阶段；
 * 判据是在搜索前沿上反复求值的，「到过又下来」不该让已经达成的阶段回退。
 */
export function phaseGoalMet(state: GameState, data: GameData, goal: WalkthroughGoal): boolean {
  switch (goal.type) {
    case 'item':
      return !!goal.id && itemTaken(state, goal.id);
    case 'defeat':
      return !!goal.id && monsterDefeated(state, goal.id);
    case 'floor':
      return goal.floor !== undefined && state.floor >= goal.floor;
    case 'clear':
      return isCleared(state, data);
  }
}

/** 阶段目标对应的楼层 —— 估价的梯度方向。未知时返回 null（退化成「越高越好」） */
function phaseFloorOf(goal: WalkthroughGoal, wt: Walkthrough): number | null {
  if (goal.floor !== undefined) return goal.floor;
  if (goal.type === 'item' && goal.id) {
    return wt.milestones.find((m) => m.id === goal.id)?.floor ?? null;
  }
  return null;
}

/**
 * 状态估价：越高越「接近通关」。
 *
 * 三层结构（从粗到细）：
 *   1. **里程碑**（主导）—— 拿到质变道具 = 质变加分，引导束搜索朝它们推进；
 *   2. **阶段距离 + 实力** —— 有阶段时按「离阶段目标楼层还有几层」给梯度，
 *      没有阶段时退回「楼层越高越好」；atk/def 是硬门槛，权重与楼层无关；
 *   3. **资源** —— 钥匙（按稀缺度计价的通行权）+ 金币（购买力）+ HP（存活）。
 *
 * ⚠️ 阶段距离是**这一版的核心修正**。旧版无论规划哪一段都用
 * `state.floor * 2e5`（越高越好）+ 里程碑加分，于是「空手往高层冲」的分支
 * 因为楼层高而胜出，而它到第 8 层就被门卡死 —— 里程碑加分只在**拿到之后**生效，
 * 对「正在朝它推进」没有任何引导。现在改成阶段相关：目标在 13 层时，
 * 停在 13 层附近的分支得分最高，冲过头、缩在低层都被扣分。
 *
 * ⚠️ 楼层用 `state.floor`（当前层）而不是历史最高：否则「冲上高层又退回」的
 * 残血状态背着虚高分，把「稳步推进」的分支挤掉。
 */
function beamScore(
  state: GameState,
  data: GameData,
  milestones: WalkthroughMilestone[],
  phase?: PhaseHint,
  maxFloor = state.floor
): number {
  const milestone = milestoneBonus(state, milestones);
  const progress = state.removed.size * 1e3;
  const power = state.atk * 5e2 + state.def * 5e1 + state.hp * 0.5;
  // 钥匙按稀缺度计价（与 autoplay 的 `keyValue` 同一口径）：
  // 「手里还有钥匙」是通行权，比同价值的一个道具更重要 —— 花掉最后一把钥匙
  // 换来一件小道具，在分数上必须是亏的。
  const keys = KEY_IDS.reduce((s, k) => s + keyValue(state, data, k) * 0.5, 0);
  const res = state.gold * 5 + keys;
  //
  // ⚠️ 这个系数（每层 2e4）是**实测调出来的**，不能随手放大：
  //   · 太强（初版 2e5，即「近一层 = 200 件道具」）→ 束搜索一路空手冲高层，
  //     到第 9 层攻防只有 24/16，连骷髅队长都碰不动，而它已经没资源可回头拿
  //     （回头会被「离目标更远」扣掉分，低分分支被 K 剪掉）；
  //   · 太弱（≈0）→ 退化成旧版「楼层越高越好」，回到前 10 层打转。
  // 2e4 的含义是「近一层 ≈ 20 件道具」：先把本层该拿的拿到，再往上走一格。
  //
  // 「现在打不打得动阶段 BOSS」—— 一个**有梯度**的就绪度。
  //
  // `ready = (当前生命 − 打它要掉的血) × 500`：
  // 打不动（canWin=false）时是 0；能打但只剩一点血时很小；血厚且掉得少时很大。
  // 于是 atk / def / hp 每涨一点，分数就涨一点，**束搜索会保留「继续补强」的分支**。
  //
  // ⚠️ 这一项是与 `near` 联动的，两半缺一不可：
  //   · `ready` 只回答「够不够格去打」；
  //   · `readyRaw`（带余量）决定 `near` 还要不要把人往 BOSS 那层拉。
  // 没联动时的实测症状：AI 一路空手冲到第 10 层，`previewBattle` 说「能赢」
  // （atk 刚好过 def），于是它就真去打，掉到 20 血，之后什么都做不了 ——
  // 「能赢」和「赢完还能继续玩」是两件事，余量那一档就是这道分界。
  let ready = 0;
  let readyRaw = false;
  //
  // 基准 BOSS 的选择：从「本阶段要打的」+「往后所有要打的」里挑**第一个打得动的**
  // （`atk > def`）。一个都打不动时，改用「离破防还差多少攻击」的梯度。
  //
  // 这两种情况必须都有：只挑「下一个」会在下一个打不动时让整项归零（见
  // `futureBossIds` 的注释）；而不给「打不动」留梯度的话，前期连铁剑都拿不到。
  const ladder: string[] = [];
  if (phase?.defeatId) ladder.push(phase.defeatId);
  for (const id of phase?.futureBossIds ?? []) if (!ladder.includes(id)) ladder.push(id);
  let readySource: string | null = null;
  for (const id of ladder) {
    const m = data.monsters[id];
    if (m && state.atk > m.def) {
      readySource = id;
      break;
    }
  }
  if (!readySource && ladder.length) {
    let minDef = Infinity;
    for (const id of ladder) {
      const m = data.monsters[id];
      if (m) minDef = Math.min(minDef, m.def);
    }
    if (Number.isFinite(minDef)) {
      // 越接近破防越接近 0，破防后由上面那一支接管
      ready = -(Math.max(0, minDef - state.atk) + 1) * 2e4;
      readyRaw = ready > -2e4;
    }
  }
  if (readySource) {
    const pv = previewBattle(state, data, readySource);
    //
    // ⚠️ 这里**不能**用 `pv.canWin` 当门槛。
    //
    // 第一版写的是「canWin 才给分」，实测在前期**恒为 0** —— 起始三围打不过
    // 任何 BOSS，于是这一项对整个前 10 层没有任何梯度，里程碑加分照样主导，
    // AI 依旧空手冲上去拿铁剑、只剩 284 血。
    //
    // `simulateBattle` 在「打得动但会死」时给的是**有限**的 `hpLoss`
    // （只有 `atk ≤ def` 那种彻底打不动才是 Infinity），
    // 所以 `state.hp − hpLoss` 在整段前期都是一个可比较的数：
    // 加攻击（少挨几轮）、加防御（每轮少掉血）、加生命（底数变大）都会让它变好。
    // 这就是我们要的梯度。
    if (pv && Number.isFinite(pv.hpLoss)) {
      const margin = state.hp - pv.hpLoss;
      readyRaw = margin >= 400;
      //
      // ⚠️ 权重 150 是**实测扫出来的**（2026-09-26）：500 → 150 → 50。
      //
      // 500 时的症状极具迷惑性：束一直在跑（32 宽、7 万节点）、最远也到 F7，
      // 但**一个达标节点都没找到**，而「最高分」从第 1 轮起就冻结不动。
      // 原因是每点 HP 值 500 分，而「前进一层」只值 2e4 分 —— 等于 40 点血。
      // 于是「打架推进」永远比「原地不动」分低，搜索**为了保血而不肯出战**，
      // 束里 32 个状态全是原地打转的，永远走不到 F9。
      //
      // 血是要**花**出去换进度的资源，不是越高越好的目标函数。
      ready = Math.max(-6e5, margin) * 150;
    }
  }
  //
  // 楼层梯度分三种情况，这是本版能推进第二阶段的直接原因：
  //   · 无阶段        → 越高越好（旧行为）；
  //   · BOSS 阶段未就绪 → **不给楼层梯度**，让 `progress`/`power` 主导，
  //                      于是 AI 会去「哪儿还有东西可拿」而不是「往 BOSS 那层凑」；
  //   · BOSS 阶段已就绪 → 按距目标楼层给梯度（近一层 ≈ 20 件道具），把人拉过去打。
  //
  // 位置项用**到过的最高层 `maxFloor`**，不是当前层 —— 这是「能回头补强」的关键。
  //
  // 用当前层时的实测症状（2026-09-26 定位）：z1-shield 阶段在第 5 层缺黄钥匙，
  // 必须退回 1~4 层去攒；而每退一层 `-|floor-9|×2e4` 就多扣 2e4，
  // 捡一把钥匙只值 1e3 —— 回头分支在束里排不上号，阶段永远推进不了。
  // `maxFloor` 是**单调量**：退回去不会把它变小，于是「下去拿钥匙再上来」
  // 只损失每层 1e3 的当前层位（下面那一项），不再被整层扣分。
  //
  // ⚠️ 旧注释担心过「冲上高层又退回的残血状态背着虚高分」——那份担心现在由
  // `ready`（按当前血/防算的 BOSS 余量）和 `power` 承担：虚高的只剩「去过哪」，
  // 「现在还打不打得动」是另算的。两者分开之后才可能既敢回头、又不自我欺骗。
  //
  // ⚠️ 梯度看**当前层**，单调量只做小幅资产 —— 这两个在早期版本里是反的。
  //
  // 用单调的 `maxFloor` 算距离时，「目标在下面」的阶段梯度**恒为常数**：
  // `z1-redkey`（红钥匙在 F8，而上一阶段把勇者停在了 F9）里
  // `maxFloor` 已经是 9、再也不会变小，于是 |9−8|×2e4 对每个状态都一样 ——
  // 搜索不知道要往下走，实测在 F9/F8/F7/F6 之间乱逛，184666 个节点都到不了 F8。
  //
  // 而当初改成 maxFloor 是为了「退回去补强不要被整层扣分」。那个诉求现在由
  // **`here` 这一项**承担：`maxFloor × 2e3` 是「到过的高度」这份资产的单调奖励，
  // 退回低层不会丢掉它 —— 于是既能往回走，也不至于把「冲过高层的残血状态」当宝
  // （残血另有 `ready` 按当前血/防算，两者分开）。
  const near =
    phase && phase.floor !== null
      ? phase.defeatId && !readyRaw
        ? 0
        : -Math.abs(state.floor - phase.floor) * 2e4
      : state.floor * 2e5;
  const here = phase && phase.floor !== null ? maxFloor * 2e3 : 0;
  //
  // 抵达目标楼层时的钥匙储备：**到了那一层还缺钥匙**就重罚。
  //
  // 只在 `state.floor >= phase.floor` 时生效 —— 爬楼途中花钱是正常的，
  // 只有「落地那一刻手上没有钥匙」才是病（见 `PhaseHint.arriveKeys`）。
  // 扣分而不是剪枝：剪枝会把「只能先花掉再上去」的路直接判死。
  let arrivePenalty = 0;
  if (phase?.arriveKeys && phase.floor !== null && state.floor >= phase.floor) {
    for (const k of KEY_IDS) {
      const need = phase.arriveKeys[k] ?? 0;
      if (need > 0 && state.keys[k] < need) arrivePenalty -= 3e6;
    }
  }
  // 解锁进度：击败守门怪是「打开一扇门」，必须在束里体现出来（见 `gateProgress`）
  const unlocked = gateProgress(state, data) * 1.5e5;
  const bossBonus = bossReachable(state) ? 1e8 : 0;
  return milestone + near + here + progress + power + res + ready + arrivePenalty + unlocked + bossBonus;
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
    /** 里程碑清单（来自 `data/walkthrough.json`）；缺省时估价里没有里程碑项 */
    milestones?: WalkthroughMilestone[];
    /** 阶段提示 —— 估价据此给出「离目标楼层还有几层」的梯度 */
    phase?: PhaseHint;
    /**
     * 找到目标后**还要再搜多少轮**才收手（默认 60）。
     *
     * 这是「阶段结束时状态好不好」的关键：`goal` 是一个**终点谓词**，
     * 而搜索原本一碰到它就返回 —— 于是「拿到铁剑」那一刻的状态（实测只剩
     * 284 血、0 把黄钥匙）就是整个阶段的交付物，之后没有机会再补。
     * 加上这个参数之后，搜索会在达标后继续收集，直到分数连续 `goalPatience`
     * 轮没有变好为止，交出来的是**这一阶段能达到的最好终点**而不是第一个终点。
     */
    goalPatience?: number;
    /** 诊断钩子：每一轮结束回调一次（`--beam-debug` 用它，正常路径不传） */
    onIter?: (info: {
      iter: number;
      beam: number;
      nodes: number;
      bestScore: number;
      bestLen: number;
      goalLen: number | null;
      exploredMaxFloor: number;
    }) => void;
  } = {}
): PlanResult {
  const maxBeam = opts.maxBeam ?? 64;
  const maxIter = opts.maxIter ?? 1000;
  const maxNodes = opts.maxNodes ?? 2_000_000;
  const goal = opts.goal ?? isCleared;
  const milestones = opts.milestones ?? [];
  const phase = opts.phase;
  const goalPatience = opts.goalPatience ?? 60;

  let nodes = 0;
  let bestScore = -Infinity;
  let bestActions: string[] = [];
  //
  // ⚠️ 「最远走到哪」必须与「分数最高的是哪条」分开记。
  //
  // 旧版只更新 `bestMaxFloor`（挂在最高分那条路上），于是报告会**低估**搜索
  // 实际探到的深度：一个冲到第 9 层但评分低的残血状态不算数，报告写「最远 F5」。
  // 那是把「报告口径」当成了「搜索能力」，会让人以为卡在第 5 层 —— 而真正的
  // 瓶颈可能在更深处。现在两个量分开：`exploredMaxFloor` 是**真的到过**，
  // `bestActions` 仍然只用于展示「最像样的那条路」。
  let exploredMaxFloor = state0.floor;
  let deepestPath: string[] = [];

  const hash = (s: GameState): string => stateDigest(s);

  const root: BeamNode = {
    state: cloneState(state0),
    path: [],
    score: beamScore(state0, data, milestones, phase, state0.floor),
    maxFloor: state0.floor
  };

  //
  // ★ 束宽**只用 maxBeam 跑一遍**，不做「从 1 开始迭代加深」。
  //
  // ⚠️ 这里改过一次，原因值得记下来：原实现是 `K = 1, 2, 4, … maxBeam`，
  // 而每一轮里只要 `bestGoal` 非空就在轮末 `return`。于是 **K=1 那一轮
  // （等价于纯贪心）一找到目标就结束了，束宽从来没有长起来过** ——
  // 「束搜索」实际上一直是 K=1 的贪心。
  //
  // 它是怎么被发现的：调 `near`（2e4 / 1e4 / 5e3）与 `goalPatience`（60 / 400）
  // 四组参数，结果**逐位相同**（连动作数 13、结束 hp60 都一样）。
  // 评分权重完全不影响结果，只可能是「排序根本没参与决策」。
  //
  // 迭代加深本来是为了「先找短的解」，但这里的代价函数里带 HP/资源/就绪度，
  // 短解不等于好解 —— 真正想要的是**分数最高的终点**（`bestGoal` 已经这么选了）。
  // 所以直接上最大束宽。
  {
    const K = maxBeam;
    let beam: BeamNode[] = [root];
    /** 已经达标、且分数最高的那个终点 —— 达标后继续搜，目标就是刷新它 */
    let bestGoal: BeamNode | null = null;
    let bestGoalScore = -Infinity;
    let goalIter = -1;
    let iter = 0;

    while (beam.length > 0 && iter < maxIter && nodes < maxNodes) {
      iter++;
      const seen = new Map<string, BeamNode>();

      for (const node of beam) {
        if (node.state.dead) continue;
        //
        // ⚠️ 达标**不再立刻返回**，而是记下来继续搜（见 `goalPatience` 的注释）。
        // 达标节点也要继续展开：阶段目标多半是「拿到某件道具」，
        // 拿到之后那一层往往还有药水 / 宝石可拿 —— 那些正是下一阶段的启动资金。
        if (goal(node.state, data) && node.score > bestGoalScore) {
          bestGoal = node;
          bestGoalScore = node.score;
          goalIter = iter;
        }
        for (const t of generateTargets(node.state, data, phase)) {
          if (nodes >= maxNodes) break;
          nodes++;
          const c = cloneState(node.state);
          if (!executeTarget(c, data, t)) continue;
          const mf = Math.max(node.maxFloor, c.floor);
          const child: BeamNode = {
            state: c,
            path: [...node.path, `${c.floor}@${c.pos.x},${c.pos.y} ${t.kind} ${t.id}`],
            score: beamScore(c, data, milestones, phase, mf),
            maxFloor: mf
          };
          // 真正到过的最高层（与分数无关）
          if (mf > exploredMaxFloor) {
            exploredMaxFloor = mf;
            deepestPath = [...child.path];
          }
          // 另外记一条「分数最高的路」用于展示
          if (child.score > bestScore) {
            bestScore = child.score;
            bestActions = [...child.path];
          }
          const h = hash(c);
          const existing = seen.get(h);
          if (!existing || child.score > existing.score) seen.set(h, child);
        }
      }

      // 达标之后连续 `goalPatience` 轮没能刷新 → 收手
      if (bestGoal && iter - goalIter >= goalPatience) break;

      // 束内去重后取 top-K
      beam = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, K);
      opts.onIter?.({
        iter,
        beam: beam.length,
        nodes,
        bestScore,
        bestLen: bestActions.length,
        goalLen: bestGoal ? bestGoal.path.length : null,
        exploredMaxFloor
      });
    }

    if (bestGoal) {
      return {
        cleared: true,
        actions: [...bestGoal.path],
        maxFloor: exploredMaxFloor,
        nodes,
        depth: bestGoal.path.length,
        finalState: cloneState(bestGoal.state)
      };
    }

  }

  // 失败时：`actions` 给**最深的那条路**（它比「分数最高但没走远」更有诊断价值），
  // `maxFloor` 是真的到过的最高层
  void deepestPath;
  return {
    cleared: false,
    actions: bestActions,
    maxFloor: exploredMaxFloor,
    nodes,
    depth: bestActions.length
  };
}

// ── 分阶段规划（攻略骨架驱动）────────────────────────────────────────

export interface PhaseOutcome {
  id: string;
  goal: WalkthroughGoal;
  ok: boolean;
  /** 该阶段的动作序列（人读字符串） */
  actions: string[];
  nodes: number;
  /** 没达成时：这一阶段最远推进到第几层 */
  reachedFloor: number;
  /** 没达成时的原因（要能回答「卡在哪个阶段、缺什么」） */
  reason: string;
  /** 达成时：这一阶段**结束时**的三围 —— 「阶段是拿到了，但只剩 20 血」要能看出来 */
  endStats?: { hp: number; atk: number; def: number; gold: number; keys: Record<string, number> };
  /**
   * 这一阶段**从哪一层、什么状态**开始。
   *
   * 没有它时，「z1-shield 只走了 1 步就失败」会被读成「搜索坏了」——
   * 而真正的原因可能是**上一阶段把勇者停在了意料之外的位置**（阶段之间是状态交接，
   * 交接口的那一层决定下一阶段有没有路可走）。
   */
  startStats?: { floor: number; hp: number; atk: number; def: number; gold: number; keys: Record<string, number> };
}

export interface PhasePlanResult {
  cleared: boolean;
  phases: PhaseOutcome[];
  actions: string[];
  maxFloor: number;
  finalState?: GameState;
}

/**
 * 分阶段规划：按 `data/walkthrough.json` 的 `phases` 顺序逐段求解。
 *
 * ## 为什么必须分阶段
 *
 * 一次性规划 50 层是「一个 400 步深、每步 ~10 分支」的搜索，无论 DFS 还是束搜索
 * 都会被「低层宝石的即时收益」拉走（实测贪心/DFS/束搜索三者都卡在前 10 层）。
 * 分阶段把大问题拆成 10 个可解的小问题：每一段只需要「从现在走到某个里程碑」，
 * 目标单一、楼层跨度小（通常 3~8 层），估价函数终于有了正确的梯度。
 *
 * ## 段与段之间靠状态交接，不靠回放日志
 *
 * `planBeam` 找到解时返回 `finalState`，下一段以它为起点 —— 而不是拿
 * `actions` 那些**人读字符串**去重演。理由是字符串的格式属于日志，改一次排版
 * 就会静默错位，而错位的表现是「后续所有阶段都基于一个假状态」。
 *
 * ## 失败要能定位到阶段
 *
 * 任何一段失败就立刻返回，并在 `phases` 里留下**那一段的 id 与最远楼层**。
 * 「卡在第 8 层」这种笼统结论对调策略没有用；「卡在 z2-sword（神圣剑 F13），
 * 最远到第 8 层」直接指向缺什么（这里是钥匙/商人）。
 */
export function planPhases(
  state0: GameState,
  data: GameData,
  wt: Walkthrough,
  opts: {
    maxBeam?: number;
    maxIter?: number;
    maxNodesPerPhase?: number;
    until?: string;
    /** 达标后继续搜多少轮（见 `planBeam` 的 `goalPatience`） */
    goalPatience?: number;
    /** 诊断钩子，透传给 `planBeam`（`--beam-debug`） */
    onIter?: (info: {
      iter: number;
      beam: number;
      nodes: number;
      bestScore: number;
      bestLen: number;
      goalLen: number | null;
      exploredMaxFloor: number;
    }) => void;
  } = {}
): PhasePlanResult {
  let cur = cloneState(state0);
  const outcomes: PhaseOutcome[] = [];
  const allActions: string[] = [];
  let maxFloor = cur.floor;

  //
  // 「做到哪一幕为止」由调用方给（值来自 `walkthrough.json` 的 `acts[].until`）。
  // 到了就停 —— 用户定的范围是「先通关第一个 BOSS」，后面那段刻意不规划：
  // 把没优化的楼层一起放进来，只会让「卡在 z1-shield」这种结论被后面的噪声淹掉。
  // 写错名字当场抛，**不静默退化成「整座塔」**（那会让判据以为范围生效了）。
  const stopAt = opts.until === undefined ? -1 : wt.phases.findIndex((p) => p.id === opts.until);
  if (opts.until !== undefined && stopAt < 0) {
    throw new Error(
      `planPhases：until="${opts.until}" 不在 phases 里（可选：${wt.phases.map((p) => p.id).join('/')}）`
    );
  }

  //
  // 「下一个要打的 BOSS」阶梯：从当前阶段往后找第一个 defeat 目标；
  // 都没有（最后一段）就用最终 BOSS。
  const bossLadder = wt.phases.map(
    (p) => (p.goal.type === 'defeat' ? p.goal.id ?? null : null)
  );
  const futureBossOf = (i: number): string | null => {
    for (let j = i; j < bossLadder.length; j++) if (bossLadder[j]) return bossLadder[j];
    return 'demonKingTrue';
  };

  for (let pi = 0; pi < wt.phases.length; pi++) {
    const phase = wt.phases[pi];
    const hint: PhaseHint = {
      floor: phaseFloorOf(phase.goal, wt),
      itemId: phase.goal.type === 'item' ? phase.goal.id ?? null : null,
      defeatId: phase.goal.type === 'defeat' ? phase.goal.id ?? null : null,
      futureBossId: futureBossOf(pi),
      futureBossIds: bossLadder.slice(pi).filter((x): x is string => !!x).concat('demonKingTrue'),
      arriveKeys: phase.arriveKeys
    };
    const r = planBeam(cur, data, {
      maxBeam: opts.maxBeam ?? 32,
      maxIter: opts.maxIter ?? 400,
      maxNodes: opts.maxNodesPerPhase ?? 400_000,
      goalPatience: opts.goalPatience,
      onIter: opts.onIter,
      milestones: wt.milestones,
      phase: hint,
      goal: (s, d) => phaseGoalMet(s, d, phase.goal)
    });

    outcomes.push({
      id: phase.id,
      goal: phase.goal,
      startStats: {
        floor: cur.floor,
        hp: cur.hp,
        atk: cur.atk,
        def: cur.def,
        gold: cur.gold,
        keys: { ...cur.keys }
      },
      ok: r.cleared,
      actions: r.actions,
      nodes: r.nodes,
      reachedFloor: r.maxFloor,
      reason: r.cleared
        ? ''
        : `阶段「${phase.id}」未能在 ${r.nodes} 个搜索节点内达成；最远推进到第 ${r.maxFloor} 层`,
      endStats: r.finalState
        ? {
            hp: r.finalState.hp,
            atk: r.finalState.atk,
            def: r.finalState.def,
            gold: r.finalState.gold,
            keys: { ...r.finalState.keys }
          }
        : undefined
    });

    if (!r.cleared || !r.finalState) {
      return { cleared: false, phases: outcomes, actions: allActions, maxFloor, finalState: r.finalState };
    }

    cur = r.finalState;
    allActions.push(...r.actions);
    maxFloor = Math.max(maxFloor, r.maxFloor);
    if (pi === stopAt) {
      // 一幕到此为止：`cleared` 表示**本幕目标**达成（不是通关真魔王）
      return { cleared: true, phases: outcomes, actions: allActions, maxFloor, finalState: cur };
    }
  }

  return { cleared: isCleared(cur, data), phases: outcomes, actions: allActions, maxFloor, finalState: cur };
}
