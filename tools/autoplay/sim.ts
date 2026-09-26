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
import { buyStat, newGame, step, tradeAccept, travelTo, useItem } from '../../src/game/engine';
import { previewBattle } from '../../src/game/engine/vitals';
import { createAutoMemory, decideAutoAction, explainDecision, explainStop, isCleared, progressOf, type AutoAction, type AutoMemory, type Decision, type Rejection } from '../../src/game/autoplay';
import { tileAt } from '../../src/game/state';
import { loadWalkthrough } from './walkthrough';
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
  /**
   * 「撞了却不动」的次数。
   *
   * `sim.ts` 的 `refused` 分支原本只写日志；把它计数出来才能做成判据 ——
   * 它看起来完全不像卡住（没有报错、没有 blocked，只是原地不动），
   * 而实测 AI 曾在「拾取铁盾」前反复撞了 805 步。
   */
  refusals: number;
  /**
   * 同一个「局势」（层 / 坐标 / 血 / 钥匙 / 金币 / 进展）最多被碰到过几次。
   *
   * ★ 它守的是一种**旧探针完全看不见**的死法：**交替两步**的循环
   *   （上楼 → 下楼 → 上楼 …）。那种循环里 `refusals` 是 0（每一步都合法）、
   *   `stuckAt` 是 null（没有连续重复的同一个动作），于是报告只写一句
   *   「步数上限」——看起来像「AI 只是慢」。实测 2026-09-26 那一轮：
   *   20000 步里 **19605 步**是这种横跳（`trace` 里全是上楼/下楼）。
   */
  maxCycle: number;
  /**
   * 局势循环的现场（`层:坐标:hp…:进展`），没触发就是 null。
   *
   * ⚠️ 刻意与 `stuckAt` **分开两个字段**：`stuckAt` 守的是「原地撞不动」
   * （连续同一动作），它是一条**回归**判据；局势循环是「一直在动但什么都没变」，
   * 属于还没做完的**目标**。合成一个字段的话，目标没达成会把回归判据一起染红，
   * 于是「做坏了」与「还没做完」又混在一起 —— 正是铁律 #44 要避免的事。
   */
  deadlock: string | null;
  /**
   * **停下那一刻，决策器到底看到了什么。**
   *
   * `explainStop()` 回答的是「现场长什么样」（可达几格、楼梯要不要钥匙、哪只怪打不动），
   * 而它回答不了「这些东西在决策器的**六段闸门**里各自被挡在哪一关」。
   * 2026-09-26 追「同一局势重复 31 次」那条红判据时，只能靠
   * `--scores` + `--reach` + `--verbose` 三样手工反推，代价很高、结论还不敢打包票
   * （`--reach` 走的是 `planner.reach`，贪心走的是另一份 `autoplay.reach`）。
   *
   * 现在每次非正常结束时自动带一份 —— 与当时**同一个 state、同一份 mem**，
   * 所以它就是那一瞬间的真实账本，不是事后复现。
   */
  why: Decision | null;
  /**
   * 整局累计：「哪一段的哪一类闸门」一共挡掉了多少次（降序）。
   *
   * ⚠️ 与 `why` 是两件事，别合并：`why` 是**那一刻**的账，`whyTally` 是**整局**的账。
   * 只看快照会得出「卡在 F4」这种表层结论；只看累计会不知道最后一步长什么样。
   */
  whyTally: RejectTally[];
  /** 首次到达每层时的三围 —— 进度基准（walkthrough 的 checkpoints）靠它比对 */
  firstReach: Record<number, { hp: number; atk: number; def: number; gold: number }>;
  /** 里程碑取得情况（清单来自 data/walkthrough.json） */
  milestones: { id: string; name: string; floor: number; taken: boolean; takenAtFloor: number | null }[];
  /** 没达到的进度基准（空数组 = 全达到） */
  checkpointFails: string[];
  /** 商人成交次数 */
  trades: number;
  /**
   * **第一个 BOSS**（第 10 层骷髅队长）是否已被击败。
   *
   * 单列出来是因为用户把范围划到了这里（「先以第一个 BOSS 前为基准」）——
   * 它是「一区能不能出去」的同义词：击败它才触发 f10-zone1-clear 生成 10→11 的楼梯。
   */
  firstBossDefeated: boolean;
}

/**
 * 整局里「某一类被挡掉」一共出现过多少次。
 *
 * 为什么需要一个**累计**统计而不只是停下那一刻的快照：停下那一刻只说明
 * 「最后一步为什么走不动」，而真正要回答的是「这 5000 步到底被什么挡着」。
 * 实测 2026-09-26 那一局：快照显示 F4 的道具/怪全被 `代价 > 20` 挡住（对），
 * 累计统计则指出 **② 道具·cost 占了绝大多数**，一眼就锁定 `spendCap`
 * 是那一轮的元凶 —— 而这一步当时是靠人工反推出来的。
 */
