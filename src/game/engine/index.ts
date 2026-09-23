/**
 * 规则引擎门面（barrel）—— 纯逻辑，零渲染依赖。
 *
 * ## 这个文件为什么存在
 *
 * `engine.ts` 曾经是一个 936 行的单文件，从「战斗预判」一路写到「商店文案」。
 * 拆成目录后，**外部 import 路径一个字都不用改**：`./game/engine` 解析到这里，
 * 导出面与拆分前完全一致（`app.ts` 引 12 个、`render/trade.ts` 引 3 个类型）。
 *
 * ## 目录职责与依赖方向（**是 DAG，没有循环**）
 *
 *   naming.ts    属性/钥匙/地形的中文名           ← 谁都可以用，它谁都不用
 *   types.ts     对外的类型契约（零 render 依赖）
 *   vitals.ts    派生量 + 生死（伤害的唯一落点）
 *   travel.ts    落点 / 落地 / 传送
 *   effects.ts   数据驱动的效果执行
 *   items.ts     道具发放与扣除
 *   merchant.ts  商人交易（sourceId 33）
 *   shop.ts      商店三选一（sourceId 39）
 *   step.ts      主步骤 + 使用道具 ← **依赖链顶端**，不该被任何人 import
 *
 * 判断拆分对不对，看 import 方向就够了：**箭头只能从上往下**。
 * 反向 import 一律说明这两个文件该合并或者该分层。
 */

export type { BattlePreview, EffectContext, NpcTalk, StepKind, StepResult, UiKind, UseResult } from './types';
export { keyNameOf, statNameOf } from './naming';
export { currentTier, goldMultiplier, heroStats, previewBattle } from './vitals';
export { arriveOnFloor, nearestStandable, travelTo } from './travel';
export { applyEffects } from './effects';
export { grantItem, heldCount } from './items';
export { merchantNote, merchantOffers, tradeAccept, type MerchantOffer, type RawTrade } from './merchant';
export { buyStat, shopOptions, shopQuote, type ShopOption, type ShopView } from './shop';
export { step, useItem } from './step';
