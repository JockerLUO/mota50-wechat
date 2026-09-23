/**
 * 道具的**发放与扣除**。
 *
 * 从 `engine.ts` 拆出来的理由写在原注释里，值得原样保留：
 *
 * > 拾取和商人买入走的是同一套语义，所以抽在一起。分成两处写的话，
 * > 迟早会出现「地上捡的蓝钥匙进背包、买来的蓝钥匙进 keys」这种撕裂。
 *
 * 拆文件之后这条约束更硬了：`grantItem` 现在是**唯一**能把道具塞给勇者的入口，
 * 而 `heldCount` / `takeItem` 是它的对称面 —— 三者同文件才守得住
 * 「发放与扣除用同一套口径判定钥匙 vs 背包」。
 */

import type { GameData, KeyId } from '../../data';
import type { GameState } from '../state';
import { PERSISTENT_OPS, applyEffects } from './effects';
import { keyName } from './naming';

/** items.json 里钥匙类道具的 id 恰好就是 KeyId；钥匙不进背包，直接进 state.keys */
const KEY_ITEM_IDS = new Set<string>(['yellowKey', 'blueKey', 'redKey']);

/**
 * 把道具发给勇者，返回给玩家看的说明行。
 *   - 钥匙 → 直接进 `state.keys`
 *   - 可使用 → 进背包（不立刻结算，否则地震卷轴会在买入瞬间清掉本层地图）
 *   - 拾取即生效 / 持有即生效 → 立刻结算效果，并登记被动
 */
export function grantItem(state: GameState, data: GameData, id: string, count = 1, floor = state.floor): string[] {
  const item = data.items[id];
  if (!item) return [`未知道具「${id}」`];

  if (KEY_ITEM_IDS.has(id)) {
    const key = id as KeyId;
    state.keys[key] += count;
    return [`${keyName(key)} +${count}`];
  }

  if (item.kind === 'usable') {
    state.bag[id] = (state.bag[id] ?? 0) + count;
    return [`获得 ${item.name} ×${count}（可使用）`];
  }

  const persistent = (item.effects ?? []).some((e) => PERSISTENT_OPS.has(e.op));
  if (item.kind === 'passive' || persistent) {
    if (!state.passives.includes(id)) state.passives.push(id);
  }
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(...applyEffects(state, data, item.effects ?? [], { floor, source: item.name }).log);
  }
  return lines;
}

/** 勇者当前持有多少个该道具（钥匙看 keys，其余看背包） */
export function heldCount(state: GameState, id: string): number {
  if (KEY_ITEM_IDS.has(id)) return state.keys[id as KeyId];
  return state.bag[id] ?? 0;
}

/** 扣除道具。数量不足时返回 false，且不留下任何半途改动。 */
export function takeItem(state: GameState, id: string, count: number): boolean {
  if (heldCount(state, id) < count) return false;
  if (KEY_ITEM_IDS.has(id)) {
    state.keys[id as KeyId] -= count;
  } else {
    state.bag[id] -= count;
    if (state.bag[id] <= 0) delete state.bag[id];
  }
  return true;
}
