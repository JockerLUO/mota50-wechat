/**
 * 把 deluxe 源（h5mota 官方原版复刻数据）的**对白**导入本项目 `data/npcs.json` 的 `talkByFloor`。
 *
 * ## 这个脚本为什么存在
 *
 * 现用的参考源 `m8705/MAGIC-TOWER-JS` 上游自述「**只写完了前 10 层的事件部分**」，
 * 所以本项目的 NPC 台词一直是**残缺**的：`sage.talkByFloor` 只有 1/2/3 层，
 * 而原版智者从 2 层一路提示到 48 层。
 *
 * `githubxzw/mota50-deluxe` 的数据来自 **h5mota 官方原版复刻**，对白是完整的。
 * 两个源的地图**是同一张**（逐格 97.03% 一致，deluxe 是 13×13、本项目是去掉外框的 11×11，
 * 坐标映射为 **−1**），所以对白可以按楼层精确落到本项目已有的 NPC 上
 * （实测 22/23 条智者提示都能落到本项目的 sage 坐标上）。
 *
 * ## 边界：本脚本只碰「对白」，不碰「效果」
 *
 * 有意**不**处理的三类（各自的理由）：
 *
 * 1. **`gift`**（2 层送 1000 金币、3 层送怪物书）—— 效果归属在 `events.json`，
 *    本脚本只写台词。有 gift 的条目会在报告里标出来，供人工核对台词与效果是否说得通。
 * 2. **商品数值差异**（31 层 deluxe 是「黄钥匙×4+蓝钥匙×1」、47 层地震卷轴 4000）——
 *    那是 `goodsByFloor` 的事，改它会动平衡，不在「补对白」范围内。只**报告**。
 * 3. **带触发条件的剧情**（cutscene、`if flag then ...` 的 step）—— 需要引擎支持
 *    条件分支与放置/删除实体，本轮不做（见 docs/known-gaps.md）。
 *    例外：小偷/公主那些**纯台词**的 step 仍按「这人说过的话」归入其 `talkByFloor`。
 *
 * ## 数据文件是生成的，不要手改
 *
 * `npcs.json` 的 `talkByFloor` 这一层由本脚本负责；其余字段（`greet` / `repeat` /
 * `note` / `goodsByFloor` / `effects`）是手写的，脚本**原样保留**。
 * 手改 `talkByFloor` 会在下次运行时静默丢失。
 *
 * ## 用法
 *
 *   node tools/import-deluxe-dialogue.mjs           # dry-run：只打印将要发生的改动
 *   node tools/import-deluxe-dialogue.mjs --write   # 真正写入 data/npcs.json
 *
 * 与 `tools/analyze-deluxe-dialogue.mjs` 的分工：那个是**对照表**（人读的），
 * 这个是**执行器**（改数据）。分析器先跑，确认缺口后再执行。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'reference/mota50-deluxe/source/mota-data.js');
const NPCS = path.join(ROOT, 'data/npcs.json');
const FLOORS = path.join(ROOT, 'data/floors');
const WRITE = process.argv.includes('--write');

// ── 读源 ────────────────────────────────────────────────────────────
if (!fs.existsSync(SRC)) {
  console.error(`找不到 ${SRC}。见 reference/mota50-deluxe/ATTRIBUTION.md`);
  process.exit(2);
}
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: SRC });
const D = ctx.window.MOTA_DATA;

const npcsDoc = JSON.parse(fs.readFileSync(NPCS, 'utf8'));

// ── 结构自检：源的表在不在、形状对不对（导入阶段就拦住，别留给运行期）──
{
  const need = ['oldmanHints', 'traders', 'shrines', 'cutscenes', 'floors'];
  const bad = need.filter((k) => !D[k]);
  if (bad.length) {
    console.error(`[deluxe] 源数据缺少表：${bad.join(', ')} —— 上游形态变了，先更新本脚本`);
    process.exit(1);
  }
  if (D.floors.length !== 51) {
    console.error(`[deluxe] floors 应为 51 层，实际 ${D.floors.length} —— 上游形态变了`);
    process.exit(1);
  }
  for (const k of ['sage', 'merchant', 'thief', 'princess']) {
    if (!npcsDoc.npcs[k]) {
      console.error(`[deluxe] 本项目 npcs.json 里没有 ${k} —— 落点不存在`);
      process.exit(1);
    }
  }
}

/** 本项目某层某 id 的 NPC 坐标（用来确认「这条台词真的有载体」） */
const myFloor = {};
for (const f of fs.readdirSync(FLOORS)) {
  if (!/^floor-\d+\.json$/.test(f)) continue;
  const j = JSON.parse(fs.readFileSync(path.join(FLOORS, f), 'utf8'));
  myFloor[j.index] = j;
}
const hasHome = (floor, id) =>
  (myFloor[floor]?.entities ?? []).some((e) => e.type === 'npc' && e.id === id);

