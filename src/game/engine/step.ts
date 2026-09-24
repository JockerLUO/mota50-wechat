/**
 * 主步骤 —— 「按一次方向键」与「用一件道具」。引擎的对外主入口。
 *
 * 从 `engine.ts` 拆出来的。这个文件是**唯一知道「谁调谁」的地方**，
 * 也是原文件头那几条出处的落点：
 *  - 开门：撞门成功即消耗钥匙并**走上该格**（源码 event.js:386 清门后 player.x++）
 *  - 假墙：撞一次即变为空地并走上去（event.js:412）
 *
 * 它处于依赖链的顶端（依赖效果 / 道具 / 交易 / 换层 / 派生量），
 * 所以这一节不适合作任何人的上游 —— 想在这里被别处 import 说明分层错了。
 */

import type { GameData } from '../../data';
import { floorOf } from '../../data';
import { DIRS, entityAt, entityKey, patchTile, pushLog, tileAt, type Dir, type GameState } from '../state';
import { bumpTalk, npcLine } from '../dialogue';
import { REUSABLE_OPS, applyEffects } from './effects';
import { grantItem } from './items';
import { MERCHANT_SOURCE_ID, SHOP_SOURCE_ID, merchantOffers } from './merchant';
import { keyName } from './naming';
import { arriveOnFloor, nearestStandable } from './travel';
import type { NpcTalk, StepKind, StepResult, UseResult } from './types';
import { applyAura, checkDeath, goldMultiplier, previewBattle } from './vitals';

// ── 主步骤：向某方向走一步 ──────────────────────────────────────────

export function step(state: GameState, data: GameData, dir: Dir): StepResult {
  if (state.dead) return { kind: 'blocked', moved: false, message: '勇者已阵亡' };
  state.face = dir;

  const d = DIRS[dir];
  const nx = state.pos.x + d.dx;
  const ny = state.pos.y + d.dy;
  if (nx < 0 || ny < 0 || nx > 10 || ny > 10) {
    return { kind: 'blocked', moved: false, message: '塔墙挡住了去路' };
  }

  const floor = state.floor;
  // `entityAt` 对 BOSS 是**按占位块**命中的（见 `footprint.ts`）：目标格落在它的
  // 3×3 里就算「撞上它」，所以「BOSS 挡路」这条规则不需要在这里写任何特判 ——
  // 下面的 `ent.type === 'monster'` 分支自然把开战接上。
  const ent = entityAt(state, data, floor, nx, ny);

  // ① 怪物：先打，打赢才走上去
  if (ent && ent.type === 'monster') {
    const p = previewBattle(state, data, ent.id);
    if (!p) return { kind: 'blocked', moved: false, message: `未知怪物 ${ent.id}` };
    if (p.reason === 'unpierceable') {
      const msg = `${p.monster.name}：防御 ${p.monster.def} ≥ 攻击 ${state.atk}，完全打不动`;
      pushLog(state, msg, 'battle');
      return { kind: 'battle', moved: false, message: msg };
    }
    if (p.reason === 'heroDies') {
      const msg = `${p.monster.name}：预计损失 ${p.hpLoss} HP，超过当前生命 ${state.hp}，禁止硬拼`;
      pushLog(state, msg, 'warn');
      return { kind: 'battle', moved: false, message: msg };
    }

    state.hp -= p.hpLoss;
    state.stats.hpLost += p.hpLoss;
    state.stats.battles++;
    state.stats.kills++;
    const gain = p.monster.gold * goldMultiplier(state);
    // 原版金币即经验：击杀只加金币，不加经验值（progression.hasExperience = false）
    state.gold += gain;
    state.stats.goldEarned += gain;
    state.removed.add(entityKey(floor, ent.x, ent.y, 'monster', ent.id));
    const exec = p.execute ? '（一击必杀）' : '';
    const cnt = p.appliedCounters?.length ? '（特攻生效）' : '';
    pushLog(
      state,
      `击败 ${p.monster.name}${exec}${cnt}：损失 ${p.hpLoss} HP，获得 ${gain} 金币`,
      'battle'
    );
    checkDeath(state);
    if (state.dead) return { kind: 'battle', moved: false, message: '勇者阵亡' };
    return moveOnto(state, data, floor, nx, ny, 'battle');
  }

  // ② 道具 / NPC
  if (ent) {
    if (ent.type === 'item') {
      const item = data.items[ent.id];
      if (!item) return { kind: 'blocked', moved: false, message: `未知道具 ${ent.id}` };
      state.removed.add(entityKey(floor, ent.x, ent.y, 'item', ent.id));

      const got = grantItem(state, data, ent.id, 1, floor);
      const detail = got.length ? `（${got.join('，')}）` : '';
      pushLog(state, `拾得 ${item.name}${detail}`, 'loot');
      checkDeath(state);
      return moveOnto(state, data, floor, nx, ny, 'pickup');
    }
    if (ent.type === 'npc') {
      const npc = data.npcs[ent.id];
      // 台词在**搭话之前**取，然后再记一次搭话 —— 否则这次就会跳到下一句
      const line = npcLine(state, data, ent.id, floor);
      bumpTalk(state, ent.id);

      // 交易入口：商人只在本层真的配了货时才摆摊；商店（sourceId 39）永远可以做属性买卖
      const tradeKind: NpcTalk['tradeKind'] =
        npc?.sourceId === SHOP_SOURCE_ID
          ? 'shop'
          : npc?.sourceId === MERCHANT_SOURCE_ID && merchantOffers(state, data, floor).length > 0
            ? 'merchant'
            : null;

      const talk: NpcTalk = {
        id: ent.id,
        name: npc?.name ?? ent.id,
        text: line.text,
        from: line.from,
        canTrade: tradeKind !== null,
        tradeKind
      };
      const msg = `${talk.name}：${talk.text}`;
      pushLog(state, msg, 'talk');
      // NPC 不可踩踏：搭话后勇者留在原地。开不开面板由编排层决定（见 StepResult.npc）
      return { kind: 'talk', moved: false, message: msg, npc: talk };
    }
  }

  // ③ 地形
  const ch = tileAt(state, data, floor, nx, ny);
  const info = data.byChar[ch];
  if (!info) return { kind: 'blocked', moved: false, message: `未知地形 ${ch}` };

  if (ch === 'w') {
    patchTile(state, floor, nx, ny, '.');
    pushLog(state, '撞破了一面假墙。', 'info');
    return moveOnto(state, data, floor, nx, ny, 'fakewall');
  }

  if (info.key) {
    if (state.keys[info.key] <= 0) {
      const msg = `没有${keyName(info.key)}，打不开${info.name}`;
      pushLog(state, msg, 'warn');
      return { kind: 'blocked', moved: false, message: msg };
    }
    state.keys[info.key] -= 1;
    patchTile(state, floor, nx, ny, '.');
    pushLog(state, `用掉 1 把${keyName(info.key)}打开${info.name}`, 'info');
    return moveOnto(state, data, floor, nx, ny, 'door');
  }

  if (!info.passable) {
    const msg = `${info.name}无法通行`;
    return { kind: 'blocked', moved: false, message: msg };
  }

  return moveOnto(state, data, floor, nx, ny, 'move');
}

