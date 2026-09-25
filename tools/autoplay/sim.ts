/**
 * 无人操作的整局模拟 —— 「自动通关到底能不能通关」这条断言的现场。
 *
 * 它跑的是**和游戏里完全同一套引擎**（`src/game/engine`），只是不渲染：
 * 决策来自 `src/game/autoplay.ts`，执行来自引擎的 `step()` / `useItem()` /
 * `buyStat()` / `travelTo()`。所以这里能通关 ≠ 游戏里能通关的说法不成立 ——
 * 两者之间只差一层动画。
 *
 * 用法（由 `tools/autoplay-sim.mjs` 打包后调用）：
 *   node tools/autoplay-sim.mjs [--max-steps 40000] [--quiet]
 */

import { loadData } from '../../src/data';
import { buyStat, newGame, step, travelTo, useItem } from '../../src/game/engine';
import { previewBattle } from '../../src/game/engine/vitals';
import { createAutoMemory, decideAutoAction, explainStop, isCleared, type AutoAction, type AutoMemory } from '../../src/game/autoplay';
import { tileAt } from '../../src/game/state';
import type { GameData, GameState } from '../../src/data';

// 单层体检（`--floor N` 用）。与整局模拟共用同一次打包，省掉第二份入口。
export { dumpFloor, probePos } from './diag';

export interface SimReport {
  cleared: boolean;
  dead: boolean;
  reason: string;
  floor: number;
  maxFloor: number;
  steps: number;
  hp: number;
  atk: number;
  def: number;
  gold: number;
  keys: { yellowKey: number; blueKey: number; redKey: number };
  kills: number;
  hpLost: number;
  buys: number;
  visited: number[];
  stuckAt: string | null;
  tail: string[];
  /**
   * 最后若干步的**紧凑轨迹**（`F6(5,7)→step 上楼…`）。
   *
   * `tail` 只记「值得记的事」，看不出循环长什么样 —— 而卡住几乎总是
   * 「在两三层之间转圈」，只有把连续的 (层, 位置, 目标) 摊开才看得见。
   * 实测 3712 步的循环光看 tail 只能猜，看轨迹一眼就知道是 6⇄7 还是 4→9 大回环。
   */
  trace: string[];
  /** 每层剩下的东西 —— 用来看 AI 是「清干净了才走」还是「漏了一地就上楼」 */
  leftovers: string[];
}

/**
 * 访问过的每一层还剩什么。
 *
 * 没有它，报告只能说「卡在第 N 层」，看不出 AI 是**真的清干净了**还是
 * **漏了一地宝石就往上冲**（后者才是魔塔 AI 最常见的死法：属性不够 →
 * 打不动 → 上不去 → 回头发现该拿的都没拿）。
 */
function dumpLeftovers(state: GameState, data: GameData, maxFloor: number): string[] {
  const out: string[] = [];
  for (let f = 1; f <= Math.min(maxFloor, 50); f++) {
    const fd = data.floors.get(f);
    if (!fd) continue;
    const items: string[] = [];
    const mons: string[] = [];
    for (const e of fd.entities) {
      if (e.type === 'item' && !state.removed.has(`${f}:${e.x}:${e.y}:item:${e.id}`)) {
        items.push(data.items[e.id]?.name ?? e.id);
      }
      if (e.type === 'monster' && !state.removed.has(`${f}:${e.x}:${e.y}:monster:${e.id}`)) {
        const p = previewBattle(state, data, e.id);
        mons.push(`${data.monsters[e.id]?.name ?? e.id}${p?.canWin ? '' : '(打不动)'}`);
      }
    }
    const shop = fd.entities.some((e) => e.type === 'npc' && e.id === 'shop') ? ' [商店]' : '';
    out.push(`  F${f}${shop} 道具剩 ${items.length}：${items.slice(0, 8).join('、') || '—'}｜怪剩 ${mons.length}：${mons.slice(0, 6).join('、') || '—'}`);
  }
  return out;
}