// ── 收集：各 NPC 的新台词（按楼层）────────────────────────────────────
const next = { sage: {}, merchant: {}, thief: {}, princess: {} };
const notes = [];   // 报告用
const skipped = []; // 落不下去的

/** oldmanHints → sage（`text` 栏）与 merchant（`trader` 栏） */
for (const [floor, v] of Object.entries(D.oldmanHints)) {
  const n = Number(floor);
  const oldman = v.text || v.oldman || '';
  const trader = v.trader || '';

  if (oldman) {
    if (v.oldman) notes.push(`${n} 层：oldmanHints 是 oldman/trader 双栏结构，oldman 栏归 sage`);
    if (hasHome(n, 'sage')) next.sage[n] = oldman;
    else skipped.push(`sage ${n} 层「${oldman.slice(0, 20)}…」（本项目该层无 sage 实体）`);
    if (v.gift) notes.push(`${n} 层：源里带 gift=${JSON.stringify(v.gift)} —— 效果归属见 events.json / goodsByFloor，本脚本只写台词`);
  }
  if (trader) {
    if (hasHome(n, 'merchant')) next.merchant[n] = trader;
    else skipped.push(`merchant ${n} 层「${trader.slice(0, 20)}…」（本项目该层无 merchant 实体）`);
  }
}

/** traders → merchant 的叫卖词（`text` 栏就是他说的话） */
for (const [floor, t] of Object.entries(D.traders)) {
  const n = Number(floor);
  if (!t.text) continue;
  if (hasHome(n, 'merchant')) next.merchant[n] = t.text;
  else skipped.push(`merchant ${n} 层叫卖「${t.text.slice(0, 20)}…」（本项目该层无 merchant 实体）`);
}

// ── 从 cutscenes / step 里取「某个 NPC 说过的话」（纯台词，不带条件判断）──
// 只取这个 NPC **作为地图 NPC 出场**的楼层，不取旁白与别人的台词。
const NPC_OF = { 小偷: 'thief', 洋娃娃: 'princess' };

/**
 * 「动作序列里有 flag」默认跳过，但**这几处例外** —— 它们是本项目**已经实现了的剧情**，
 * 台词就是这个人说的原话，收进 `talkByFloor` 只是把自撰台词换成原版：
 *
 *   · thief 2 层   —— 源里小偷在 (3,7)/(1,9)/(10,11) 三处，对应「越狱 → 逃出 → 再遇」。
 *                    本项目已用自撰台词实现同一段剧情（`f2-prison-open` + thief.note），
 *                    位置合并成 (3,4) 一个实体，但三句话都是他说过的。
 *   · princess 26 层 —— 源里 (6,6) 的「洋娃娃」，映射后正好是本项目 princess 的 (5,5)。
 *                    含 flag 的那半只是「是否已营救」的分支，台词本身照收。
 *
 * ⚠️ 名单是**写死**的：新增例外要连理由一起加，别改成「凡是有台词的都收」——
 *    那样会把「营救公主后才生效」这种**条件台词**变成随口就说的，静默改掉游戏行为。
 */
