/**
 * 游戏运行时状态 —— 可序列化的单一状态树。
 *
 * 设计原则：
 *  1. **地图数据不可变**。门被打开、假墙被撞破、地震卷轴清空墙体……
 *     这些「地形被改变」的结果只记录在 `terrainPatch` 里，绝不回写 data/。
 *  2. **实体移除只记 key**。`removed` 集合用 `floor:x:y:type:id` 定位，
 *     这样反复上下楼时怪物不会复活，也不需要深拷贝楼层数据。
 *  3. 状态里不存任何 PixiJS 对象，渲染层可随时整体重建。
 *
 * 字段命名尽量与 data/ 对齐（yellowKey / blueKey / redKey、hp / atk / def、gold），
 * 只在原版用 `coin`/`att` 的地方统一成 `gold`/`atk`。
 */

import type { FloorEntity, GameData, KeyId, Stair } from '../data';
import { floorOf } from '../data';
import { footprintAt, inFootprint, type Footprint } from './footprint';

/**
 * 事件生成的楼梯。比 `Stair` 多一个 `floor`：它是**全局**记的，
 * 而数据里那些楼梯本来就挂在各自楼层下。
 */
export interface PlacedStair extends Stair {
  floor: number;
}

export type Dir = 'up' | 'down' | 'left' | 'right';

export const DIRS: Record<Dir, { dx: number; dy: number }> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 }
};

export interface LogEntry {
  text: string;
  /** 用于配色：普通/战斗/拾取/警告/对话 */
  kind: 'info' | 'battle' | 'loot' | 'warn' | 'talk' | 'floor';
  seq: number;
}

export interface GameState {
  floor: number;
  pos: { x: number; y: number };
  face: Dir;

  hp: number;
  atk: number;
  def: number;
  gold: number;
  keys: Record<KeyId, number>;

  /** 可使用的道具：id → 数量 */
  bag: Record<string, number>;
  /** 被动道具（十字架 / 屠龙剑 / 大金币 / 神圣盾…），持有即生效 */
  passives: string[];

  /** 到过的楼层（原版楼层传送器只能去这里面的层） */
  visited: number[];

  /** 商店全局购买次数，初值 1 —— 原版是全局共享的 */
  buyTimes: number;

  /**
   * 一次性事件的领取记录。商人赠礼（第 2 层救出智者给 1000 金币）只能领一次，
   * 反复打开交易面板不能反复给。key 形如 `gift:merchant:2:0`。
   */
  claimed: Set<string>;

  /**
   * 搭话次数：**实体键**（`floor:x:y:npc:id`）→ 已经说过几句。
   *
   * 这是「NPC 只会说同一句」这个问题的解药 —— 台词按它轮换
   * （见 `src/game/dialogue.ts`）。
   *
   * ⚠️ 键是**实体**而不是 NPC id，这是 2026-09-27 修的：原先按 id 计数，
   * 于是全塔同类 NPC 共用一个计数器 —— 12 个商人共用 `talked['merchant']`，
   * 从第二个商人起 `n % 池长` 已经不是 0，他那一层的特供台词被静默跳过。
   * 键空间与 `removed` 完全一致（都由 `entityKey` 生成），两处记账不会错位。
   */
  talked: Record<string, number>;

  /** 已移除的实体 key：`floor:x:y:type:id` */
  removed: Set<string>;
  /** 地形覆盖：楼层 → `x,y` → 新字符（门被打开、墙被挖掉等） */
  terrainPatch: Record<number, Record<string, string>>;
  /**
   * 怪物替换表：`floor:x,y` → 新怪物 id。
   *
   * 用于「封印解除」这类二形态切换：第 50 层的假魔王在封印解除后换成真魔王。
   * 数据（`data/floors`）是静态的，动态换怪只能记在状态里，`entityAt` 查它。
   */
  monsterSwap: Record<string, string>;

  /**
   * 事件生成的楼梯（区域边界通路，见 docs/known-gaps.md §1）。
   *
   * 楼梯图在 10→11 / 40→41 / 49→50 三处断开，其中最后一条让游戏**不可通关**。
   * 这三条路是「打完 BOSS 才开启」这类事件补出来的，所以它们必须存在**状态**里
   * （会随开局重置），不能写回 `data/`。
   */
  extraStairs: PlacedStair[];

