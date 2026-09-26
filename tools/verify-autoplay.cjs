#!/usr/bin/env node
/**
 * 「自动通关」的可复算判据。
 *
 * ## 为什么这一套必须独立存在
 *
 * 在它出现之前，「自动通关」的验收方式是**盯着屏幕看勇者走**——
 * 50 层、上千步，人眼只能看出「好像在动」。`tools/autoplay-sim.mjs` 已经
 * 把决策核心搬到 Node 里了，但没有判据，于是「这一轮改动到底有没有让它更接近通关」
 * 每次都得靠人读报告。
 *
 * 这一套把报告变成**会红会绿的数字**，并且刻意分成两组：
 *
 *   · **回归判据（现在必须绿）** —— 不倒退的底线：没死循环、没阵亡、
 *     最远层不低于已达成的最好成绩、里程碑至少拿到一个。改策略时踩坏东西，
 *     它会立刻红。
 *   · **目标判据（现在红是正常的）** —— `cleared === true`、18 件里程碑全拿、
 *     进度基准全达到。它们红着就是「还没做完」，绿了就是做完了。
 *
 * 两组合在一起，输出本身就是进度条：红的目标判据剩几条，一眼看得出还差多远。
 *
 * ## 与其它 `verify:*` 的关系
 *
 * 它**不进 `verify:all`**：整局模拟要跑上万步，比另外五套加起来还慢。
 * 它是独立入口，提交前手动跑（判据红的时候顺便把卡点打印出来）。
 *
 * 用法：`npm run verify:autoplay [-- --max-steps 20000] [-- --phases]`
 *   · 默认只跑**贪心**整局模拟（快，是当前接得上的那条路）
 *   · `--phases` 额外跑一遍**分阶段规划**（慢，是攻坚目标）
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
};
const maxSteps = getArg('max-steps', 20000);
const withPhases = argv.includes('--phases');

/**
 * 已达成的最好成绩 —— **回归判据的下限**。
 *
 * ⚠️ 改策略让 AI 走得更远/拿得更多时，**必须把这里的数往上调**：
 * 它守的是「不许倒退」，不是「达标」。调低它等于删判据（铁律 #37）。
 */
const BASELINE = {
  maxFloor: 9,
  milestones: 1,
  /**
   * 同一局势最多重复几次 —— **从「目标」提升上来的回归下限**。
   *
   * 2026-09-26 第七轮统一闸门（`floorHasWork` 改读 `gateItem/Monster/Npc`）之前
   * 实测是 **31 次**；修完是 **2 次**（步数 5000+ → 1263）。
   * 阈值取 12：健康局留 6 倍余量，而旧病（≥31）无论如何都过不去。
   * ⚠️ 与 `a20-idle-bob` 的窗口一样，这个数**改了要重跑一遍健康局再定**，别凭感觉（铁律 #39）。
   */
  maxCycle: 12,
  note: '2026-09-26 第七轮：统一闸门后「不在楼层之间空转」从目标转正（31 次 → 2 次）；F9 / 里程碑 1 未变'
};

function add(name, ok, detail) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  —— ${detail}` : ''}`);
  return { name, ok };
}

// ── A 段：攻略骨架与 data/ 的交叉核对（不跑模拟，几毫秒）──────────────
//
// 为什么放在最前面：`data/walkthrough.json` 是**手写**的策略数据，
// 它的楼层与道具 id 完全可能写错，而写错的后果是「AI 朝一个不存在的东西努力」——
// 搜索照样跑、报告照样出，只是永远达不成阶段目标。这类错误必须在几毫秒内报出来，
// 不能等跑完两万步。

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 道具 id → 出现过的楼层集合（从楼层文件里现算，不依赖任何缓存） */
function itemFloors() {
  const place = {};
  const dir = path.join(DATA, 'floors');
  for (const file of fs.readdirSync(dir)) {
    if (!/^floor-\d+\.json$/.test(file)) continue;
    const floor = readJson(path.join(dir, file));
    for (const e of floor.entities ?? []) {
      if (e.type !== 'item') continue;
      (place[e.id] ??= []).push(floor.index);
    }
  }
  return place;
}

