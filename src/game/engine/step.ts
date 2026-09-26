/**
 * 主步骤 —— 「按一次方向键」与「用一件道具」。引擎的对外主入口。
 *
 * 从 `engine.ts` 拆出来的。这个文件是**唯一知道「谁调谁」的地方**，
 * 也是原文件头那几条出处的落点：
 *  - 开门：撞门成功即消耗钥匙并**走上该格**（源码 event.js:386 清门后 player.x++）
 *  - 假墙：撞一次即变为空地并走上去（event.js:412）
 *  - 地块剧情：走上某格自动触发（`enterTile`，本项目原创 —— 见 moveOnto 的注释）
 *
 * 它处于依赖链的顶端（依赖效果 / 道具 / 交易 / 换层 / 派生量），
 * 所以这一节不适合作任何人的上游 —— 想在这里被别处 import 说明分层错了。
 */

import type { GameData } from '../../data';
import { DIRS, entityAt, entityKey, patchTile, pushLog, stairsOn, tileAt, type Dir, type GameState } from '../state';
import { bumpTalk, npcLine } from '../dialogue';
import { applyTrigger } from './events';
import { REUSABLE_OPS, applyEffects } from './effects';
import { pickUpAt } from './items';
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
    // 区域边界通路：打完 BOSS 才开启通往下一区的路（10→11 / 40→41）；
    // 封印解除：某组怪全灭后触发（如第 49 层守卫全灭 → 假魔王换真魔王）
    applyTrigger(state, data, { op: 'defeated', id: ent.id });
    applyTrigger(state, data, { op: 'allDefeated' });
    return moveOnto(state, data, floor, nx, ny, 'battle');
  }

  // ② 道具 / NPC
  if (ent) {
    if (ent.type === 'item') {
      if (!data.items[ent.id]) return { kind: 'blocked', moved: false, message: `未知道具 ${ent.id}` };
      // 拾取的实现在 `items.ts` 的 `pickUpAt()` —— 与「落地即拾取」共用同一份
      pickUpAt(state, data, floor, ent.x, ent.y);
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
      //
      // 搭话也是**事件触发点**：第 2 层智者给「攻击/防御各 +10%」、第 3 层智者
      // 送怪物书，参考源码都挂在搭话上（`eventHappened[1]` / `[3]`）。
      //
      // ⚠️ 坐标必须一起传：第 2 层有两个智者 (10,3)/(10,9)，只有前者给 +10%。
      // 只传 id 与 floor 会让两个都触发（+10% 变成 +21%）。
      //
      // 放在 `pushLog` **之后**：这样对话框里显示的还是「搭话当时」的台词，
      // 属性变化紧跟在后面记一条 —— 顺序反了的话，台词会晚一步。
      applyTrigger(state, data, { op: 'talked', id: ent.id, floor, x: ent.x, y: ent.y });
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

/** 走上某格，并按需触发楼梯 / 领域 / 地块剧情 */
function moveOnto(state: GameState, data: GameData, floor: number, x: number, y: number, kind: StepKind): StepResult {
  state.pos = { x, y };
  state.stats.steps++;

  // ⚠️ 必须走 `stairsOn`（数据里的 + 事件生成的）：直接读 `floorOf(data, floor).stairs`
  // 会漏掉三处区域边界通路，表现是勇者踩在画着楼梯的格子上却不换层。
  const stair = stairsOn(state, data, floor).find((s) => s.x === x && s.y === y);

  if (stair) {
    const target = stair.to;
    const adjusted = stair.arriveAdjusted ? nearestStandable(state, data, target, stair.arrive.x, stair.arrive.y) : stair.arrive;
    arriveOnFloor(state, data, target, adjusted.x, adjusted.y);
    return { kind: 'stairs', moved: true, floorChanged: target, message: `前往第 ${target} 层` };
  }

  // ⚠️ 顺序：**先**跑地块剧情，**再**结算领域。
  //    地块剧情可能把勇者传送走（第 3 层的伏击就是），此时 `arriveOnFloor()`
  //    已经在落地时结算过一次领域了；这里再调一次就是**两次扣血** ——
  //    `applyAura` 会真的扣 HP（见 vitals.ts），它不幂等。所以按「还在不在原来
  //    那一层」分流，而不是无条件调。
  const talk = applyTrigger(state, data, { op: 'enterTile', floor, x, y });
  if (state.floor === floor) applyAura(state, data);
  return { kind, moved: true, npc: talk ?? undefined };
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
