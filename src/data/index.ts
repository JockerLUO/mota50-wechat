/**
 * 数据加载层 —— 唯一职责：把仓库根 `data/` 下的原始 JSON 变成强类型对象。
 *
 * 这里**不做任何数据加工**。数值语义、公式、效果算子全部由 `core/` 与
 * `src/game/` 负责；本文件只负责「取到、定型、索引好」。
 *
 * ## 目录结构（拆分自原来的单文件 `src/data.ts`）
 *
 * ```
 * src/data/
 *   types.ts           ← 数据长什么样（纯类型，无代码）
 *   source.ts          ← 「怎么取到」的接口（JsonSource）
 *   source-web.ts      ← 网页端：构建期 import.meta.glob，数据烘进 bundle
 *   source-minigame.ts ← 小游戏端：运行期 readFileSync 读代码包内文件
 *   runtime-files.mjs  ← 运行时数据清单（TS 侧与 tools/copy-minigame-assets.mjs 共用）
 *   index.ts           ← 本文件：加载 + 索引 + 便捷查询
 * ```
 *
 * 上面那份 `source-web` / `source-minigame` 的**二选一由构建配置决定**：
 * 本文件一律写 `from '@data-source'`，两个 vite 配置各自把它 alias 到对应实现
 * （网页端 → `source-web.ts`，小游戏端 → `source-minigame.ts`）。
 * 这样「同一份逻辑、两套取数机制」不需要任何 `if (isMinigame)` 分支，
 * 也不会把另一端的实现（比如 `import.meta.glob`）拖进不该有的包里。
 * tsconfig 的 `paths` 把 `@data-source` 指向网页端那份做类型检查 ——
 * 小游戏那份同样会被检查，理由见 `source-minigame.ts` 文件尾。
 *
 * **外部调用方的 import 路径一字未改**：`src/app/game.ts` 写的是
 * `from '../data'`，不带扩展名 —— Node/Vite/Rollup 都会把它解析到
 * `data/index.ts`，导出面与拆分前完全一致。
 *
 * ## 两个宿主读同一份数据、机制不同
 *
 * 这是本层唯一需要理解的设计（完整理由见 `source.ts` 与 `source-web.ts`）：
 * 网页端把 JSON 烘进 bundle，小游戏端运行期读代码包。两边的**数据源是同一份
 * `data/` 目录**，所以不存在「副本漂移」；差别只在「什么时候读」。
 *
 * ⚠️ 小游戏包里的 `data/` 是 `npm run build:minigame` 拷进去的一份**副本**，
 *    由 `tools/copy-minigame-assets.mjs` 按 `runtime-files.mjs` 的清单生成。
 *    改了 `data/` 里的 json 就必须重跑 `build:minigame` ——
 *    与图集那条约定的性质相同（见 docs/wechat-minigame.md §7）。
 *
 * ⚠️ 楼层数据当前为**全量预载**（51 层一次性进内存），原型阶段最省事。
 *    拆出代码包之后，「按需读某一层」已经是现成能力（`read` 支持任意 key）——
 *    真要省内存时改 `loadData()` 的这一个循环即可。见 docs/data-spec.md「体积预算」。
 */

import type {
  FloorData,
  FloorIndexEntry,
  GameConstants,
  GameData,
  GameEvent,
  ItemDef,
  Monster,
  NpcDef,
  TileInfo
} from './types';
import { RUNTIME_FLOOR_DIR, RUNTIME_TOP_JSON } from './runtime-files.mjs';
import { jsonSource } from '@data-source';

// ── 类型（对外 re-export，保证 `from '../data'` 拿得到全部原有符号）──────

export type {
  EntityType,
  FloorData,
  FloorEntity,
  FloorIndexEntry,
  GameConstants,
  GameData,
  GameEvent,
  HeroConstants,
  ItemDef,
  ItemEffect,
  KeyId,
  Monster,
  NpcDef,
  RegionDef,
  Stair,
  Stat,
  TileInfo,
  Trait,
  TraitObject
} from './types';

// ── 数据源 ──────────────────────────────────────────────────────────

