/**
 * 棋盘寻路 —— 点击地图时「怎么走过去」。
 *
 * 从 `app.ts` 拆出来的。它是编排层里**唯一一块纯算法**：不碰渲染、不调引擎，
 * 只读状态与数据，算出一条格子路径。原先它（`dirToward` / `enterable` /
 * `pathTo` 三个方法 + `Cell` 类型）散在 `Game` 类中间，读者要从「输入分发」
 * 一路翻到「动作」才能看完寻路这一件事。
 *
 * ⚠️ 三个函数原来都是 `Game` 的私有方法（读 `this.state` / `this.data`），
 *    现在改成**显式接收** `state` / `data`。这不是形式上的搬运：
 *    纯函数化之后它们可以脱离游戏实例单独测，也不再能顺手读到 `this` 上
 *    那些与寻路无关的字段（比如 `browseFloor`）—— 后一条正是这类
 *    「方法搬出类」最容易留下的暗耦合。
 */

import type { GameData } from '../data';
import { DIRS, entityAt, tileAt, type Dir, type GameState } from '../game/state';

export interface Cell {
  x: number;
  y: number;
}

/** 四方向之一，「从 from 走到相邻的 to」—— 不相邻或是对角线时返回 null */
export function dirToward(from: Cell, to: Cell): Dir | null {
  if (to.y === from.y && to.x === from.x + 1) return 'right';
  if (to.y === from.y && to.x === from.x - 1) return 'left';
  if (to.x === from.x && to.y === from.y + 1) return 'down';
  if (to.x === from.x && to.y === from.y - 1) return 'up';
  return null;
}

/** 能否走进某格（供寻路使用）。isTarget 时放宽，因为目标格可以是怪物 / 门 / 假墙 */
export function enterable(state: GameState, data: GameData, x: number, y: number, isTarget: boolean): boolean {
  if (x < 0 || y < 0 || x > 10 || y > 10) return false;
  const ch = tileAt(state, data, state.floor, x, y);
  const info = data.byChar[ch];
  if (!info?.passable) return false;
  if (isTarget) return true;
  if (entityAt(state, data, state.floor, x, y)) return false;
  if (info.stairs) return false; // 别把楼梯当中转点，会意外换层
  if (ch === 'w') return false;
  return true;
}

/** BFS 寻路。目标不可直入时（门 / 墙 / 岩浆）退化成「走到它旁边再撞一下」 */
export function pathTo(state: GameState, data: GameData, tx: number, ty: number): Cell[] | null {
  const startK = `${state.pos.x},${state.pos.y}`;
  const targetK = `${tx},${ty}`;
  const prev = new Map<string, string>();
  const dist = new Map<string, number>([[startK, 0]]);
  const q: Cell[] = [{ x: state.pos.x, y: state.pos.y }];

  const reconstruct = (k: string): Cell[] => {
    const out: Cell[] = [];
    let cur: string | undefined = k;
    while (cur && cur !== startK) {
      const [x, y] = cur.split(',').map(Number);
      out.unshift({ x, y });
      cur = prev.get(cur);
    }
    return out;
  };

  while (q.length) {
    const cur = q.shift()!;
    const cd = dist.get(`${cur.x},${cur.y}`) ?? 0;
    for (const d of Object.values(DIRS)) {
      const nx = cur.x + d.dx;
      const ny = cur.y + d.dy;
      const k = `${nx},${ny}`;
      if (dist.has(k)) continue;
      if (!enterable(state, data, nx, ny, nx === tx && ny === ty)) continue;
      dist.set(k, cd + 1);
      prev.set(k, `${cur.x},${cur.y}`);
      q.push({ x: nx, y: ny });
    }
  }

  if (dist.has(targetK)) return reconstruct(targetK);

  // 目标不可直入：找一个**紧邻目标**的可达格，路径末尾补上目标本身
  //（引擎的 `step()` 撞上去自然会处理门 / 墙 / 怪）
  let best: { k: string; d: number } | null = null;
  for (const [k, d] of dist) {
    const [x, y] = k.split(',').map(Number);
    if (Math.abs(x - tx) + Math.abs(y - ty) !== 1) continue;
    if (!best || d < best.d) best = { k, d };
  }
  if (!best) return null;
  return [...reconstruct(best.k), { x: tx, y: ty }];
}
