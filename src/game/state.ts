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

import type { GameData, KeyId } from '../data';
import { floorOf } from '../data';

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

  /** 已移除的实体 key：`floor:x:y:type:id` */
  removed: Set<string>;
  /** 地形覆盖：楼层 → `x,y` → 新字符（门被打开、墙被挖掉等） */
  terrainPatch: Record<number, Record<string, string>>;

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
    removed: new Set<string>(),
    terrainPatch: {},
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

/** 该格上尚未被移除的实体（怪物 / 道具 / NPC） */
export function entityAt(
  state: GameState,
  data: GameData,
  floor: number,
  x: number,
  y: number
): { type: string; id: string; hidden?: boolean } | null {
  const f = floorOf(data, floor);
  for (const e of f.entities) {
    if (e.x !== x || e.y !== y) continue;
    if (state.removed.has(entityKey(floor, e.x, e.y, e.type, e.id))) continue;
    return e;
  }
  return null;
}

/** 勇者与某怪物的曼哈顿距离为 1（领域伤害的判定条件） */
export function isAdjacent(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) + Math.abs(ay - by) === 1;
}

/** 当前楼层上所有存活的怪物（含坐标） */
export function livingMonsters(state: GameState, data: GameData, floor: number): { id: string; x: number; y: number }[] {
  const out: { id: string; x: number; y: number }[] = [];
  for (const e of floorOf(data, floor).entities) {
    if (e.type !== 'monster') continue;
    if (state.removed.has(entityKey(floor, e.x, e.y, e.type, e.id))) continue;
    out.push({ id: e.id, x: e.x, y: e.y });
  }
  return out;
}

/** 勇者是否持某件被动道具 */
export function hasPassive(state: GameState, id: string): boolean {
  return state.passives.includes(id);
}

export function addToBag(state: GameState, id: string): void {
  state.bag[id] = (state.bag[id] ?? 0) + 1;
}
