/**
 * 单层的静态体检（调策略时看「这一层长什么样、从入口能拿到什么」）。
 *
 * 和 sim.ts 分开是因为它们的用途不同：sim 看的是**一整局的结果**，
 * 这里看的是**某一层的地形与可达性** —— 调「为什么这一层没清干净」时
 * 需要的是后者，而它不该被几千步的全局模拟淹掉。
 */

import { loadData } from '../../src/data';
import { newGame, step } from '../../src/game/engine';
import { previewBattle } from '../../src/game/engine/vitals';
import { decideAutoAction } from '../../src/game/autoplay';
import { tileAt } from '../../src/game/state';
import type { GameData, GameState } from '../../src/data';
const CH: Record<string, string> = {
  '.': '·',
  '#': '■',
  w: '▒',
  Y: 'Y',
  B: 'B',
  R: 'R',
  '~': '≋',
  a: 'A',
  D: 'D'
};

export function dumpFloor(floor: number): string[] {
  const data: GameData = loadData();
  const state: GameState = newGame(data);
  state.floor = floor;
  const f = data.floors.get(floor);
  if (!f) return [`没有第 ${floor} 层`];

  const out: string[] = [`第 ${floor} 层（勇者 atk ${state.atk} def ${state.def} hp ${state.hp}）`];
  const grid: string[][] = [];
  for (let y = 0; y <= 10; y++) {
    grid.push([]);
    for (let x = 0; x <= 10; x++) grid[y].push(CH[f.terrain[y][x]] ?? f.terrain[y][x]);
  }
  const marks: Array<{ x: number; y: number; s: string }> = [];
  for (const e of f.entities) {
    let s = '?';
    if (e.type === 'item') s = (data.items[e.id]?.name ?? e.id).slice(0, 1);
    else if (e.type === 'monster') {
      const p = previewBattle(state, data, e.id);
      s = p?.canWin ? (data.monsters[e.id]?.name ?? 'M').slice(0, 1) : '✗';
    } else if (e.type === 'npc') s = 'N';
    marks.push({ x: e.x, y: e.y, s });
  }
  for (const s of f.stairs.up) marks.push({ x: s.x, y: s.y, s: '↑' });
  for (const s of f.stairs.down) marks.push({ x: s.x, y: s.y, s: '↓' });
  for (const m of marks) grid[m.y][m.x] = m.s;

  for (const row of grid) out.push('  ' + row.join(' '));

  out.push('  实体清单：');
  for (const e of f.entities) {
    if (e.type === 'monster') {
      const m = data.monsters[e.id];
      const p = previewBattle(state, data, e.id);
      out.push(
        `    怪 (${e.x},${e.y}) ${m?.name ?? e.id} hp${m?.hp} atk${m?.atk} def${m?.def} gold${m?.gold}` +
          ` → ${p?.canWin ? `损失 ${p.hpLoss}` : `打不动(${p?.reason})`}`
      );
    } else if (e.type === 'item') {
      out.push(`    道具 (${e.x},${e.y}) ${data.items[e.id]?.name ?? e.id}`);
    } else {
      out.push(`    NPC (${e.x},${e.y}) ${e.id}`);
    }
  }
  return out;
}

/**
 * 复现某格的决策：把勇者放到 (x,y)，打印决策器返回的动作，以及朝该方向
 * 走一步的真实结果。用来查「决策器算的路径」和「引擎实际能走」不一致的地方。
 * `keys` 形如 "y2b1r0"，可设置初始钥匙。
 */
export function probePos(floor: number, x: number, y: number, keys?: string): string[] {
  const data: GameData = loadData();
  const state: GameState = newGame(data);
  state.floor = floor;
  state.pos = { x, y };
  if (keys) {
    const m = keys.match(/y(\d+)/); if (m) state.keys.yellowKey = Number(m[1]);
    const b = keys.match(/b(\d+)/); if (b) state.keys.blueKey = Number(b[1]);
    const r2 = keys.match(/r(\d+)/); if (r2) state.keys.redKey = Number(r2[1]);
  }
  const out: string[] = [`探针：第 ${floor} 层 (${x},${y}) 勇者 atk${state.atk} def${state.def} hp${state.hp} 黄${state.keys.yellowKey}蓝${state.keys.blueKey}红${state.keys.redKey}`];

  // 四邻地形（决策器会读这个）
  for (const [d, dx, dy] of [
    ['up', 0, -1],
    ['down', 0, 1],
    ['left', -1, 0],
    ['right', 1, 0]
  ] as const) {
    const ch = tileAt(state, data, floor, x + dx, y + dy);
    out.push(`  ${d} (${x + dx},${y + dy}) 地形=${JSON.stringify(ch)}`);
  }

  for (let i = 0; i < 6; i++) {
    const a = decideAutoAction(state, data);
    out.push(`  决策 #${i}: ${JSON.stringify(a)}`);
    if (a.kind === 'step') {
      const res = step(state, data, a.dir);
      out.push(`    → step(${a.dir}): ${JSON.stringify(res)}`);
    } else {
      break;
    }
  }
  return out;
}
