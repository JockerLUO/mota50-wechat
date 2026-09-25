#!/usr/bin/env node
/**
 * 跑一局「无人操作」的整局模拟（headless）。
 *
 * ## 为什么要有它
 *
 * 「自动通关」这个功能如果只能靠**盯着屏幕看勇者走**来验收，那它等于没有验收 ——
 * 50 层、上千步，人眼只能看出「好像在动」。这里把决策核心与引擎直接跑在 Node 里，
 * 于是「能不能通关」变成一条**每次都能复算的等式**，改策略参数的代价也降到一次命令。
 *
 * ## 为什么先 esbuild 打包再 import
 *
 * 决策核心是 TypeScript，而且 `src/data/index.ts` 通过 `@data-source` 这个 alias
 * 选数据源（网页端 / 小游戏端）。Node 既不认 TS 也不认这个 alias，所以这里
 * 用 esbuild 把它连 `core/*.mjs` 一起打成一份 ESM，并把 alias 指到
 * `tools/autoplay/node-source.ts`（直读磁盘上的 `data/`）。
 *
 * 用法：npm run autoplay [-- --max-steps 40000] [--verbose]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(os.tmpdir(), `mota50-autoplay-${process.pid}.mjs`);

const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
};
const maxSteps = getArg('max-steps', 40000);
const verbose = argv.includes('--verbose');

let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  try {
    esbuild = await import(pathToFileURL(path.join(ROOT, 'node_modules/esbuild/lib/main.js')).href);
  } catch (err) {
    console.error('需要 esbuild（vite 的传递依赖）才能跑模拟：', err?.message ?? err);
    process.exit(2);
  }
}

await esbuild.build({
  entryPoints: [path.join(ROOT, 'tools/autoplay/sim.ts')],
  outfile: OUT,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  logLevel: 'warning',
  define: { __DATA_ROOT__: JSON.stringify(path.join(ROOT, 'data')) },
  alias: { '@data-source': path.join(ROOT, 'tools/autoplay/node-source.ts') }
});

const { simulate, dumpFloor, probePos } = await import(pathToFileURL(OUT).href);
fs.rmSync(OUT, { force: true });

// `--floor N`：只打印那一层的地形与可达性（调策略用，不跑整局）
const fi = argv.indexOf('--floor');
if (fi >= 0) {
  const n = Number(argv[fi + 1]);
  for (const line of dumpFloor(n)) console.log(line);
  console.log('');
  process.exit(0);
}

// `--probe F,X,Y[,keys]`：复现某格的决策与走一步结果（keys 形如 y2b1r0）
const pi = argv.indexOf('--probe');
if (pi >= 0) {
  const [f, x, y, keys] = argv[pi + 1].split(',');
  for (const line of probePos(Number(f), Number(x), Number(y), keys)) console.log(line);
  console.log('');
  process.exit(0);
}

const r = simulate(maxSteps, verbose);

const line = (k, v) => console.log(`  ${k.padEnd(10, ' ')} ${v}`);
console.log('\n自动通关模拟报告');
console.log('─'.repeat(52));
line('通关', r.cleared ? '✅ 是' : '❌ 否');
line('阵亡', r.dead ? '是' : '否');
line('结束原因', r.reason);
line('最终层', `${r.floor}（最高到过 ${r.maxFloor}）`);
line('步数', r.steps);
line('生命', `${r.hp}（累计损失 ${r.hpLost}）`);
line('攻/防', `${r.atk} / ${r.def}`);
line('金币', `${r.gold}（商店购买 ${r.buys} 次）`);
line('击杀', r.kills);
line('钥匙', `黄 ${r.keys.yellowKey} / 蓝 ${r.keys.blueKey} / 红 ${r.keys.redKey}`);
line('到过层数', r.visited.length);
if (r.stuckAt) line('卡住点', r.stuckAt);
console.log('\n最后 24 条：');
for (const t of r.tail) console.log('  · ' + t);
console.log('\n最后 80 步轨迹（看循环长什么样）：');
for (const t of r.trace.slice(-80)) console.log('  ' + t);
console.log('\n每层剩余（看清没清干净）：');
for (const t of r.leftovers) console.log(t);
console.log('');

process.exit(r.cleared ? 0 : 1);
