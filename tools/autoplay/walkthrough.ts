/**
 * 攻略骨架的读取（`data/walkthrough.json`）。
 *
 * ## 为什么骨架在 `data/` 而不在 `tools/`
 *
 * 它是**策略数据**，但不是「工具的一次性配置」—— 它记录的是从攻略考证来的
 * 楼层里程碑与进度基准（每一条都带 `why` 与来源）。放在 `data/` 里，
 * 它才能和 `floor-notes.json` / `constants.json` 一起被校验器对账
 * （`verify:autoplay` 有一条判据就是拿它与 `data/` 交叉核对：
 * 里程碑声明的楼层必须真的放着那件道具）。
 *
 * ## 为什么**不**进 `src/data/runtime-files.mjs`
 *
 * 那一份清单是「游戏运行时需要读的文件」，它的每条都会被打进小游戏包。
 * 骨架只有 headless 模拟与规划器用（`src/game/planner.ts` 通过参数接收它，
 * 不自己去读文件），游戏本体一个字节都不需要 —— 与 `combat-cases.json` /
 * `monster-placement.json` 同类（见 `runtime-files.mjs` 末尾那一节）。
 * 哪天「自动通关」接进 UI 了，再把它登记进运行时清单。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Walkthrough } from '../../src/game/planner';

/**
 * `data/` 的绝对路径由 `tools/autoplay/bundle.mjs` 用 esbuild 的 `define` 注入
 * （打包产物落在 /tmp，不能用 `import.meta.dirname` 推）。
 */
declare const __DATA_ROOT__: string;

let cached: Walkthrough | null = null;

export function loadWalkthrough(): Walkthrough {
  if (!cached) {
    cached = JSON.parse(readFileSync(path.join(__DATA_ROOT__, 'walkthrough.json'), 'utf8')) as Walkthrough;
  }
  return cached;
}
