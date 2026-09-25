/**
 * 验证「封印解除」事件：手动击败第 49 层 4 守卫，确认第 50 层魔王被切换。
 */

import { loadData } from '../../src/data';
import { applyTrigger, newGame } from '../../src/game/engine';
import { entityAt } from '../../src/game/state';
import type { GameData, GameState } from '../../src/data';

export function verifySeal(): string[] {
  const out: string[] = [];
  const data: GameData = loadData();
  const state: GameState = newGame(data);

  out.push('触发前：第 50 层 (5,5) = ' + JSON.stringify(entityAt(state, data, 50, 5, 5)));

  // 逐个「击败」第 49 层守卫（直接标 removed，模拟战斗胜利后的状态）
  const guards = [
    { id: 'darkKnight', x: 4, y: 7 },
    { id: 'darkKnight', x: 6, y: 7 },
    { id: 'seniorWizard', x: 4, y: 9 },
    { id: 'seniorWizard', x: 6, y: 9 }
  ];
  for (const g of guards) {
    state.removed.add(`49:${g.x}:${g.y}:monster:${g.id}`);
    applyTrigger(state, data, { op: 'allDefeated' });
  }

  out.push('触发后：第 50 层 (5,5) = ' + JSON.stringify(entityAt(state, data, 50, 5, 5)));
  out.push('monsterSwap = ' + JSON.stringify(state.monsterSwap));
  out.push('原 demonKing 已移除? ' + state.removed.has('50:5:5:monster:demonKing'));

  return out;
}