/**
 * 这一次会话读了多少个文件、走的哪条路 —— 写进启动诊断。
 *
 * 「读了几次」是用来分辨**数据到底是运行时读的、还是被内联的**：
 * 小游戏端正确接入时这个数就是「7 个顶层 + 51 层 = 58」；
 * 若它还是 0（或被内联），说明构建配置没生效 —— 而那是一类
 * **游戏照跑、判据全绿、`data/` 目录其实是死的** 的假绿。
 */
let reads = 0;

export function dataSourceInfo(): { label: string; reads: number } {
  return { label: jsonSource.label, reads };
}

// ── 加载 ────────────────────────────────────────────────────────────

function buildTiles(raw: { legend: Record<string, TileInfo> }): {
  tiles: TileInfo[];
  byChar: Record<string, TileInfo>;
  codeOf: Record<string, number>;
} {
  const tiles: TileInfo[] = [];
  const byChar: Record<string, TileInfo> = {};
  const codeOf: Record<string, number> = {};
  for (const [code, info] of Object.entries(raw.legend)) {
    tiles.push(info);
    byChar[info.char] = info;
    codeOf[info.char] = Number(code);
  }
  return { tiles, byChar, codeOf };
}

/** 挑出「声明了但从未被放置」的怪物 / 道具 / NPC —— UI 上要能看到这些空洞 */
function findMissing(
  monsters: Record<string, Monster>,
  items: Record<string, ItemDef>,
  floors: FloorData[]
): string[] {
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

  /**
   * 加载期记账：本层**实际读了哪些 key**。
   *
   * 与 `runtime-files.mjs` 的清单对撞，用两个方向把「清单与代码不一致」堵住：
   *   - 清单里列了、但没人读 → 包内多一个死文件（下面断言报错）
   *   - 代码要读、但清单里没列 → 小游戏端 readFileSync 直接抛（source 层报错）
   * 两端都报错，就不可能出现「网页端好好的、小游戏端白屏」这种最难查的形态。
   */
  const seen = new Set<string>();
  function read<T>(key: string): T {
    seen.add(key);
    reads += 1;
    return jsonSource.read<T>(key);
  }

  const { tiles, byChar, codeOf } = buildTiles(read<{ legend: Record<string, TileInfo> }>('tiles.json'));
  const monsters = read<{ monsters: Record<string, Monster> }>('monsters.json').monsters;
  const items = read<{ items: Record<string, ItemDef> }>('items.json').items;
  const npcs = read<{ npcs: Record<string, NpcDef> }>('npcs.json').npcs;
  const constants = read<GameConstants>('constants.json');

  const floorIndex = read<{ floors: FloorIndexEntry[] }>('floors/index.json').floors;

  /**
   * 楼层：**按索引里的 id 推文件名**，而不是把文件名写死。
   *
   * 这么写是为了让「加了第 52 层」只需要改数据、不需要改代码 ——
   * 而那条 `id → index` 的一致性断言是必须的：小游戏端是按 id 拼路径去读的，
   * 一旦索引里 id 与实际楼层对不上，就会**静默错位**（读到的楼层装进了错误的 index）。
   */
  const floors = new Map<number, FloorData>();
  for (const entry of floorIndex) {
    const floor = read<FloorData>(`${RUNTIME_FLOOR_DIR}/${entry.id}.json`);
    if (floor.index !== entry.index) {
      throw new Error(
        `楼层索引与文件不一致：索引说 ${entry.id} 的 index 是 ${entry.index}，` +
          `而文件里写的是 ${floor.index}`
      );
    }
    floors.set(floor.index, floor);
  }

  const floorNotes = read<{ floorNotes: Record<string, Record<string, unknown>> }>('floor-notes.json').floorNotes;
  const events = read<{ events: GameEvent[] }>('events.json').events;

  // 清单 ↔ 实际读取 的双向核对（少读的那一侧在上面 read 时就会抛，这里管多列的那一侧）
  const unused = RUNTIME_TOP_JSON.filter((key: string) => !seen.has(key));
  if (unused.length) {
    throw new Error(
      `src/data/runtime-files.mjs 列了但没人读：${unused.join('、')} —— ` +
        `要么把它接进 loadData()，要么从清单里删掉（包内不该有死的 json）。`
    );
  }

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
    floorNotes,
    events,
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
