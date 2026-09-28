#!/usr/bin/env node
/**
 * **判据元测试**：把 S12c（「估价与先前算过哪些楼层无关」）的病根种回去，
 * 确认它真的会红。
 *
 *     npm run probe:score-cache
 *
 * ## 它在守什么
 *
 * `src/game/score.ts` 的 `marginalCache` 的键**漏了 `state.floor`**，而它的值来自
 * `remainingMonsters()`（按 `[floor, floor + RELEVANT_FLOORS]` 窗口筛怪）
 * ⇒ 同一个三围指纹在不同楼层**本来就该给出不同的值**，漏了 floor 的键让
 * 「先被问到的那一层」决定之后所有层的答案。
 *
 * 两个探针，量的**不是同一件事**（铁律 #38：一个探针点亮全部 = 判据重复）：
 *   ① 键退回旧口径（去掉 `floor`）⇒ **S12c** 必须红（值随「先前算过哪些楼层」漂移）。
 *      同时顺带量一次**最远层**：旧口径下是 F16，修好后是 F15 ——
 *      这正是「基线里那条约 16 由缺陷撑起来」的因果证据（见 `tools/verify-autoplay.cjs`
 *      的 `BASELINE.note`）。
 *   ② 键里加上 `floor`、却把**刹车**（`guard.has` 早退）删掉 ⇒ **S12** 必须红（栈溢出）。
 *      这一条排除「S12c 只是 S12 的复读机」。
 *
 * ## ⚠️ 它会改仓库里的文件（改完自动还原）
 *
 * 被测对象是**磁盘上的源码**（判据每次重新打包并直读），没法用进程内 monkey-patch
 * 代替。所以照抄 `probe-score-unify.mjs` 的三件套：
 *   ① 开局把被测文件**快照到磁盘**（`/tmp/probe-score-floor-cache-snapshot/`）；
 *   ② `finally` + `exit/SIGINT/SIGTERM/uncaughtException` 多重还原；
 *   ③ 最末**逐字节**比对快照，不一致就以非零码退出。
 *
 * ⚠️ **别在别的构建 / 验证跑着的时候跑它** —— 它有一小段时间让源码处于「坏」状态。
 * 这也是它不并进 `verify:all` 的原因（那是给别人 CI 跑的，不该写文件）。
 * ⚠️ 它比同族探针**慢**：每个探针要跑两遍整局模拟（一次判据 + 最远层因果），
 * 实测约 3 分钟。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SC = `${ROOT}/src/game/score.ts`;

/** 修复后的键（探针要能把它换掉、再换回来） */
const KEY_FIXED =
  '  const key =\n' +
  '    `${state.floor}|${state.atk}|${state.def}|${state.hp}|` +\n' +
  "    `${state.passives.join(',')}|${state.removed.size}|${Object.keys(state.monsterSwap).length}`;";
/** 旧口径：漏了 floor（2026-09-28 之前的样子） */
const KEY_OLD =
  "  const key = `${state.atk}|${state.def}|${state.hp}|${state.passives.join(',')}|${state.removed.size}`;";

// ── ① 磁盘快照 + 崩溃标记 ──────────────────────────────────────────
const SNAP = '/tmp/probe-score-floor-cache-snapshot';
{
  const marker = path.join(SNAP, '.running');
  const sp = path.join(SNAP, 'score.ts.orig');
  if (fs.existsSync(marker) && fs.existsSync(sp)) {
    if (fs.readFileSync(sp, 'utf8') !== fs.readFileSync(SC, 'utf8')) {
      fs.writeFileSync(SC, fs.readFileSync(sp, 'utf8'));
      console.log('↩︎ 上一轮崩溃退出：score.ts 已从快照还原');
    }
  }
  fs.mkdirSync(SNAP, { recursive: true });
  fs.writeFileSync(sp, fs.readFileSync(SC, 'utf8'));
  fs.writeFileSync(marker, String(process.pid));
}
const ORIG = fs.readFileSync(`${SNAP}/score.ts.orig`, 'utf8');

// ── ② 多重还原 ────────────────────────────────────────────────────
let dirty = false;
const restore = () => {
  if (!dirty) return;
  fs.writeFileSync(SC, ORIG);
  dirty = false;
};
process.on('exit', () => {
  try {
    restore();
  } catch {
    /* 退出钩子里不再抛 */
  }
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));
process.on('uncaughtException', (e) => {
  try {
    restore();
  } catch {
    /* ignore */
  }
  console.error('\n💥 未捕获异常（仓库已还原）：', e);
  process.exit(1);
});

/** 改一处源码；锚点找不到就抛错（**不能静默跳过** —— 那会让探针变成假绿） */
const patch = (from, to) => {
  const s = fs.readFileSync(SC, 'utf8');
  if (!s.includes(from)) throw new Error(`探针锚点没找到：${from.slice(0, 60)}…`);
  fs.writeFileSync(SC, s.replace(from, to));
  dirty = true;
};

/** 跑第六套判据，返回红行的判据名 */
const runChecks = () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/verify-autoplay.cjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const reds = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*❌\s+(.*?)\s+——/);
    if (m) reds.push(m[1]);
  }
  return reds;
};