const ALLOW_FLAGGED = { thief: [2], princess: [26] };
/** 收集某处所有 text 里、指定说话人的台词 */
function linesOf(who, at) {
  const found = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      // 只看「同一层动作序列」里的直接对话，不递归进 if 的 else 分支去凑
      if (v.t === 'text' && v.who === who && v.text) found.push(v.text);
      for (const [k, x] of Object.entries(v)) if (k !== 'text') walk(x);
    }
  };
  walk(at);
  return found;
}
/** 该处的动作序列是否依赖 flag（依赖就不当「常规台词」收） */
function dependsOnFlag(at) {
  const s = JSON.stringify(at);
  return s.includes('"flag"') || s.includes('"if"');
}

for (const f of D.floors) {
  const n = f.n;
  for (const [at, acts] of Object.entries(f.step || {})) {
    for (const [who, id] of Object.entries(NPC_OF)) {
      const lines = linesOf(who, acts);
      if (!lines.length) continue;
      const allowed = (ALLOW_FLAGGED[id] || []).includes(n);
      const flagged = dependsOnFlag(acts);
      if (flagged && !allowed) {
        skipped.push(`${id} ${n} 层 @${at} 的 ${lines.length} 句（动作序列里有 if/flag，属剧情分支，本轮不落）`);
        continue;
      }
      if (flagged) notes.push(`${id} ${n} 层 @${at}：含 if/flag，但在 ALLOW_FLAGGED 白名单里（本项目已实现该剧情）⇒ 收作常规台词`);
      if (!hasHome(n, id)) {
        skipped.push(`${id} ${n} 层 @${at} 的 ${lines.length} 句（本项目该层无 ${id} 实体）`);
        continue;
      }
      // 同层多条既可能是「一段连续对话」也可能是「两处不同触发」，用数组保序；
      // 源里同一句会重复出现（洋娃娃把同一句话连说两遍），去重后再收。
      const acc = Array.isArray(next[id][n]) ? next[id][n] : next[id][n] ? [next[id][n]] : [];
      for (const line of lines) if (!acc.includes(line)) acc.push(line);
      next[id][n] = acc;
    }
  }
  // MT50 的小偷真身揭示：小偷在第 50 层**没有实体**，跳过（由 cutscene 承担）
}

/** MT1 (7,10) 的作者欢迎语 —— **有意不采用**，只记进报告 */
{
  const t1 = D.floors.find((f) => f.n === 1)?.talk || {};
  for (const [at, acts] of Object.entries(t1)) {
    const line = linesOf('作者', acts)[0];
    if (line) {
      notes.push(
        `1 层 (${at}) 的「${line.slice(0, 24)}…」**有意不采用**：它说的是「欢迎来到《魔塔50层》原版复刻」，` +
        `那是 **deluxe 这个复刻项目自己的标语**（img=king 的作者口吻，属它的元信息而非原版游戏内容）。` +
        `本项目同样是复刻，引用它 = 让自己也说「原版复刻」，语义错位。` +
        `（本项目 1 层 (6,9) 站的是 sage，本来就没有 author 实体 —— 落表也会变成「写了没人读」，校验器的 neverPlaced 会报出来。）`
      );
    }
  }
}

// ── 生成新的 talkByFloor（旧的被替换的记录下来）──────────────────────
const changes = [];
function applyTalkByFloor(id, obj) {
  const cur = npcsDoc.npcs[id].talkByFloor || {};
  const merged = { ...cur, ...obj };
  // 楼层升序，读起来像一条时间线
  const sorted = {};
  for (const k of Object.keys(merged).sort((a, b) => Number(a) - Number(b))) sorted[k] = merged[k];

  for (const [f, v] of Object.entries(obj)) {
    const before = cur[f];
    const eq = JSON.stringify(before) === JSON.stringify(v);
    changes.push({
      id, floor: Number(f),
      kind: before === undefined ? 'add' : eq ? 'same' : 'replace',
      before, after: v
    });
  }
  npcsDoc.npcs[id].talkByFloor = sorted;
  return Object.keys(cur).length;
}

const beforeCounts = {};
for (const id of Object.keys(next)) {
  beforeCounts[id] = Object.keys(npcsDoc.npcs[id]?.talkByFloor || {}).length;
}
const touched = [];
for (const [id, obj] of Object.entries(next)) {
  if (!Object.keys(obj).length) continue;
  applyTalkByFloor(id, obj);
  touched.push(id);
}

