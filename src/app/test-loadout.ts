/**
 * 神装测试起手 —— 点「自动通关」时给勇者套上的那套属性。
 *
 * ## 为什么要有这个文件
 *
 * `verify:autoplay` 的 **D 段**早就证明了「这塔能不能通」可以单独判：
 * 把属性与钥匙给足（hp90000 / atk1000 / def1000 / 三色钥匙各 999），
 * 贪心能在 7906 步内一路打到第 50 层并击败真魔王（`docs/known-gaps.md` §4）。
 *
 * 但那一直是 **headless** 的能力 —— 只能在 Node 里跑报告，看不见它在界面上走。
 * 而「看得见它在干什么」正是把自动通关接进界面的全部意义（`game.ts` 的
 * `AUTO_STEP_MS` 注释）。所以这里把同一套起手搬到界面上：点「自动通关」即套用。
 *
 * ## ⚠️ 这是一颗**测试开关**，不是玩法
 *
 * 它让游戏**直接跳掉全部属性成长**。所以：
 *   · 只有 `AUTO_GOD_LOADOUT` 为真时才生效，关掉它按钮就回到真实起手；
 *   · 套用之后**必须留一条日志**（`game.ts` 的 `startAuto` 里那行 `warn`）——
 *     界面上悄悄把属性拉满，与判据里悄悄把期望值改掉是同一类病：
 *     玩家/下一个读代码的人分不清「它真的打过了」还是「它开了挂」。
 *   · 值本身**只有这一份**：界面（`game.ts`）与判据（`__probe().autoLoadout`
 *     经 `probe.ts`）都读它，不各自抄一遍数字（铁律 #66）。
 *
 * ## 为什么是这几个数
 *
 * 它们是 D 段一直在用的那一组，**实测能通关**的那一组（不是推算出来的）：
 *
 * | 项 | 值 | 作用 |
 * |---|---|---|
 * | hp | 90000 | 免疫「磨不过」：真魔王一发 3766，够吃几十轮 |
 * | atk | 1000 | 过全塔所有怪的防御门槛（最高是封印前魔王的 def1000） |
 * | def | 1000 | 把绝大多数战斗的掉血压到 0（`freeKills` 那一档） |
 * | 三色钥匙各 999 | — | 把「钥匙经济」这一层整个拿掉，只问「塔通不通」 |
 *
 * 钥匙那一项是关键：只给黄钥匙也能通关，但**不给就卡在第 40 层**
 * （红钥匙全塔只有 4 把 + 商人 1 把，而红门有 11 扇，见 `known-gaps.md` §13）。
 */

import type { GameState } from '../game/state';

/** 神装起手的三围与钥匙 —— 界面与判据**共用这一份** */
export const GOD_LOADOUT = {
  hp: 90000,
  atk: 1000,
  def: 1000,
  keys: { yellowKey: 999, blueKey: 999, redKey: 999 }
} as const;

/**
 * 测试开关：点「自动通关」时套用神装起手。
 *
 * ⚠️ 关掉它（改 `false`）之后，`A23` 的「属性必须变成神装」那一条会**报红** ——
 * 这是有意的：一条「豁免/测试态」的判据必须能自己过期，否则它会变成假绿
 * （铁律 #81：豁免表必须带过期检查）。真要永久关掉，就同时删掉 A23 里那一段。
 */
export const AUTO_GOD_LOADOUT = true;

/** 把神装起手套到这一局上（幂等；只动三围与钥匙，不动地图进度） */
export function applyGodLoadout(state: GameState): void {
  state.hp = GOD_LOADOUT.hp;
  state.atk = GOD_LOADOUT.atk;
  state.def = GOD_LOADOUT.def;
  state.keys = { ...GOD_LOADOUT.keys };
}

/** 一行可读的起手描述 —— 日志与判据详情共用一个写法，免得两边各写一遍数字 */
export function godLoadoutText(): string {
  const k = GOD_LOADOUT.keys;
  return `hp${GOD_LOADOUT.hp} 攻${GOD_LOADOUT.atk} 防${GOD_LOADOUT.def} 钥匙 黄${k.yellowKey}/蓝${k.blueKey}/红${k.redKey}`;
}
