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
  return extra && extra.length ? [...base, ...extra] : base;
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
    // 怪物替换：这一格若被 swap，先看是否命中（同一格），命中就返回新怪物。
    // 注意要在 removed 检查**之前**：假魔王「现出真身」后，它自己并没被打败，
    // 而是「这一格现在是真魔王」，所以要优先读 swap。
    const swapped = state.monsterSwap[`${floor}:${e.x},${e.y}`];
    if (swapped && e.type === 'monster' && e.x === x && e.y === y) {
      return { type: 'monster', id: swapped, x, y };
    }
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
    if (state.removed.has(entityKey(floor, e.x, e.y, e.type, e.id))) continue;
    const swapped = state.monsterSwap[`${floor}:${e.x},${e.y}`];
    const id = swapped ?? e.id;
    out.push({ id, x: e.x, y: e.y, fp: entityFootprint(data, { ...e, id }) });
  }
  return out;
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