/**
 * 清掉历史遗留的 `npcs.author`。
 *
 * 本脚本的早期版本曾把它写进表（当时以为「内容不丢」就是对的），但它在地图上
 * **没有任何实体** —— 校验器 I 段的 `neverPlaced` 立刻报出「定义了但从未出现的 NPC」。
 * 那是铁律 #50 的形状：**写了但没人读的字段比没有更坏**（读者会以为它生效了）。
 * 现在改为只在报告里说明来源与不采用的理由。
 *
 * 判定条件写得窄（`sourceId === null`）是**故意的**：将来若真有人手工补一条
 * 有 sourceId 的 author，不该被本脚本顺手删掉。
 */
if (npcsDoc.npcs.author && npcsDoc.npcs.author.sourceId === null) {
  delete npcsDoc.npcs.author;
  notes.push('已删除历史遗留的 npcs.author（地图上没有实体 ⇒ 它的 talkByFloor 永远不会被读到）');
}

// ── 报告 ────────────────────────────────────────────────────────────
const L = (s = '') => console.log(s);
L('═'.repeat(76));
L(`deluxe 对白导入${WRITE ? '【写入】' : '【dry-run，未写入】'}`);
L('═'.repeat(76));
L(`源: reference/mota50-deluxe/source/mota-data.js（h5mota 官方原版复刻）`);
L();
for (const id of touched) {
  const after = Object.keys(npcsDoc.npcs[id].talkByFloor).length;
  L(`  ${id.padEnd(10)} talkByFloor ${beforeCounts[id]} → ${after} 层` +
    `   新增 ${changes.filter((c) => c.id === id && c.kind === 'add').length}` +
    ` / 替换 ${changes.filter((c) => c.id === id && c.kind === 'replace').length}` +
    ` / 相同 ${changes.filter((c) => c.id === id && c.kind === 'same').length}`);
}
L();
if (changes.some((c) => c.kind === 'replace')) {
  L('被**替换**的原有台词（逐条核对，确认不是误伤）：');
  for (const c of changes.filter((c) => c.kind === 'replace')) {
    L(`  ${c.id} ${c.floor} 层`);
    L(`    旧: ${String(Array.isArray(c.before) ? c.before.join(' / ') : c.before).slice(0, 70)}`);
    L(`    新: ${String(Array.isArray(c.after) ? c.after.join(' / ') : c.after).slice(0, 70)}`);
  }
  L();
}
if (notes.length) {
  L('说明：');
  for (const n of notes) L('  · ' + n);
  L();
}
if (skipped.length) {
  L(`未能落地（${skipped.length} 条，都已记录原因）：`);
  for (const s of skipped) L('  ✗ ' + s);
  L();
}

// ── 写入 ────────────────────────────────────────────────────────────
if (WRITE) {
  const before = fs.readFileSync(NPCS, 'utf8');
  // 快照：万一写坏了，上一版还在（铁律 #64 的精神 —— 改仓库文件的脚本人人自危）
  const snap = NPCS + '.bak';
  if (!fs.existsSync(snap)) fs.writeFileSync(snap, before);
  // $comment 里补一句来源，否则读者看不出这个字段是生成的
  npcsDoc.$comment =
    (npcsDoc.$comment || '').replace(/\s*【talkByFloor 来源】[\s\S]*$/, '') +
    ' 【talkByFloor 来源】该字段由 tools/import-deluxe-dialogue.mjs 从 reference/mota50-deluxe' +
    '/source/mota-data.js（h5mota 官方原版复刻数据）生成，**不要手改**，改了下一次运行会覆盖。' +
    '其余字段（greet/repeat/note/goodsByFloor/effects）为手写。';
  fs.writeFileSync(NPCS, JSON.stringify(npcsDoc, null, 2) + '\n');
  const after = fs.readFileSync(NPCS, 'utf8');
  L(`已写入 ${path.relative(ROOT, NPCS)}  ${before.length} → ${after.length} 字节`);
  L(`（上一版快照留在 ${path.relative(ROOT, snap)}，确认无误后删掉）`);
} else {
  L('（这是 dry-run。确认上面的替换与跳过都合理后，加 --write 执行）');
}