  /**
   * **事件放进地图的实体** —— 原版 `set` 算子的产物（楼层 → 实体表）。
   *
   * 与 `extraStairs` 同一族的理由：第 20 层那 8 只蝙蝠汇聚成的吸血鬼、
   * 第 49 层假魔王召出的 8 个白王、第 25 层打完守卫落下的 4 把红钥匙，
   * 都是**剧情把它们放上去的**，一开始不在图上 ⇒ 只能记在状态里。
   *
   * ⚠️ 读实体一律走 `entitiesOn()`，**不要**再直接写 `floorOf(data, f).entities`
   * —— 那样写出来的地方看不见事件放的实体，症状是「吸血鬼站在那儿却撞不到」
   * 或者渲染层不画（画面与规则撕裂，`footprint.ts` 文件头讲的就是这一类）。
   * 这条约束由静态判据守（铁律 #66）：只有 `state.ts` 里允许出现
   * `floorOf(data, …).entities`。
   *
   * 同一个理由，**换怪（`monsterSwap`）也在 `entitiesOn()` 里统一生效** ——
   * 第 50 层那一格在数据里永远是「魔王（封印前）」，只有经过这里才会变成真身。
   * 见 `entitiesOn` 里面的长注释：漏查 swap 的那几处（贪心目标生成、`hasWall`、
   * `floorHasWork`、诊断输出）曾让 AI 一路走到 F50 却永远打不动最终 BOSS。
   *
   * 移除走的还是 `removed` 那一套 key（`entityKey`），所以事件放的实体
   * 被打死 / 被捡走 / 被 `remove` 之后，不会因为「它不在 data 里」而复活。
   */
  spawned: Record<number, FloorEntity[]>;

  /** 已触发过的一次性事件 id —— `once: true` 的事件靠它不重复执行 */
  fired: Set<string>;

  /** 领域伤害可以把勇者打死（战斗会被提前禁止），所以阵亡是一种真实状态 */
  dead: boolean;

  log: LogEntry[];
  stats: { steps: number; battles: number; hpLost: number; goldEarned: number; kills: number };
}

let logSeq = 0;

export function entityKey(floor: number, x: number, y: number, type: string, id: string): string {
  return `${floor}:${x}:${y}:${type}:${id}`;
}

export function createInitialState(data: GameData): GameState {
  const h = data.constants.hero;
  return {
    floor: h.startFloor,
    pos: { x: h.startPos.x, y: h.startPos.y },
    face: 'up',
    hp: h.hp,
    atk: h.atk,
    def: h.def,
    gold: h.gold,
    keys: { yellowKey: h.yellowKey, blueKey: h.blueKey, redKey: h.redKey },
    bag: {},
    passives: [],
    visited: [h.startFloor],
    buyTimes: data.constants.shop.nStartsAt,
    claimed: new Set<string>(),
    talked: {},
    removed: new Set<string>(),
    terrainPatch: {},
    monsterSwap: {},
    extraStairs: [],
    spawned: {},
    fired: new Set<string>(),
    dead: false,
    log: [],
    stats: { steps: 0, battles: 0, hpLost: 0, goldEarned: 0, kills: 0 }
  };
}

export function pushLog(state: GameState, text: string, kind: LogEntry['kind'] = 'info'): void {
  state.log.push({ text, kind, seq: ++logSeq });
  if (state.log.length > 60) state.log.splice(0, state.log.length - 60);
}

/**
 * 取某格**当前生效**的地形字符 —— 先查覆盖层，再回落原始数据。
 * 渲染与规则判定都必须走这个函数，否则会出现「画面是空地、逻辑上还是门」的撕裂。
 */
export function tileAt(state: GameState, data: GameData, floor: number, x: number, y: number): string {
  const patch = state.terrainPatch[floor]?.[`${x},${y}`];
  if (patch !== undefined) return patch;
  if (x < 0 || y < 0 || x > 10 || y > 10) return '#';
  return floorOf(data, floor).terrain[y][x];
}

export function patchTile(state: GameState, floor: number, x: number, y: number, char: string): void {
  (state.terrainPatch[floor] ??= {})[`${x},${y}`] = char;
}

/**
 * 某一层上**当前存在**的全部实体 —— 数据里的 + 事件放上去的（`state.spawned`）。
 *
 * **唯一入口**：引擎、渲染、AI 三方都必须读它，不能各自去翻
 * `floorOf(data, f).entities`（那样写的地方看不见事件放的实体）。
 * 无事件实体时直接返回数据里那个数组本身（热路径上不额外分配）。
 */