function sectionWalkthrough(results) {
  console.log('\nA · 攻略骨架与数据交叉核对（data/walkthrough.json）');
  const wt = readJson(path.join(DATA, 'walkthrough.json'));
  const items = readJson(path.join(DATA, 'items.json')).items;
  const monsters = readJson(path.join(DATA, 'monsters.json')).monsters;
  const place = itemFloors();

  // A1 里程碑：id 有效 + 声明楼层真的放着它
  const badMilestones = [];
  for (const m of wt.milestones) {
    if (!items[m.id]) {
      badMilestones.push(`${m.id} 不是合法道具 id`);
      continue;
    }
    const floors = place[m.id] ?? [];
    if (!floors.includes(m.floor)) {
      badMilestones.push(`${m.name}(${m.id}) 声明 F${m.floor}，实际在 [${floors.join(',') || '从未放置'}]`);
    }
    if (!Number.isFinite(m.bonus)) badMilestones.push(`${m.name}(${m.id}) 缺 bonus`);
    if (!m.why) badMilestones.push(`${m.name}(${m.id}) 缺 why（不可审计）`);
  }
  results.push(
    add(
      `里程碑与地图一致（${wt.milestones.length} 件）`,
      badMilestones.length === 0,
      badMilestones.length === 0 ? '每件的 id / 楼层 / bonus / why 都成立' : badMilestones.join('；')
    )
  );

  // A2 阶段目标可解析
  const badPhases = [];
  for (const ph of wt.phases) {
    const g = ph.goal;
    if (!ph.why) badPhases.push(`${ph.id} 缺 why`);
    if (g.type === 'item' && !items[g.id]) badPhases.push(`${ph.id} 的道具 ${g.id} 不存在`);
    if (g.type === 'defeat' && !monsters[g.id]) badPhases.push(`${ph.id} 的怪物 ${g.id} 不存在`);
    if ((g.type === 'item' || g.type === 'defeat') && g.floor === undefined) {
      badPhases.push(`${ph.id} 没有楼层（估价算不出梯度）`);
    }
    //
    // `arriveKeys` 是一份**名字清单** —— 写成 `yellowkey` / `yellow` / `黄钥匙`
    // 都不会报错，只会**静默不生效**（储备这一档等于没加，而报告照样全绿）。
    // 与铁律 #23 同源：名单写错时的表现是「安静」而不是「红」。
    for (const [k, v] of Object.entries(ph.arriveKeys ?? {})) {
      if (!['yellowKey', 'blueKey', 'redKey'].includes(k)) {
        badPhases.push(`${ph.id} 的 arriveKeys 里 "${k}" 不是合法钥匙 id（yellowKey/blueKey/redKey）`);
      }
      if (!Number.isInteger(v) || v <= 0) {
        badPhases.push(`${ph.id} 的 arriveKeys["${k}"] = ${v}，必须是正整数`);
      }
    }
  }
  results.push(
    add(
      `阶段目标可解析（${wt.phases.length} 个阶段）`,
      badPhases.length === 0,
      badPhases.length === 0 ? '道具 / 怪物 / 楼层都成立，且每条都有 why' : badPhases.join('；')
    )
  );

  // A3 进度准则是「可判定的数」——防止有人写一句描述当基准
  const badCps = (wt.checkpoints ?? []).filter(
    (c) => typeof c.floor !== 'number' || typeof c.hp !== 'number' || typeof c.atk !== 'number' || typeof c.def !== 'number'
  );
  results.push(
    add(
      `进度基准可判定（${(wt.checkpoints ?? []).length} 条）`,
      badCps.length === 0,
      badCps.length === 0 ? '每条都有 floor/hp/atk/def' : `${badCps.length} 条缺数值字段`
    )
  );

  return wt;
}

// ── Z 段：一区（1–10 层）事件，真的走一遍 ────────────────────────────
//
// 这一段守的是「数据里写了事件」与「引擎真的执行了」之间的那道缝。
// 本项目在这道缝上踩过一次（商人交易：`case 'trade'` 是空实现，数据齐备、
// 判据全绿、功能是死的），所以一区事件补完之后必须有**从头走一遍**的断言。

