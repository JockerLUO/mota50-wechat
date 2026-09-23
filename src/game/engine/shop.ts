/**
 * 商店三选一（参考源码 sourceId 39）。
 *
 * 从 `engine.ts` 拆出来的。它与 `merchant.ts` 长得像但**规则完全不同**，
 * 这正是必须分成两个文件的原因：
 *
 *   |          | 商人（33）                   | 商店（39）                      |
 *   | 货从哪来 | 数据里逐层写死                | 固定三选一（生命/攻击/防御）     |
 *   | 价格     | 固定，不涨价                  | 只随**全局购买次数**上涨         |
 *   | 增量     | 固定                          | 随**楼层档位**放大               |
 *
 * 「价格与楼层无关、增量随楼层放大」是原版攻略「前期别买、把钱留到高楼层」
 * 的全部依据 —— 所以 `shopAdvice()` 的文案是**结论的一部分**，不是装饰。
 *
 * 定价与增量公式都在 `core/shop.mjs`，这里只组织成 UI 能直接画的结构，
 * **不重新实现一遍公式** —— 那样 Node 校验器和浏览器就会各算一套。
 */

import type { GameData, Stat } from '../../data';
import { tierOf } from '../../data';
import { goldPerPoint, maxPurchasesFrom, shopCost, shopGain } from '../../../core/shop.mjs';
import { pushLog, type GameState } from '../state';
import { statName } from './naming';
import type { UseResult } from './types';

export interface ShopOption {
  stat: Stat;
  /** 生命 / 攻击 / 防御 */
  label: string;
  /** 本次增量 —— 随楼层档位放大 */
  gain: number;
  /** 本次价格 —— 只随购买次数上涨，与楼层无关 */
  cost: number;
  /** 每点属性花多少金币，越小越划算。这是判断「该不该现在买」的直接指标。 */
  goldPerPoint: number;
  affordable: boolean;
  /** 买下之后该属性会变成多少 */
  after: number;
}

export interface ShopView {
  /** 这是第几次购买（从 1 起，全局共享） */
  n: number;
  cost: number;
  /** 本层收益倍率 */
  tierMul: number;
  /** 档位说明，如「第 40–49 层档位 · 收益 ×5」 */
  tierNote: string;
  /** 现有金币最多还能买几次 */
  remaining: number;
  /** 勇者当前金币 */
  gold: number;
  /** 买完这一次之后，下一次的价格 */
  nextCost: number;
  options: ShopOption[];
  /** 一句策略提示 */
  advice: string;
}

export function shopQuote(state: GameState, stat: Stat): { n: number; cost: number; gain: number; affordable: boolean } {
  const n = state.buyTimes;
  return {
    n,
    cost: shopCost(n),
    gain: shopGain(state.floor, stat),
    affordable: state.gold >= shopCost(n)
  };
}

export function buyStat(state: GameState, stat: Stat): UseResult {
  const q = shopQuote(state, stat);
  if (!q.affordable) {
    return { ok: false, message: `需要 ${q.cost} 金币，当前只有 ${state.gold}` };
  }
  state.gold -= q.cost;
  state[stat] += q.gain;
  state.buyTimes += 1;
  const msg = `花费 ${q.cost} 金币：${statName(stat)} +${q.gain}（下次价格 ${shopCost(state.buyTimes)}）`;
  pushLog(state, msg, 'loot');
  return { ok: true, message: msg };
}

export function shopOptions(state: GameState, data: GameData): ShopView {
  const n = state.buyTimes;
  const cost = shopCost(n);
  const tier = tierOf(data, state.floor);
  const tierDef = data.constants.shop.tiers.find((t) => state.floor >= t.floorFrom && state.floor <= t.floorTo);

  const options: ShopOption[] = (['hp', 'atk', 'def'] as Stat[]).map((stat) => {
    const gain = shopGain(state.floor, stat);
    return {
      stat,
      label: statName(stat),
      gain,
      cost,
      goldPerPoint: goldPerPoint(state.floor, stat, n),
      affordable: state.gold >= cost,
      after: state[stat] + gain
    };
  });

  return {
    n,
    cost,
    tierMul: tier.mul,
    tierNote: tierDef ? `第 ${tierDef.floorFrom}–${tierDef.floorTo} 层档位 · 收益 ×${tierDef.mul}` : `收益 ×${tier.mul}`,
    remaining: maxPurchasesFrom(state.gold, n),
    gold: state.gold,
    nextCost: shopCost(n + 1),
    options,
    advice: shopAdvice(tier.mul)
  };
}

/**
 * 商店策略提示。原版最优解「前期别买、把钱留到高楼层」不是玄学 ——
 * 它直接来自「价格只与购买次数有关、增量随楼层放大」这个设计。
 */
function shopAdvice(mul: number): string {
  if (mul >= 4) {
    return `高层档位（×${mul}）。价格只随购买次数涨、与楼层无关 —— 同样的钱在这里买最划算。`;
  }
  if (mul >= 3) {
    return `收益 ×${mul}，中档。再往上走档位更高，但每买一次后续价格都会涨，要权衡。`;
  }
  return `收益只有 ×${mul}。价格与楼层无关、只随购买次数上涨 —— 现在买是用最贵的钱换最少的属性，原版攻略「1–10 层不进商店」正是这个结论。`;
}