export function entitiesOn(state: GameState, data: GameData, floor: number): FloorEntity[] {
  const base = floorOf(data, floor).entities;
  const extra = state.spawned[floor];
  const list = extra && extra.length ? [...base, ...extra] : base;
  //
  // ★ 换怪（`monsterSwap`）在这里**统一生效**，调用方不需要、也不应该再自己查一次。
  //
  // 第 50 层是唯一的例子，也是为什么这条必须写在这儿：`data/floors` 是静态的，
  // 那一格永远写着「魔王（封印前）」（def 1000）；击败第 49 层四守卫后
  // `f49-seal-break` 把它 `replaceMonster` 成真魔王（def 190）。
  // 换怪前有 `entityAt` / `livingMonsters` 两处各自手查了一遍 swap，而
  // 「按 id 算怪」的地方（贪心的目标生成、`hasWall`、`floorHasWork`、
  // 诊断输出）**全都漏了** —— 它们照着 def 1000 判「打不动」，
  // 于是 AI 一路走到 F50 却**永远不碰真正的最终 BOSS**，退回 F48 死循环。
  // （实测现场：`怪剩 1：魔王（封印前）(打不动)`，而那一格当时已经是真魔王，一刀就死。）
  //
  // 教训与 `footprint.ts` 文件头同一条：**同一件事只能有一个判据来源**。
  // 只要还需要「记得再查一次 swap」，早晚会有人忘。放这儿以后，
  // `removed` 的 key 也跟着自动对齐（真魔王用真魔王的 key），不会再出现
  // 「杀了真身、假身复活」这类错位。
  if (!hasSwapOnFloor(state, floor)) return list;
  return list.map((e) => {
    if (e.type !== 'monster') return e;
    const to = state.monsterSwap[`${floor}:${e.x},${e.y}`];
    return to && to !== e.id ? { ...e, id: to } : e;
  });
}

