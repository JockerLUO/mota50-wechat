/**
 * 商人交易（参考源码 sourceId 33）。
 *
 * 从 `engine.ts` 拆出来的。这一节是全项目**最贴近叙事**的一段规则 ——
 * 数据形态见 `data/npcs.json → npcs.merchant.goodsByFloor`：
 *   6 层  买蓝钥匙 50 金币     12 层 买红钥匙 800 金币
 *   28 层 **卖**黄钥匙 100 金币（唯一的反向条目）
 *   45 层 买生命 +2000 / 1000 金币（唯一由商人出售属性的层）
 *   47 层 买地震卷轴 3000 金币（该道具全塔唯一来源）
 *   2 层  没有 goods，只有一次性剧情赠礼
 *
 * 把它单独放一个文件，是因为「报价（`merchantOffers`）」与「成交
 * （`tradeAccept`）」必须成对阅读：成交**不重新判断一次能不能成交**，
 * 它复用报价时算好的 `blocked` —— 两条路径各判一次就会出现
 * 「界面上写着金币不足、点下去却成交了」。
 */

import type { GameData, KeyId, Stat } from '../../data';
import { pushLog, type GameState } from '../state';
import { applyEffects } from './effects';
import { grantItem, heldCount, takeItem } from './items';
import { keyName, statName } from './naming';
import type { UseResult } from './types';
import { checkDeath } from './vitals';

/** 参考源码 role 层的取值。`SHOP_SOURCE_ID` 见 `shop.ts` 的说明，但两者要一起读，故同放这里 */
export const MERCHANT_SOURCE_ID = 33;
export const SHOP_SOURCE_ID = 39;

/**
 * 商人在某层的原始条目。字段随 op 变化，故全部可选。
 * 索引签名是为了让它能直接当 ItemEffect 喂给 applyEffects（赠礼条目就是这么用的）。
 */
export interface RawTrade extends Record<string, unknown> {
  op: string;
  item?: string;
  count?: number;
  price?: number;
  stat?: string;
  value?: number;
  key?: string;
}

export interface MerchantOffer {
  /** 在报价列表中的稳定下标 —— 成交时原样回传给 `tradeAccept` */
  index: number;
  op: 'buyItem' | 'sellItem' | 'buyStat' | 'gift';
  /** 按钮上的动词：购买 / 出售 / 兑换 / 领取 */
  verb: string;
  /** 主标题，如「蓝钥匙 ×1」 */
  title: string;
  /** 副标题：这笔交易会做什么 */
  detail: string;
  /** 价格；赠礼为 0 */
  price: number;
  /** 金币收支，支出为负 —— UI 可直接用它做「成交后余额」预览 */
  goldDelta: number;
  /** 不能成交的原因；null 表示可以成交 */
  blocked: string | null;
  /** 一次性条目的领取标记，成交后写入 `state.claimed` */
  claimKey?: string;
  raw: RawTrade;
}

function merchantRow(
  data: GameData,
  floor: number
): { goods?: RawTrade[]; gifts?: RawTrade[]; note?: string } | undefined {
  const npc = Object.values(data.npcs).find((n) => n.sourceId === MERCHANT_SOURCE_ID);
  const rows = npc?.goodsByFloor as
    | Record<string, { goods?: RawTrade[]; gifts?: RawTrade[]; note?: string }>
    | undefined;
  return rows?.[String(floor)];
}

/**
 * 商人某层的备注。几条都不只是说明 —— 28 层是**反向**条目（玩家卖钥匙），
 * 45 层是全塔唯一由商人出售属性的层，47 层是地震卷轴唯一来源。
 * 不看这句，玩家会以为自己在 28 层也能买到钥匙。
 */
export function merchantNote(data: GameData, floor: number): string | null {
  return merchantRow(data, floor)?.note ?? null;
}

function itemLabel(data: GameData, id: string, count: number): string {
  const name = data.items[id]?.name ?? id;
  // 数量始终写出来：「买后 黄钥匙 ×1」比「买后 黄钥匙」明确，
  // 而且和「买后 黄钥匙 ×6」排在一起时，格式一致才不会看漏
  return `${name} ×${count}`;
}

/** 原始条目 → 一句中文。赠礼条目与商品条目共用这套描述。 */
function describeRaw(data: GameData, g: RawTrade): string {
  switch (g.op) {
    case 'buyItem':
      return `${itemLabel(data, String(g.item), Number(g.count ?? 1))}，${g.price} 金币`;
    case 'sellItem':
      return `交出 ${itemLabel(data, String(g.item), Number(g.count ?? 1))}，换 ${g.price} 金币`;
    case 'buyStat':
      return `${statName(g.stat as Stat)} +${g.value}，${g.price} 金币`;
    case 'addStat':
      return String(g.stat) === 'gold' ? `金币 +${g.value}` : `${statName(g.stat as Stat)} +${g.value}`;
    case 'addKey':
      return `${keyName(g.key as KeyId)} +${g.value}`;
    default:
      return g.op;
  }
}

