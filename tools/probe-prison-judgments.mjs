#!/usr/bin/env node
/**
 * **判据元测试**：把 Z6–Z13（第 3 层伏击 → 牢房 → 越狱）每条判据的「病根」种回去，
 * 确认它真的会红。
 *
 *     npm run probe:prison
 *
 * ## 为什么需要它
 *
 * 与 `tools/probe-boss-judgments.py` 同源：判据写完了、一直是绿的，而它其实
 * **根本不可能红**（阈值定错、按恒空集合筛、分支没被走到）—— 比没有判据更糟，
 * 因为它给人一种「这块有人守着」的错觉。「新判据的验收 = 逐个探针证明会红」
 * 是一条硬规矩，这个脚本把那条规矩变成一条可执行的命令。
 *
 * ## 判据（用「改值」而不是「删算子」）
 *
 * 第一版是「删掉某个算子」（删 `say` / 删 `teleport`……）。跑了才发现：判据里有一条
 * **硬前置守卫**（`f3-ambush-prison` 少了 teleport / setTerrain(D) / setTerrain(w)
 * 就直接抛错，不让判据空转）——删算子的探针会撞上守卫、把 Z6–Z13 整组一起打断，
 * 于是量不出「哪几条变红」的矩阵。
 *
 * 改成**保留算子、只改它的值**（落点挪到走廊、暗道挖错地方、触发格挪到非必经格……）
 * 之后，问的才是真正要紧的那句话：**判据在量数，还是只在查存在性？**
 *
 * ## ⚠️ 它会改仓库里的文件（改完自动还原）
 *
 * 三个被测对象是**磁盘上的数据/源码**（`loadPlanner()` 每次重新打包并直读 `data/`），
 * 没法用进程内 monkey-patch 代替。所以：
 *   ① 开局把三个文件**快照到磁盘**（`/tmp/probe-prison-snapshot/`）；
 *   ② `finally` + `exit/SIGINT/SIGTERM/uncaughtException` 三重还原；
 *   ③ 最末逐字节比对快照，不一致就以非零码退出。
 *
 * ⚠️ **别在别的构建/验证跑着的时候跑它** —— 它有一小段时间让仓库处于「数据是坏的」
 * 状态。这也是为什么它没有并进 `verify:all`（那是给别人 CI 跑的，不该写文件）。
 *
 * ①②③ 这套不是洁癖：第一版把原文只存在**内存**里，结果某个探针抛异常时
 * `restore()` 没执行到，`data/events.json` 被留在改坏的状态（teleport 被删），
 * 而磁盘上没有任何副本 —— 只能靠记忆重建。这里每一个多余的进程钩子都对应那次教训。
 *
 * ⚠️ 而**快照的自动还原本身又伤过我一次**（见下面 `.running` 标记那段的长注释）：
 * 「快照与当前不同就回写」分不清「崩溃残留」与「之后的合法修改」，把刚加的参数覆盖掉了。
 * ⇒ 只有「上一轮**没跑完**」时才回写。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlanner } from './autoplay/bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FILES = {
  EV: `${ROOT}/data/events.json`,
  F2: `${ROOT}/data/floors/floor-02.json`,
  TR: `${ROOT}/src/game/engine/travel.ts`
};

// ── ① 磁盘快照（进程崩了也还在）──
const SNAP = '/tmp/probe-prison-snapshot';
const orig = {};
const restoreAll = () => {
  for (const [k, p] of Object.entries(FILES)) fs.writeFileSync(p, orig[k]);
};
/**
 * 崩溃标记：只有「上一轮**没跑完**」时才允许拿快照回写仓库。
 *
 * ⚠️ **这一条是踩出来的，而且踩得很疼。** 第一版启动逻辑是「只要快照存在且与当前不同，
 * 就回写」——它**分不清两种「不同」**：
 *   ① 上一轮崩了、仓库留在改坏的状态（该还原）；
 *   ② 上一轮跑得好好的，**之后我又合法地改了那个文件**（绝不能还原）。
 * 实测：22:44 那轮干净跑完（快照留着），22:50 我给 `travel.ts` 加了 `avoidEntities` 参数，
 * 22:55 再跑探针 ⇒ 启动就把 22:44 的旧版**回写覆盖**了新参数 ⇒ `tsc` 报
 * `game.ts(347) Expected 5 arguments, but got 6`，而 `verify:visual` **照绿**
 * （它读的是上一次 `dist/`，铁律 #60 的假绿）。
 * ⇒ 现在用 `.running` 标记区分：标记在 ⇒ 上一轮确实是被杀掉的，才还原并消费快照；
 *   标记不在 ⇒ 快照是陈的，**只提示、不回写**，以当前文件为准重新快照。
 */
{
  const marker = path.join(SNAP, '.running');
  const crashed = fs.existsSync(marker);
  let consumed = 0;
  for (const [k, p] of Object.entries(FILES)) {
    const sp = path.join(SNAP, path.basename(p) + '.orig');
    if (crashed && fs.existsSync(sp)) {
      const prev = fs.readFileSync(sp, 'utf8');
      if (prev !== fs.readFileSync(p, 'utf8')) {
        fs.writeFileSync(p, prev);
        consumed++;
        console.log(`↩︎ 上一轮是崩溃退出：${path.relative(ROOT, p)} 已从快照还原`);
      }
    }
    orig[k] = fs.readFileSync(p, 'utf8');
  }
  fs.mkdirSync(SNAP, { recursive: true });
  for (const [k, p] of Object.entries(FILES)) fs.writeFileSync(path.join(SNAP, path.basename(p) + '.orig'), orig[k]);
  fs.writeFileSync(marker, String(process.pid));
  if (crashed) console.log(`（上一轮崩溃残留已消费${consumed ? `（回写了 ${consumed} 个文件）` : ''}）`);
  else if (fs.readdirSync(SNAP).length > 1) console.log('（快照目录里有上一轮干净跑完留下的副本：**不回写**，以当前内容重新快照）');
  console.log('');
}

