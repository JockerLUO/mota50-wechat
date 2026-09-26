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

/**
 * 事件 —— 引擎的数据驱动剧情层。算子按**来路**分三组，别混（`data/events.json`
 * 的 `$comment` 有完整交代）：
 *
 *   · **补断点** —— `addStair`：楼梯图在三处区域边界的断点
 *     （`docs/known-gaps.md §1`），其中 49→50 那条是「游戏不可通关」的直接原因。
 *   · **补漏转写** —— `clearTerrain` / `mulStat` / `grantItem` / `replaceMonster`：
 *     参考源码**写好了**而本项目导入时没搬过来的那几条。
 *   · **本项目原创** —— `setTerrain` / `teleport` / `say`：参考源码里根本没有的剧情玩法
 *     （`say` 是**通用**算子：任何剧情都可以让人物说话，不专属这一条）。
 *     这一类**必须**在 `why` 里写明「无源码依据」，否则下一个读的人会以为
 *     「源码里查得到」而白找一遍（铁律 #50：派生项目里「源码写了」≠「本项目有」）。
 */
export interface EventEffect extends Record<string, unknown> {
  op: 'addStair';
  floor: number;
  x: number;
  y: number;
  to: number;
  arrive: { x: number; y: number };
}

/** 把某层某格的怪物替换成另一个 id（「封印解除」这类二形态切换） */
export interface ReplaceMonsterEffect extends Record<string, unknown> {
  op: 'replaceMonster';
  floor: number;
  x: number;
  y: number;
  /** 原怪物 id（用于防御性断言：换错对象会当场报错） */
  from: string;
  /** 替换成 */
  to: string;
}

/**
 * 清除某层的某种地形（按 `data/tiles.json` 的**编号**）。
 *
 * 第 2 层监牢的 6 扇牢门、第 8 层的自动门都走它 —— 参考源码是逐格写死的
 * （`floor[2][48]=floor[2][81]=…=0`），而那一层的这种地形**恰好只有那几格**，
 * 所以「按地形清」与「按坐标清」等价。等价这件事由判据钉住
 * （`verify:autoplay` 的 A 段会核对 F2 恰有 6 格牢门、F8 恰有 1 格自动门）。
 */
export interface ClearTerrainEventEffect extends Record<string, unknown> {
  op: 'clearTerrain';
  floor: number;
  /** 地形编号（tiles.json legend 的键）：2 = 牢门 D，10 = 自动门 a */
  terrain: number;
}

/** 按比例增减属性（第 2 层智者的「攻击/防御各 +10%」） */
export interface MulStatEventEffect extends Record<string, unknown> {
  op: 'mulStat';
  floor: number;
  stat: string;
  value: number;
}

/** 直接发一件道具（第 3 层智者送怪物书） */
export interface GrantItemEventEffect extends Record<string, unknown> {
  op: 'grantItem';
  floor: number;
  item: string;
  count?: number;
}

/**
 * 把某层**某一格**的地形精确改成指定字符。
 *
 * 与 `clearTerrain`（按编号把整层那种地形清空）是**反着的一对**：那一条是
 * 「不关心在哪几格」，这一条是「只动这一格」。
 *
 * 第 3 层伏击（红魔王）的剧情用它做两件事（同一条事件的两个 effect）：
 *   · 牢房左墙 (1,4) `#` → `w`（假墙）—— 撞开它才是唯一的越狱出路；
 *   · 牢房正门 (4,4) → `D`（牢门）—— 无论玩家此前有没有打过两名中级卫兵
 *     （`f2-prison-open` 是否已触发），被关进去时门都是**落锁**的。
 *
 * ⚠️ 只写进 `state.terrainPatch`，**不动 `data/`** —— 数据是静态的、全局面共享，
 * 改它等于把「一条剧情的临时地形」变成「所有存档的地形」。
 */
export interface SetTerrainEventEffect extends Record<string, unknown> {
  op: 'setTerrain';
  floor: number;
  x: number;
  y: number;
  /** 地形**字符**（`data/tiles.json` 的 char 列）：`w` = 假墙、`D` = 牢门 */
  terrain: string;
}

/**
 * 把勇者搬到**绝对**楼层与坐标。
 *
 * 与 `changeFloor`（`effects.ts` 里那个，只吃 `delta`，只能相对位移）不是一回事：
 * 这一条是为了「剧情把人扔到某层某格」而存在的 —— 第 3 层伏击把勇者
 * 打晕后扔进第 2 层牢房走的就是它。
 *
 * ⚠️ 落点必须走 `travel.ts` 的 `arriveOnFloor()`：那是**唯一**的落地入口，
 * 负责 `visited` / `steps` 记账与领域结算。绕过去的话，「被传送落地不结算领域」
 * 这类 bug 会只在这一条路径上出现（`travel.ts` 文件头写的就是这件事）。
 * 落点被实体占着时由 `nearestStandable()` 就近修正，不静默把人塞进墙里。
 */
