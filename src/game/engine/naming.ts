/**
 * 属性 / 钥匙 / 地形的**中文名**。
 *
 * 这是全引擎最底层的一个文件：它不依赖任何东西，却被效果、道具、交易、
 * 商店四处用来拼日志。拆出来的理由很实际 —— 原来「生命」这两个字在
 * `engine.ts` 里出现过三种拼法（`statName()`、内联字面量、`statCn()`），
 * 而中文名一旦要改（比如「生命」改叫「HP」）就必须三处一起改。
 * 现在只有这一份。
 *
 * ⚠️ 与 `render/hud` 的 `statCn()` **不是重复**：那边多一个 `gold`
 *    （UI 里金币和三维并排显示），这边按 `Stat` 的联合类型收窄到三维。
 *    两个函数服务的是两种数据，故意不合并。
 */

import type { GameData, KeyId, Stat } from '../../data';

export function statName(s: Stat): string {
  return { hp: '生命', atk: '攻击', def: '防御' }[s];
}

export function keyName(k: KeyId): string {
  return { yellowKey: '黄钥匙', blueKey: '蓝钥匙', redKey: '红钥匙' }[k];
}

export function terrainName(data: GameData, code: number): string {
  const info = data.tiles.find((t) => data.codeOf[t.char] === code);
  return info?.name ?? `地形${code}`;
}

// ── 给 UI 的别名 ────────────────────────────────────────────────────
// 对外用 `keyNameOf` / `statNameOf`（UI 层读起来更像「取名字」），
// 对内仍叫 keyName / statName。两个名字指向同一个实现，不存在第二份真值。

export function keyNameOf(k: KeyId): string {
  return keyName(k);
}

export function statNameOf(s: Stat): string {
  return statName(s);
}