let dirty = false;
const restore = () => {
  if (!dirty) return;
  restoreAll();
  dirty = false;
};
/** 收工时删掉 `.running` 标记 —— 标记的含义是「还在跑，别信仓库现在的样子」 */
const clearMarker = () => {
  try {
    fs.rmSync(path.join(SNAP, '.running'), { force: true });
  } catch {
    /* 退出钩子里不再抛 */
  }
};
const emergency = () => {
  try {
    restore();
    clearMarker();
  } catch {
    /* 退出钩子里不再抛 */
  }
};
process.on('exit', emergency);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));
process.on('uncaughtException', (e) => {
  emergency();
  console.error('\n💥 未捕获异常（仓库已还原）：', e);
  process.exit(1);
});

const write = (key, text) => {
  fs.writeFileSync(FILES[key], text);
  dirty = true;
};

/** 改事件（按 id 取；`loadPlanner()` 每次重新打包并直读磁盘，所以改完立刻生效） */
const patchEvent = (fn) => {
  const j = JSON.parse(orig.EV);
  fn(j.events.find((e) => e.id === 'f3-ambush-prison'));
  write('EV', JSON.stringify(j, null, 2) + '\n');
};

/** 跑一遍 Z6–Z13，返回变红的判据编号 */
async function reds(label) {
  const p = await loadPlanner();
  let res;
  try {
    res = p.zone1Verifications().filter((c) => /^Z(6|7|8|9|1[0-3])/.test(c.name));
  } catch (err) {
    console.log(`\n=== ${label} ===\n  💥 抛错（整组被守卫打断）：${String(err.message).slice(0, 70)}`);
    return ['💥'];
  }
  const red = res.filter((c) => !c.ok);
  console.log(`\n=== ${label} ===（共 ${res.length} 条，红 ${red.length}）`);
  if (!red.length) console.log('  （全绿：这个探针没点亮任何判据 —— 这条改动没人在守）');
  for (const c of red) console.log(`  ❌ ${c.name.split('：')[0]}  ${c.detail.slice(0, 96)}`);
  return red.map((c) => c.name.slice(0, 3));
}

