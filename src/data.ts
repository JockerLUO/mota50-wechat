/**
 * 数据加载层 —— 唯一职责：把仓库根 `data/` 下的原始 JSON 变成强类型对象。
 *
 * 这里**不做任何数据加工**。数值语义、公式、效果算子全部由 `core/` 与
 * `src/game/` 负责；本文件只负责「取到、定型、索引好」。
 *
 * 数据文件不做拷贝：直接用 Vite 的 JSON 导入 + `import.meta.glob` 读原文件，
 * 从根上排除「内联副本与数据源漂移」这类问题。
 *
 * ⚠️ 楼层数据当前为**全量预载**（51 层一次性进包），原型阶段最省事。
 *    上线微信小游戏时应改为按需加载或分包，见 docs/data-spec.md「体积预算」。
 */

import tilesJson from '../data/tiles.json';
import monstersJson from '../data/monsters.json';
import itemsJson from '../data/items.json';
import npcsJson from '../data/npcs.json';
import constantsJson from '../data/constants.json';
import floorNotesJson from '../data/floor-notes.json';
import floorIndexJson from '../data/floors/index.json';

// ── 类型 ────────────────────────────────────────────────────────────

export type Stat = 'hp' | 'atk' | 'def';
export type KeyId = 'yellowKey' | 'blueKey' | 'redKey';

/** 带参数的特性（领域 / 夹击 / 斩杀） */
export interface TraitObject {
  type: 'aura' | 'flank' | 'execute';
  damage?: number;
  chance?: number;
  stat?: string;
  threshold?: number;
}

export type Trait = string | TraitObject;

export interface Monster {
  roleId: number;
  name: string;
  hp: number;
  atk: number;
  def: number;
  gold: number;
  exp: number;
  traits: Trait[];
  boss?: boolean;
  note?: string;
  sprite?: string;
}

export interface ItemEffect {
  op: string;
  [key: string]: unknown;
}

export interface ItemDef {
  sourceId?: number;
  name: string;
  kind: 'pickup' | 'usable' | 'passive';
  effects?: ItemEffect[];
  note?: string;
}

export interface NpcDef {
  sourceId?: number;
  name: string;
  sprite?: string;
  effects?: ItemEffect[];
  /**
   * 首次搭话的台词。
   *
   * 旧字段是单个 `talk` —— 结果**同一个 NPC 无论第几次搭话都只会说这一句**，
   * 玩家一撞就发现「对话是假的」。现在拆成三段：
   *   `talkByFloor`（本层特供，最优先）→ `greet`（首次）→ `repeat`（之后轮流）
   * 具体轮换规则见 `src/game/dialogue.ts`。
   */
  greet?: string;
  /** 之后每次搭话轮流说的几句；少于 2 句就会立刻显出重复，所以有几层就写几句 */
  repeat?: string[];
  /** 按楼层覆盖的台词；key 为楼层数字字符串。值可以是单句，也可以是数组（多段） */
  talkByFloor?: Record<string, string | string[]>;
  note?: string;
  goodsByFloor?: Record<string, unknown>;
}

export interface TileInfo {
  char: string;
  name: string;
  passable: boolean;
  key?: KeyId;
  stairs?: 'up' | 'down';
  openBy?: string;
  note?: string;
}

export type EntityType = 'monster' | 'item' | 'npc';

export interface FloorEntity {
  type: EntityType;
  id: string;
  x: number;
  y: number;
  /** 埋在墙内的道具：正常游戏流程中不可见 */
  hidden?: boolean;
}

export interface Stair {
  x: number;
  y: number;
  to: number;
  arrive: { x: number; y: number };
  /** 落点经过 BFS 就近修正（原落点在目标层是墙） */
  arriveAdjusted?: { from: { x: number; y: number }; reason: string };
}

export interface FloorData {
  id: string;
  index: number;
  title: string;
  size: { cols: number; rows: number };
  /** 每行一个字符串，terrain[y][x] */
  terrain: string[];
  stairs: { up: Stair[]; down: Stair[] };
  doors: { yellow: number; blue: number; red: number };
  entities: FloorEntity[];
  notes?: Record<string, unknown>;
}

export interface FloorIndexEntry {
  id: string;
  index: number;
  title: string;
  monsters: number;
  items: number;
  npcs: number;
  doors: { yellow: number; blue: number; red: number };
}

export interface HeroConstants {
  hp: number;
  atk: number;
  def: number;
  gold: number;
  yellowKey: number;
  blueKey: number;
  redKey: number;
  startFloor: number;
  startPos: { x: number; y: number };
  startPosNote?: string;
  startFace?: string;
}

export interface RegionDef {
  id: string;
  name: string;
  floorFrom: number;
  floorTo: number;
  note?: string;
}

export interface GameConstants {
  hero: HeroConstants;
  progression: { hasExperience: boolean; hasLevel: boolean; note: string };
  combat: Record<string, unknown>;
  shop: {
    costFormula: string;
    nStartsAt: number;
    globalCounter: boolean;
    tiers: { floorFrom: number; floorTo: number; mul: number; hp: number; atk: number; def: number }[];
    [key: string]: unknown;
  };
  economy: Record<string, unknown>;
  /**
   * ⚠️ `regions` 只是一个**说明对象**（`{ note: "见 zoneBaseline.regions" }`），
   * 不是区域数组。真正的区域定义在 `zoneBaseline.regions`。
   * 这一点最初弄错过一次：对它做 `for...of` 会直接抛「object is not iterable」。
   */
  regions?: Record<string, unknown>;
  zoneBaseline?: {
    regions?: RegionDef[];
    [key: string]: unknown;
  };
}

