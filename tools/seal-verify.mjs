#!/usr/bin/env node
/**
 * 验证封印解除事件（docs/known-gaps.md §4）。
 *
 * 打包 `tools/autoplay/seal-verify.ts`，在 headless 下确认：
 * 击败第 49 层 4 守卫后，第 50 层 (5,5) 的假魔王被替换成真魔王（monsterSwap）。
 * 这是「游戏可通关」的关键正确性 —— 换错会静默地让玩家永远打不过最终 BOSS。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(os.tmpdir(), `mota50-seal-${process.pid}.mjs`);

const esbuild = await import('esbuild');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'tools/autoplay/seal-verify.ts')],
  outfile: OUT, bundle: true, format: 'esm', platform: 'node', target: 'node18',
  logLevel: 'warning',
  define: { __DATA_ROOT__: JSON.stringify(path.join(ROOT, 'data')) },
  alias: { '@data-source': path.join(ROOT, 'tools/autoplay/node-source.ts') }
});

const { verifySeal } = await import(pathToFileURL(OUT).href);
fs.rmSync(OUT, { force: true });
for (const line of verifySeal()) console.log(line);
