/**
 * 效果执行 —— 把 `items.json` / `npcs.json` 里那条 `effects` 数组变成实际改动。
 *
 * 从 `engine.ts` 拆出来的。这是**数据驱动的那一层**：新增一件道具通常
 * 不需要改任何渲染代码，只要在这里加一个 `case`、在数据里写一条 `op`。
 * 所以这个文件是「玩法扩展的入口」，单独放一个文件才找得到。
 *
 * ## 一条硬约束（改动时最容易被破）
 *
 * **「持有即生效」的算子在这里什么也不做。** `mulGoldGain` / `traitCounter` /
 * `immune` 三种算子的效果由 `state.passives` 承载（见 `vitals.ts` 的
 * `goldMultiplier`、`previewBattle`）。曾经有人在这里「顺手把效果也实现一遍」，
 * 于是持大金币时金币被算了两次 —— 这类 bug 在 UI 上表现为「收益偶尔翻倍」，
 * 很难复现。
 */

import type { GameData, ItemEffect, KeyId, Stat } from '../../data';
import { DIRS, entityAt, entityKey, patchTile, tileAt, type GameState } from '../state';
import { keyName, statName, terrainName } from './naming';
import { arriveOnFloor, nearestStandable } from './travel';
import type { EffectContext, UseResult } from './types';
import { applyAura } from './vitals';

/** 持有即生效的效果算子 —— 拾取时同步进 `passives` */
export const PERSISTENT_OPS = new Set(['traitCounter', 'immune', 'mulGoldGain']);
/** 可重复使用、不消耗的道具效果 */
export const REUSABLE_OPS = new Set(['openFloorSelect', 'toggleUi']);

export function applyEffects(state: GameState, data: GameData, effects: ItemEffect[], ctx: EffectContext): { log: string[]; openUi?: UseResult['openUi'] } {
  const lines: string[] = [];
  let openUi: UseResult['openUi'];

  for (const e of effects) {
    switch (e.op) {
      case 'addStat': {
        // 金币也走 addStat：第 2 层商人赠礼就是 `{op:'addStat', stat:'gold', value:1000}`
        const stat = String(e.stat);
        const value = e.value as number;
        if (stat === 'gold') {
          state.gold += value;
          lines.push(`金币 +${value}`);
        } else {
          state[stat as Stat] += value;
          lines.push(`${statName(stat as Stat)} +${value}`);
        }
        break;
      }
      case 'mulStat': {
        const stat = e.stat as Stat;
        const value = e.value as number;
        const before = state[stat];
        state[stat] = Math.floor(before * value);
        lines.push(`${statName(stat)} ${before} → ${state[stat]}（×${value}）`);
        break;
      }
      case 'addKey': {
        const key = e.key as KeyId;
        const value = e.value as number;
        state.keys[key] += value;
        lines.push(`${keyName(key)} +${value}`);
        break;
      }
      case 'mulGoldGain':
      case 'traitCounter':
      case 'immune':
        // 持有即生效，由 `passives` 承载；此处不产生即时效果
        break;
      case 'clearTerrain': {
        const code = e.terrain as number;
        let n = 0;
        for (let y = 0; y < 11; y++) {
          for (let x = 0; x < 11; x++) {
            if (data.codeOf[tileAt(state, data, ctx.floor, x, y)] === code) {
              patchTile(state, ctx.floor, x, y, '.');
              n++;
            }
          }
        }
        lines.push(`清除本层 ${n} 格 ${terrainName(data, code)}`);
        break;
      }
      case 'breakWall': {
        let n = 0;
        for (const d of Object.values(DIRS)) {
          const x = state.pos.x + d.dx;
          const y = state.pos.y + d.dy;
          if (tileAt(state, data, ctx.floor, x, y) === '#') {
            patchTile(state, ctx.floor, x, y, '.');
            n++;
          }
        }
        lines.push(n ? `挖开相邻 ${n} 面墙` : '相邻没有可挖的墙');
        break;
      }
      case 'bomb': {
        const ex = (e.exclude ?? {}) as { roleIds?: number[]; roleIdAtLeast?: number };
        let n = 0;
        for (const d of Object.values(DIRS)) {
          const x = state.pos.x + d.dx;
          const y = state.pos.y + d.dy;
          const ent = entityAt(state, data, ctx.floor, x, y);
          if (!ent || ent.type !== 'monster') continue;
          const m = data.monsters[ent.id];
          if (!m) continue;
          if (ex.roleIdAtLeast !== undefined && m.roleId >= ex.roleIdAtLeast) continue;
          if (ex.roleIds?.includes(m.roleId)) continue;
          state.removed.add(entityKey(ctx.floor, x, y, 'monster', ent.id));
          n++;
        }
        lines.push(n ? `炸掉相邻 ${n} 只怪物` : '相邻没有可炸的怪物');
        break;
      }
      case 'teleportSymmetric': {
        // 源码 1 基 `player.x = 12 - player.x` → 0 基 10 − x
        const tx = 10 - state.pos.x;
        const ty = 10 - state.pos.y;
        const info = data.byChar[tileAt(state, data, ctx.floor, tx, ty)];
        if (info?.passable && !entityAt(state, data, ctx.floor, tx, ty)) {
          state.pos = { x: tx, y: ty };
          lines.push(`对称传送到 (${tx}, ${ty})`);
          applyAura(state, data);
        } else {
          lines.push(`对称点 (${tx}, ${ty}) 不是空位，传送失败`);
          return { log: lines, openUi };
        }
        break;
      }
      case 'changeFloor': {
        const delta = e.delta as number;
        const target = state.floor + delta;
        if (!data.floors.has(target)) {
          lines.push(`第 ${target} 层不存在，无法前往`);
          break;
        }
        const drop = nearestStandable(state, data, target, state.pos.x, state.pos.y);
        arriveOnFloor(state, data, target, drop.x, drop.y);
        lines.push(`前往第 ${target} 层`);
        break;
      }
      case 'openFloorSelect':
        openUi = 'floorSelect';
        break;
      case 'toggleUi':
        openUi = e.ui === 'notebook' ? 'notebook' : 'monsterBook';
        break;
      default:
        lines.push(`未实现的算子：${e.op}`);
    }
  }
  return { log: lines, openUi };
}
