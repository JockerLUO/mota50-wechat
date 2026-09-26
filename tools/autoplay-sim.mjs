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
 * 打包 + 载入的部分在 `tools/autoplay/bundle.mjs`（与规划器、判据共用同一份配置）。
 *
 * 用法：npm run autoplay [-- --max-steps 40000] [--verbose] [--json]
 *
 * `--json` 把整份 `SimReport` 打到 stdout（**人看的正文全部抑制**）——
 * `tools/verify-autoplay.cjs` 靠它取值，不去解析给人看的报告排版。
 * 排版一改就解析失败的判据是「假红制造机」，所以两者必须分开。
 */

import { loadSim } from './autoplay/bundle.mjs';

const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
};
const maxSteps = getArg('max-steps', 40000);
const verbose = argv.includes('--verbose');
const asJson = argv.includes('--json');

const { simulate, dumpFloor, probePos } = await loadSim();

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

if (asJson) {
  // 只打 JSON：判据拿它做断言，人的正文一律不混进去
  process.stdout.write(JSON.stringify(r));
  process.exit(r.cleared ? 0 : 1);
}

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
line('金币', `${r.gold}（商店购买 ${r.buys} 次 / 商人成交 ${r.trades} 次）`);
line('击杀', r.kills);
line('撞不动', `${r.refusals} 次`);
// 「同一局势最多重复几次」—— 交替两步的横跳只有这个数看得出来（见 SimReport.maxCycle）
line('局势重复', `${r.maxCycle} 次（上限 30，超了判走投无路）`);
line('钥匙', `黄 ${r.keys.yellowKey} / 蓝 ${r.keys.blueKey} / 红 ${r.keys.redKey}`);
line('到过层数', r.visited.length);
if (r.stuckAt) line('卡住点', r.stuckAt);
// 局势循环（一直在动但什么都没变）—— 与「撞不动」是两种完全不同的死法
if (r.deadlock) line('走投无路', `局势循环：${r.deadlock}`);

// 决策交代 —— 这一段是「AI 为什么不动」的**机器答案**。
// 上面那些行说「停在哪」，这一段说「每一段闸门各自挡掉了什么、因为哪个数」。
// 没有它，同一句「第 4 层无路可走」对应十几种病（够不着 / 钥匙不够 / 打不动 /
// 代价超上限 / 利润率不够 / 白来过…），只能靠人工反推。
if (r.why) {
  console.log('\n决策交代（停下那一刻，六段闸门各自挡了什么）：');
  console.log(`  选中  ${r.why.chosen}`);
  const byStage = new Map();
  for (const x of r.why.rejected) {
    if (!byStage.has(x.stage)) byStage.set(x.stage, []);
    byStage.get(x.stage).push(x);
  }
  for (const [stage, list] of byStage) {
    console.log(`  ── ${stage}（${list.length} 条）`);
    for (const x of list.slice(0, 8)) console.log(`       ${x.what}  —— ${x.why}`);
    if (list.length > 8) console.log(`       …还有 ${list.length - 8} 条`);
  }
}

// 整局累计 —— 快照只说「最后一步为什么走不动」，这一张说「这几千步到底被什么挡着」。
// 实测：快照指向 F4，而累计一眼指出 ② 道具·cost 占了绝大多数 ⇒ 元凶是 spendCap。
if (r.whyTally?.length) {
  console.log('\n整局累计（哪一段的哪一类闸门挡得最多）：');
  for (const t of r.whyTally.slice(0, 10)) {
    console.log(`  ${String(t.count).padStart(6, ' ')}  ${t.stage} · ${t.kind}`);
    console.log(`          例：${t.sampleWhat} —— ${t.sampleWhy}`);
  }
}

console.log('\n里程碑（来自 data/walkthrough.json）：');
for (const m of r.milestones) {
  console.log(`  ${m.taken ? '✅' : '❌'} ${m.name.padEnd(6, '　')} 声明 F${m.floor}${m.taken ? `　实际 F${m.takenAtFloor}` : ''}`);
}
console.log('\n进度基准：');
if (r.checkpointFails.length === 0) console.log('  ✅ 全部达到');
else for (const f of r.checkpointFails) console.log(`  ❌ ${f}`);
console.log('\n最后 24 条：');
for (const t of r.tail) console.log('  · ' + t);
console.log('\n最后 80 步轨迹（看循环长什么样）：');
for (const t of r.trace.slice(-80)) console.log('  ' + t);
console.log('\n每层剩余（看清没清干净）：');
for (const t of r.leftovers) console.log(t);
console.log('');

process.exit(r.cleared ? 0 : 1);
