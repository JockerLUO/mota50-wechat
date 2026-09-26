/**
 * 一区（1–10 层）事件的 headless 断言。
 *
 * ## 为什么必须有这一套
 *
 * 「数据里写了事件」和「引擎真的执行了」是两件事。本项目刚好在这上面踩过一次
 * （`docs/ui-prototype.md` §27 的 `case 'trade'` 是空实现）—— 数据齐备、判据全绿、
 * 功能是死的。所以一区这几条事件补完之后，必须有一条**从头走一遍**的断言：
 * 真的去击败那两只中级卫兵、真的去搭话，然后看属性与地形变没变。
 *
 * ## 断言口径
 *
 * 每条都给自己造前置（走位、击杀），不依赖别条的副作用 —— 除了「只触发一次」
 * 那条**故意**要复用同一次搭话（它要验的正是重复搭话不再加）。
 */

import { loadData } from '../../src/data';
import { newGame, step } from '../../src/game/engine';
import { applyTrigger } from '../../src/game/engine/events';
import { debugReach } from '../../src/game/planner';
import { arriveOnFloor } from '../../src/game/engine/travel';
import { DIRS, entityKey, tileAt } from '../../src/game/state';
import type { GameData, GameState } from '../../src/data';

export interface Zone1Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** 把某格的怪标记为「已击败」，并补上引擎在战斗结束后会发的两个信号 */
function killAt(state: GameState, data: GameData, floor: number, x: number, y: number): void {
  const ent = data.floors.get(floor)?.entities.find((e) => e.x === x && e.y === y && e.type === 'monster');
  if (!ent) throw new Error(`第 ${floor} 层 (${x},${y}) 没有怪可杀`);
  state.removed.add(entityKey(floor, x, y, 'monster', ent.id));
  // 与 `step.ts` 战斗结束后同规：先 defeated，再 allDefeated
  applyTrigger(state, data, { op: 'defeated', id: ent.id });
  applyTrigger(state, data, { op: 'allDefeated' });
}

/** 站到 (x,y) 的相邻格并撞上去搭话 —— 走的是引擎真正的搭话路径，不是绕过它直接发信号 */
function talkTo(state: GameState, data: GameData, floor: number, x: number, y: number): string {
  const dirs = Object.entries(DIRS) as [
    'up' | 'down' | 'left' | 'right',
    { dx: number; dy: number }
  ][];
  for (const [dir, v] of dirs) {
    const sx = x - v.dx;
    const sy = y - v.dy;
    if (sx < 0 || sy < 0 || sx > 10 || sy > 10) continue;
    // 落脚点必须能站：地形可通行、且没有别的实体
    const ch = data.floors.get(floor)!.terrain[sy][sx];
    if (data.byChar[ch]?.passable !== true) continue;
    const occupied = data.floors.get(floor)!.entities.some((e) => e.x === sx && e.y === sy);
    if (occupied) continue;
    arriveOnFloor(state, data, floor, sx, sy);
    const res = step(state, data, dir);
    return `${res.kind}:${res.message}`;
  }
  throw new Error(`第 ${floor} 层 (${x},${y}) 四周没有可站的落脚点`);
}

