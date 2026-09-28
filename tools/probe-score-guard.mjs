#!/usr/bin/env node
/**
 * **判据元测试**：把 S12 / S12b（「估价互相递归」那两条）的病根种回去，
 * 确认它们真的会红，以及**各自守的是哪一半**。
 *
 *     npm run probe:score-guard
 *
 * ## 为什么需要它
 *
 * 与 `tools/probe-score-unify.mjs` / `probe-prison-judgments.mjs` /
 * `probe-boss-judgments.py` 同一族：判据写完、一直是绿的，而它其实**根本不可能红**
 * （阈值定错、按恒空集合筛、分支没被走到、被 try/catch 吞掉）—— 那比没有判据更坏，
 * 因为它给人一种「这块有人守着」的错觉。
 * 「新增判据的验收 = 逐个探针证明会红」是铁律 #38，这个脚本把它变成一条命令。
 *
 * ## 两个探针：一条刹车，两种坏法
 *
 * `src/game/score.ts:itemWorth()` 里那行 `if (guard.has(itemId)) return 0;` 是防
 * `rawItemWorth ↔ unlockValue` 互相递归的刹车（破障道具自己躺在那一层 ⇒ 环路回到自身）。
 * 刹车有**两种**坏法，而它们各自只会被**一条**判据抓到：
 *
 *   ① **拆掉刹车** —— 环路回来 ⇒ `RangeError: Maximum call stack size exceeded`。
 *      S12（崩不崩）红；S12b 顺带红（面值停在 `NaN`，因为赋值语句根本没执行到）。
 *      ⚠️ 探针 ① **不是** S12 的专属探针：它必然连带 S12b。
 *   ② **刹车过度**（`guard.size > 0` ⇒ 任何嵌套求值都记 0）—— **不崩**，
 *      但破障道具被算成 0 分 ⇒ 玩家会主动跳过铁锹/雪花/炸弹/金钥匙。
 *      S12 照样绿（`crashes.length === 0`），**只有 S12b 会红**。
 *
 * ⇒ 矩阵读出来的结论：S12b 有「只点亮自己」的探针（②），S12 **不被**②点亮 ⇒
 * 两条判据不可互相替代（一条量「会不会崩」，一条量「还值不值钱」）。
 * 只看 S12 一条会漏掉「刹车写得太狠」这一整类坏法 —— 那正是探针 ② 存在的理由。
 *
 * ## ⚠️ 它会改仓库里的文件（改完自动还原）
 *
 * 被测对象是**磁盘上的源码**（判据每次重新打包并直读），没法用进程内 monkey-patch
 * 代替。所以照抄同族的三件套（铁律 #64）：
 *   ① 开局把被测文件**快照到磁盘**（`/tmp/probe-score-guard-snapshot/`）；
 *   ② `finally` + `exit/SIGINT/SIGTERM/uncaughtException` 多重还原；
 *   ③ 最末**逐字节**比对快照，不一致就以非零码退出。
 *
 * 崩溃标记 `.running` 也在（**只有上一轮没跑完才回写快照**）—— 那是同族探针用
 * 「`data/events.json` 被留在改坏的状态、而磁盘上没有副本」换来的。
 *
 * ⚠️ **别在别的构建 / 验证跑着的时候跑它** —— 它有一小段时间让源码处于「坏」状态。
 * 这也是它不并进 `verify:all` 的原因（那是给别人 CI 跑的，不该写文件）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FILES = {
  SC: `${ROOT}/src/game/score.ts`
};

// 探针锚点（**唯一**一份字面量；找不到就抛，不许静默跳过）——见下面 `patch()`
const BRAKE_COMMENT = `  // 环路回到自身：这一项的价值由**上游那一环**负责，这里记 0（不是「它不值钱」）\n`;
const BRAKE_LINE = `  if (guard.has(itemId)) return 0;\n`;

// ── ① 磁盘快照 + 崩溃标记 ──────────────────────────────────────────
const SNAP = '/tmp/probe-score-guard-snapshot';
const orig = {};
const restoreAll = () => {
  for (const [k, p] of Object.entries(FILES)) fs.writeFileSync(p, orig[k]);
};
{
  const marker = path.join(SNAP, '.running');
  const crashed = fs.existsSync(marker);
  let consumed = 0;
  for (const [k, p] of Object.entries(FILES)) {
    const sp = path.join(SNAP, path.basename(p) + '.orig');
    if (crashed && fs.existsSync(sp) && fs.readFileSync(sp, 'utf8') !== fs.readFileSync(p, 'utf8')) {
      fs.writeFileSync(p, fs.readFileSync(sp, 'utf8'));
      consumed++;
      console.log(`↩︎ 上一轮崩溃退出：${path.relative(ROOT, p)} 已从快照还原`);
    }
    orig[k] = fs.readFileSync(p, 'utf8');
  }
  fs.mkdirSync(SNAP, { recursive: true });
  for (const [k, p] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(SNAP, path.basename(p) + '.orig'), orig[k]);
  }
  fs.writeFileSync(marker, String(process.pid));
  if (crashed) console.log(`（上一轮崩溃残留已消费${consumed ? `，回写了 ${consumed} 个文件` : ''}）`);
}

// ── ② 多重还原 ────────────────────────────────────────────────────
let dirty = false;
const restore = () => {
  if (!dirty) return;
  restoreAll();
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

// ── ③ 跑判据并抓红行 ──────────────────────────────────────────────
const runChecks = () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/verify-autoplay.cjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const reds = [];
  const detail = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*❌\s+(.*?)\s+——\s*(.*)$/);
    if (m) {
      reds.push(m[1]);
      detail.set(m[1], m[2]);
    }
  }
  return { reds, detail };
};

/** 改一处源码；锚点找不到就抛错（**不能静默跳过** —— 那会让探针变成假绿） */
const patch = (file, from, to) => {
  const s = fs.readFileSync(FILES[file], 'utf8');
  if (!s.includes(from)) throw new Error(`探针锚点没找到（${file}）：${from.slice(0, 70)}…`);
  fs.writeFileSync(FILES[file], s.replace(from, to));
  dirty = true;
};

