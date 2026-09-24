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

import type { FloorEntity, GameData } from '../data';
import { DIRS, entityAt, entityFootprint, tileAt, type Dir, type GameState } from '../game/state';
import { inFootprint, type Footprint } from '../game/footprint';

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

/**
 * 点击目标的**占位块** + 「名义目标」那一格 + 占着它的实体。
 *
 * 为什么要单独取这个：`pathTo` 的兜底是「走到目标旁边再撞一下」，
 * 而 BOSS 的 3×3 里有 9 格是进不去的 —— 「紧邻目标格且可达」在
 * 贴着 BOSS 时恒为空集（紧邻它那一格的 4 格全在占位块里）。
 * 不改成按占位块判定，表现是**点 BOSS 毫无反应**。
 *
 * ⚠️ 但**只有名义目标那一格可以放宽判据**，占位块的其余格必须仍然进不去。
 * 全块放宽的后果不是「多走两步」而是**点击变成没反应**：BFS 会把 9 格
 * 全当成可走的，然后返回一条**从 BOSS 身体里穿过**的路径；
 * `onBoardClick` 走到第一格非末尾的占位格时发现「有实体」就 break 了，
 * 于是勇者停在原地、既不移动也不开战 —— 一条「寻路成功但什么都没发生」的路径。
 *
 * `ent` 要带出来是因为占位块里的 8 格都会命中**同一只** Boss ——
 * 兜底那一步要据此区分「这块地是它的」和「这块地被别人占着」。
 */
function targetBlock(
  state: GameState,
  data: GameData,
  tx: number,
  ty: number
): { block: Footprint; ax: number; ay: number; ent: FloorEntity | null } {
  const e = entityAt(state, data, state.floor, tx, ty);
  if (!e) return { block: { x0: tx, y0: ty, x1: tx, y1: ty }, ax: tx, ay: ty, ent: null };
  return { block: entityFootprint(data, e), ax: e.x, ay: e.y, ent: e };
}

/**
 * 两个实体是不是同一个。
 *
 * 不写 `a === b`：`entityAt` 今天确实每次都返回 `data.floors` 里那只同一个对象，
 * 但那是它的实现细节 —— 一旦哪天给 `entityAt` 加上「按需构造」，
 * 引用比较会**静默**恒为 false，于是「占位块里全是别人」→ 兜底恒空集 →
 * 又回到「点 BOSS 没反应」。按内容比就只有一处会错，且错得看得见。
 */
function sameEntity(a: FloorEntity | null, b: FloorEntity | null): boolean {
  if (!a || !b) return false;
  return a.type === b.type && a.id === b.id && a.x === b.x && a.y === b.y;
}

/** BFS 寻路。目标不可直入时（门 / 墙 / 岩浆 / BOSS 的占位块）退化成「走到它旁边再撞一下」 */
export function pathTo(state: GameState, data: GameData, tx: number, ty: number): Cell[] | null {
  const { block, ax, ay, ent } = targetBlock(state, data, tx, ty);
  const anchorK = `${ax},${ay}`;
  const startK = `${state.pos.x},${state.pos.y}`;
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
      if (!enterable(state, data, nx, ny, nx === ax && ny === ay)) continue;
      dist.set(k, cd + 1);
      prev.set(k, `${cur.x},${cur.y}`);
      q.push({ x: nx, y: ny });
    }
  }

  if (dist.has(anchorK)) return reconstruct(anchorK);

  // 目标不可直入：找一格**紧贴占位块**的可达格，路径末尾补上「朝块里迈的那一格」
  //（引擎的 `step()` 撞上去自然会处理门 / 墙 / 怪）
  //
  // 迈进去的那一格必须**能安全地迈**，否则最后这一步不会走到「与目标交互」上：
  //
  //  · 名义目标那一格（门 / 假墙 / 岩浆 / 怪）照旧一律放行 —— 它的「不可通行」
  //    正是要靠撞一下触发的东西，而 1×1 的情形必须与改动前逐字一致；
  //  · 占位块里的**其余**格（只有 BOSS 有）必须与普通可走格同规：
  //      地形可通行（否则会挑到占位块四角的墙 —— BOSS 常蹲在墙角壁龛里，
  //        走一步撞上墙、不入战，等于点击失效）；
  //      不是楼梯（踩上去会换层，点击变成「莫名其妙下楼」）；
  //      不是假墙（撞一下把墙破了，白走一步）；
  //      且**没有别的实体**占着。
  //
  // ⚠️ 这里一度写成 `enterable(..., true)`（只查地形）。那是个错的口子：
  //    `enterable` 的 `isTarget` 是给**名义目标**开的，用在占位块的其余格上
  //    等于把楼梯、假墙和「被别的实体占着的中间格」一起放行了。
  //    唯独必须允许的是**目标自己** —— 占位块内 8 格都会命中它（`entityAt`
  //    按块判定），这正是本函数存在的理由，也是不能用 `enterable` 的原因。
  let best: { k: string; to: Cell; d: number; near: number } | null = null;
  for (const [k, d] of dist) {
    const [x, y] = k.split(',').map(Number);
    for (const v of Object.values(DIRS)) {
      const bx = x + v.dx;
      const by = y + v.dy;
      if (!inFootprint(block, bx, by)) continue;
      if (!(bx === ax && by === ay)) {
        const ch = tileAt(state, data, state.floor, bx, by);
        const info = data.byChar[ch];
        if (!info?.passable || info.stairs || ch === 'w') continue;
        const other = entityAt(state, data, state.floor, bx, by);
        if (other && !sameEntity(other, ent)) continue;
      }
      const near = Math.abs(bx - tx) + Math.abs(by - ty);
      if (!best || d < best.d || (d === best.d && near < best.near)) {
        best = { k, to: { x: bx, y: by }, d, near };
      }
    }
  }
  if (!best) return null;
  return [...reconstruct(best.k), best.to];
}