export interface RejectTally {
  stage: string;
  kind: string;
  count: number;
  /** 一条样例（最后一次被挡时的候选与原因）—— 光看计数不知道这一类长什么样 */
  sampleWhat: string;
  sampleWhy: string;
}

/** 累计表 → 按次数降序的数组（报告只打前几条） */
function dumpTally(t: Map<string, RejectTally>): RejectTally[] {
  return [...t.values()].sort((a, b) => b.count - a.count);
}

function tallyInto(t: Map<string, RejectTally>, rej: Rejection[]): void {
  for (const x of rej) {
    const key = `${x.stage}‖${x.kind}`;
    const hit = t.get(key);
    if (hit) {
      hit.count++;
      hit.sampleWhat = x.what;
      hit.sampleWhy = x.why;
    } else {
      t.set(key, { stage: x.stage, kind: x.kind, count: 1, sampleWhat: x.what, sampleWhy: x.why });
    }
  }
}

/** 某个怪是否已被击败（扫 `removed` 的 key，与 `isCleared` 同一口径） */
function defeated(state: GameState, id: string): boolean {
  for (const k of state.removed) if (k.endsWith(`:monster:${id}`)) return true;
  return false;
}

/**
 * 里程碑与进度基准的报告。
 *
 * 「在哪一层拿到的」直接从 `removed` 的 key（`floor:x:y:item:id`）里读回来 ——
 * 不去运行时另记一份，避免「记录与实际状态两套账」。
 */
