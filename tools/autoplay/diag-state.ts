/**
 * 诊断入口共用的状态构造 —— `--reach` / `--targets` / `--scores` / `--why`
 * 与 `verify:autoplay` 的 W 段都用它。
 *
 * ## 为什么单独一个文件
 *
 * 原先 `plan-entry.ts` 里三支诊断各写了一遍构造代码，其中 `--targets` 那份还多了一段
 * 「先 `removed.add(...)` 再 `removed.clear()`」的空操作。三份拷贝的典型后果**不是报错**，
 * 而是「同一层同一钥匙，两支诊断给出相反结论」—— 而两支各自看起来都对得上自己的期望值。
 *
 * 更要紧的是：W 段判据必须能复现**与诊断入口完全相同的局面**。判据里再抄一份的话，
 * 「诊断能用」与「判据能过」就变成两件独立的事 —— 于是诊断烂了判据还是绿的（铁律 #23）。
 *
 * `keys` 形如 `y1b0r0`；`at` 省略时落在该层的**下楼梯格**（即换层落点）。
 */

import { newGame } from '../../src/game/engine';
import type { GameData, GameState } from '../../src/data';

export interface DiagStateOpts {
  floor?: number;
  keys?: string;
  stats?: { hp?: number; atk?: number; def?: number };
  at?: { x: number; y: number };
}

/**
 * `y999b999r999` → 三把钥匙的持有量。
 *
 * ⚠️ 解析放在这里**只此一份**：整局模拟的「起手状态覆盖」（`sim.ts` 的 `SimInit`）
 *    也要用同一套写法。判据与诊断各写一份的话，「同一串钥匙串被读成不同数量」
 *    会表现成两个入口对同一局面给出相反结论，而两边各自都对得上自己的期望值。
 *
 * 不匹配时**原样返回 false**（调用方保留 `newGame` 给的初始钥匙），不抛出 ——
 * 诊断入口的既有语义是「给了才覆盖」。
 */
export function applyKeySpec(state: GameState, keys: string): boolean {
  const m = /^y(\d+)b(\d+)r(\d+)$/.exec(keys);
  if (!m) return false;
  state.keys = { yellowKey: Number(m[1]), blueKey: Number(m[2]), redKey: Number(m[3]) };
  return true;
}

export function makeDiagState(data: GameData, opts: DiagStateOpts): GameState {
  const state: GameState = newGame(data);
  if (opts.keys) applyKeySpec(state, opts.keys);
  if (opts.stats) {
    if (opts.stats.hp !== undefined) state.hp = opts.stats.hp;
    if (opts.stats.atk !== undefined) state.atk = opts.stats.atk;
    if (opts.stats.def !== undefined) state.def = opts.stats.def;
  }
  if (opts.floor !== undefined) {
    state.floor = opts.floor;
    const s = data.floors.get(opts.floor)?.stairs.down[0];
    if (s) state.pos = { x: s.x, y: s.y };
  }
  if (opts.at) state.pos = { ...opts.at };
  return state;
}

/** 一行「现在站在哪、什么状态」——所有诊断入口共用同一种写法 */
export function stateLine(state: GameState): string {
  return (
    `${state.floor}@${state.pos.x},${state.pos.y} ` +
    `hp${state.hp} atk${state.atk} def${state.def} 金${state.gold} ` +
    `黄${state.keys.yellowKey}/蓝${state.keys.blueKey}/红${state.keys.redKey}`
  );
}