/** 单跑一次整局模拟，只要最远层（因果取证用；不重复判据的逻辑） */
const maxFloorNow = () => {
  const src =
    "import { loadSim } from '/Users/jockerluo/Documents/Github/mota50-wechat/tools/autoplay/bundle.mjs';\n" +
    "const m = await loadSim();\n" +
    "const r = m.simulate(40000, false);\n" +
    "console.log('MAXFLOOR=' + r.maxFloor);\n" +
    "process.exit(0);\n";
  const tmp = `/tmp/probe-floor-${process.pid}.mjs`;
  fs.writeFileSync(tmp, src);
  try {
    const r = spawnSync(process.execPath, [tmp], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
    const m = `${r.stdout ?? ''}`.match(/MAXFLOOR=(\d+)/);
    return m ? Number(m[1]) : NaN;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
};

// ── ③ 主流程 ──────────────────────────────────────────────────────
console.log('══ 探针：S12c / S12 会不会红 ══\n');

const baseline = runChecks();
console.log(`基线：${baseline.length} 条红 —— ${baseline.join('、') || '（无）'}`);
console.log('（基线里只有「目标判据」与已知的常态红是红的，其余必须全绿 —— 否则探针矩阵读不出来）\n');
const baseSet = new Set(baseline);

const rows = [];
let allHit = true;
let independent = true;

// 探针 ①：键退回旧口径 ⇒ S12c 红
{
  patch(KEY_FIXED, KEY_OLD);
  const reds = runChecks();
  const extra = reds.filter((n) => !baseSet.has(n));
  const hit = extra.some((n) => n.startsWith('S12c'));
  const clean = extra.length === 1 && hit;
  rows.push({ name: '① 记忆化键去掉 floor（回到 2026-09-28 之前的旧口径）', expect: 'S12c', extra, hit, clean });
  console.log(`  ${hit ? '✅' : '❌'} ① 键去掉 floor —— 期望变红：S12c｜实测：${extra.join('、') || '（无）'}`);
  console.log(
    `       ${clean ? '✓ 只点亮它自己（判据互不重复）' : `⚠️ 还点亮了别的：${extra.filter((n) => !n.startsWith('S12c')).join('、') || '无'}`}`
  );
  if (!hit) allHit = false;
  if (!clean) independent = false;
  restore(); // ⚠️ 必须先还原再进下一个探针，否则②是叠在①的坏状态上跑的
}

// 探针 ②：键没问题、但刹车删掉 ⇒ S12 红（证明 S12c 不是 S12 的复读机）
{
  patch('  if (guard.has(itemId)) return 0;\n', '');
  const reds = runChecks();
  const extra = reds.filter((n) => !baseSet.has(n));
  const hit = extra.some((n) => n.startsWith('S12 ') || n.startsWith('S12b'));
  const clean = hit;
  rows.push({ name: '② 删掉估价递归的刹车（`guard.has` 早退）', expect: 'S12', extra, hit, clean });
  console.log(`  ${hit ? '✅' : '❌'} ② 删掉刹车 —— 期望变红：S12｜实测：${extra.join('、') || '（无）'}`);
  if (!hit) allHit = false;
}

restore();

// ── ④ 最远层的因果取证（在**测试基准**上跑，不重复判据逻辑） ──────────
console.log('\n=== 最远层的因果：旧口径 vs 修复口径 ===');
restore();
const floorFixed = maxFloorNow();
patch(KEY_FIXED, KEY_OLD);
const floorOld = maxFloorNow();
restore();
console.log(`  修复口径（键含 floor）最远层 = F${floorFixed}`);
console.log(`  旧 口径（键漏 floor）最远层 = F${floorOld}`);
const causality = floorOld > floorFixed;
console.log(
  `  ${causality ? '✓' : '✗'} 旧口径把最远层抬高了 ${floorOld - floorFixed} 层 ⇒ ` +
    `基线里那条约「最远层 ≥ ${floorOld}」**是缺陷撑起来的**（修好后诚实值是 F${floorFixed}）`
);

// ── ⑤ 还原 + 逐字节复查 ───────────────────────────────────────────
console.log('\n=== 还原复查（应与快照逐字节一致）===');
restore();
let restored = true;
{
  const same = fs.readFileSync(SC, 'utf8') === ORIG;
  console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, SC)}`);
  if (!same) restored = false;
}
const after = runChecks();
const sameAsBase = after.length === baseline.length && after.every((n) => baseSet.has(n));
console.log(`  ${sameAsBase ? '✓' : '✗'} 还原后判据回到基线状态（${after.length} 条红）`);

// ── ⑥ 结论 ────────────────────────────────────────────────────────
const probe1 = rows[0];
const probe2 = rows[1];
const ok = probe1.hit && probe2.hit && causality && restored && sameAsBase;
if (ok) {
  fs.rmSync(path.join(SNAP, '.running'), { force: true });
  console.log(
    '\n✅ ① 点亮 S12c 且只点亮它；② 删刹车点亮 S12 —— 两条判据各自独立；' +
      '最远层的落差已归因到这条缺陷'
  );
} else {
  const why = [];
  if (!probe1.hit) why.push('① 没点亮 S12c');
  if (!probe2.hit) why.push('② 没点亮 S12');
  if (!causality) why.push('最远层没有落差（因果取证失败）');
  if (!restored) why.push('还原失败');
  if (!sameAsBase) why.push('还原后判据没回到基线');
  console.log(`\n❌ 探针结果不完整：${why.join('；')}（快照保留，下次启动会提示）`);
  process.exitCode = 1;
}