export interface GameData {
  tiles: TileInfo[];
  byChar: Record<string, TileInfo>;
  /** 原地形字符 → 数字编码（数据里 terrain 是字符画，图例给的是数字 key） */
  codeOf: Record<string, number>;
  monsters: Record<string, Monster>;
  items: Record<string, ItemDef>;
  npcs: Record<string, NpcDef>;
  constants: GameConstants;
  floorIndex: FloorIndexEntry[];
  floors: Map<number, FloorData>;
  floorNotes: Record<string, Record<string, unknown>>;
  missing: string[];
}

// ── 加载 ────────────────────────────────────────────────────────────

const floorModules = import.meta.glob('../data/floors/floor-*.json', {
  eager: true,
  import: 'default'
}) as Record<string, FloorData>;

function buildTiles(): { tiles: TileInfo[]; byChar: Record<string, TileInfo>; codeOf: Record<string, number> } {
  const legend = (tilesJson as unknown as { legend: Record<string, TileInfo> }).legend;
  const tiles: TileInfo[] = [];
  const byChar: Record<string, TileInfo> = {};
  const codeOf: Record<string, number> = {};
  for (const [code, info] of Object.entries(legend)) {
    tiles.push(info);
    byChar[info.char] = info;
    codeOf[info.char] = Number(code);
  }
  return { tiles, byChar, codeOf };
}

/** 挑出「声明了但从未被放置」的怪物 / 道具 / NPC —— UI 上要能看到这些空洞 */
function findMissing(monsters: Record<string, Monster>, items: Record<string, ItemDef>, floors: FloorData[]): string[] {
  const usedMonster = new Set<string>();
  const usedItem = new Set<string>();
  for (const f of floors) {
    for (const e of f.entities) {
      if (e.type === 'monster') usedMonster.add(e.id);
      else if (e.type === 'item') usedItem.add(e.id);
    }
  }
  const out: string[] = [];
  for (const id of Object.keys(monsters)) if (!usedMonster.has(id)) out.push(`怪物 ${monsters[id].name}（${id}）从未放置`);
  for (const id of Object.keys(items)) if (!usedItem.has(id)) out.push(`道具 ${items[id].name}（${id}）从未放置`);
  return out;
}

let cached: GameData | null = null;

export function loadData(): GameData {
  if (cached) return cached;

  const { tiles, byChar, codeOf } = buildTiles();
  const monsters = (monstersJson as unknown as { monsters: Record<string, Monster> }).monsters;
  const items = (itemsJson as unknown as { items: Record<string, ItemDef> }).items;
  const npcs = (npcsJson as unknown as { npcs: Record<string, NpcDef> }).npcs;
  const constants = constantsJson as unknown as GameConstants;

  const floors = new Map<number, FloorData>();
  for (const mod of Object.values(floorModules)) floors.set(mod.index, mod);

  const floorIndex = (floorIndexJson as unknown as { floors: FloorIndexEntry[] }).floors;
  const fn = (floorNotesJson as unknown as { floorNotes: Record<string, Record<string, unknown>> }).floorNotes;

  cached = {
    tiles,
    byChar,
    codeOf,
    monsters,
    items,
    npcs,
    constants,
    floorIndex,
    floors,
    floorNotes: fn,
    missing: findMissing(monsters, items, [...floors.values()])
  };
  return cached;
}

// ── 便捷查询 ────────────────────────────────────────────────────────

export function floorOf(data: GameData, index: number): FloorData {
  const f = data.floors.get(index);
  if (!f) throw new Error(`楼层 ${index} 不存在（数据只有 ${[...data.floors.keys()].join(',')}）`);
  return f;
}

/**
 * 楼层所属区域。
 * 区域表在 `constants.zoneBaseline.regions`；注意第 0 层（地下室）不在任何区内，
 * 它是靠下楼器才能到的独立空间。
 */
export function regionOf(data: GameData, floorIndex: number): string {
  if (floorIndex === 0) return '地下室';
  const regions = data.constants.zoneBaseline?.regions;
  if (Array.isArray(regions)) {
    for (const r of regions) {
      if (floorIndex >= r.floorFrom && floorIndex <= r.floorTo) return r.name;
    }
  }
  return '未知区域';
}

/**
 * 某层是否放了指定 NPC。
 * HUD 用它来决定「要不要提商店」—— 第 6 层只有商人没有商店，
 * 却在提示里写「商店第 N 次…」会让玩家在整层找不存在的商店。
 */
export function hasNpcOnFloor(data: GameData, floor: number, npcId: string): boolean {
  const f = data.floors.get(floor);
  return !!f?.entities.some((e) => e.type === 'npc' && e.id === npcId);
}

/** 商店收益倍率所在档位（也用于 HUD 上提示「本层收益档位 ×N」） */
export function tierOf(data: GameData, floorIndex: number): { mul: number; hp: number; atk: number; def: number } {
  const tiers = data.constants.shop.tiers;
  for (const t of tiers) {
    if (floorIndex >= t.floorFrom && floorIndex <= t.floorTo) return { mul: t.mul, hp: t.hp, atk: t.atk, def: t.def };
  }
  const last = tiers[tiers.length - 1];
  return { mul: last.mul, hp: last.hp, atk: last.atk, def: last.def };
}
