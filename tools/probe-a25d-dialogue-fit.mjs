#!/usr/bin/env node
/**
 * A25d 探针 —— 证明「每一段都塞得进对话框」这条判据**真的会红**（铁律 #38/#59）。
 *
 * ## 造的是什么局面
 *
 * 把**两段**一次性台词加长到超过卡片容量（9 行）：
 *
 *   · `thief.talkByFloor["2"]`     现 8 行  →  追加 2 句短句 ≈ 10 行
 *   · `princess.talkByFloor["26"]`（+ greet） →  追加 9 句短句 ≈ 10 行
 *
 * 两段都超限，是为了回答一个更要紧的问题：**A25a 与 A25d 是不是重复的**。
 *
 *   A25a 的靶子是**按 chars 自动选出的那一个**（最长段）⇒ 只会报 1 条；
 *   A25d 逐段过一遍 ⇒ 报**全部**超限段。
 *
 * 实测（2026-09-27）：A25a 报 1 条（靶子自动换到 princess）、A25d 报 2 条，
 * 且两条都点明「尾巴被截断」。若探针下两条只报同样一条，那 A25d 就是多余的。
 *
 * ## 为什么改 data 还不够，必须 rebuild
 *
 * 判据的**期望值**在 Node 侧从 `data/npcs.json` 读，而 A25a 让**浏览器里的**人真说话
 * ——浏览器用的是 `dist/` 里**打包进去**的那份副本（铁律 #30）。只改 data 不 rebuild，
 * A25a 会以「数据不同步」的方式变红，那是假红，量不出「段太长装不下」。
 * ⇒ 本脚本只负责改 / 还原数据；`npm run build` 与 `verify:visual` 在外面跑。
 *
 * ## 用法
 *
 * ```bash
 * node tools/probe-a25d-dialogue-fit.mjs --apply
 * mv dist /tmp/dist_bak_$(date +%s) && npm run build && npm run verify:visual   # 看 A25a / A25d 各报几条
 * node tools/probe-a25d-dialogue-fit.mjs --restore && npm run build            # 还原（逐字节复查）
 * ```
 *
 * ⚠️ 会写仓库文件（`data/npcs.json`）⇒ **刻意不进 `verify:all`**（那是给别人 CI 跑的）。
 *    与 `probe-prison-judgments.mjs` / `probe-score-unify.mjs` 同规。
 *
 * ## 崩溃还原（铁律 #64 的三件套）
 *
 *   ① 开局把原文**快照到磁盘**（`/tmp/probe-a25d-dialogue-fit/`），且**拒绝叠加**：
 *      快照已存在时 `--apply` 直接报错，不覆盖 —— 那意味着上一次没还原干净。
 *   ② `SIGINT`/`SIGTERM`/`uncaughtException`/`exit` 多重还原。
 *   ③ `--restore` 最末**逐字节**比对快照，不一致以非零码退出。
 *
 * ⚠️ 第一版把「紧急还原」无条件挂在 `process.on('exit')` 上 ⇒ `--apply` 刚改完文件、
 *    **正常退出**时就把自己还原了 —— 探针静默失效，而且是「看起来跑过了」的那种失效。
 *    ⇒ `exit` **分不清正常退出与异常退出**，正常路径必须显式置 `finished`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'data', 'npcs.json');
const SNAP_DIR = '/tmp/probe-a25d-dialogue-fit';
const SNAP = path.join(SNAP_DIR, 'npcs.json');

const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

/** 只用来把行占满的短句（每句恰好一行） */
const PAD = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬'].map(
  (c) => `探针${c}：这句话只用来把这一行占满。`
);

