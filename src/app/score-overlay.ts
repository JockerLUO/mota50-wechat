/**
 * 计分视图 —— 把 `game/score.ts` 的分数变成**棋盘上的一个数**与**对话框里的一行算式**。
 *
 * ## 它为什么在 `app/` 而不是 `render/`
 *
 * 判定标准还是那句「搬出去之后还需不需要 `this`」：这一页是纯函数，
 * 不认识 Pixi、不认识 `Game`，只吃 `state` / `data` / 层号。
 * 它落在 `app/` 是因为**只有编排层知道「现在显示的是哪一层」**
 * （楼层浏览下显示的层与勇者所在层不同）—— 棋盘不该知道这件事。
 *
 * ## 三条纪律（每一条都对应一类已经踩过的坑）
 *
 * **① 分数的来源只有 `score.ts` 一处。** 界面上自己再算一遍的典型后果是
 *    「徽标写着 223、AI 却按 -180 行动」，而两边各自都对得上自己的期望值。
 *    所以这里只调 `floorScores()`——它与 `--scores` 诊断用的是同一段代码。
 *
 * **② 路上代价必须是 `autoplay.reachCosts()` 的同一个 `reach`。**
 *    那 121 格的 Dijkstra 只有一份（铁律 #45：代价模型必须与执行逐字一致）。
 *
 * **③ 算式的格式只有这一份。** 判据在 Node 侧**独立重实现**一遍
 *    （`tools/verify/checks/a24-score-overlay.cjs`），两边对撞才能抓住「改了一边」。
 *    所以 `fmtScoreValue()` 这类函数必须**可以被逐字重写**——别在里面藏状态。
 *
 * ## 三个刻度为什么要连口径一起写在对话框里
 *
 * 「223」这个数离开它的刻度就没有意义：道具的 223 是「省下 223 点血」，
 * 怪物的 223 是「优先级 223」，NPC 的 223 是「金币余量 223」。三类不可相加，
 * 所以明细里必须带上刻度名与门槛 —— 否则读的人会拿三类去比大小，
 * 而那正是这套评分**故意不允许**的事（见 `score.ts` 文件头）。
 */

import type { GameData } from '../data';
import { reachCosts } from '../game/autoplay';
import {
  SCALE_NOTE,
  THRESHOLD,
  UNREACHABLE_SCORE,
  floorScores,
  type FloorScore
} from '../game/score';
import type { GameState } from '../game/state';
import { SCORE_STYLE } from '../render/theme';
import type { ScoreBadgeView } from '../render/board/types';

/**
 * 徽标上的短字 —— 棋盘一格只有 32px，放不下 `-1000000000`。
 *
 * 量级换算只在**真的需要**时才做（≥10000 才上 k，≥1e6 才上 M），
 * 于是常见的 223 / -1000 / 2500 都是**精确的整数**，
 * 只有那些本来就只是「一个很大的数」的项才会变成 12k —— 那没有损失信息。
 *
 * `打不动`（`UNREACHABLE_SCORE`，-1e9）单独判：它不是「一个很小的分」，
 * 它是「这件事不可选」，画成 `-1000M` 只会让人以为还能商量。用 `∞`。
 */