function reportProgress(state: GameState, wt: ReturnType<typeof loadWalkthrough>, firstReach: SimReport['firstReach']) {
  const milestones = wt.milestones.map((m) => {
    let takenAtFloor: number | null = null;
    for (const k of state.removed) {
      if (k.endsWith(`:item:${m.id}`)) {
        takenAtFloor = Number(k.split(':')[0]);
        break;
      }
    }
    return { id: m.id, name: m.name, floor: m.floor, taken: takenAtFloor !== null, takenAtFloor };
  });

  const checkpointFails: string[] = [];
  for (const cp of wt.checkpoints ?? []) {
    const st = firstReach[cp.floor];
    if (!st) {
      checkpointFails.push(`第 ${cp.floor} 层：从未到达（基准 生命${cp.hp ?? '-'}/攻${cp.atk ?? '-'}/防${cp.def ?? '-'}）`);
      continue;
    }
    const bad: string[] = [];
    if (cp.hp !== undefined && st.hp < cp.hp) bad.push(`生命 ${st.hp} < ${cp.hp}`);
    if (cp.atk !== undefined && st.atk < cp.atk) bad.push(`攻击 ${st.atk} < ${cp.atk}`);
    if (cp.def !== undefined && st.def < cp.def) bad.push(`防御 ${st.def} < ${cp.def}`);
    if (bad.length) checkpointFails.push(`第 ${cp.floor} 层：${bad.join('、')}`);
  }
  return { milestones, checkpointFails };
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

/**
 * 同一个「局势」最多允许重复几次 —— 超过就判「走投无路」并停下。
 *
 * ⚠️ 判据必须是**局势**（层 + 坐标 + 血 + 钥匙 + 金币 + 进展），不是动作：
 * 交替的循环（上楼 → 下楼 → 上楼）没有连续重复的动作，只看动作的探针
 * 一条也抓不到（见 `SimReport.maxCycle`）。
 *
 * 取 30 是因为健康的一局里「同一局势反复出现」最多也就十几次
 * （来回取钥匙、上下楼补货、从商店走回楼梯），量级差得开。
 */
const CYCLE_LIMIT = 30;

export function simulate(maxSteps = 40000, verbose = false): SimReport {  const data: GameData = loadData();
  const wt = loadWalkthrough();
  const state: GameState = newGame(data);

  let steps = 0;
  let buys = 0;
  let trades = 0;
  let refusals = 0;
  const mem: AutoMemory = createAutoMemory();
  let maxFloor = state.floor;
  let stuckAt: string | null = null;
  /**
   * 局势循环现场（见 `SimReport.deadlock`）。与 `stuckAt` 分开：前者是「一直在动
   * 但什么都没变」，后者是「原地撞不动」—— 一个是目标、一个是回归判据。
   */
  let deadlock: string | null = null;
  const tail: string[] = [];
  const trace: string[] = [];
  /** 局势 → 被碰到的次数（循环探针，见 `SimReport.maxCycle`） */
  const cycleSeen = new Map<string, number>();
  let maxCycle = 0;
  let lastSig = '';
  let runLen = 0;
  /**
   * 停下那一刻的决策交代（见 `SimReport.why`）。每一步都刷新，
   * 于是循环里的 stop / deadlock / stuck 三个出口拿到的都是**那一瞬间**的账。
   */
  let why: Decision | null = null;
  /** 整局累计（见 `SimReport.whyTally`） */
  const whyTally = new Map<string, RejectTally>();
  /** 首次到达每层时的三围（进度基准比对用） */
  const firstReach: SimReport['firstReach'] = {
    [state.floor]: { hp: state.hp, atk: state.atk, def: state.def, gold: state.gold }
  };

  const progress = () => reportProgress(state, wt, firstReach);

  const note = (s: string) => {
    tail.push(s);
    if (tail.length > 24) tail.shift();
    if (verbose) console.log(`  [${steps}] ${s}`);
  };

  while (steps < maxSteps) {
    //
    // ⚠️ 每一步都走 `explainDecision()`（而不是 `decideAutoAction()`）：两者是**同一段代码**，
    //    区别只是前者顺手记下「被哪一关挡掉」。分成两处调用的话，
    //    「诊断说的」与「实际做的」迟早分叉，而两边各自都对得上自己的期望值（铁律 #23）。
    const dec = explainDecision(state, data, mem);
    const action: AutoAction = dec.action;
    why = dec;
    tallyInto(whyTally, dec.rejected);
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
        leftovers: dumpLeftovers(state, data, maxFloor),
        refusals,
        maxCycle,
        deadlock,
        why,
        whyTally: dumpTally(whyTally),
        firstReach,
        ...progress(),
        trades,
        firstBossDefeated: defeated(state, 'skeletonCaptain')
      };
    }

    // 死循环探针：同一个「位置 + 楼层 + 动作」反复出现说明决策卡住了。
    // 没有它，卡住会表现成「跑满 maxSteps 然后说步数超了」，看不出是策略问题还是步数给少了。
    //
    // ★ 局势循环探针（2026-09-26 新增）：同一个**局势**反复出现说明这一局已经死了，
    //   而 `sig` 那条只认「连续同一动作 ×12」，抓不到**交替两步**的循环。
    //   实测 20000 步里 19605 步是「上楼↔下楼」横跳：动作没有连续重复、
    //   每一步都合法（refusals 0），报告只说「步数上限」——像「AI 只是慢」。
    const situation =
      `${state.floor}:${state.pos.x},${state.pos.y}:hp${state.hp}:` +
      `k${state.keys.yellowKey},${state.keys.blueKey},${state.keys.redKey}:` +
      `g${state.gold}:p${progressOf(state)}`;
    const seenTimes = (cycleSeen.get(situation) ?? 0) + 1;
    cycleSeen.set(situation, seenTimes);
    if (seenTimes > maxCycle) maxCycle = seenTimes;
    if (seenTimes > CYCLE_LIMIT) {
      deadlock = `${situation}（重复 ${seenTimes} 次）`;
      note(`LOOP: 局势循环 —— ${deadlock}`);
      for (const line of explainStop(state, data)) note(line);
      break;
    }
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
        if (refused) {
          refusals++;
          note(`REFUSED ${before} → ${action.dir}：${res.message}（目标：${action.goal}）`);
        }
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
        // 商人成交。`index` 来自决策器最近一次 `merchantOffers()` 的报价，
        // 而 `tradeAccept` 会**重新算一遍报价**再按 index 找 —— 所以两边必须
        // 在同一层、同一状态下调用（决策与执行之间没有别的动作改过 state）。
        const r = tradeAccept(state, data, state.floor, action.index);
        if (r.ok) trades++;
        note(r.ok ? `TRADE #${action.index} —— ${r.message}` : `TRADE 失败 #${action.index} —— ${r.message}`);
        break;
      }
      case 'travel': {
        const r = travelTo(state, data, action.floor);
        note(`TRAVEL ${action.floor} —— ${r.message}`);
        break;
      }
    }

    // 首次到达某层时记下三围（进度基准要比的是**刚到时**的实力，不是最终值）
    if (!firstReach[state.floor]) {
      firstReach[state.floor] = { hp: state.hp, atk: state.atk, def: state.def, gold: state.gold };
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
    reason: deadlock
      ? `走投无路：局势循环（${deadlock}）`
      : stuckAt
        ? `卡住：${stuckAt}`
        : steps >= maxSteps
          ? `步数上限 ${maxSteps}`
          : '未知',
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
    leftovers: dumpLeftovers(state, data, maxFloor),
    refusals,
    maxCycle,
    deadlock,
    why,
    whyTally: dumpTally(whyTally),
    firstReach,
    ...progress(),
    trades,
    firstBossDefeated: defeated(state, 'skeletonCaptain')
  };
}
