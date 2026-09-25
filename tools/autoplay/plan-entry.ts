/**
 * 规划器的 headless 入口（由 tools/autoplay-plan.mjs 打包后 import）。
 */

import { loadData } from '../../src/data';
import { newGame } from '../../src/game/engine';
import { plan, planBeam } from '../../src/game/planner';
import type { GameData, GameState } from '../../src/data';

export function runPlan(maxDepth: number, maxNodes: number) {
  const data: GameData = loadData();
  const state: GameState = newGame(data);
  return plan(state, data, maxDepth, maxNodes);
}

export function runBeam(opts: { maxBeam?: number; maxIter?: number; maxNodes?: number }) {
  const data: GameData = loadData();
  const state: GameState = newGame(data);
  return planBeam(state, data, opts);
}