/** 走上某格，并按需触发楼梯 / 领域 */
function moveOnto(state: GameState, data: GameData, floor: number, x: number, y: number, kind: StepKind): StepResult {
  state.pos = { x, y };
  state.stats.steps++;

  const stair = [...floorOf(data, floor).stairs.up, ...floorOf(data, floor).stairs.down].find(
    (s) => s.x === x && s.y === y
  );

  if (stair) {
    const target = stair.to;
    const adjusted = stair.arriveAdjusted ? nearestStandable(state, data, target, stair.arrive.x, stair.arrive.y) : stair.arrive;
    arriveOnFloor(state, data, target, adjusted.x, adjusted.y);
    return { kind: 'stairs', moved: true, floorChanged: target, message: `前往第 ${target} 层` };
  }

  applyAura(state, data);
  return { kind, moved: true };
}

// ── 使用道具 ────────────────────────────────────────────────────────

export function useItem(state: GameState, data: GameData, id: string): UseResult {
  const item = data.items[id];
  if (!item) return { ok: false, message: `未知道具 ${id}` };
  if ((state.bag[id] ?? 0) <= 0) return { ok: false, message: `没有${item.name}` };

  const effects = item.effects ?? [];
  const res = applyEffects(state, data, effects, { floor: state.floor, source: item.name });

  const reusable = effects.some((e) => REUSABLE_OPS.has(e.op));
  if (!reusable) {
    state.bag[id] -= 1;
    if (state.bag[id] <= 0) delete state.bag[id];
  }

  const detail = res.log.length ? `：${res.log.join('，')}` : '';
  pushLog(state, `使用 ${item.name}${detail}`, 'loot');
  checkDeath(state);

  return { ok: true, message: `${item.name}${detail}`, openUi: res.openUi };
}