const PROBES = [
  {
    name: '① 拆掉递归刹车（环路回到自身）',
    expect: ['S12', 'S12b'],
    why: 'S12 报 RangeError；S12b 顺带红（面值停在 NaN）—— 所以①**不是**S12 的专属探针',
    apply() {
      patch('SC', BRAKE_COMMENT + BRAKE_LINE, '');
    }
  },
  {
    name: '② 刹车过度（任何嵌套求值都记 0：`guard.size > 0`）',
    expect: ['S12b'],
    why: '不崩 ⇒ S12 照样绿；只有 S12b 红（破障道具被判成 0 分）',
    apply() {
      patch('SC', BRAKE_LINE + '  guard.add(itemId);\n', '  if (guard.size > 0) return 0;\n  guard.add(itemId);\n');
    }
  }
];

// ── 主流程 ────────────────────────────────────────────────────────
console.log('══ 探针：S12 / S12b 会不会红 ══\n');
const base = runChecks();
console.log(`基线：${base.reds.length} 条红 —— ${base.reds.join('、') || '（无）'}`);
console.log('（基线里只有「目标判据」+「同一局势重复」是红的，其余必须全绿 —— 否则探针矩阵读不出来）\n');
const baseSet = new Set(base.reds);

const rows = [];
let allHit = true;
let noCollateral = true;

for (const p of PROBES) {
  p.apply();
  const { reds, detail } = runChecks();
  restore();
  const extra = reds.filter((n) => !baseSet.has(n));
  const hit = p.expect.every((n) => extra.some((e) => e.startsWith(n)));
  const collateral = extra.filter((e) => !p.expect.some((n) => e.startsWith(n)));
  if (!hit) allHit = false;
  if (collateral.length) noCollateral = false;
  rows.push({ ...p, extra, hit, collateral });
  console.log(`  ${hit ? '✅' : '❌'} ${p.name}`);
  console.log(`       期望变红：${p.expect.join('、')}｜实测：${extra.join('、') || '（无）'}`);
  for (const n of extra) console.log(`         · ${n} —— ${(detail.get(n) ?? '').slice(0, 120)}`);
  console.log(
    `       ${collateral.length ? `⚠️ 还点亮了期望之外的：${collateral.join('、')}` : '✓ 没有波及其它判据（改动是局部的）'}`
  );
  console.log(`       ${p.why}`);
  console.log('');
}

// 独立性：哪个判据有「只点亮它自己」的探针
const exclusive = (name) => rows.filter((r) => r.extra.some((e) => e.startsWith(name)) && r.extra.length === 1);
const exS12 = exclusive('S12 ');
const exS12b = exclusive('S12b');
const litByAll = (name) => rows.every((r) => r.extra.some((e) => e.startsWith(name)));
const s12Redundant = litByAll('S12 ') && !exS12.length;
const s12bRedundant = litByAll('S12b') && !exS12b.length;

console.log('=== 独立性矩阵 ===');
console.log(`  S12  被 ${rows.filter((r) => r.extra.some((e) => e.startsWith('S12 '))).length}/${rows.length} 个探针点亮`);
console.log(`  S12b 被 ${rows.filter((r) => r.extra.some((e) => e.startsWith('S12b'))).length}/${rows.length} 个探针点亮`);
console.log(`  ${s12Redundant ? '❌' : '✓'} S12 不是多余的（没有探针「点亮全部」而它又拿不出独有证据）`);
console.log(`  ${s12bRedundant ? '❌' : '✓'} S12b 不是多余的（探针②只点亮它）`);

// ── ④ 还原 + 逐字节复查 ───────────────────────────────────────────
console.log('\n=== 还原复查（应与快照逐字节一致）===');
restore();
let restored = true;
for (const [k, p] of Object.entries(FILES)) {
  const same = fs.readFileSync(p, 'utf8') === orig[k];
  console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, p)}`);
  if (!same) restored = false;
}

const after = runChecks();
const sameAsBase = after.reds.length === base.reds.length && after.reds.every((n) => baseSet.has(n));
console.log(`  ${sameAsBase ? '✓' : '✗'} 还原后判据回到基线状态（${after.reds.length} 条红）`);

const ok = allHit && noCollateral && !s12Redundant && !s12bRedundant && restored && sameAsBase;
if (ok) {
  fs.rmSync(path.join(SNAP, '.running'), { force: true });
  console.log('\n✅ 两条判据各自守着一半坏法，且都至少被一个探针证明会红');
} else {
  console.log('\n❌ 探针结果不完整，见上面几条 ⚠️（快照保留，下次启动会提示）');
  process.exitCode = 1;
}