export function zone1Verifications(): Zone1Check[] {
  const data: GameData = loadData();
  const out: Zone1Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });

  // ── Z1 第 2 层监牢：6 扇牢门是 6 个藏宝口袋的唯一入口 ──
  //
  // ⚠️ 量可达性必须**站在中间脊骨上**（第 2 层从入口 (0,0) 出发先被蓝门 (2,0) 挡住，
  // 牢门在更里面）。第一版站在 (0,0) 量，于是「开门前后都是 13 格」——
  // 断言红了，但红得指向错误的方向（看着像事件没生效，其实是量错了地方）。
  {
    const s = newGame(data);
    arriveOnFloor(s, data, 2, 6, 1); // 中间脊骨（蓝门之后）
    const beforeGrid = debugReach(s, data);
    const poke = (g: string[], x: number, y: number) => g[y][x] === '·' || g[y][x] === 'S';
    // 三个左侧口袋各一格 + 右侧智者
    const probes: [number, number, string][] = [
      [2, 3, '左·黄钥匙'],
      [2, 6, '左·蓝宝石'],
      [2, 9, '左·蓝药水'],
      [10, 3, '右·智者']
    ];
    const beforeReach = probes.map(([x, y]) => poke(beforeGrid.grid, x, y));

    killAt(s, data, 2, 5, 1);
    killAt(s, data, 2, 7, 1);
    const afterGrid = debugReach(s, data);
    const afterReach = probes.map(([x, y]) => poke(afterGrid.grid, x, y));

    const doors = [
      [4, 4], [8, 4], [4, 7], [8, 7], [4, 10], [8, 10]
    ].map(([x, y]) => tileAt(s, data, 2, x, y));
    const doorsOpen = doors.every((c) => c === '.');
    const wasSealed = beforeReach.every((v) => !v);
    const nowOpen = afterReach.every((v) => v);

    add(
      'Z1 第 2 层监牢：击败两名中级卫兵后 6 扇牢门全开，6 个藏宝口袋全部可达',
      doorsOpen && wasSealed && nowOpen && afterGrid.size > beforeGrid.size,
      `牢门 ${doors.join('')}（应 ......）· 可达 ${beforeGrid.size} → ${afterGrid.size} 格 · ` +
        `探针 ${probes.map(([, , n], i) => `${n} ${beforeReach[i] ? '通' : '断'}→${afterReach[i] ? '通' : '断'}`).join(' ')}`
    );
  }

  // ── Z2 第 2 层 (10,3) 智者：攻防各 +10%；同层 (10,9) 智者**不**加 ──
  {
    const s = newGame(data);
    // 先把智力老人能走到的入口打开（牢门关着就到不了 (9,3)）
    killAt(s, data, 2, 5, 1);
    killAt(s, data, 2, 7, 1);
    const a0 = s.atk;
    const d0 = s.def;
    talkTo(s, data, 2, 10, 3);
    const a1 = s.atk;
    const d1 = s.def;
    const expectA = Math.floor(a0 * 1.1);
    const expectD = Math.floor(d0 * 1.1);
    const buffed = a1 === expectA && d1 === expectD;

    // 另一个智者 (10,9)：不该再动属性
    talkTo(s, data, 2, 10, 9);
    const unchanged = s.atk === a1 && s.def === d1;
    add(
      'Z2 第 2 层智者：只有 (10,3) 给攻防各 +10%，同层 (10,9) 不加',
      buffed && unchanged,
      `攻 ${a0}→${a1}（应 ${expectA}）· 防 ${d0}→${d1}（应 ${expectD}）· 搭话 (10,9) 后 ${s.atk}/${s.def}${unchanged ? '（未变）' : '（**变了**）'}`
    );
  }

  // ── Z3 一次性：再搭一次话不会再加 10% ──
  {
    const s = newGame(data);
    killAt(s, data, 2, 5, 1);
    killAt(s, data, 2, 7, 1);
    talkTo(s, data, 2, 10, 3);
    const a1 = s.atk;
    talkTo(s, data, 2, 10, 3);
    talkTo(s, data, 2, 10, 3);
    add(
      'Z3 一次性事件：重复搭话（×2）不再叠加 +10%',
      s.atk === a1,
      `第一次后攻 ${a1}，再搭两次后攻 ${s.atk}`
    );
  }

  // ── Z4 第 3 层智者：送怪物书 ──
  {
    const s = newGame(data);
    const before = s.bag.monsterBook ?? 0;
    talkTo(s, data, 3, 10, 3);
    const after = s.bag.monsterBook ?? 0;
    add(
      'Z4 第 3 层智者：赠送怪物书 ×1（且只送一次）',
      before === 0 && after === 1,
      `monsterBook ${before} → ${after}`
    );
  }

  // ── Z5 第 8 层自动门：击败两名初级卫兵后 (9,3) 开启 ──
  {
    const s = newGame(data);
    const before = tileAt(s, data, 8, 9, 3);
    killAt(s, data, 8, 8, 4);
    killAt(s, data, 8, 10, 4);
    const after = tileAt(s, data, 8, 9, 3);
    add(
      'Z5 第 8 层自动门：击败两名初级卫兵后 (9,3) 由自动门变空地',
      before === 'a' && after === '.',
      `(9,3) ${before} → ${after}（应为 a → .）`
    );
  }

  return out;
}
