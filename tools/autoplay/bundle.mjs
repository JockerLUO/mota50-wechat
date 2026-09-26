/**
 * headless 入口的「打包 + 载入」公共部分。
 *
 * ## 为什么单独抽出来
 *
 * `tools/autoplay-sim.mjs`（整局模拟）与 `tools/autoplay-plan.mjs`（离线规划）
 * 各写过一遍同样的 esbuild 配置，而 **`tools/verify-autoplay.cjs`（判据）需要第三遍**。
 * 三份拷贝的典型后果是「判据那份忘了改 alias / define」——
 * 于是判据跑的是另一份产物，绿得没有意义（与铁律 #23 同源：名单写死在多处必漏）。
 *
 * 所以打包配置**只有一个来源**，就是这里。
 *
 * ## 为什么先打包再 import
 *
 * 决策核心是 TypeScript，且 `src/data/index.ts` 用 `@data-source` alias 选数据源。
 * Node 既不认 TS 也不认这个 alias，所以用 esbuild 把它连 `core/*.mjs` 一起打成一个
 * ESM，并把 alias 指到 `tools/autoplay/node-source.ts`（直读磁盘上的 `data/`）、
 * 用 `define` 注入 `__DATA_ROOT__`（产物落在 /tmp，不能用 import.meta.dirname 推）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 仓库根 —— `tools/autoplay/bundle.mjs` → 上两级 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** esbuild 是 vite 的传递依赖；顶层 import 失败时退回到项目内路径 */
async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch {
    try {
      return await import(pathToFileURL(path.join(ROOT, 'node_modules/esbuild/lib/main.js')).href);
    } catch (err) {
      console.error('需要 esbuild（vite 的传递依赖）才能跑模拟：', err?.message ?? err);
      process.exit(2);
    }
  }
}

/**
 * 打包一个 TS 入口并 import 它，返回导出面。
 *
 * @param {string} entryRelative 相对仓库根的入口（如 `tools/autoplay/sim.ts`）
 * @param {string} tag           临时文件名里的标记，便于区分同时跑的两支脚本
 */
export async function loadEntry(entryRelative, tag) {
  const esbuild = await loadEsbuild();
  const OUT = path.join(os.tmpdir(), `mota50-${tag}-${process.pid}-${Date.now()}.mjs`);

  await esbuild.build({
    entryPoints: [path.join(ROOT, entryRelative)],
    outfile: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    logLevel: 'warning',
    define: { __DATA_ROOT__: JSON.stringify(path.join(ROOT, 'data')) },
    alias: { '@data-source': path.join(ROOT, 'tools/autoplay/node-source.ts') }
  });

  try {
    return await import(pathToFileURL(OUT).href);
  } finally {
    fs.rmSync(OUT, { force: true });
  }
}

/** 整局模拟入口（`simulate` / `dumpFloor` / `probePos`） */
export const loadSim = () => loadEntry('tools/autoplay/sim.ts', 'autoplay');

/** 离线规划入口（`runPlan` / `runBeam`） */
export const loadPlanner = () => loadEntry('tools/autoplay/plan-entry.ts', 'planner');