export interface TeleportEventEffect extends Record<string, unknown> {
  op: 'teleport';
  floor: number;
  x: number;
  y: number;
  /** 落地时记一条 log —— 剧情台词 / 场面说明（省略则记「被带到了第 N 层」） */
  say?: string;
}

/**
 * 让某个人物**说一段话**（剧情演出），走的是撞 NPC 弹出**同一块对话框**。
 *
 * ## 为什么需要它
 *
 * 在这之前，事件对玩家说的话只有一条出口：`pushLog()`。而界面上那条「消息条」
 * 已经按玩家要求整条删掉了（见 `src/render/hud/toolbar.ts` 的文件头）——
 * 于是「事件说的话」**在屏幕上根本不存在**：玩家走到伏击点，只看见画面一跳就到了
 * 牢房，没有任何交代。这条算子把剧情台词接回对话框，与 NPC 台词共用一套版式。
 *
 * ## 与 `TeleportEventEffect.say` 的分工
 *
 * `teleport.say` 只是落地时记一条 log（**没有**对话框，给调试/回放看的）；
 * 这条是真的弹给玩家读的。两者不重复：一条剧情可以只有旁白、没有位移。
 *
 * ⚠️ **同一个事件里最多一条 `say`**：`applyTrigger()` 一次只带回一条台词
 * （返回最后一条），写两条的话第一条会被静默丢掉。这条约束由
 * `tools/validate-data.mjs` 的 E 段机器检查（铁律 #23：约束要有人检查）。
 */
export interface SayEventEffect extends Record<string, unknown> {
  op: 'say';
  /**
   * 说话人 id —— 只用来取**职能章**（`src/render/theme.ts` 的 `NPC_ROLE`）。
   * 它**不需要**是地图上真实存在的 NPC：首领与旁白也会说话，
   * 给不存在的 id 会落到「路人」那一档（不报错，但也没颜色）。
   */
  speaker: string;
  /** 对话框标题上的名字 */
  name: string;
  /** 正文，逐段显示；面板最多 7 行，超出的会被截断（篇幅由数据作者控制） */
  lines: string[];
}

export type AnyEventEffect =
  | EventEffect
  | ReplaceMonsterEffect
  | ClearTerrainEventEffect
  | MulStatEventEffect
  | GrantItemEventEffect
  | SetTerrainEventEffect
  | TeleportEventEffect
  | SayEventEffect;

export interface GameEvent {
  id: string;
  title: string;
  /**
   * 触发条件。
   *   - `start`        开局即生效
   *   - `defeated`     击败某怪
   *   - `allDefeated`  列表内的怪全部被击败（可限定楼层）
   *   - `talked`       与某 NPC 搭话（可限定楼层与坐标）
   *   - `enterTile`    **走到某一格**时自动发生（可限定楼层）
   *
   * ⚠️ `talked` 的 `x`/`y` 不是可选的锦上添花：第 2 层**有两个智者**，
   * 参考源码靠 `pos===43` 区分（(10,3) 给 +10%，(10,9) 去 35 楼开暗道）。
   * 只按 `id + floor` 匹配会让**两个都触发**同一个事件 —— 那是 +10% 变 +21%。
   *
   * ⚠️ `enterTile` 的坐标必须验证「玩家真的会踩到」：它是**被动**触发，
   * 玩家不会为了触发剧情特意去走某一格。放在一条不被经过的支路上，
   * 剧情就变成「存在但永不发生」—— 数据齐备、判据全绿、玩家一辈子没见过。
   * 所以第 3 层那条伏击的判据里有一条专门量「从入口到上楼梯的路径**必然**经过它」。
   */
  trigger:
    | { op: 'defeated'; id: string }
    | { op: 'start' }
    | { op: 'allDefeated'; ids: string[]; floor?: number }
    | { op: 'talked'; id: string; floor?: number; x?: number; y?: number }
    | { op: 'enterTile'; floor: number; x: number; y: number };
  once: boolean;
  effects: AnyEventEffect[];
  /** 为什么要有这条 —— 必须指向证据，见 data/events.json */
  why: string;
  evidence?: string;
}

export interface GameConstants {
  hero: HeroConstants;
  /**
   * BOSS 的棋盘占位 —— **本项目自有规则**，不是原版的（原版 BOSS 与杂兵同为 1 格）。
   *
   * 它是三方共用的单一来源：素材侧据此算绘制网格（格子 × footprintTiles），
   * 渲染层据此算落屏尺寸，引擎据此算阻挡。改这一个数会同时改掉三方，
   * 构建期有一条断言钉住「素材网格 == 格子 × 本值」。
   */
  boss: {
    footprintTiles: number;
    note?: string;
    singleSourceNote?: string;
    deviatesFromSource?: string;
  };
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
  /** 区域边界通路事件（docs/known-gaps.md §1）。空数组 = 游戏不可通关 */
  events: GameEvent[];
  missing: string[];
}