function sectionZone1(results, planner) {
  console.log('\nZ · 一区事件（headless：真的击杀 / 真的搭话）');
  for (const c of planner.zone1Verifications()) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}  —— ${c.detail}`);
    results.push({ name: c.name, ok: c.ok });
  }
  console.log('\nS · 评分系统（道具 / 怪物 / NPC 各一套刻度）');
  for (const c of planner.scoreVerifications()) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}  —— ${c.detail}`);
    results.push({ name: c.name, ok: c.ok });
  }
  // 决策器「为什么不是别的」—— 分数之外的**另一半**：分数再高，被闸门挡住照样不做。
  // 2026-09-26 追红判据时最缺的就是这一半（当时只能靠分数 + 格子图人工反推）。
  console.log('\nW · 决策交代（为什么不是别的：六段闸门各自挡了什么）');
  for (const c of planner.whyVerifications()) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}  —— ${c.detail}`);
    results.push({ name: c.name, ok: c.ok });
  }
}

// ── B 段：整局模拟（贪心）────────────────────────────────────────────

function sectionSim(results, sim) {
  console.log(`\nB · 整局模拟（贪心决策，最多 ${maxSteps} 步）`);

  const r = sim.simulate(maxSteps, false);

  console.log(
    `     实测：${r.cleared ? '通关' : '未通关'}　最终 F${r.floor}（最高 F${r.maxFloor}）　` +
      `步 ${r.steps}　HP ${r.hp}　攻/防 ${r.atk}/${r.def}　黄${r.keys.yellowKey}/蓝${r.keys.blueKey}/红${r.keys.redKey}`
  );
  console.log(`     商店购买 ${r.buys} 次　商人成交 ${r.trades} 次　撞不动 ${r.refusals} 次　击杀 ${r.kills}`);
  console.log(`     同一局势最多重复 ${r.maxCycle} 次（超过 30 由模拟器判走投无路并停下）`);

  // ── 回归判据（必须绿）──
  //
  // ⚠️ 这一条守的是「**原地不动**」：同一个 (层,坐标,动作) 连续重复 12 次。
  //    它**抓不到**另一种死法 —— 交替两步的横跳（上楼 ↔ 下楼），
  //    那种循环里从头到尾没有连续重复的动作，所以必须有下面那条局势判据。
  results.push(
    add('没有撞不动的死循环（连续同一动作 ×12）', r.stuckAt === null, r.stuckAt ? `卡在 ${r.stuckAt}` : '未触发')
  );
  results.push(add('勇者没有阵亡', !r.dead, r.dead ? '阵亡' : `剩余 HP ${r.hp}`));
  results.push(
    add(
      `最远层 ≥ ${BASELINE.maxFloor}（不倒退）`,
      r.maxFloor >= BASELINE.maxFloor,
      `实际 F${r.maxFloor}`
    )
  );
  const takenCount = r.milestones.filter((m) => m.taken).length;
  results.push(
    add(
      `里程碑 ≥ ${BASELINE.milestones}（不倒退）`,
      takenCount >= BASELINE.milestones,
      `实际 ${takenCount}/${r.milestones.length}：${r.milestones.filter((m) => m.taken).map((m) => m.name).join('、') || '无'}`
    )
  );
  // 撞不动只作观察：它是「目标算得出来、引擎却拒绝」的信号，
  // 有时是正常的（会打死自己的怪），所以给一个宽松的上限而不是 0
  results.push(add('撞不动次数 < 200（无明显空转）', r.refusals < 200, `实际 ${r.refusals} 次`));
  //
  // ★ 决策交代可用。
  //
  // 这是一条**回归**判据，不是目标判据：它守的是「停下来的时候能说出理由」这件事本身。
  // 在它之前，报告只能说「第 4 层无路可走」，而那句话对应十几种病
  // （够不着 / 钥匙不够 / 打不动 / 代价超上限 / 利润率不够 / 白来过…）——
  // 2026-09-26 追红判据时全靠人工反推，代价远大于写这段代码。
  // `whyTally` 也要判：快照只说「最后一步为什么走不动」，
  // 「这几千步到底被什么挡着」只有累计表答得上来。
  results.push(
    add(
      '停下时给出决策交代（六段闸门各自挡了什么）',
      !!r.why && r.why.rejected.length > 0 && r.why.chosen.length > 0 && r.whyTally.length > 0,
      r.why
        ? `选中「${r.why.chosen}」· ${r.why.rejected.length} 条挡因 · 累计 ${r.whyTally.length} 类` +
          `（最多的一类：${r.whyTally[0].stage} · ${r.whyTally[0].kind} ×${r.whyTally[0].count}）`
        : '未产生决策交代'
    )
  );

  //
  // ★★ 局势循环 —— **2026-09-26 第七轮从「目标」转正成「回归」**。
  //
  // 为什么必须转正：留在目标组里，它下一次变红会被读成「这件事还没做完」，
  // 而实际上它**已经做完过一次了** —— 那是倒退，必须当回归红处理（铁律 #44 的老病）。
  // 「目标转正」是这套两分组的常规动作：**做绿一条就把它搬进回归组，并把下限写进
  // `BASELINE`**，否则进度条只会一直显示「还差 5 条」而没人知道其中一条已经守住。
  //
  // 它守的是另一类死法：同一个 `层:坐标:hp:钥匙:金币:进展` 反复出现。
  // 上面那条「连续同一动作 ×12」**抓不到**它 —— 横跳（上楼 ↔ 下楼）里从头到尾
  // 没有连续重复的动作，每一步都合法。
  // 病根是 `floorHasWork()` 与 ② 各写一套闸门（「够得着」≠「真的会拿」）；
  // 修法是让它们读同一份（`gateItem` / `gateMonster` / `gateNpc`）。
  // 实测 **31 次 → 2 次**，步数 5000+ → 1263，失败理由也从
  // 「走投无路：局势循环」变成诚实的「第 9 层无路可走」。
  results.push(
    add(
      `同一局势重复 ≤ ${BASELINE.maxCycle} 次（不空转，不倒退）`,
      r.maxCycle <= BASELINE.maxCycle,
      `实际 ${r.maxCycle} 次${r.deadlock ? `，现场 ${r.deadlock}` : ''}（修前 31 次）`
    )
  );

  // ── 目标判据（现在红是正常的）──
  // ★ 用户当前划定的范围：第一个 BOSS。它是「一区能不能出去」的同义词
  // （击败它才触发 f10-zone1-clear 生成 10→11 的楼梯）。
  results.push(
    add(
      '★ 击败第一个 BOSS（第 10 层骷髅队长）',
      r.firstBossDefeated,
      r.firstBossDefeated ? `用 ${r.steps} 步` : `未击败（最远 F${r.maxFloor}）`
    )
  );
  results.push(add('★ 通关（击败真魔王）', r.cleared, r.cleared ? `用 ${r.steps} 步` : r.reason));
  const missing = r.milestones.filter((m) => !m.taken);
  results.push(
    add(
      `★ 18 件里程碑全部取得`,
      missing.length === 0,
      missing.length === 0 ? '全拿到' : `缺 ${missing.length} 件：${missing.map((m) => `${m.name}(F${m.floor})`).join('、')}`
    )
  );
  results.push(
    add(
      `★ 进度基准全达到`,
      r.checkpointFails.length === 0,
      r.checkpointFails.length === 0 ? '全部达到' : r.checkpointFails.join('；')
    )
  );

  // 卡点必须可读 —— 没有这一条，红的判据只说明「不行」，不说明「为什么不行」
  console.log('\n     卡点摘要：');
  if (r.stuckAt) console.log(`       · 撞不动死循环：${r.stuckAt}`);
  if (r.deadlock) console.log(`       · 走投无路（局势循环）：${r.deadlock}`);
  for (const line of r.tail.slice(-6)) console.log(`       · ${line}`);
  for (const line of r.leftovers.slice(0, 9)) console.log(`     ${line}`);

  return r;
}

// ── C 段（可选）：分阶段规划 ─────────────────────────────────────────

function sectionPhases(results, planner) {
  console.log('\nC · 分阶段规划（攻略骨架驱动，慢）');
  const r = planner.runPhases({ maxBeam: 32, maxIter: 300, maxNodesPerPhase: 200000 });

  for (const ph of r.phases) {
    const goal =
      ph.goal.type === 'item' ? `道具 ${ph.goal.id}` : ph.goal.type === 'floor' ? `到达 F${ph.goal.floor}` : ph.goal.type;
    console.log(`  ${ph.ok ? '✅' : '❌'} ${ph.id.padEnd(12, ' ')} ${goal}　动作 ${ph.actions.length}　最远 F${ph.reachedFloor}`);
  }

  const reached = r.phases.filter((p) => p.ok).length;
  results.push(
    add(`★ 阶段全部达成（${r.phases.length} 个）`, reached === r.phases.length, `已达成 ${reached}/${r.phases.length}`)
  );
  results.push(add('★ 分阶段规划通关', r.cleared, r.cleared ? `最远 F${r.maxFloor}` : `停在 ${r.phases.find((p) => !p.ok)?.id ?? '未知'}`));
}

// ── main ────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══ 自动通关判据（headless，与游戏同一套引擎）══');
  console.log(`   基线：最远层 ≥ ${BASELINE.maxFloor}、里程碑 ≥ ${BASELINE.milestones}`);
  console.log(`   来源：${BASELINE.note}`);

  const results = [];
  const wt = sectionWalkthrough(results);

  if (!results.every((r) => r.ok)) {
    console.log('\n⚠️ 攻略骨架与数据不一致，跳过整局模拟（先把 A 段修绿）');
  } else {
    // 打包 + 载入走 `tools/autoplay/bundle.mjs`（与 `npm run autoplay` 同一份配置）
    const bundle = await import(pathToFileURL(path.join(__dirname, 'autoplay/bundle.mjs')).href);
    sectionZone1(results, await bundle.loadPlanner());
    sectionSim(results, await bundle.loadSim());
    if (withPhases) sectionPhases(results, await bundle.loadPlanner());
  }

  const failed = results.filter((r) => !r.ok);
  const hardFailed = failed.filter((r) => !r.name.startsWith('★')).length;
  const targetFailed = failed.length - hardFailed;
  console.log(
    `\n${hardFailed === 0 ? '✅ 回归判据全绿' : `❌ 回归判据 ${hardFailed} 条不通过`}` +
      `　·　目标判据 还差 ${targetFailed} 条` +
      `（共 ${results.length} 条判据）\n`
  );
  process.exit(hardFailed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n判据自身崩溃：', err);
  process.exit(2);
});
