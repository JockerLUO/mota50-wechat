/**
 * 规划器入口 —— 跑一次「离线搜索通关路线」。
 *
 * 与 `autoplay-sim.mjs` 一样走 esbuild 打包（TS + alias），但入口是 planner。
 * 打包配置在 `tools/autoplay/bundle.mjs`（单一来源，判据侧共用）。
 *
 * 用法：npm run autoplay:plan [-- --beam --max-beam 64 --max-nodes 20000000] [--json]
 */

import { loadPlanner } from './autoplay/bundle.mjs';

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
const nodesPerPhase = getArg('nodes-per-phase', 400_000);
const patience = getArg('patience', 60);
const useBeam = argv.includes('--beam');
const usePhases = argv.includes('--phases');
const asJson = argv.includes('--json');

const { runPlan, runBeam, runPhases, runTargets, runReach, runScores, runWhy } = await loadPlanner();

// `--why N [yXbYrZ] [hp] [atk] [def] [x y]`：**为什么不是别的** ——
// 决策器六段闸门各自挡掉了什么、因为哪个数。与 `--scores` 互补：
// `--scores` 说「这项值多少」，`--why` 说「它被哪一关挡在门外」。
{
  const wi = argv.indexOf('--why');
  if (wi >= 0) {
    const num = (v) => (v === undefined || v === '-' ? undefined : Number(v));
    const r = runWhy(
      Number.isFinite(Number(argv[wi + 1])) ? Number(argv[wi + 1]) : undefined,
      argv[wi + 2],
      { hp: num(argv[wi + 3]), atk: num(argv[wi + 4]), def: num(argv[wi + 5]) },
      argv[wi + 6] ? { x: Number(argv[wi + 6]), y: Number(argv[wi + 7]) } : undefined
    );
    console.log(`\n决策交代 @ ${r.at}`);
    console.log('─'.repeat(52));
    console.log(`  选中  ${r.chosen}`);
    console.log(`  动作  ${JSON.stringify(r.action)}`);
    console.log('  各段闸门挡掉的候选：');
    if (!r.rejected.length) console.log('    （一条都没有 —— 说明②直接给动作了，或候选本来就不存在）');
    for (const x of r.rejected) console.log(`    [${x.stage} · ${x.kind}] ${x.what}  —— ${x.why}`);
    console.log('  按「哪一段 · 哪一类」归并：');
    for (const [k, n] of r.byKind) console.log(`    ${String(n).padStart(4, ' ')}  ${k}`);
    process.exit(0);
  }
}

// `--scores N [yXbYrZ] [hp] [atk] [def] [x y]`：把三类分数摊开（道具 / 怪物 / NPC 各一套刻度）
{
  const si = argv.indexOf('--scores');
  if (si >= 0) {
    const num = (v) => (v === undefined || v === '-' ? undefined : Number(v));
    const r = runScores(
      Number.isFinite(Number(argv[si + 1])) ? Number(argv[si + 1]) : undefined,
      argv[si + 2],
      { hp: num(argv[si + 3]), atk: num(argv[si + 4]), def: num(argv[si + 5]) },
      argv[si + 6] ? { x: Number(argv[si + 6]), y: Number(argv[si + 7]) } : undefined
    );
    console.log(`\n评分 @ ${r.at}`);
    console.log(`   类别次序 ${r.order.join(' > ')}　门槛 ${JSON.stringify(r.thresholds)}`);
    for (const cat of r.order) {
      const rows = r.scores.filter((x) => x.category === cat);
      if (!rows.length) continue;
      console.log(`\n  ── ${cat}（${rows.length} 项，本类刻度）──`);
      for (const sc of rows.slice(0, 14)) {
        const detail = sc.parts.map((p) => `${p.label} ${Math.round(p.value)}`).join(' | ');
        console.log(`   ${String(Math.round(sc.total)).padStart(7, ' ')}  ${sc.why}`);
        console.log(`            ${detail}`);
      }
    }
    process.exit(0);
  }
}

// `--reach N [yXbYrZ] [hp] [atk] [def]`：画可达性格子图（`·`可达 `x`可达但不通 `D`门 `#`墙）
{
  const ri = argv.indexOf('--reach');
  if (ri >= 0) {
    const num = (v) => (v === undefined || v === '-' ? undefined : Number(v));
    const rr = runReach(
      Number.isFinite(Number(argv[ri + 1])) ? Number(argv[ri + 1]) : undefined,
      argv[ri + 2],
      { hp: num(argv[ri + 3]), atk: num(argv[ri + 4]), def: num(argv[ri + 5]) }
    );
    console.log(`\n可达性 @ ${rr.at}　可达 ${rr.size} 格`);
    console.log('─'.repeat(52));
    rr.grid.forEach((row, y) => console.log(`  ${String(y).padStart(2, ' ')} ${row.split('').join(' ')}`));
    process.exit(0);
  }
}

