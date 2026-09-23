/**
 * 换层与落点 —— 「勇者从这一层到那一层」的全部规则。
 *
 * 从 `engine.ts` 拆出来的。三个函数是一条链：
 *   `nearestStandable` 找落脚点 → `arriveOnFloor` 落地（含领域结算）→ `travelTo` 是它的对外封装
 *
 * ⚠️ 这条链被 **三处** 用到，而且来自三个不同方向：楼梯（走动）、
 *    传送器（道具）、`changeFloor` 效果（道具/事件的位移）。
 *    它们必须共用同一个「落地」函数，否则「传送落地不结算领域」
 *    这种 bug 会只在其中一条路径上出现。
 */

import type { GameData } from '../../data';
import { floorOf } from '../../data';
import { DIRS, entityAt, pushLog, tileAt, type GameState } from '../state';
import type { UseResult } from './types';
import { applyAura } from './vitals';

/** 找最近的、可站立且无实体的格子（换层落点修正用） */
export function nearestStandable(state: GameState, data: GameData, floor: number, x: number, y: number): { x: number; y: number } {
  const ok = (cx: number, cy: number) => {
    if (cx < 0 || cy < 0 || cx > 10 || cy > 10) return false;
    const info = data.byChar[tileAt(state, data, floor, cx, cy)];
    if (!info?.passable) return false;
    return !entityAt(state, data, floor, cx, cy);
  };
  if (ok(x, y)) return { x, y };
  const seen = new Set<string>([`${x},${y}`]);
  const q: { x: number; y: number }[] = [{ x, y }];
  while (q.length) {
    const cur = q.shift()!;
    for (const d of Object.values(DIRS)) {
      const nx = cur.x + d.dx;
      const ny = cur.y + d.dy;
      const k = `${nx},${ny}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (ok(nx, ny)) return { x: nx, y: ny };
      if (nx >= 0 && ny >= 0 && nx <= 10 && ny <= 10) q.push({ x: nx, y: ny });
    }
  }
  return { x, y };
}

/**
 * 落到某一层。**这是唯一的落地入口** —— 它负责记账（visited/steps）
 * 与领域结算，所以任何「把勇者挪到别处」的代码都必须经过它。
 */
export function arriveOnFloor(state: GameState, data: GameData, floor: number, x: number, y: number): void {
  state.floor = floor;
  state.pos = { x, y };
  if (!state.visited.includes(floor)) {
    state.visited.push(floor);
    state.visited.sort((a, b) => a - b);
  }
  const f = floorOf(data, floor);
  pushLog(state, `进入第 ${floor} 层 · ${f.title}`, 'floor');
  state.stats.steps++;
  applyAura(state, data);
}

/** 楼层传送器：只能去已到过的楼层 */
export function travelTo(state: GameState, data: GameData, floor: number): UseResult {
  if (!state.visited.includes(floor)) {
    return { ok: false, message: `第 ${floor} 层还没去过，楼层传送器无法直达。` };
  }
  if (floor === state.floor) {
    return { ok: false, message: '已经在这一层了。' };
  }
  const drop = nearestStandable(state, data, floor, state.pos.x, state.pos.y);
  arriveOnFloor(state, data, floor, drop.x, drop.y);
  return { ok: true, message: `传送到第 ${floor} 层。` };
}
