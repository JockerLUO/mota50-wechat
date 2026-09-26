/**
 * 事件执行 —— 「数据里写了一条事件，引擎真的会照做」的唯一落点。
 *
 * 算子按**来路**分三组（`src/data/types.ts` 的 `AnyEventEffect` 有完整交代）：
 *
 * | 来路 | 算子 | 依据 |
 * |---|---|---|
 * | 补断点（区域边界通路） | `addStair` | `docs/known-gaps.md §1` |
 * | 补漏转写（源码写了、导入没搬） | `clearTerrain` / `mulStat` / `grantItem` / `replaceMonster` | 各条的 `evidence` 字段 |
 * | 本项目原创（源码里没有） | `setTerrain` / `teleport` / `say` | 各条的 `why` 必须写明「无源码依据」 |
 *
 * 补断点那一组的重点是 49→50：它是「游戏不可通关」的直接原因，
 * 也是这个文件最初存在的唯一理由。
 *
 * ## 照抄算子的两条硬约束
 *
 * ① **能复用就别重写**。`clearTerrain` / `mulStat` 的实现在 `effects.ts`
 *    （道具也在用同一个），这里只负责套上「哪一层」；抄一份必然漂移 ——
 *    「按编号清」与「先 floor 再乘」都是被道具侧断言过的行为。
 * ② **位移必须走 `travel.ts` 的 `arriveOnFloor()`**（见下面的 `teleport`）。
 *
 * ## 为什么仍然不是通用事件系统
 *
 * 一个带条件、带阶段、带优先级的事件引擎是**另一个项目**。这里只有四个调用点
 * （开局、击败怪物、搭话、走到某格），而「事件」这个概念一旦泛化，最先长出的
 * 一定是「为什么这条没触发」这类只有通用系统才有的 bug。
 * 所以这里保持**只有两张表**：`trigger` 匹配、`effects` 执行，没有第三种概念。
 * 想加算子就先回答「它能不能表达成已有的某一条」。
 */

import type { GameData } from '../../data';
import { createInitialState, patchTile, pushLog, tileAt, type GameState } from '../state';
import { applyEffects } from './effects';
import { grantItem } from './items';
import { arriveOnFloor, nearestStandable } from './travel';
import type { NpcTalk } from './types';

/**
 * 引擎内部触发某类事件时传的「信号」——只含触发种类与必要的定位信息。
 *
 * 注意它与数据表里的 `trigger` **不是同一个类型**：数据表写的是「触发条件」
 * （带 ids / floor 这些筛选），这里传的是「刚刚发生了什么」。
 *   - `defeated` / `talked` 带具体的 id（引擎在发生时才知道）
 *   - `allDefeated` 不带 ids：全灭与否要由数据表里的名单去数（见 `allDefeated()`）
 *   - `talked` 还要带坐标：同一层可能有多个同类 NPC（第 2 层有两个智者）
 *   - `enterTile` 由 `step.ts` 的 `moveOnto()` 在**走上某格之后**发出，
 *     所以带的就是勇者刚踏上的那一格
 */
export type EventTrigger =
  | { op: 'defeated'; id: string }
  | { op: 'start' }
  | { op: 'allDefeated' }
  | { op: 'talked'; id: string; floor: number; x: number; y: number }
  | { op: 'enterTile'; floor: number; x: number; y: number };

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
  if (t.op === 'enterTile') {
    return trigger.op === 'enterTile' && t.floor === trigger.floor && t.x === trigger.x && t.y === trigger.y;
  }
  if (t.op === 'talked') {
    if (trigger.op !== 'talked' || t.id !== trigger.id) return false;
    if (t.floor !== undefined && t.floor !== trigger.floor) return false;
    // 坐标是可选的**细化条件**：第 2 层两个智者必须靠它区分（见 types.ts 的注释）
    if (t.x !== undefined && t.x !== trigger.x) return false;
    if (t.y !== undefined && t.y !== trigger.y) return false;
    return true;
  }
  return false;
}

