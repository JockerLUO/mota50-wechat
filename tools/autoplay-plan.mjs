/**
 * 规划器入口 —— 跑一次「离线搜索通关路线」。
 *
 * 与 `autoplay-sim.mjs` 一样走 esbuild 打包（TS + alias），但入口是 planner。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(os.tmpdir(), `mota50-planner-${process.pid}.mjs`);

const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
};
const maxDepth = getArg('max-depth', 400);
const maxNodes = getArg('max-nodes', 2_000_000);
const maxBeam = getArg('max-beam', 64);
const maxIter = getArg('max-iter', 1000);
const useBeam = argv.includes('--beam');

let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  esbuild = await import(pathToFileURL(path.join(ROOT, 'node_modules/esbuild/lib/main.js')).href);
}

await esbuild.build({
  entryPoints: [path.join(ROOT, 'tools/autoplay/plan-entry.ts')],
  outfile: OUT,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  logLevel: 'warning',
  define: { __DATA_ROOT__: JSON.stringify(path.join(ROOT, 'data')) },
  alias: { '@data-source': path.join(ROOT, 'tools/autoplay/node-source.ts') }
});

const { runPlan, runBeam } = await import(pathToFileURL(OUT).href);
fs.rmSync(OUT, { force: true });

const r = useBeam ? runBeam({ maxBeam, maxIter, maxNodes }) : runPlan(maxDepth, maxNodes);
console.log(`\n规划器报告${useBeam ? '（束搜索）' : ''}`);
console.log('─'.repeat(52));
console.log(`  通关       ${r.cleared ? '✅ 是' : '❌ 否'}`);
console.log(`  最远层     ${r.maxFloor}`);
console.log(`  搜索节点   ${r.nodes}`);
console.log(`  动作数     ${r.actions.length}`);
console.log('');
console.log('前 60 个动作：');
for (const a of r.actions.slice(0, 60)) console.log('  ' + a);
if (r.actions.length > 60) console.log(`  …（共 ${r.actions.length} 步）`);
console.log('');