export function fmtScoreValue(v: number): string {
  if (v <= UNREACHABLE_SCORE / 2) return '∞';
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}${Math.round(a / 1e6)}M`;
  if (a >= 10000) return `${sign}${Math.round(a / 1000)}k`;
  // ⚠️ 这里必须是 `a` 不是 `v` —— 写 `v` 会得到 `--30`（sign 里已经有一个负号了）。
  // 这正是那条判据（Node 侧独立重实现同一格式）要抓的东西。
  return `${sign}${Math.round(a)}`;
}

/** 对话框里的完整数字（可以有 5 位数，不缩写 —— 算式要对得上） */
export function fmtScoreNumber(v: number): string {
  if (v <= UNREACHABLE_SCORE / 2) return '-∞';
  return String(Math.round(v));
}

/**
 * 算式：`1164（面值） - 582（守卫转移） - 982（路上代价）`。
 *
 * 用户 2026-09-27 给的口径原话是「如：100（基础）+ 20（守护道具）+ 30（主路径拦路）」，
 * 所以每一项都是 `数字（这个数字的来路）`，正项带 `+`、负项带 `-`，
 * 第一项不带前导符号（它已经是「等于」右边那一串的开头）。
 *
 * ⚠️ 空 `parts` 返回 `0`：不能让对话框出现「= 」这种断头句。
 */
export function scoreFormula(parts: { label: string; value: number }[]): string {
  if (parts.length === 0) return '0';
  return parts
    .map((p, i) => {
      const v = fmtScoreNumber(p.value);
      // v 自带负号，所以负项写 ` - 582` 时要把它从数字里摘掉，避免 `- -582`
      const neg = p.value < 0 && v !== '-∞';
      const body = neg ? v.slice(1) : v;
      if (i === 0) return `${v}（${p.label}）`;
      return ` ${neg ? '-' : '+'} ${body}（${p.label}）`;
    })
    .join('');
}

/** 算式的完整一行：`223 = 750（金币） - 3027（掉血代价）` */
export function scoreEquation(sc: FloorScore['score']): string {
  return `${fmtScoreNumber(sc.total)} = ${scoreFormula(sc.parts)}`;
}

/** 这一项在界面上叫什么（对话框标题） */
export function scoreName(data: GameData, entry: FloorScore): string {
  if (entry.type === 'monster') return data.monsters[entry.id]?.name ?? entry.id;
  if (entry.type === 'item') return data.items[entry.id]?.name ?? entry.id;
  return data.npcs[entry.id]?.name ?? entry.id;
}

/** 类别 → 对话框的职能章（与棋盘徽标的配色同源，都是 `SCORE_STYLE`） */
export function scoreRole(entry: FloorScore): { label: string; color: number } {
  const st = SCORE_STYLE[entry.type];
  return { label: st.label, color: st.color };
}

/**
 * 对话框正文 —— `lines[0]` 会被面板画成深色强调行，所以算式放第一位。
 *
 * 四条各司其职：
 *   ① 算式（用户点名要的那一行）；
 *   ② `score.why` —— 机器给的一句话解释（谁守着谁、挡在哪条路上）；
 *   ③ 刻度口径（三类不通用，离开刻度这个数没有意义）；
 *   ④ 门槛 + 「属性一变就重算」这件事。
 */
export function scoreExplain(entry: FloorScore): string[] {
  const sc = entry.score;
  return [
    scoreEquation(sc),
    sc.why,
    `${SCORE_STYLE[entry.type].label}刻度：${SCALE_NOTE[sc.category]}。`,
    `同类内比大小，入选门槛 ${THRESHOLD[sc.category]}；攻 / 防 / 血 / 钥匙 / 金币一变，这一行立刻重算。`
  ];
}

/**
 * 一份分数清单 → 棋盘徽标（棋盘消费的形状）。
 *
 * ⚠️ 它收的是**已经算好的清单**而不是 `(state,data,floor)`：那样两个调用方
 * （徽标与点击明细）各算一遍 `scoreList()`，就是两遍 Dijkstra ——
 * 更要紧的是两份结果在调参之后可能对不上，而「徽标写着 A、点开写着 B」
 * 正是这个功能最不该有的那种 bug。
 */
export function badgesOf(entries: FloorScore[]): ScoreBadgeView[] {
  return entries.map((e) => ({
    key: e.key,
    text: fmtScoreValue(e.score.total),
    color: SCORE_STYLE[e.type].chip
  }));
}

/**
 * 本层全部分数 —— 徽标与点击明细的**唯一**来源。
 *
 * `costAt` 只在**显示的就是勇者所在层**时给：别的层上「从勇者位置走过去要掉多少血」
 * 是个没有意义的数（人不在那儿），宁可为空也不要编一个出来 ——
 * 编出来的数会被当成真的读（与铁律 #39 同族：量错了比不量更坏）。
 */
export function scoreList(state: GameState, data: GameData, floor: number): FloorScore[] {
  const costs = floor === state.floor ? reachCosts(state, data) : null;
  return floorScores(state, data, floor, costs ? (x, y) => costs.get(`${x},${y}`) : undefined);
}