/**
 * 商人在当前楼层的报价。本层没配商品就返回空数组 —— 调用方据此决定
 * 是开交易界面还是走普通对话。
 */
export function merchantOffers(state: GameState, data: GameData, floor: number): MerchantOffer[] {
  const row = merchantRow(data, floor);
  if (!row) return [];
  const out: MerchantOffer[] = [];

  (row.gifts ?? []).forEach((g, i) => {
    const claimKey = `gift:merchant:${floor}:${i}`;
    const claimed = state.claimed.has(claimKey);
    out.push({
      index: out.length,
      op: 'gift',
      verb: '领取',
      title: describeRaw(data, g),
      detail: '剧情赠礼，只能领一次',
      price: 0,
      goldDelta: g.op === 'addStat' && String(g.stat) === 'gold' ? Number(g.value) : 0,
      blocked: claimed ? '已领取' : null,
      claimKey,
      raw: g
    });
  });

  for (const g of row.goods ?? []) {
    const price = Number(g.price ?? 0);
    if (g.op === 'buyItem') {
      const id = String(g.item);
      const count = Number(g.count ?? 1);
      const have = heldCount(state, id);
      out.push({
        index: out.length,
        op: 'buyItem',
        verb: '购买',
        title: itemLabel(data, id, count),
        detail: `买后 ${itemLabel(data, id, have + count)}`,
        price,
        goldDelta: -price,
        blocked: state.gold < price ? `金币不足（还差 ${price - state.gold}）` : null,
        raw: g
      });
    } else if (g.op === 'sellItem') {
      const id = String(g.item);
      const count = Number(g.count ?? 1);
      const have = heldCount(state, id);
      out.push({
        index: out.length,
        op: 'sellItem',
        verb: '出售',
        title: itemLabel(data, id, count),
        detail: `卖后 ${itemLabel(data, id, Math.max(0, have - count))}`,
        price,
        goldDelta: price,
        blocked: have < count ? `没有足够的${data.items[id]?.name ?? id}（持有 ${have}）` : null,
        raw: g
      });
    } else if (g.op === 'buyStat') {
      const stat = String(g.stat) as Stat;
      const value = Number(g.value ?? 0);
      out.push({
        index: out.length,
        op: 'buyStat',
        verb: '兑换',
        title: `${statName(stat)} +${value}`,
        // 与商店的关键差别：这里是数据里写死的固定价，不推进全局购买次数
        detail: `买后 ${statName(stat)} ${state[stat]} → ${state[stat] + value}（固定价，不涨价）`,
        price,
        goldDelta: -price,
        blocked: state.gold < price ? `金币不足（还差 ${price - state.gold}）` : null,
        raw: g
      });
    }
    // 其余 op 一律跳过：宁可少显示一条，也不替数据猜一个交易语义
  }
  return out;
}

/** 成交。`index` 必须来自最近一次 `merchantOffers` 的返回。 */
export function tradeAccept(state: GameState, data: GameData, floor: number, index: number): UseResult {
  if (state.dead) return { ok: false, message: '勇者已阵亡，无法交易' };

  const offer = merchantOffers(state, data, floor).find((o) => o.index === index);
  if (!offer) return { ok: false, message: '这笔交易已经不存在了' };
  if (offer.blocked) return { ok: false, message: offer.blocked };

  // 先把要交出去的东西扣掉；扣不动就整笔取消，绝不留半成品状态
  if (offer.op === 'sellItem') {
    const id = String(offer.raw.item);
    const count = Number(offer.raw.count ?? 1);
    if (!takeItem(state, id, count)) return { ok: false, message: '数量不足，交易取消' };
  }

  let line = '';
  switch (offer.op) {
    case 'gift': {
      const res = applyEffects(state, data, [offer.raw], { floor, source: offer.title });
      if (offer.claimKey) state.claimed.add(offer.claimKey);
      line = `领取「${offer.title}」${res.log.length ? `：${res.log.join('，')}` : ''}`;
      break;
    }
    case 'buyItem': {
      state.gold -= offer.price;
      const got = grantItem(state, data, String(offer.raw.item), Number(offer.raw.count ?? 1), floor);
      line = `买入 ${offer.title}：花 ${offer.price} 金币${got.length ? `，${got.join('，')}` : ''}`;
      break;
    }
    case 'sellItem': {
      state.gold += offer.price;
      line = `卖出 ${offer.title}，得到 ${offer.price} 金币`;
      break;
    }
    case 'buyStat': {
      state.gold -= offer.price;
      const stat = String(offer.raw.stat) as Stat;
      const before = state[stat];
      state[stat] += Number(offer.raw.value ?? 0);
      line = `兑换 ${offer.title}：花 ${offer.price} 金币，${statName(stat)} ${before} → ${state[stat]}`;
      break;
    }
  }

  pushLog(state, line, 'loot');
  checkDeath(state);
  return { ok: true, message: line };
}