export function simulate(maxSteps = 40000, verbose = false): SimReport {
  const data: GameData = loadData();
  const state: GameState = newGame(data);

  let steps = 0;
  let buys = 0;
  const mem: AutoMemory = createAutoMemory();
  let maxFloor = state.floor;
  let stuckAt: string | null = null;
  const tail: string[] = [];
  const trace: string[] = [];
  let lastSig = '';
  let runLen = 0;

  const note = (s: string) => {
    tail.push(s);
    if (tail.length > 24) tail.shift();
    if (verbose) console.log(`  [${steps}] ${s}`);
  };

  while (steps < maxSteps) {
    const action: AutoAction = decideAutoAction(state, data, mem);
    if (action.kind === 'stop') {
      note(`STOP: ${action.reason}`);
      for (const line of explainStop(state, data)) note(line);
      return {
        cleared: isCleared(state, data),
        dead: state.dead,
        reason: action.reason,
        floor: state.floor,
        maxFloor,
        steps,
        hp: state.hp,
        atk: state.atk,
        def: state.def,
        gold: state.gold,
        keys: { ...state.keys },
        kills: state.stats.kills,
        hpLost: state.stats.hpLost,
        buys,
        visited: [...state.visited],
        stuckAt,
        tail,
        trace,
        leftovers: dumpLeftovers(state, data, maxFloor)
      };
    }

    // 死循环探针：同一个「位置 + 楼层 + 动作」反复出现说明决策卡住了。
    // 没有它，卡住会表现成「跑满 maxSteps 然后说步数超了」，看不出是策略问题还是步数给少了。
    if (verbose) {
      const g = (action as { goal?: string }).goal ?? '';
      console.log(
        `  [${steps}] F${state.floor} (${state.pos.x},${state.pos.y}) hp${state.hp} ` +
          `黄${state.keys.yellowKey} 蓝${state.keys.blueKey} 红${state.keys.redKey} → ${action.kind} ${g}`
      );
    }
    const sig = `${state.floor}:${state.pos.x},${state.pos.y}:${action.kind}:${JSON.stringify(action).slice(0, 60)}`;
    //
    // 死循环探针只认「**连续**同一动作」—— 用「累计」会把大回环里的
    // 重复路过误判成死循环（勇者每次从低层回来都路过 (2,6) 执行同一步上楼，
    // 累计 13 次就被当成卡住，其实它一直在推进）。
    let n = 0;
    if (lastSig === sig) {
      n = runLen + 1;
    } else {
      lastSig = sig;
      n = 1;
    }
    runLen = n;
    trace.push(
      `F${state.floor}(${state.pos.x},${state.pos.y}) ${action.kind} ${(action as { goal?: string }).goal ?? ''}`
    );
    if (trace.length > 160) trace.shift();
    if (n > 12) {
      stuckAt = `${sig} ×${n}`;
      note(`STUCK: ${stuckAt}`);
      note(`  state.pos = (${state.pos.x},${state.pos.y})，floor=${state.floor}`);
      // 直接复现这一步：决策器给的 dir，引擎到底返回什么
      const probeAction = decideAutoAction(state, data, mem);
      note(`  decide 此刻返回：${JSON.stringify(probeAction)}`);
      if (probeAction.kind === 'step') {
        const pr = step(state, data, probeAction.dir);
        note(`  step(${probeAction.dir}) 返回：${JSON.stringify(pr)}`);
      }
      // 卡点四邻地形 —— 判「决策器算的路径」和「引擎实际能走」是否撕裂
      for (const [d, dx, dy] of [
        ['up', 0, -1],
        ['down', 0, 1],
        ['left', -1, 0],
        ['right', 1, 0]
      ] as const) {
        note(`  邻格 ${d} (${state.pos.x + dx},${state.pos.y + dy}) 地形=${JSON.stringify(tileAt(state, data, state.floor, state.pos.x + dx, state.pos.y + dy))}`);
      }
      for (const line of explainStop(state, data)) note(line);
      break;
    }

    switch (action.kind) {
      case 'step': {
        const before = `${state.floor}:${state.pos.x},${state.pos.y}`;
        const res = step(state, data, action.dir);
        //
        // ⚠️ `battle` 且 `moved === false` 也必须记：那是「打不动 / 会打死自己」的
        // 拒绝开战（`step.ts` 的两个 early return），而它看起来**完全不像卡住** ——
        // 没有报错、没有 blocked，只是原地不动。漏掉它的话，AI 会在同一个
        // 目标前反复撞几千步，而日志里一条线索都没有（实测卡在「拾取铁盾」805 步）。
        const refused = !res.moved && (res.kind === 'battle' || res.kind === 'blocked');
        if (refused) note(`REFUSED ${before} → ${action.dir}：${res.message}（目标：${action.goal}）`);
        if (!res.moved && res.kind !== 'battle' && res.kind !== 'talk' && res.kind !== 'blocked') {
          note(`NO-MOVE ${before} → ${action.dir}：${res.kind} ${res.message}`);
        }
        break;
      }
      case 'useItem': {
        useItem(state, data, action.id);
        note(`USE ${action.id} —— ${action.goal}`);
        break;
      }
      case 'buy': {
        const r = buyStat(state, action.stat);
        if (r.ok) buys++;
        note(`BUY ${action.stat} —— ${r.message}`);
        break;
      }
      case 'trade': {
        // 商人成交（目前策略表还没启用，留着给钥匙补给用）
        break;
      }
      case 'travel': {
        const r = travelTo(state, data, action.floor);
        note(`TRAVEL ${action.floor} —— ${r.message}`);
        break;
      }
    }

    if (state.floor > maxFloor) {
      maxFloor = state.floor;
      note(`到达第 ${state.floor} 层（hp ${state.hp} atk ${state.atk} def ${state.def} gold ${state.gold}）`);
    }
    steps++;
  }

  return {
    cleared: isCleared(state, data),
    dead: state.dead,
    reason: stuckAt ? `卡住：${stuckAt}` : steps >= maxSteps ? `步数上限 ${maxSteps}` : '未知',
    floor: state.floor,
    maxFloor,
    steps,
    hp: state.hp,
    atk: state.atk,
    def: state.def,
    gold: state.gold,
    keys: { ...state.keys },
    kills: state.stats.kills,
    hpLost: state.stats.hpLost,
    buys,
    visited: [...state.visited],
    stuckAt,
    tail,
    trace,
    leftovers: dumpLeftovers(state, data, maxFloor)
  };
}