// ══════════════════════════════════════════════════════════════════
// --apply：快照 + 加长
// ══════════════════════════════════════════════════════════════════
function apply() {
  if (fs.existsSync(SNAP)) {
    throw new Error(
      `快照已存在：${SNAP}\n` +
        `⇒ 上一次探针没还原干净（或正在跑）。先 --restore，别在坏数据上再叠一层。`
    );
  }
  const orig = fs.readFileSync(TARGET);
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.writeFileSync(SNAP, orig); // ① 磁盘快照
  console.log(`① 快照        ${orig.length} B  sha=${sha(orig)}  → ${SNAP}`);

  const data = JSON.parse(orig.toString('utf8'));
  const npcs = data.npcs;

  const before = {
    thief: npcs.thief.talkByFloor['2'].length,
    princess: npcs.princess.talkByFloor['26'].length
  };

  npcs.thief.talkByFloor['2'] = [...npcs.thief.talkByFloor['2'], PAD[0], PAD[1]];
  npcs.princess.talkByFloor['26'] = [...npcs.princess.talkByFloor['26'], ...PAD];

  const out = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.writeFileSync(TARGET, out);

  console.log(`② 改坏        ${out.length} B  sha=${sha(out)}`);
  console.log(`   thief.talkByFloor["2"]     ${before.thief} 句 → ${npcs.thief.talkByFloor['2'].length} 句`);
  console.log(`   princess.talkByFloor["26"] ${before.princess} 句 → ${npcs.princess.talkByFloor['26'].length} 句`);
  console.log('');
  console.log('③ 下一步（数据改了，必须让 dist 也带上这一版）：');
  console.log('   mv dist /tmp/dist_bak_$(date +%s) && npm run build && npm run verify:visual');
  console.log('   node tools/probe-a25d-dialogue-fit.mjs --restore && npm run build');
}

// ══════════════════════════════════════════════════════════════════
// --restore：还原 + 逐字节复查
// ══════════════════════════════════════════════════════════════════
function restore() {
  if (!fs.existsSync(SNAP)) throw new Error(`没有快照可还原：${SNAP}`);
  const snap = fs.readFileSync(SNAP);
  const cur = fs.readFileSync(TARGET);
  fs.writeFileSync(TARGET, snap);
  const now = fs.readFileSync(TARGET);
  const ok = Buffer.compare(snap, now) === 0;
  console.log('还原 data/npcs.json');
  console.log(`  快照   ${snap.length} B  sha=${sha(snap)}`);
  console.log(`  坏版   ${cur.length} B  sha=${sha(cur)}`);
  console.log(`  还完   ${now.length} B  sha=${sha(now)}`);
  if (!ok) {
    console.error('✗ 逐字节比对不一致 —— 还原失败，别再往下走');
    process.exit(1);
  }
  fs.unlinkSync(SNAP);
  console.log('✓ 逐字节一致；快照已删。别忘了再 npm run build 一次。');
}

const mode = process.argv.includes('--restore')
  ? 'restore'
  : process.argv.includes('--apply')
    ? 'apply'
    : 'usage';

if (mode === 'usage') {
  console.log('用法：node tools/probe-a25d-dialogue-fit.mjs --apply | --restore');
  process.exit(0);
}

// ② 多重还原：apply 中途崩了就把文件放回去。
//    判据用「快照在不在磁盘上」而不是内存里某个布尔量 —— 后者是上一轮事故的成因
//    （崩在标志置位之前就等于没有还原）。
//    ⚠️ `exit` 分不清正常退出与异常退出 ⇒ 正常路径必须先置 `finished`。
let finished = false;

function emergency() {
  if (mode !== 'apply' || finished || !fs.existsSync(SNAP)) return;
  try {
    fs.writeFileSync(TARGET, fs.readFileSync(SNAP));
    console.error(`⚠️ 异常退出 → 已紧急还原 data/npcs.json（快照保留在 ${SNAP}，供复查）`);
  } catch (e) {
    console.error(`⚠️ 异常退出 → 紧急还原失败：${e.message}（原文还在 ${SNAP}）`);
  }
}
process.on('exit', emergency);
process.on('SIGINT', () => {
  process.exit(130);
});
process.on('SIGTERM', () => {
  process.exit(143);
});
process.on('uncaughtException', (e) => {
  console.error(e);
  process.exit(1);
});

if (mode === 'apply') {
  apply();
  finished = true;
} else {
  restore();
}