/**
 * 在第 3 层自动挑一个**非必经格**当探针 ⑤ 的目标。
 *
 * 口径与 Z7 一致（乐观到底：只把 `#` 墙与 `*` 星际空间当阻挡）。挑法 =
 * 「封掉它之后 (10,10) 仍然可达」⇒ 它对「必经」是个**假目标**，正好当探针。
 */
function pickSpur() {
  const f = JSON.parse(fs.readFileSync(`${ROOT}/data/floors/floor-03.json`, 'utf8'));
  const HARD = new Set(['#', '*']);
  const reach = (block) => {
    const seen = new Set(['0,10']);
    const q = [[0, 10]];
    while (q.length) {
      const [x, y] = q.shift();
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx > 10 || ny > 10) continue;
        if (block && nx === block[0] && ny === block[1]) continue;
        const k = `${nx},${ny}`;
        if (seen.has(k) || HARD.has(f.terrain[ny][nx])) continue;
        seen.add(k);
        q.push([nx, ny]);
      }
    }
    return seen;
  };
  const open = reach(null);
  if (!open.has('10,10')) throw new Error('第 3 层 (0,10) 到不了上楼梯 —— 口径或地形有问题');
  for (const k of open) {
    const [x, y] = k.split(',').map(Number);
    if (k === '0,10' || k === '10,10') continue;
    if (f.terrain[y][x] !== '.') continue;
    if (!reach([x, y]).has('10,10')) continue; // 封掉它上楼梯仍然通 ⇒ 非必经
    return { x, y };
  }
  throw new Error('第 3 层找不到非必经的空地 —— 无法构造探针 ⑤');
}

const results = {};
const record = async (key, promise) => {
  results[key] = await promise;
  restore();
};

// ── 基线 ──
await record('全绿基线', reds('基线（不改任何东西，应全绿）'));

// ① 删 say：台词没有出口（玩家只看见画面一跳）
patchEvent((e) => {
  e.effects = e.effects.filter((x) => x.op !== 'say');
});
await record('① 删 say', reds('① 删掉 say：台词不再交回界面'));

// ② teleport 落点挪到走廊 (5,4)：人关不进牢房
patchEvent((e) => {
  const t = e.effects.find((x) => x.op === 'teleport');
  t.x = 5;
  t.y = 4;
});
await record('② 落点挪走廊', reds('② teleport 落点挪到走廊 (5,4)'));

// ③ 落锁挪到 (5,4)：正门 (4,4) 没落锁
patchEvent((e) => {
  const t = e.effects.find((x) => x.op === 'setTerrain' && x.terrain === 'D');
  t.x = 5;
});
await record('③ 落锁挪走廊', reds('③ setTerrain(D) 挪到 (5,4)：正门没锁'));

// ④ 暗道挖错地方 (1,3)：撞 (1,4) 出不去
patchEvent((e) => {
  const t = e.effects.find((x) => x.op === 'setTerrain' && x.terrain === 'w');
  t.x = 1;
  t.y = 3;
});
await record('④ 暗道挖错', reds('④ setTerrain(w) 挪到 (1,3)：暗道没挖在出口上'));

// ⑤ 触发格挪到一个**非必经格**：剧情永远不发生
const SPUR = pickSpur();
patchEvent((e) => {
  e.trigger.x = SPUR.x;
  e.trigger.y = SPUR.y;
});
await record(`⑤ 触发格→(${SPUR.x},${SPUR.y})`, reds(`⑤ 触发格挪到非必经格 (${SPUR.x},${SPUR.y})`));

// ⑥ nearestStandable 退回旧口径（道具也算占位）
{
  const patched = orig.TR.replace("    return !ent || ent.type === 'item';", '    return !ent;');
  if (patched === orig.TR) throw new Error('探针 ⑥ 没匹配到 nearestStandable 那一行');
  write('TR', patched);
}
await record('⑥ 落点退回旧口径', reds('⑥ nearestStandable 退回旧口径（道具也算占位）'));

// ⑦ 小偷不在牢房里（从第 2 层删掉那个实体）
{
  const j = JSON.parse(orig.F2);
  j.entities = j.entities.filter((e) => !(e.type === 'npc' && e.id === 'thief'));
  write('F2', JSON.stringify(j, null, 2) + '\n');
}
await record('⑦ 小偷挪走', reds('⑦ 小偷不在第 2 层（数据里删掉那个实体）'));

