/**
 * 派生量与生死 —— 「勇者现在有多强、打一只怪会怎样、谁死了」。
 *
 * 从 `engine.ts` 拆出来的。这里是**所有伤害的唯一落点**：
 * `applyAura`（领域）与 `checkDeath`（阵亡判定）都在这个文件里，
 * 于是「扣血之后必须判死」这条纪律只需要在这一个文件里守住。
 *
 * 原先它们散在 `engine.ts` 的「派生量」一节，但 `checkDeath` 被
 * 效果 / 步骤 / 使用道具 / 交易四处调用、`applyAura` 被效果 / 换层 / 走动
 * 三处调用 —— 一个被七个地方调用的函数挤在 936 行文件的中段，
 * 是「改一处要全文搜索」的典型。
 */

import { simulateBattle, auraStepDamage, grade } from '../../../core/combat.mjs';
import { countersFromItems, hasAuraImmunity } from '../../../core/shop.mjs';
import type { GameData, Monster } from '../../data';
import { tierOf } from '../../data';
import { hasPassive, livingMonsters, pushLog, type GameState } from '../state';
import { touchesFootprint } from '../footprint';
import type { BattlePreview } from './types';

export function heroStats(state: GameState): { hp: number; atk: number; def: number } {
  return { hp: state.hp, atk: state.atk, def: state.def };
}

/** 击杀一只怪物的金币收益（持大金币翻倍） */
export function goldMultiplier(state: GameState): number {
  return hasPassive(state, 'bigGold') ? 2 : 1;
}

/** 对某只怪物的战斗预判 —— 渲染层用它做 hover 提示与危险配色 */
export function previewBattle(
  state: GameState,
  data: GameData,
  monId: string
): (BattlePreview & { grade: string; monster: Monster }) | null {
  const monster = data.monsters[monId];
  if (!monster) return null;
  const counters = countersFromItems(state.passives, data.items);
  const preview = simulateBattle(heroStats(state), monster, { counters });
  return { ...preview, grade: grade(heroStats(state), preview), monster };
}

/**
 * 领域伤害：移动后与带 aura 的怪物相邻则扣血。
 *
 * **导出**是因为它有三个调用点分处不同模块（效果里的对称传送、换层落地、
 * 走完一格）。原先是模块私有的，拆文件后必须显式导出。
 *
 * ⚠️ 「相邻」用的是 `touchesFootprint`（贴到**占位块**），不是老的
 * `isAdjacent`（贴到**坐标**）。对杂兵两者逐字等价（占位块就是它那一格）；
 * 对 BOSS 才有区别 —— 它占 3×3，站在它正上/正下方那一格时，到它**坐标**的
 * 曼哈顿距离是 2，用老函数会漏掉，读起来就是「站在魔王头顶上不吃领域伤害」。
 */
export function applyAura(state: GameState, data: GameData): number {
  const monsters = livingMonsters(state, data, state.floor)
    .filter((m) => touchesFootprint(m.fp, state.pos.x, state.pos.y))
    .map((m) => data.monsters[m.id])
    .filter(Boolean);
  if (monsters.length === 0) return 0;
  const immune = hasAuraImmunity(state.passives, data.items);
  const dmg = auraStepDamage(monsters, { auraImmune: immune });
  if (dmg <= 0) return 0;
  state.hp -= dmg;
  state.stats.hpLost += dmg;
  const names = monsters.map((m) => m.name).join('、');
  pushLog(state, `巫师领域：${names} 相邻，损失 ${dmg} HP${immune ? '（免疫）' : ''}`, 'warn');
  checkDeath(state);
  return dmg;
}

/**
 * 阵亡判定。**任何扣血之后都必须调它** —— 所以它和 `applyAura` 待在同一个文件里。
 * 拆开这两个函数是这类项目里最典型的隐患：改了扣血的那处、忘了新加的这处。
 */
export function checkDeath(state: GameState): void {
  if (state.hp <= 0) {
    state.hp = 0;
    state.dead = true;
    pushLog(state, '勇者阵亡。', 'warn');
  }
}

/** 本层的收益档位（给 UI 的说明性数据） */
export function currentTier(data: GameData, floor: number): { mul: number; hp: number; atk: number; def: number } {
  return tierOf(data, floor);
}