/** 该层是否存在换怪记录 —— `entitiesOn` 的快路径（绝大多数层没有，保持原数组不动） */
function hasSwapOnFloor(state: GameState, floor: number): boolean {
  const prefix = `${floor}:`;
  for (const k of Object.keys(state.monsterSwap)) {
    if (k.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * 某一格上**自己就站在这儿**的实体 —— 不含 BOSS 的 3×3 占位块。
 *
 * `entityAt`（撞上即开战）对 BOSS 是按占位块命中的，那是对的；
 * 但 `remove`（原版 `hide`）给的是**实体自己那一格**，用 `entityAt`
 * 会把「删掉 (5,6) 那块装饰」变成「删掉整只 BOSS」。
 */
export function entityOwnAt(
  state: GameState,
  data: GameData,
  floor: number,
  x: number,
  y: number
): FloorEntity | null {
  for (const e of entitiesOn(state, data, floor)) {
    if (e.x === x && e.y === y && !state.removed.has(entityKey(floor, e.x, e.y, e.type, e.id))) return e;
  }
  return null;
}

/**
 * 某实体在棋盘上的**占位块**。BOSS 是居中的 `n × n`（必要时整体平移进棋盘），
 * 其余实体（道具 / NPC / 杂兵）就是它自己那一格。
 *
 * 渲染层据此摆精灵与光环，引擎据此判断阻挡 —— 两边读同一个函数，
 * 所以不存在「画面与规则不一致」的可能。范围怎么算见 `footprint.ts`。
 */
export function entityFootprint(data: GameData, e: FloorEntity): Footprint {
  // 传的是**怪物 id** 而不是布尔值：占位格数逐只不同（只有 dragon/kraken 是 3）
  return footprintAt(data, e.x, e.y, e.type === 'monster' && data.monsters[e.id]?.boss ? e.id : null);
}

/**
 * 该格上**当前占着**的实体（怪物 / 道具 / NPC）。
 *
 * ⚠️ 返回的是**实体本身**，所以调用方必须用 `ent.x / ent.y` 去记账
 * （`entityKey`），**不能**用查询坐标：BOSS 的占位块有 3×3 格，
 * 「撞上它」的那一格通常不是它自己那一格，用查询坐标拼出来的 key
 * 移除不掉任何东西 —— 表现是「打死了却还在」。
 *
 * 命中的判定是「精确同格，或（对 BOSS）落在它的占位块内」。
 * 同格的怪与道具（参考源把镐 / 雪花放在 BOSS 那一格）按 `entities` 的
 * 文件顺序返回，而数据里怪一律排在道具之前 —— 于是先开战、击败后才拿得到道具。
 */
export function entityAt(
  state: GameState,
  data: GameData,
  floor: number,
  x: number,
  y: number
): FloorEntity | null {
  for (const e of entitiesOn(state, data, floor)) {
    // ⚠️ 换怪（`monsterSwap`）已经在 `entitiesOn` 里生效，这里**不要再查一次** ——
    // 从前那两行「先看 swap」既冗余、又只保护了本函数自己（见 `entitiesOn` 的注释）。
    // 顺序问题也随之消失：`e.id` 现在就是当前的真身，`removed` 用的正是它的 key。
    if (state.removed.has(entityKey(floor, e.x, e.y, e.type, e.id))) continue;
    if (e.x === x && e.y === y) return e;
    if (e.type !== 'monster' || !data.monsters[e.id]?.boss) continue;
    if (inFootprint(entityFootprint(data, e), x, y)) return e;
  }
  return null;
}

/** 当前楼层上所有存活的怪物（含占位块） */
export function livingMonsters(
  state: GameState,
  data: GameData,
  floor: number
): { id: string; x: number; y: number; fp: Footprint }[] {
  const out: { id: string; x: number; y: number; fp: Footprint }[] = [];
  for (const e of entitiesOn(state, data, floor)) {
    if (e.type !== 'monster') continue;
    // 换怪已在 `entitiesOn` 生效：`e.id` 就是当前真身，`removed` 的 key 因此天然对齐
    if (state.removed.has(entityKey(floor, e.x, e.y, e.type, e.id))) continue;
    out.push({ id: e.id, x: e.x, y: e.y, fp: entityFootprint(data, e) });
  }
  return out;
}

/**
 * 是否已通关：第 50 层的魔王（封印解除后是真魔王）**全部**已被击败。
 *
 * ⚠️ 这个判据只允许有一份。它原先在 `autoplay.ts` 与 `planner.ts` 里各写了一遍，
 * 两处都要自己记得查 `monsterSwap`；而「按 id 算怪」的第三、第四处（贪心的目标生成、
 * `hasWall`）**都忘了**，于是 AI 一路走到第 50 层却永远打不动最终 BOSS。
 * 现在它和 `entitiesOn` 住在同一个文件里：读的就是「现在这一格是谁」。
 */
export function isCleared(state: GameState, data: GameData): boolean {
  for (const e of entitiesOn(state, data, 50)) {
    if (e.type !== 'monster') continue;
    // 胜 = 「当前这一格的魔王」已被击败（`entitiesOn` 已把假魔王换成真身）
    if (!state.removed.has(entityKey(50, e.x, e.y, 'monster', e.id))) return false;
  }
  return true;
}

/**
 * 击败它是否**直接导致通关** —— 即「通关终点目标」。
 *
 * 判据是**试一次**：把它加进 `removed` 再看 `isCleared`。不写死层号、不写死怪 id，
 * 所以换个最终 BOSS / 换层也不会有隐藏假设。
 *
 * 为什么需要这个：通关条件是**终点**，不是可选项。用「利润率」这把尺子去量它是
 * 范畴错误 —— 实测（神装局）逼到第 50 层，贪心给出的理由是
 * 「怪「真魔王」(5,5) —— 利润率不够：得分 -1649 < 需要 3460」，
 * 也就是说：打得动、也不会死，但「不划算」，于是它退回第 48 层转圈。
 * 这与「不掉血的怪分数为负」是同一族规则的**例外**：那一条针对可清可不清的经济项，
 * 而终点目标没有「不清」这个选项。
 */
export function monsterClearsGame(
  state: GameState,
  data: GameData,
  floor: number,
  x: number,
  y: number,
  id: string
): boolean {
  if (isCleared(state, data)) return false; // 已经通关，没有终点目标了
  if (state.removed.has(entityKey(floor, x, y, 'monster', id))) return false;
  const probe: GameState = { ...state, removed: new Set(state.removed) };
  probe.removed.add(entityKey(floor, x, y, 'monster', id));
  return isCleared(probe, data);
}

/** 勇者是否持某件被动道具 */
export function hasPassive(state: GameState, id: string): boolean {
  return state.passives.includes(id);
}

/**
 * 某一层上**当前存在**的全部楼梯 —— 数据里的 + 事件生成的。
 *
 * 换层判定必须走这个函数，不能只读 `floorOf(data, floor).stairs`：
 * 三处区域边界通路是事件补出来的，直接读数据会得到「楼梯不存在」，
 * 表现是勇者踩在画着楼梯的格子上却原地不动。
 */
export function stairsOn(state: GameState, data: GameData, floor: number): PlacedStair[] {
  const f = floorOf(data, floor);
  const out: PlacedStair[] = [];
  for (const s of f.stairs.up) out.push({ ...s, floor });
  for (const s of f.stairs.down) out.push({ ...s, floor });
  for (const s of state.extraStairs) if (s.floor === floor) out.push(s);
  return out;
}

export function addToBag(state: GameState, id: string): void {
  state.bag[id] = (state.bag[id] ?? 0) + 1;
}
