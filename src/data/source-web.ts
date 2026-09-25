/**
 * 网页端数据源 —— 把 `data/` 下的 JSON **在构建期**烘进 bundle。
 *
 * 行为与拆分前的 `src/data.ts` 完全一致（那时是一组静态 `import` +
 * 一条 `import.meta.glob('../data/floors/floor-*.json', { eager: true })`），
 * 只是现在被收进 `read(key)` 这一个入口里。
 *
 * ## 为什么网页端不改用 fetch
 *
 * 「两个宿主读同一份数据、机制不同」听着别扭，但这里的不对称是**对的**：
 *
 *   - 网页端是静态站点，`data/` 不与 `dist/` 一起发布（`npm run build` 只产出
 *     `dist/index.html` + `dist/assets/*`），改成 fetch 就得先解决
 *     「把 51 个 JSON 也搬进 dist 并保证路径对得上」——这是新增的失败面，不是简化。
 *   - 构建期内联对网页端**没有任何代价**（gzip 后很小，且首屏零请求）。
 *
 * 所以这里刻意保持「构建期内联」，把「运行期读文件」留给真正需要它的那一端。
 *
 * ## 显式登记表而不是一条大 glob
 *
 * glob 写成 `'../data/**\/*.json'` 最省事，但它会把 `combat-cases.json` /
 * `monster-placement.json` / `_legacy-3floors/` 这些**工具用**的数据也打进来
 * —— 那就等于用「网页包体积」替「工具链」买单。
 *
 * 所以这里是穷尽式登记：顶层 7 个显式 `import`、楼层用一条收窄的 glob。
 * 表里缺项不会静默 —— `index.ts` 会拿 `RUNTIME_TOP_JSON` 逐项 `read`，
 * 读不到就带着 key 名抛出来。
 */

import type { FloorData } from './types';
import type { JsonSource } from './source';
import { RUNTIME_TOP_JSON } from './runtime-files.mjs';

import tilesJson from '../../data/tiles.json';
import monstersJson from '../../data/monsters.json';
import itemsJson from '../../data/items.json';
import npcsJson from '../../data/npcs.json';
import constantsJson from '../../data/constants.json';
import floorNotesJson from '../../data/floor-notes.json';
import floorIndexJson from '../../data/floors/index.json';
import eventsJson from '../../data/events.json';

/**
 * 楼层：一条收窄的 glob。
 *
 * `eager: true` 是必须的 —— 非 eager 会生成 `import()` 动态导入，
 * 而 `loadData()` 是**同步**的（整个引擎都建立在「数据在手」之上）。
 */
const floorModules = import.meta.glob('../../data/floors/floor-*.json', {
  eager: true,
  import: 'default'
}) as Record<string, FloorData>;

/** `../data/tiles.json` → `tiles.json`（把 glob 的键归一成 `read` 约定的 key） */
function toKey(globKey: string): string {
  return globKey.replace(/^\.\.\/\.\.\/data\//, '');
}

const table: Record<string, unknown> = {
  'tiles.json': tilesJson,
  'monsters.json': monstersJson,
  'items.json': itemsJson,
  'npcs.json': npcsJson,
  'constants.json': constantsJson,
  'floor-notes.json': floorNotesJson,
  'floors/index.json': floorIndexJson,
  'events.json': eventsJson
};

for (const [globKey, data] of Object.entries(floorModules)) {
  table[toKey(globKey)] = data;
}

export const jsonSource: JsonSource = {
  label: '网页端：构建期 import.meta.glob（数据已在 bundle 内）',

  read<T>(key: string): T {
    if (!Object.prototype.hasOwnProperty.call(table, key)) {
      throw new Error(
        `数据文件不在网页端登记表里：data/${key}\n` +
          `  → 若是新增的顶层数据文件，请同时改 src/data/runtime-files.mjs 与本文件的 import。`
      );
    }
    return table[key] as T;
  }
};

/**
 * 构建期自检：清单里每一项都得在登记表里。
 *
 * 放在模块求值期（而不是等 `loadData()` 被调用）是为了**在构建期就炸**：
 * 加了数据文件却忘了登记时，`npm run build` 立刻失败，
 * 而不是等到网页端某个角落才报「读不到」。
 *
 * 这也顺手解释了为什么这张表是「穷尽式」的 —— 有这条断言兜着，
 * 漏项不可能藏到运行期。
 */
for (const key of RUNTIME_TOP_JSON) {
  if (!Object.prototype.hasOwnProperty.call(table, key)) {
    throw new Error(
      `src/data/runtime-files.mjs 里列了 data/${key}，但 source-web.ts 没有登记它 —— ` +
        `两边必须对齐（小游戏侧会真的去读这个文件）。`
    );
  }
}