/**
 * 按触发条件跑一遍事件表。`once` 的事件由 `state.fired` 保证不重复执行。
 *
 * **返回值 = 这一段剧情要对玩家说的话**（没有就是 `null`）。
 *
 * 为什么要有返回值：事件跑完之后，玩家该看到的那句台词得有人接住。
 * 但引擎不认界面（这个文件不 import 任何 `render/`），所以它只把台词
 * **交回去**，由 `step.ts` 挂到 `StepResult.npc` 上、编排层决定怎么画。
 * 在此之前事件说的话只进 `state.log`，而界面上的消息条已经删掉了 ——
 * 表现是「走到伏击点，画面一跳就到牢房，没有任何交代」。
 *
 * ⚠️ 一次只带回**最后一条** `say`：同一事件写两条的话第一条会被静默丢掉。
 * 这条约束由 `tools/validate-data.mjs` 机器检查（铁律 #23）。
 */
export function applyTrigger(state: GameState, data: GameData, trigger: EventTrigger): NpcTalk | null {
  let said: NpcTalk | null = null;
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
      } else if (e.op === 'clearTerrain' || e.op === 'mulStat') {
        // 这两个算子的实现在 `effects.ts`（道具也在用同一个），这里只是把它
        // 套上「哪一层」——`EffectContext.floor` 是它认的楼层口径。
        // ⚠️ 别在这里重写一遍：`clearTerrain` 的「按编号清」与 `mulStat` 的
        // 「先 floor 再乘」都是被道具侧断言过的行为，抄一份必然漂移。
        applyEffects(state, data, [e], { floor: e.floor, source: ev.title });
      } else if (e.op === 'grantItem') {
        const got = grantItem(state, data, e.item, e.count ?? 1, e.floor);
        pushLog(state, `${ev.title}：${got.join('，') || e.item}`, 'loot');
      } else if (e.op === 'setTerrain') {
        // 逐格精确改（`clearTerrain` 的反面）。先读一次是为了两件事：
        //   ① 把「原来是什么」也记进 log，否则只能看到地形凭空变了；
        //   ② **改不动就不动** —— 原本就是目标字符时既不 patch 也不记 log。
        // ② 是必须的：本项目的落锁 effect 在「玩家没打过那两名中级卫兵」时
        // (4,4) 本来就是牢门 `D`，再记一条「D 变成 D」纯属噪音（而且会在
        // state.terrainPatch 里留一条永远无人读的冗余）。
        // 刻意**不**校验 `terrain` 是不是合法符号：非法值会让 `tileAt` 返回它，
        // 随后 `step()` 报「未知地形 x」当场炸出来 —— 比静默通过好。
        const before = tileAt(state, data, e.floor, e.x, e.y);
        if (before !== e.terrain) {
          patchTile(state, e.floor, e.x, e.y, e.terrain);
          pushLog(
            state,
            `${ev.title}：第 ${e.floor} 层 (${e.x},${e.y}) 的「${before}」变成「${e.terrain}」`,
            'info'
          );
        }
      } else if (e.op === 'teleport') {
        // 绝对楼层 + 坐标。落点被实体占着时 `nearestStandable` 就近修正 ——
        // 修正这件事必须留痕（它会**穿墙**找格子，静默修正可能把人放到牢房外面，
        // 那「被关进监牢」这条剧情就整个失效了，而报告上一切正常）。
        const drop = nearestStandable(state, data, e.floor, e.x, e.y);
        if (drop.x !== e.x || drop.y !== e.y) {
          pushLog(state, `（落点 (${e.x},${e.y}) 有人占着，改在 (${drop.x},${drop.y}) 落地）`, 'warn');
        }
        // `arriveOnFloor` 自己会记一条「进入第 N 层」，所以这里记的是**剧情**那句。
        arriveOnFloor(state, data, e.floor, drop.x, drop.y);
        pushLog(state, e.say ?? `被带到了第 ${e.floor} 层`, 'warn');
      } else if (e.op === 'say') {
        // 剧情台词：**交给调用方去画**（返回值），这里只记台账。
        // 为什么不在引擎里直接「打开对话框」：引擎不认界面 —— 它不知道什么是面板，
        // 也不该知道（engine/types.ts 的文件头就是这条边界）。
        //
        // `from: 'story'` 让编排层能把这句话和 NPC 的台词轮换区分开：
        // 剧情台词不参与 `talked[npcId]` 计数，也不该走「本层专说 / 初次见面」
        // 那套提示（它既不是搭话、也不轮换）。
        said = {
          id: e.speaker,
          name: e.name,
          text: e.lines.join('\n'),
          lines: e.lines,
          from: 'story',
          canTrade: false,
          tradeKind: null
        };
        pushLog(state, `${e.name}：${e.lines.join(' ')}`, 'talk');
      }
    }
  }
  return said;
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
