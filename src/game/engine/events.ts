/**
 * 事件执行 —— 补齐参考源码「没写完的那部分」，而不是新增玩法。
 *
 * 目前只有一类效果：`addStair`（在指定格生成一条楼梯）。它存在的唯一理由
 * 是**楼梯图在三处区域边界断开，其中 49→50 让游戏不可通关**：
 *
 * | 断点 | 触发 | 依据 |
 * |---|---|---|
 * | 10 → 11 | 击败骷髅队长 | `mota50-event.js` 的 `floor[10][115]=4`（115 = 5 + 10×11） |
 * | 40 → 41 | 击败骑士队长 | 同一手法，参考实现漏写 |
 * | 24 → 50 | 开局即存在 | 智者 `wiserWord[24]`「魔塔50层与24层有关联」+ 24 层红门后的空腔 |
 *
 * 全部依据与「为什么不是别的方案」见 `docs/known-gaps.md §1` 与 `data/events.json`。
 *
 * ## 为什么不写成通用事件系统
 *
 * 一个带条件、带阶段、带优先级的事件引擎是**另一个项目**。这里只有三个调用点
 * （开局、击败怪物），而「事件」这个概念一旦泛化，最先长出的一定是
 * 「为什么这条没触发」这类只有通用系统才有的 bug。
 * 所以这里保持**只有两张表**：`trigger` 匹配、`effects` 执行，没有第三种概念。
 */

import type { GameData } from '../../data';
import { createInitialState, patchTile, pushLog, type GameState } from '../state';

/** 引擎内部触发某类事件时传的「信号」——只含触发种类与必要的定位信息，不带 ids/floor（那些在数据表里） */
export type EventTrigger = { op: 'defeated'; id: string } | { op: 'start' } | { op: 'allDefeated' };

/**
 * 开一局新游戏 —— 建初始状态之后**必须**跑一遍 `start` 事件。
 *
 * 单独封一个函数是因为「建状态」和「跑开局事件」是两件事，而后者**只有这一处**知道：
 * 漏了它的症状是第 24 层通往 50 层的楼梯不出现，而游戏其余部分一切正常 ——
 * 一种只在终点才暴露的静默失败。
 */
export function newGame(data: GameData): GameState {
  const state = createInitialState(data);
  applyTrigger(state, data, { op: 'start' });
  return state;
}

function matches(trigger: EventTrigger, t: GameData['events'][number]['trigger']): boolean {
  if (t.op === 'start') return trigger.op === 'start';
  if (t.op === 'defeated') return trigger.op === 'defeated' && t.id === trigger.id;
  if (t.op === 'allDefeated') return trigger.op === 'allDefeated';
  return false;
}

/** 按触发条件跑一遍事件表。`once` 的事件由 `state.fired` 保证不重复执行。 */
export function applyTrigger(state: GameState, data: GameData, trigger: EventTrigger): void {
  for (const ev of data.events) {
    if (!matches(trigger, ev.trigger)) continue;
    // allDefeated：需要「列表内怪全灭」才真正触发
    if (ev.trigger.op === 'allDefeated' && !allDefeated(state, data, ev.trigger.ids, ev.trigger.floor)) continue;
    if (ev.once && state.fired.has(ev.id)) continue;
    if (ev.once) state.fired.add(ev.id);
    for (const e of ev.effects) {
      if (e.op === 'addStair') {
        // 地形改成上楼梯标记 —— 渲染层是按地形画的，不改这里画面上就没有楼梯，
        // 而引擎的换层判定读的是 extraStairs，两者必须一起改。
        patchTile(state, e.floor, e.x, e.y, '^');
        state.extraStairs.push({
          floor: e.floor,
          x: e.x,
          y: e.y,
          to: e.to,
          arrive: { ...e.arrive }
        });
        pushLog(state, `${ev.title}：第 ${e.floor} 层 (${e.x},${e.y}) 出现了通往第 ${e.to} 层的楼梯`, 'info');
      } else if (e.op === 'replaceMonster') {
        replaceMonster(state, data, e);
      }
    }
  }
}

/** 列表内的怪是否已全部被击败（按「这种怪在（限定楼层内）数据里的总数 vs removed 里的数量」） */
function allDefeated(state: GameState, data: GameData, ids: string[], floor?: number): boolean {
  for (const id of ids) {
    let total = 0;
    let removed = 0;
    for (const [idx, f] of data.floors) {
      if (floor !== undefined && idx !== floor) continue;
      for (const e of f.entities) {
        if (e.type !== 'monster' || e.id !== id) continue;
        total++;
        if (state.removed.has(`${idx}:${e.x}:${e.y}:monster:${e.id}`)) removed++;
      }
    }
    if (removed < total) return false;
  }
  return true;
}

/** 把某层某格的怪物换成另一个 id（封印解除）。换错对象会当场报错，不静默。 */
function replaceMonster(state: GameState, data: GameData, e: { floor: number; x: number; y: number; from: string; to: string }): void {
  const f = data.floors.get(e.floor);
  const ent = f?.entities.find((x) => x.x === e.x && x.y === e.y && x.type === 'monster');
  if (!ent) throw new Error(`replaceMonster：第 ${e.floor} 层 (${e.x},${e.y}) 没有怪物可替换`);
  if (ent.id !== e.from) throw new Error(`replaceMonster：第 ${e.floor} 层 (${e.x},${e.y}) 是 ${ent.id}，不是预期的 ${e.from}`);
  // 记下「这一格现在是 to」。不标 removed：假魔王不是「被打败」，而是「现出真身」，
  // 真魔王还要继续在这一格被战斗。entityAt 读到 swap 就返回真魔王。
  state.monsterSwap[`${e.floor}:${e.x},${e.y}`] = e.to;
  pushLog(state, `魔法封印解除！魔王现出真身。`, 'info');
}
