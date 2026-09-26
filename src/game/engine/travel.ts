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
import { pickUpAt } from './items';
import type { UseResult } from './types';
import { applyAura } from './vitals';

/**
 * 找最近的、可站立且无实体的格子（换层落点修正用）。
 *
 * ⚠️ 「可站立」= **没有挡路的实体**，而不是「没有任何实体」。道具不挡路 ——
 * 玩家平时就是踩着道具格把东西捡起来的（`step.ts` 的 pickup 分支）。
 * 上一版这里用 `entityAt()` 一票否决，于是「落点上正好放着一瓶药水」就会把
 * 勇者悄悄挪到别的格子去。这在开阔地形上只是难看，在**关着人的地方是致命的**：
 * 下面那段 BFS 入队时**不看通行性**（为了能绕到墙另一侧去找落脚点），
 * 所以牢房四格全被道具占着时，它会穿墙找到一个**牢房外面**的格子 ——
 * 「被关进监牢」这条剧情整个失效，而报告上一切正常。
 *
 * 判据：`tools/autoplay/zone1.ts` 的 Z 段量的是**落点真的在牢房里**，
 * 不是「事件里写了 teleport」。
 *
 * `opts.avoidEntities`（只有 `__goto` 这个调试钩子在用）：连道具也要避开。
 * 因为 `arriveOnFloor()` 现在**落地即拾取**（官方规则「走到物品上自动拾起获得」），
 * 于是「道具不挡路」+「落地即拾取」叠起来，`__goto(37)` 正好落在放着炸弹的
 * (4,4) 上 —— 调试传送顺手把炸弹塞进了背包，把 A11「空背包不占位」弄红了，
 * 而 A11 并不知道是谁弄的。**调试钩子的契约是「只搬人」**，所以它走这条口径。
 * 判据：`tools/verify/checks/a01-terrain.cjs` 的 A1b。
 */
export function nearestStandable(
  state: GameState,
  data: GameData,
  floor: number,
  x: number,
  y: number,
  opts: { avoidEntities?: boolean } = {}
): { x: number; y: number } {
  const ok = (cx: number, cy: number) => {
    if (cx < 0 || cy < 0 || cx > 10 || cy > 10) return false;
    const info = data.byChar[tileAt(state, data, floor, cx, cy)];
    if (!info?.passable) return false;
    const ent = entityAt(state, data, floor, cx, cy);
    if (opts.avoidEntities) return !ent;
    return !ent || ent.type === 'item';
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
  // **落地也算走上去**：踩在道具格上就拾起来（官方规则「走到物品上自动拾起获得」）。
  // 漏掉这一处的实际后果：被扔进第 2 层牢房的勇者正好落在放着黄钥匙的那一格上，
  // 钥匙留在原地 —— 不报错、不报警，只是**少了一件玩家本该拿到的东西**。
  pickUpAt(state, data, floor, x, y);
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