// `--targets [floor] [yXbYrZ] [hp] [atk] [def]`：列出生成的目标（诊断「搜索为什么找不到路」）
const ti = argv.indexOf('--targets');
if (ti >= 0) {
  const fl = Number(argv[ti + 1]);
  const num = (v) => (v === undefined || v === '-' ? undefined : Number(v));
  const r = runTargets(
    Number.isFinite(fl) ? fl : undefined,
    argv[ti + 2],
    { hp: num(argv[ti + 3]), atk: num(argv[ti + 4]), def: num(argv[ti + 5]) },
    argv[ti + 6] ? { x: Number(argv[ti + 6]), y: Number(argv[ti + 7]) } : undefined
  );
  console.log(`\n目标清单 @ ${r.at}`);
  console.log('─'.repeat(52));
  for (const t of r.targets) console.log(`  ${String(t.gain).padStart(8, ' ')}  ${t.kind.padEnd(10, ' ')} ${t.id.padEnd(28, ' ')} path ${String(t.pathLen).padStart(3, ' ')}  钥匙 ${t.keyCost.padEnd(12, ' ')} ${t.orderOk ? '顺序可行' : '顺序堵在 ' + t.blockedAt}`);
  process.exit(0);
}

if (usePhases) {
  const r = runPhases({
    maxBeam,
    maxIter,
    maxNodesPerPhase: nodesPerPhase,
    goalPatience: patience,
    beamDebug: argv.includes('--beam-debug')
  });
  if (asJson) {
    // finalState 是完整 GameState，序列化会很大；判据只需要阶段结论
    const slim = { ...r, finalState: undefined };
    process.stdout.write(JSON.stringify(slim));
    process.exit(r.cleared ? 0 : 1);
  }
  console.log('\n分阶段规划报告（攻略骨架驱动）');
  console.log('─'.repeat(52));
  for (const ph of r.phases) {
    const goal =
      ph.goal.type === 'item'
        ? `取得道具 ${ph.goal.id}（F${ph.goal.floor}）`
        : ph.goal.type === 'floor'
          ? `到达第 ${ph.goal.floor} 层`
          : ph.goal.type === 'defeat'
            ? `击败 ${ph.goal.id}（F${ph.goal.floor}）`
            : '通关';
    const st = ph.endStats
      ? `　结束 hp${ph.endStats.hp} atk${ph.endStats.atk} def${ph.endStats.def} 金${ph.endStats.gold} 黄${ph.endStats.keys.yellowKey}/蓝${ph.endStats.keys.blueKey}/红${ph.endStats.keys.redKey}`
      : '';
    console.log(`  ${ph.ok ? '✅' : '❌'} ${ph.id.padEnd(12, ' ')} ${goal}　动作 ${ph.actions.length}　最远 F${ph.reachedFloor}${st}`);
    if (ph.startStats) {
      const b = ph.startStats;
      console.log(
        `       └ 起点 F${b.floor} hp${b.hp} atk${b.atk} def${b.def} 金${b.gold} 黄${b.keys.yellowKey}/蓝${b.keys.blueKey}/红${b.keys.redKey}`
      );
    }
    if (!ph.ok) {
      if (ph.reason) console.log(`       └ ${ph.reason}`);
      if (ph.actions.length) console.log(`       └ 最高分那条路：${ph.actions.slice(0, 6).join(' → ')}${ph.actions.length > 6 ? ' …' : ''}`);
    }
  }
  console.log(`\n  通关       ${r.cleared ? '✅ 是' : '❌ 否'}`);
  console.log(`  最远层     ${r.maxFloor}`);
  console.log(`  动作总数   ${r.actions.length}`);
  console.log('');
  process.exit(r.cleared ? 0 : 1);
}

const r = useBeam ? runBeam({ maxBeam, maxIter, maxNodes }) : runPlan(maxDepth, maxNodes);

if (asJson) {
  process.stdout.write(JSON.stringify(r));
  process.exit(r.cleared ? 0 : 1);
}

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

process.exit(r.cleared ? 0 : 1);
