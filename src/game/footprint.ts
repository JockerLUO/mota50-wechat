/**
 * BOSS 的**棋盘占位块** —— 渲染层与引擎共用的唯一实现。
 *
 * ## 为什么「把精灵画大一点」不够
 *
 * 2026-09-24 之前 BOSS 只是「精灵比一格大」（96px 画在 32px 的格子上），
 * 但它**仍然只占一格** —— 玩家能贴着它的身体走过去。俯视格子上读起来是错的：
 * 一个占满三格的家伙，脚下那两格却是空的。
 *
 * 所以占位块必须是**规则**，不是画法：整块区域都不可走进，撞上去即开战，
 * 击败后整块恢复通行。这份规则同时被三处消费，三处必须给出同一个答案：
 *
 *   1. 渲染层（`src/render/board/index.ts`）—— 精灵与光环摆在占位块的哪儿；
 *   2. 引擎（`state.entityAt` → `step` / `pathing` / `travel` / `effects` / `vitals`）
 *      —— 走到哪一格算「撞上它」；
 *   3. 校验脚本（`tools/verify/checks/`）—— 「不可走进」「可接近」两条行为断言。
 *
 * 三处各写一遍 `x-1 .. x+1` 是这类功能最常见的腐烂方式（改了一处，
 * 另外两处还在用旧范围，而**画面与逻辑不一致**是最难查的一类 bug：
 * 看着能走进去，走进去却开战）。所以范围只在这里算一次。
 *
 * ## 格子数从哪来
 *
 * `data/constants.json` 的 `boss.footprintTiles`（当前 3）。它同时是**素材侧**的
 * 单一来源 —— `tools/assetlib/bosses/common.py` 读同一个值算出绘制网格
 * （`CELL × footprintTiles` = 96），构建期有一条断言钉住
 * 「素材绘制网格 == 格子 × 本值」。所以这个数字不存在「只改了一侧」的可能。
 *
 * ## 居中，然后整体平移进棋盘（**不平缩**）
 *
 * 占位块恒为 `n × n`，中心对齐 BOSS 所在格；靠边放不下时**整体平移**，
 * 而不是裁掉一角变成 2×3。理由是精灵恒为 `n × n` 格那么大：
 * 一旦把占位块压成 2×3，画出来的 96px 精灵就会捅出占位块，玩家看到的
 * 「它占哪儿」又和规则对不上了 —— 那正是本节开头要消灭的东西。
 *
 * 实测只有一处会用到平移：第 40 层的骑士长在 `(5, 0)`（塔顶那一排），
 * 居中会让第一行落到 -1；平移之后占位块是 y0..2，视觉中心从 (5,0) 变到 (5,1)。
 * 其余六处（含第 42 层贴底边的 `(5, 9)`）居中即装下。
 */

import type { GameData } from '../data';

/** 棋盘边长。`state.tileAt` 与寻路都按 11×11 判界，这里跟着它们走。 */
export const BOARD = 11;

/** 一个矩形占位块，**闭区间**（`x1` / `y1` 是能被走进的最后一格）。 */
export interface Footprint {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 单格的占位块 —— 道具 / NPC / 杂兵都用它。 */
export function singleFootprint(x: number, y: number): Footprint {
  return { x0: x, y0: y, x1: x, y1: y };
}

/**
 * 占位块的边长（格）。`footprintTiles` 缺失或非法时回落到 1 ——
 * 回落成 1 而不是抛错，是为了让「数据还没加载完」的中间态
 * 退化成改动前的行为，而不是让整个棋盘渲染不出来。
 */
export function footprintTiles(data: GameData): number {
  const n = data.constants?.boss?.footprintTiles;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return 1;
  // 只允许奇数：偶数边长没有整数中心，居中会引入半格偏移（见文件头「居中」那一段）
  const k = Math.floor(n);
  return k % 2 === 1 ? k : Math.max(1, k - 1);
}

/** `isBoss` 为真时给出居中的 `n × n` 占位块（必要时平移进棋盘），否则给单格。 */
export function footprintAt(data: GameData, x: number, y: number, isBoss: boolean): Footprint {
  const n = isBoss ? footprintTiles(data) : 1;
  if (n <= 1) return singleFootprint(x, y);
  const half = (n - 1) >>> 1;
  const clamp = (v: number) => Math.max(0, Math.min(v, BOARD - n));

  const x0 = clamp(x - half);
  const y0 = clamp(y - half);
  return { x0, y0, x1: x0 + n - 1, y1: y0 + n - 1 };
}

/** 某格是否落在占位块内。 */
export function inFootprint(fp: Footprint, x: number, y: number): boolean {
  return x >= fp.x0 && x <= fp.x1 && y >= fp.y0 && y <= fp.y1;
}

/**
 * 某格是否**紧贴**占位块 —— 即到矩形的最短曼哈顿距离恰好为 1。
 *
 * 这是 `isAdjacent`（老的坐标对坐标版本）的推广，而且推广得**恰好**：
 * 单格占位块（`x0 == x1`、`y0 == y1`）时，距离就是 `|dx| + |dy|`，
 * `=== 1` 即「相邻」—— 与老函数逐字等价。所以领域伤害（`applyAura`）
 * 换用它之后，杂兵的行为一点没变，而「站在 BOSS 旁边」从「紧贴它那一格」
 * 正确地变成了「紧贴它那三格」。
 *
 * 落在块**内部**时距离是 0，返回 `false` —— 那是「同一格」，不是「相邻」。
 */
export function touchesFootprint(fp: Footprint, x: number, y: number): boolean {
  const cx = Math.max(fp.x0, Math.min(x, fp.x1));
  const cy = Math.max(fp.y0, Math.min(y, fp.y1));
  return Math.abs(x - cx) + Math.abs(y - cy) === 1;
}
