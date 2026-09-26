/**
 * 规划器的 headless 入口（由 tools/autoplay-plan.mjs 打包后 import）。
 */

import { loadData } from '../../src/data';
import { newGame } from '../../src/game/engine';
import { debugReach, debugTargets, plan, planBeam, planPhases } from '../../src/game/planner';
import { CATEGORY_ORDER, THRESHOLD, scoreDump } from '../../src/game/score';
import { explainDecision, reachCosts } from '../../src/game/autoplay';
import { loadWalkthrough } from './walkthrough';

// 一区事件的 headless 断言（`verify:autoplay` 的 Z 段用）
export { zone1Verifications } from './zone1';
export { scoreVerifications } from './score-verify';
// 决策器「为什么不是别的」的 headless 断言（`verify:autoplay` 的 W 段用）
export { whyVerifications } from './why-verify';
// 监牢剧情的剧本回放（`--prison` 用）：判据管「会不会退化」，它管「跑起来什么样」
export { prisonDemo } from './prison-demo';
import type { GameData, GameState } from '../../src/data';

/**
 * 诊断入口共用的状态构造与「一行状态」写法。
 *
 * ⚠️ 它们住在 `diag-state.ts` 而不是这里，是因为 `why-verify.ts`（W 段判据）
 *    也要用它 —— 判据里再抄一份的话，「诊断能用」与「判据能过」就变成两件
 *    互不相干的事：诊断烂了判据还是绿的（铁律 #23）。
 */
import { makeDiagState, stateLine } from './diag-state';

export function runPlan(maxDepth: number, maxNodes: number) {
  const data: GameData = loadData();
  const state: GameState = newGame(data);
  return plan(state, data, maxDepth, maxNodes);
}

export function runBeam(opts: { maxBeam?: number; maxIter?: number; maxNodes?: number }) {
  const data: GameData = loadData();
  const state: GameState = newGame(data);
  return planBeam(state, data, { ...opts, milestones: loadWalkthrough().milestones });
}

/**
 * 分阶段规划（攻略骨架驱动）。
 *
 * `act` 省略时用 `walkthrough.json` 里的第一幕（`acts[0].until`）——
 * 当前就是「打到第一个 BOSS 为止」。
 */
export function runPhases(opts: {
  maxBeam?: number;
  maxIter?: number;
  maxNodesPerPhase?: number;
  /** 指定做到哪一幕（`acts[].id`）；省略 = 第一幕 */
  act?: string;
  /** 达标后继续搜多少轮 */
  goalPatience?: number;
  /** 每轮打印一行搜索状态（调策略用） */
  beamDebug?: boolean;
  /** 不做范围限制（整座塔） */
  full?: boolean;
}) {
  const data: GameData = loadData();
  const state: GameState = newGame(data);
  const wt = loadWalkthrough();
  const acts = wt.acts ?? [];
  const act = opts.full ? undefined : (acts.find((a) => a.id === (opts.act ?? acts[0]?.id)) ?? undefined);
  return planPhases(state, data, wt, {
    maxBeam: opts.maxBeam,
    maxIter: opts.maxIter,
    maxNodesPerPhase: opts.maxNodesPerPhase,
    goalPatience: opts.goalPatience,
    onIter: opts.beamDebug
      ? (i) => {
          // 每 100 轮一行：一眼看出「束有没有塌掉」「最高分的路有多长」
          if (i.iter % 100 !== 0 && i.iter !== 1) return;
          console.log(
            `      [beam] iter=${i.iter} 束=${i.beam} 节点=${i.nodes} 最高分=${Math.round(i.bestScore)} ` +
              `最高分路长=${i.bestLen} 达标路长=${i.goalLen ?? '-'} 最远F=${i.exploredMaxFloor}`
          );
        }
      : undefined,
    until: opts.full ? undefined : act?.until
  });
}

