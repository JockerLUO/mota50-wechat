/**
 * Node 侧数据源 —— 给 headless 模拟用（它不是游戏的第三个宿主，只是工具）。
 *
 * 与 `source-minigame.ts` 一样是「运行期读文件」，区别只在读的是磁盘而不是代码包。
 * 走 `fs.readFileSync` 而不是把 JSON 内联，是为了让模拟读到的**一定**是
 * `data/` 里那份文件 —— 内联副本会漂移，而漂移在这里的后果是
 * 「模拟说能通关、真机走不通」。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { JsonSource } from '../../src/data/source';

/**
 * `data/` 的绝对路径由 `tools/autoplay-sim.mjs` 用 esbuild 的 `define` 注入。
 *
 * 为什么不写 `import.meta.dirname`：打包产物落在临时目录里，
 * 那个值会变成 /tmp 而不是项目根（实测就是这么炸的）。
 */
declare const __DATA_ROOT__: string;

export const jsonSource: JsonSource = {
  label: 'Node 模拟：fs.readFileSync 直读 data/',

  read<T>(key: string): T {
    return JSON.parse(readFileSync(path.join(__DATA_ROOT__, key), 'utf8')) as T;
  }
};
