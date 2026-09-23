/**
 * 数据层的**类型真值表** —— 仓库根 `data/` 里那些 JSON 的 TypeScript 映射。
 *
 * 这里只有类型，没有一行可执行代码。放在单独文件里的理由很实际：
 * 这个项目的 `data/` 是**外部派生数据**（见 `reference/mota50/ATTRIBUTION.md`），
 * 字段随时可能跟着参考源变；把「数据长什么样」和「怎么把它读进来」分开，
 * 改字段时只需看这一个文件，不必在一堆加载逻辑里找 `interface`。
 *
 * ⚠️ 本文件里的 `sourceId` / `$comment` 之类字段不是装饰，它们记录了
 * 「这一项对应参考源的哪个编号」，是防漂移校验的依据，不要因为「类型里用不上」而删。
 */

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
