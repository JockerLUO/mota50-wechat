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
import { entityAt, entityKey, pushLog, type GameState } from '../state';
import { PERSISTENT_OPS, applyEffects } from './effects';
import { keyName } from './naming';

/** items.json 里钥匙类道具的 id 恰好就是 KeyId；钥匙不进背包，直接进 state.keys */
const KEY_ITEM_IDS = new Set<string>(['yellowKey', 'blueKey', 'redKey']);

/**
 * 把**某一格上**的道具收进包里（「拾取」的唯一实现），返回给玩家看的那一行。
 *
 * 两个调用点：
 *   · `step.ts` —— 玩家主动走上去（`ent.type === 'item'` 分支）；
 *   · `travel.ts` 的 `arriveOnFloor()` —— **落地**（楼梯 / 层间传送器 / 事件的 teleport）。
 *
 * 为什么要抽出来：**落地也是一种走上去**。官方规则原文是「走到物品上自动拾起获得」，
 * 而上一版只有「迈步」会拾取，落地不会 —— 于是被扔进第 2 层牢房的勇者会正好压在
 * 那格黄钥匙上（牢房 4 格里 3 格各放着一把），钥匙留在原地、谁都不会发现它没被拿起：
 * 不是报错，是**少了一件东西**。两个调用点共用这一份，才不会各写一遍再漂移。
 */
export function pickUpAt(state: GameState, data: GameData, floor: number, x: number, y: number): string | null {
  const ent = entityAt(state, data, floor, x, y);
  if (!ent || ent.type !== 'item') return null;
  const item = data.items[ent.id];
  if (!item) return null;
  state.removed.add(entityKey(floor, x, y, 'item', ent.id));
  const got = grantItem(state, data, ent.id, 1, floor);
  const text = `拾得 ${item.name}${got.length ? `（${got.join('，')}）` : ''}`;
  pushLog(state, text, 'loot');
  return text;
}

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