/** 当前默认范围（第一幕）的名字与终点 —— 报告里要写清楚「判的是哪一幕」 */
export function runScope(): { act: string; title: string; until: string } | null {
  const wt = loadWalkthrough();
  const a = wt.acts?.[0];
  return a ? { act: a.id, title: a.title, until: a.until } : null;
}

/** 诊断：列出初始状态（或指定层）下生成的全部目标 */
export function runTargets(floor?: number, keys?: string, stats?: { hp?: number; atk?: number; def?: number }, at?: { x: number; y: number }) {
  const data: GameData = loadData();
  const state = makeDiagState(data, { floor, keys, stats, at });
  return { at: stateLine(state), targets: debugTargets(state, data) };
}

/** 诊断：可达性格子图 */
export function runReach(floor?: number, keys?: string, stats?: { hp?: number; atk?: number; def?: number }) {
  const data: GameData = loadData();
  const state = makeDiagState(data, { floor, keys, stats });
  return { at: stateLine(state), ...debugReach(state, data) };
}

/**
 * 诊断：把当前层的**三类分数**全摊开（道具 / 怪物 / NPC）。
 *
 * 这是评分系统唯一的「眼睛」—— 三类刻度不通用，所以输出**按类别分组**、
 * 每组各自的分数与门槛并列，不混在一张榜里排序。
 */
export function runScores(
  floor?: number,
  keys?: string,
  stats?: { hp?: number; atk?: number; def?: number },
  at?: { x: number; y: number }
) {
  const data: GameData = loadData();
  const state = makeDiagState(data, { floor, keys, stats, at });
  return {
    at: stateLine(state),
    scores: scoreDump(state, data, (x, y) => reachCosts(state, data).get(`${x},${y}`)),
    order: CATEGORY_ORDER,
    thresholds: THRESHOLD
  };
}

/**
 * 诊断：**为什么不是别的** —— 决策器六段闸门各自挡掉了什么、因为哪个数。
 *
 * 与 `--scores` 的分工：`--scores` 回答「这一项值多少分」，这一支回答
 * 「它被哪一关挡在门外」。**两者缺一不可** —— 分数再高，被 `spendCap` 挡住
 * 照样不会做，而 `--scores` 的输出里看不出这件事（它只打分数，不打闸门）。
 *
 * ⚠️ 它走的是 `explainDecision()` —— 与游戏里、模拟里**同一段代码**，
 *    不是在这里重算一遍闸门。重算的典型后果是「诊断说会做、AI 却不做」，
 *    而两边各自都对得上自己的期望值。
 *
 * ⚠️ 用**全新的 `AutoMemory`**（也就是「第一次走到这里」）。所以
 *    `③ 上楼` 不会报「上一趟白来过」「空着手掉头」这两个只与历史有关的挡法 ——
 *    想连历史一起复现，用 `npm run autoplay` 的报告尾部那份「决策交代」。
 *
 * ⚠️ **六段是级联，不是并列**：② 只要给出动作，③④⑤⑥ 根本不会被评估，
 *    于是输出里**不会**有它们的记录。这不是漏了 —— 「为什么不上楼」在那一刻
 *    本来就不是被问过的问题（`选中` 那一行已经把答案写出来了）。
 *    要看「上楼为什么不行」，得先构造一个 ② 给不出动作的局面。
 */
export function runWhy(
  floor?: number,
  keys?: string,
  stats?: { hp?: number; atk?: number; def?: number },
  at?: { x: number; y: number }
) {
  const data: GameData = loadData();
  const state = makeDiagState(data, { floor, keys, stats, at });
  const d = explainDecision(state, data);
  return {
    at: stateLine(state),
    chosen: d.chosen,
    action: d.action,
    rejected: d.rejected,
    /** 按「哪一段 · 哪一类」归并后的计数 —— 与模拟报告里那张累计表同一口径 */
    byKind: [...d.rejected.reduce((m, x) => {
      const k = `${x.stage} · ${x.kind}`;
      m.set(k, (m.get(k) ?? 0) + 1);
      return m;
    }, new Map<string, number>())].sort((a, b) => b[1] - a[1])
  };
}
