#!/usr/bin/env node
/**
 * **判据元测试**：把 S8 / S10 / S11（「估价只有一套刻度」）的病根种回去，
 * 确认它们真的会红。
 *
 *     npm run probe:score-unify
 *
 * ## 为什么需要它
 *
 * 与 `tools/probe-prison-judgments.mjs` / `tools/probe-boss-judgments.py` 同一族：
 * 判据写完、一直是绿的，而它其实**根本不可能红**（阈值定错、按恒空集合筛、
 * 分支没被走到）—— 那比没有判据更坏，因为它给人一种「这块有人守着」的错觉。
 * 「新增判据的验收 = 逐个探针证明会红」是铁律 #38，这个脚本把它变成一条命令。
 *
 * ## 三个探针与「改值而不是删算子」
 *
 * 都是**种回真实会犯的那类错**，而不是把代码删空：
 *   ① 删掉 `effectValue` 的 `changeFloor` 分支 —— 飞行器（`upFlyer`/`downFlyer`）
 *      回到 0 分。这正是 2026-09-27 迁移时真的漏掉的那一档。
 *   ② 在 `planner.ts` 里**又写一份**第一代估价（`statPrices`）—— 模拟「两代并存」
 *      的复发。注意它是**复制粘贴**而不是 import：import 一个已被删掉的导出会让
 *      esbuild 打不出包，那样量到的是「bundle 崩了」而不是「判据红了」。
 *   ③ 目标排序退回「只比 `gain`」—— 跨类混刻度比较，`stairs` 冲到最前。
 *
 * ## ⚠️ 它会改仓库里的文件（改完自动还原）
 *
 * 被测对象是**磁盘上的源码**（`loadPlanner()` 每次重新打包并直读），没法用进程内
 * monkey-patch 代替。所以照抄 `probe-prison-judgments.mjs` 的三件套：
 *   ① 开局把被测文件**快照到磁盘**（`/tmp/probe-score-unify-snapshot/`）；
 *   ② `finally` + `exit/SIGINT/SIGTERM/uncaughtException` 多重还原；
 *   ③ 最末**逐字节**比对快照，不一致就以非零码退出。
 *
 * 崩溃标记 `.running` 也在（**只有上一轮没跑完才回写快照**）—— 那条是上一族探针
 * 用惨痛代价换来的，见 `probe-prison-judgments.mjs` 里那段长注释。
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
  PL: `${ROOT}/src/game/planner.ts`,
  SC: `${ROOT}/src/game/score.ts`
};

// ── ① 磁盘快照 + 崩溃标记 ──────────────────────────────────────────
const SNAP = '/tmp/probe-score-unify-snapshot';
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
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*❌\s+(.*?)\s+——/);
    if (m) reds.push(m[1]);
  }
  return reds;
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
    name: '① 删掉 effectValue 的 changeFloor 分支（上下飞行器回到 0 分）',
    expect: 'S8',
    apply() {
      patch('SC', "      case 'changeFloor':\n        v += MOBILITY * 0.4;\n        break;\n", '');
    }
  },
  {
    name: '② 在 planner 里又写一份第一代估价（statPrices）',
    expect: 'S10',
    apply() {
      patch(
        'PL',
        "import { POLICY } from './autoplay';",
        "import { POLICY } from './autoplay';\n// 探针：重新定义一份第一代估价\nconst statPrices = (_s: unknown) => ({ atkHp: 1, defHp: 1, goldHp: 25 });\nvoid statPrices;"
      );
    }
  },
  {
    name: '③ 目标排序退回「只比 gain」（跨类混刻度，stairs 冲到最前）',
    expect: 'S11',
    apply() {
      patch(
        'PL',
        '    .sort(\n      (a, b) =>\n        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||\n        b.gain - a.gain\n    );',
        '    .sort((a, b) => b.gain - a.gain);'
      );
    }
  }
];

// ── 主流程 ────────────────────────────────────────────────────────
console.log('══ 探针：S8 / S10 / S11 会不会红 ══\n');
const baseline = runChecks();
console.log(`基线：${baseline.length} 条红 —— ${baseline.join('、') || '（无）'}`);
console.log('（基线里只有「目标判据」是红的，其余必须全绿 —— 否则探针矩阵读不出来）\n');
const baseSet = new Set(baseline);

const rows = [];
let allHit = true;
let independent = true;

for (const p of PROBES) {
  p.apply();
  const reds = runChecks();
  restore();
  const extra = reds.filter((n) => !baseSet.has(n));
  const hit = extra.some((n) => n.startsWith(p.expect));
  const clean = extra.length === 1 && hit;
  if (!hit) allHit = false;
  if (!clean) independent = false;
  rows.push({ name: p.name, expect: p.expect, extra, hit, clean });
  console.log(`  ${hit ? '✅' : '❌'} ${p.name}`);
  console.log(`       期望变红：${p.expect}｜实测：${extra.join('、') || '（无）'}`);
  console.log(
    `       ${clean ? '✓ 只点亮它自己（判据互不重复）' : `⚠️ 还点亮了别的：${extra.filter((n) => !n.startsWith(p.expect)).join('、') || '无'}`}`
  );
}

// ── ④ 还原 + 逐字节复查 ───────────────────────────────────────────
console.log('\n=== 还原复查（应与快照逐字节一致）===');
restore();
let restored = true;
for (const [k, p] of Object.entries(FILES)) {
  const same = fs.readFileSync(p, 'utf8') === orig[k];
  console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, p)}`);
  if (!same) restored = false;
}

// 全绿复核：还原之后应该回到基线（只有那几条目标判据红）
const after = runChecks();
const sameAsBase = after.length === baseline.length && after.every((n) => baseSet.has(n));
console.log(`  ${sameAsBase ? '✓' : '✗'} 还原后判据回到基线状态（${after.length} 条红）`);

const ok = allHit && independent && restored && sameAsBase;
if (ok) {
  fs.rmSync(path.join(SNAP, '.running'), { force: true });
  console.log('\n✅ 三条判据全部至少被一个探针点亮，且各自只点亮自己');
} else {
  console.log('\n❌ 探针结果不完整，见上面几条 ⚠️（快照保留，下次启动会提示）');
  process.exitCode = 1;
}
