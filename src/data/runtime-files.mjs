/**
 * 运行时需要的数据文件清单 —— **跨语言共享的单一来源**。
 *
 * ## 为什么是 .mjs 而不是 .ts
 *
 * 同一份清单有两个消费者，运行环境不同：
 *
 *   - `src/data/index.ts`（TypeScript / 浏览器 / 小游戏）：按它去读数据
 *   - `tools/copy-minigame-assets.mjs`（Node ESM）：按它决定拷哪些文件进小游戏包
 *
 * 写成 `.mjs` 是**唯一让两边都能直接 import 的形式**（TS 侧 `allowJs: true` 能读，
 * Node 侧原生 ESM 能读）。写成 `.ts` 的话拷贝脚本就得去正则解析源码 ——
 * 那种「解析源码得到清单」的做法一旦源码格式变了就静默失效，
 * 而失效的后果是「包内缺文件 → 真机白屏」，不划算。
 *
 * 仓库根的 `core/`（`shop.mjs` 等）也是同一思路的先例。
 *
 * ## ⚠️ 加数据文件时必须同时改这里
 *
 * 漏改的症状分两种，都不好看：
 *   - 只加进 `data/` 没加进本清单 → web 端照常（它是显式 import 的），
 *     但小游戏端 `read` 抛「数据文件读不到」，**构建期不会发现**，要等真机；
 *   - 加进本清单但没在 `source-web.ts` 里登记 → web 端由 `index.ts` 的
 *     穷尽断言当场报错（这是刻意设计的：让漏改在第一时间暴露）。
 */

/**
 * 需要读的顶层 JSON（相对 `data/`）。
 *
 * 顺序即加载顺序，照着 `src/data/index.ts` 的依赖写。
 */
export const RUNTIME_TOP_JSON = [
  'tiles.json',
  'monsters.json',
  'items.json',
  'npcs.json',
  'constants.json',
  // 楼层索引：它既是「第 N 层叫什么」，也是**楼层文件的清单来源**
  //（每层的文件名就是 `floors/<id>.json`，见下）。
  'floors/index.json',
  'floor-notes.json'
];

/**
 * 楼层文件所在目录（相对 `data/`）。
 *
 * 单个楼层的文件名由索引里的 `id` 推出：`floors/<id>.json`。
 * 这一点**必须与数据实际一致**，`index.ts` 里有一条断言守着
 *（它会把「id 与 index 对不上」变成一句人话，而不是让楼层静默错位）。
 */
export const RUNTIME_FLOOR_DIR = 'floors';

/**
 * 关于「**不进包**的 data/ 文件」 —— 记在这里，但刻意不写成常量。
 *
 * `combat-cases.json`（核心对拍用例）与 `monster-placement.json`（放置审计）
 * 是给 `npm run validate` / `npm run balance` / `tools/*.mjs` 用的，
 * 游戏运行时一个字节都不需要。`_legacy-3floors/` 同理。
 *
 * 它们不进包**不是靠「排除清单」实现的，而是靠上面那份显式包含清单** ——
 * 拷贝脚本只拷 `RUNTIME_TOP_JSON` + `floors/`，别的文件根本没有机会进去。
 * 「排除法」在这里会出错：往 data/ 里加一个工具用 json 时，
 * 排除清单忘了加就会被静默拷进包（占主包额度、还看不出是谁放的）。
 */