// ⑧ once:false：每次经过都被关
patchEvent((e) => {
  e.once = false;
});
await record('⑧ once→false', reds('⑧ once 改成 false：越狱后再走过那格会被关第二次'));

// ⑨ 牢房边界多开一个缺口（改底图，不动事件）
//
// 为什么必须补这一条：Z8 量的是「边界 = 6 墙 + 1 牢门 + 1 假墙」，而 (4,4) 那扇牢门
// **在 floor-02.json 的底图里本来就是 `D`** —— 所以探针 ③（把事件的落锁挪走）点亮的是
// Z10，不是 Z8。没有 ⑨ 的话 Z8 就是一个**没有任何探针能点亮**的判据，而「没人能证明
// 它会红」按铁律 #38 就等于「不知道它还在不在量东西」。
{
  const j = JSON.parse(orig.F2);
  const row = j.terrain[2];
  if (row[2] !== '#') throw new Error(`探针 ⑨ 期望 floor-02 (2,2) 是墙，实际是「${row[2]}」`);
  j.terrain[2] = row.slice(0, 2) + '.' + row.slice(3);
  write('F2', JSON.stringify(j, null, 2) + '\n');
}
await record('⑨ 牢房多开缺口', reds('⑨ 牢房边界 (2,2) 从墙改成空地'));

// ⑩ 把 arriveOnFloor 里那句 pickUpAt 删掉
//
// 铁律 #59 ②：把它保护的那处实现**退回旧口径**，看它会不会红。⑥ 虽然也能点亮 Z13，
// 但那是「落点被挪到没有道具的格」—— 证明不了「删掉拾取逻辑 Z13 会红」。
// 这条才是 Z13 的存在理由（也是**唯一**守它的那条：⑩ 只点亮 Z13，Z6/Z9 全绿）。
{
  const needle = '  pickUpAt(state, data, floor, x, y);\n';
  if (!orig.TR.includes(needle)) throw new Error('探针 ⑩ 没匹配到 arriveOnFloor 里的 pickUpAt 调用');
  write('TR', orig.TR.replace(needle, ''));
}
await record('⑩ 删落地拾取', reds('⑩ arriveOnFloor 里不再拾取（落地 ≠ 走上去）'));

// ── 汇总 ──
restore();
console.log('\n=== 汇总（每个探针点亮了哪几条）===');
const all = new Set(Object.values(results).flat());
for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(18)} ${v.length ? v.join(' ') : '（无）'}`);

const matrix = Object.entries(results).filter(([k]) => k !== '全绿基线');
console.log(`\n被点亮的判据：${[...all].sort().join(' ')}（共 ${all.size} 条）`);
if (matrix.some(([, v]) => !v.length)) {
  console.log('⚠️ 有探针一条判据都没点亮 —— 那处改动**没人在守**');
  process.exitCode = 1;
}
if (matrix.some(([, v]) => v.join(' ').includes('💥'))) {
  console.log('⚠️ 有探针把整组打断了（守卫抛错）—— 那几条没能单独被量到');
  process.exitCode = 1;
}
if (results['全绿基线']?.length) {
  console.log('⚠️ 基线就不绿 —— 先修基线再看探针');
  process.exitCode = 1;
}

// ── 还原后逐字节复查 ──
console.log('\n=== 还原复查（应与快照逐字节一致）===');
let sameAll = true;
for (const [k, p] of Object.entries(FILES)) {
  const same = fs.readFileSync(p, 'utf8') === orig[k];
  console.log(`  ${same ? '✓' : '✗'} ${path.relative(ROOT, p)}`);
  if (!same) {
    sameAll = false;
    process.exitCode = 1;
  }
}
if ((await reds('还原后全跑一遍（应全绿）')).length) process.exitCode = 1;
// 只有**确认仓库干净**才撤掉崩溃标记；否则留着，让下一轮知道该从快照还原
if (sameAll) clearMarker();
console.log(process.exitCode ? '\n❌ 探针结果不完整，见上面几条 ⚠️' : '\n✅ 八条判据全部至少被一个探针点亮，且互不重复');
