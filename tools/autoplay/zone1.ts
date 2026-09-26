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
import { npcPool } from '../../src/game/dialogue';
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
    // 落脚点必须能站：地形可通行、且没有**挡路**的实体。
    // ⚠️ 道具不算挡路 —— 玩家平时就是踩着道具格捡东西的（与 travel.ts 的
    // `nearestStandable` 同一个口径）。第一版这里把道具也算成占位，于是在
    // 「牢房 4 格里 3 格放着钥匙」的第 2 层左牢房里，绕着 (3,4) 找不到落脚点，
    // 直接抛「四周没有可站的落脚点」。
    const ch = data.floors.get(floor)!.terrain[sy][sx];
    if (data.byChar[ch]?.passable !== true) continue;
    const blocker = data.floors.get(floor)!.entities.some((e) => e.x === sx && e.y === sy && e.type !== 'item');
    if (blocker) continue;
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

  // ── Z6–Z12 第 3 层伏击 → 第 2 层牢房 → 越狱（**本项目原创剧情**）──
  //
  // 这一组同时承担两个职责：
  //   ① 验剧情：走到那一格真的会被关、牢房真的关得住、暗道真的撞得开；
  //   ② 验**四个新算子**（`enterTile` / `say` / `setTerrain` / `teleport`）真的接上了 ——
  //      「数据里写了事件」与「引擎执行了」是两件事，本项目在这上面踩过一次
  //      （`docs/ui-prototype.md` §27 的 `case 'trade'` 是空实现：数据齐备、
  //      判据全绿、功能是死的）。所以下面一律走引擎**真正的**移动与换层路径。
  //
  // ⚠️ 参考源码里**没有**这条剧情（`checkEvent()` 只有 eventHappened[0..7]，
  //    `talk()` 的 case 34/35 台词是空的）。剧情骨架取自公开攻略与官方简介，
  //    出处逐条写在 data/events.json 的 evidence 里 —— 别去源码里找。
  const CELL: [number, number][] = [
    [2, 3],
    [3, 3],
    [2, 4],
    [3, 4]
  ];

  // ⚠️ 下面四个坐标**全部从事件里读**，不在这里重写一遍。
  //    第一版把它们抄成了字面量 —— 那样「判据量的是我脑子里的数」而不是
  //    「数据里的数」：别人把触发格挪到一条支路上，Z7 照样绿（失效的地图，
  //    铁律 #27），而它本该是唯一能抓住那次改动的那条。
  const AMBUSH = data.events.find((e) => e.id === 'f3-ambush-prison');
  if (!AMBUSH || AMBUSH.trigger.op !== 'enterTile') {
    throw new Error('data/events.json 里找不到 enterTile 触发的 f3-ambush-prison —— Z6–Z13 全部依赖它');
  }
  const TRAP = { floor: AMBUSH.trigger.floor, x: AMBUSH.trigger.x, y: AMBUSH.trigger.y };
  const tp = AMBUSH.effects.find((e) => e.op === 'teleport');
  const lock = AMBUSH.effects.find((e) => e.op === 'setTerrain' && e.terrain === 'D');
  const tunnel = AMBUSH.effects.find((e) => e.op === 'setTerrain' && e.terrain === 'w');
  if (!tp || tp.op !== 'teleport' || !lock || lock.op !== 'setTerrain' || !tunnel || tunnel.op !== 'setTerrain') {
    throw new Error('f3-ambush-prison 少了 teleport / setTerrain(D) / setTerrain(w) 三者之一 —— 判据无从量起');
  }
  const DROP = { floor: tp.floor, x: tp.x, y: tp.y };

  /**
   * 走一遍**玩家真正会走的路径**：第 2 层 (0,9) → 踩上楼梯 (0,10) → 第 3 层
   * (0,10) → 向右走到事件写的那个触发格。
   *
   * 刻意**不**直接调 `applyTrigger()`：那样只能证明「事件表里有这条」，
   * 证明不了「玩家走到那儿会触发」（换层与走格是两条不同的代码路径）。
   *
   * 目标格从触发条件里读（`TRAP`），所以改了数据的触发格，这条路径会跟着走 ——
   * 走到别处就意味着剧情没触发，Z6 当场红。
   *
   * `seed` 用来让**需要前置状态**的判据（Z10：先把两名中级卫兵打死、让牢门全开）
   * 复用同一条走位。第一版 Z10 自己抄了「`down` 一步 + `right` 两步」——
   * 那是**失效的地图**（铁律 #27）：探针 ⑤ 把触发格挪到 (5,10) 之后，Z10
   * 和 Z7 一起变红，可它量的是「落锁与顺序无关」，跟触发格在哪儿无关。
   */
  const walkIntoAmbush = (seed?: GameState) => {
    // ⚠️ 这条走位假设触发格在第 3 层的 row10（唯一那条横向通路）。写死坐标会失效，
    //    所以宁可在这里**响亮地拦住**：真要挪到别处，请把下面几行换成 BFS 路径。
    if (TRAP.y !== 10 || TRAP.floor !== 3) {
      throw new Error(
        `walkIntoAmbush 只支持第 3 层 row10 上的触发格，事件里写的是 (${TRAP.floor},${TRAP.x},${TRAP.y})`
      );
    }
    const s = seed ?? newGame(data);
    arriveOnFloor(s, data, 2, 0, 9);
    const up = step(s, data, 'down'); // (0,9) → (0,10)，上楼梯 → 第 3 层
    const path: string[] = [];
    let last = step(s, data, 'right');
    path.push(`${last.kind}@${s.floor}:${s.pos.x},${s.pos.y}`);
    for (let x = 1; x < TRAP.x; x++) {
      last = step(s, data, 'right');
      path.push(`${last.kind}@${s.floor}:${s.pos.x},${s.pos.y}`);
    }
    return { s, up, last, path };
  };


  // ── Z6 自动触发：走上去就被关，落点就在事件写的那一格，台词交回界面 ──
  //
  // 四个「必须一起成立」的点，缺一个这条剧情就是坏的：
  //   · 楼层真的变了（`teleport` 生效）；
  //   · 落点**就是 (2,4)**，不是被就近修正到别处（`nearestStandable` 的道具口径）；
  //   · 一句台词被交回界面（`say` 生效）—— 没有它玩家只看见画面一跳；
  //   · 台词里说了「四个彪形大汉」（过场叙述，见 events.json 的 why ②）。
  {
    const { s, up, last, path } = walkIntoAmbush();
    const inCell = CELL.some(([x, y]) => s.pos.x === x && s.pos.y === y);
    const lined = last.npc?.lines ?? [];
    const said = lined.join('');
    add(
      'Z6 第 3 层伏击：走到触发格自动被关进第 2 层牢房，落点就是事件里写的那一格，且带出红魔王台词',
      up.floorChanged === 3 && s.floor === DROP.floor &&
        s.pos.x === DROP.x && s.pos.y === DROP.y && inCell &&
        lined.length >= 4 && said.includes('四个彪形大汉'),
      `上楼 ${up.kind}→${up.floorChanged} 层 · 向右 ${path.join(' → ')} · ` +
        `最后落在 ${s.floor} 层 (${s.pos.x},${s.pos.y})（事件写的是 ${DROP.floor} 层 ${DROP.x},${DROP.y}）· ` +
        `在牢房内 ${inCell ? '✓' : '✗'} · 台词 ${lined.length} 段：${lined.map((t) => `「${t}」`).join('')}`
    );
  }

  // ── Z7 触发格是「必经格」：把它封上就上不了 4 楼 ──
  //
  // 为什么必须有这一条：`enterTile` 是**被动**触发，玩家不会为了看剧情特意去走
  // 某一格。放在一条不被经过的支路上，剧情就变成「存在但**永远不会发生**」——
  // 数据齐备、其它判据全绿、玩家一辈子没见过。而那种坏法**别的判据一条都抓不到**
  // （Z6 会自己走到那儿去，所以它照绿）。
  //
  // ⚠️ 口径 = **乐观到底**：只把「永远过不去」的地形（`#` 墙、`*` 星际空间）当阻挡，
  //    钥匙门 / 牢门 / 自动门 / 假墙 / 岩浆**全当能过**。这是对「必经」**最不利**的
  //    口径 —— 连把门全忽略掉都绕不过去，真实路径（还要钥匙）必然也绕不过去。
  //    第一版这里用了 `tiles.json` 的 `passable`，于是「黄门」也算阻挡：不封触发格
  //    时上楼梯就已经是断的（50 格可达却到不了 (10,10)）—— 那条断言红了，
  //    但红得指向错误的方向（看着像必经成立，其实是量错了口径）。
  const HARD_BLOCK = new Set(['#', '*']);
  {
    const f = data.floors.get(TRAP.floor)!;
    const flood = (blockTrap: boolean) => {
      const seen = new Set(['0,10']);
      const q: [number, number][] = [[0, 10]];
      while (q.length) {
        const [x, y] = q.shift()!;
        for (const d of Object.values(DIRS)) {
          const nx = x + d.dx;
          const ny = y + d.dy;
          if (nx < 0 || ny < 0 || nx > 10 || ny > 10) continue;
          if (blockTrap && nx === TRAP.x && ny === TRAP.y) continue;
          const k = `${nx},${ny}`;
          if (seen.has(k)) continue;
          if (HARD_BLOCK.has(f.terrain[ny][nx])) continue;
          seen.add(k);
          q.push([nx, ny]);
        }
      }
      return seen;
    };
    const open = flood(false);
    const shut = flood(true);
    // 探针（防恒真）：把触发格封掉之后可达格必须**真的**变少，否则「必经」是假的
    const shrank = shut.size < open.size;
    add(
      `Z7 触发格 (${TRAP.x},${TRAP.y}) 是必经格：封掉它之后第 ${TRAP.floor} 层的上楼梯就上不去了`,
      open.has('10,10') && !shut.has('10,10') && shrank,
      `不封 (${TRAP.x},${TRAP.y})：可达 ${open.size} 格、上楼梯 (10,10) ${open.has('10,10') ? '通' : '断'} · ` +
        `封掉后：可达 ${shut.size} 格、上楼梯 ${shut.has('10,10') ? '通' : '断'}（应 断，且可达格变少）`
    );
  }

  // ── Z8 关得住：边界只有「一扇落锁牢门 + 一面假墙」，正门撞不动 ──
  //
  // ⚠️ **不能拿 `debugReach` 量这一条。** 它按 `tiles.json` 的 `passable` 判通行，
  //    而假墙 `w` 的 `passable` 是 **true**（撞一次就能过去）⇒ 可达性图认为
  //    「从牢房里已经能走到主竖井」，断言**恒绿**。玩家并不知道那面墙是假的，
  //    所以这一条量**地形**，再用「撞一撞」的行为做交叉验证（铁律 #39：观感/规则
  //    类判据要量玩家真正会遇到的那个东西）。
  //
  // 撞门那一撞**从走廊一侧**发起（站 (5,4) 向左撞）：牢房里唯一挨着正门 (4,4) 的
  //    格子是 (3,4)，而那格站着小偷 —— 所以「从里面撞门」这件事玩家做不到，
  //    拿它当判据就等于判了一件不存在的事。
  {
    const { s } = walkIntoAmbush();
    const around = new Set<string>();
    for (const [x, y] of CELL) for (const d of Object.values(DIRS)) around.add(`${x + d.dx},${y + d.dy}`);
    for (const [x, y] of CELL) around.delete(`${x},${y}`);
    const tiles = [...around].map((k) => {
      const [x, y] = k.split(',').map(Number);
      return tileAt(s, data, 2, x, y);
    });
    const nWall = tiles.filter((c) => c === '#').length;
    const nDoor = tiles.filter((c) => c === 'D').length;
    const nFake = tiles.filter((c) => c === 'w').length;
    const nOther = tiles.length - nWall - nDoor - nFake;

    // 从 corridor 一侧撞那扇落锁的正门
    arriveOnFloor(s, data, 2, lock.x + 1, lock.y);
    const ram = step(s, data, 'left');
    add(
      'Z8 牢房真的关得住：边界 = 6 面墙 + 1 扇落锁牢门 + 1 面假墙，正门从两侧都撞不动',
      nWall === 6 && nDoor === 1 && nFake === 1 && nOther === 0 && !ram.moved &&
        tileAt(s, data, 2, lock.x, lock.y) === 'D',
      `边界 ${tiles.length} 格：墙 ${nWall} / 牢门 ${nDoor} / 假墙 ${nFake} / 其它 ${nOther}（应 6/1/1/0）· ` +
        `从走廊撞正门 (${lock.x},${lock.y})「${ram.message}」（应不移动）· 撞完还在 (${s.pos.x},${s.pos.y})`
    );
  }

  // ── Z9 出得去：撞开左墙那面假墙 → 走到 x=0 主竖井 → 上下楼都在手上 ──
  //
  // 「出得去」必须用**引擎的移动**来验，不能只看地形改没改：假墙的语义是
  // 「撞一次即变空地并走上去」（`engine/step.ts` 的 `ch === 'w'` 分支），
  // 只判 `tileAt === '.'` 的话，把 `moveOnto` 那段删掉判据照样绿。
  {
    const { s } = walkIntoAmbush();
    const m1 = step(s, data, 'left'); // 落点 → 撞假墙（小偷挖的暗道）
    const fakeGone = tileAt(s, data, 2, tunnel.x, tunnel.y) === '.';
    const m2 = step(s, data, 'left'); // 假墙 → 主竖井
    const atWell = s.pos.x === 0 && s.pos.y === tunnel.y;
    const grid = debugReach(s, data);
    // ⚠️ `debugReach()` 返回的是 `{ size, grid }`，格子要读 **`grid.grid[y][x]`**。
    //    第一版这里写成了 `grid[y][x]`（少了第二层）——而它平时**照绿**：
    //    `'·' === grid.grid[y][x] || grid[y][x] === 'S'` 左边一旦成立就短路，
    //    右边那个错的表达式永远不求值。直到探针 ② 让 (0,0) 真的不可达，
    //    短路失效、`grid[0]` 是 undefined ⇒ `TypeError: reading '0'`，
    //    整组 Z6–Z13 被这一个崩溃一起打断（≠ 报红）。铁律 #39：判据要量
    //    「玩家真正会遇到的那个东西」，所以这里一次读全两种「可达」记号 '·' / 'S'。
    const poke = (x: number, y: number) => '·S'.includes(grid.grid[y][x]);

    const down = poke(0, 0); // 下楼梯 → 第 1 层
    const up = poke(0, 10); // 上楼梯 → 第 3 层
    add(
      'Z9 越狱成功：撞开左墙的假墙（小偷挖的暗道）就走到 x=0 主竖井，上下楼梯都重新在手',
      m1.moved && fakeGone && m2.moved && atWell && down && up,
      `两次向左 ${m1.kind}/${m2.kind} · (${tunnel.x},${tunnel.y}) 现为「${tileAt(s, data, 2, tunnel.x, tunnel.y)}」（应 .）· ` +
        `落到 (${s.pos.x},${s.pos.y})（应 0,${tunnel.y}）· 可达 (0,0) 下楼梯 ${down ? '通' : '断'}、(0,10) 上楼梯 ${up ? '通' : '断'}`
    );
  }

  // ── Z10 落锁与事件顺序无关：先清过牢门再被抓，正门照样重新落锁 ──
  //
  // 为什么必须有这一条：`f2-prison-open` 是 **once** 事件，玩家完全可能**先**
  // 打完那两名中级卫兵、让 6 扇牢门全开（(4,4) 变成空地），**再**上第 3 层被抓。
  // 少了 `setTerrain` 那一步落锁，「被关」就是假的 —— 抬脚从正门走出去，
  // 而 Z6/Z8 全都照绿（它们造的局面里门本来就没开过）。
  // 这一条把那个**顺序**钉住：换一个前置条件，落锁这一条必须仍然成立。
  {
    const s = newGame(data);
    killAt(s, data, 2, 5, 1);
    killAt(s, data, 2, 7, 1);
    const openedBefore = tileAt(s, data, 2, 4, 4);
    // 走位从事件里读（`walkIntoAmbush(s)`），不在这里重抄坐标 —— 见它的注释
    walkIntoAmbush(s);
    const lockedAfter = tileAt(s, data, 2, 4, 4);
    add(
      'Z10 落锁与事件顺序无关：先清过牢门再被抓，正门照样重新落锁',
      openedBefore === '.' && lockedAfter === 'D' && s.floor === 2,
      `打两名中级卫兵后 (4,4)=「${openedBefore}」（应 . 即已被 f2-prison-open 清掉）· ` +
        `被抓后 (4,4)=「${lockedAfter}」（应 D 即被 setTerrain 重新落锁）· 现在在 ${s.floor} 层`
    );
  }

  // ── Z11 只关一次：越狱之后再走过那格，不会被关第二次 ──
  //
  // `once: true` + `state.fired` 的正面判据。没有它，「每次经过都被关」这种
  // 玩法级灾难（玩家永远上不了 4 楼）不会有任何东西报警。
  {
    const { s } = walkIntoAmbush();
    step(s, data, 'left'); // 撞开假墙
    step(s, data, 'left'); // 落到主竖井
    arriveOnFloor(s, data, TRAP.floor, TRAP.x - 1, TRAP.y); // 从第 2 层 (0,10) 再上来一次
    const again = step(s, data, 'right'); // 再次踩上触发格
    add(
      `Z11 只关一次：越狱之后再走过 (${TRAP.x},${TRAP.y}) 不会被关第二次`,
      s.floor === TRAP.floor && s.pos.x === TRAP.x && s.pos.y === TRAP.y && again.moved && !again.npc,
      `再次踩上 (${TRAP.x},${TRAP.y}) 后：${s.floor} 层 (${s.pos.x},${s.pos.y})` +
        `（应 ${TRAP.floor} 层 ${TRAP.x},${TRAP.y}）· 这一步 ${again.kind}${again.npc ? `，**又弹了台词**「${again.npc.name}」` : '、没有台词'}`
    );
  }

  // ── Z12 小偷就在那间牢房里，且「对话两次」正是两句关键信息 ──
  //
  // 原版台词与攻略：勇者「被扔到我这个房间」，小偷先说越狱、再说铁剑 5 楼/铁盾 9 楼。
  // 这里三条一起验：① 实体真的在第 2 层牢房内；② 两次搭话分别给出「暗道/越狱」与
  // 「铁剑/铁盾」；③ 撞得通（NPC 在牢房里，四周全是墙+道具，落脚点必须算上道具格）。
  {
    const ent = data.floors.get(2)!.entities.find((e) => e.type === 'npc' && e.id === 'thief');
    const inCell = !!ent && CELL.some(([x, y]) => x === ent.x && y === ent.y);
    const pool = npcPool(data, 'thief', 2);
    const first = pool[0]?.text ?? '';
    const second = pool[1]?.text ?? '';
    // ⚠️ 找不到小偷要**报红**，不能靠 `ent!.x` 崩掉：抛错会把 Z6–Z13 整组一起打断，
    //    于是「一条数据被改坏了」看起来像「八条判据都不见了」—— 而缺失的判据在报告里
    //    是**看不见**的（`--prison` 之外的调用方只遍历返回值）。同一族问法见铁律 #16
    //    （反向断言必须带探针，探针为 0 要报红不是跳过）。
    const name = 'Z12 小偷就在第 2 层牢房里，两次搭话分别给出「暗道越狱」与「铁剑 5 楼 / 铁盾 9 楼」';
    if (!ent) {
      add(name, false, `第 2 层没有任何 thief 实体 —— 他本该和勇者关在同一间牢房 ${JSON.stringify(CELL)} 里`);
    } else {
      const s = newGame(data);
      const talk = talkTo(s, data, 2, ent.x, ent.y);
      add(
        name,
        inCell && first.includes('暗道') && first.includes('越狱') &&
          second.includes('铁剑') && second.includes('铁盾') && talk.startsWith('talk'),
        `小偷在 (${ent.x},${ent.y})（在牢房内 ${inCell ? '✓' : '✗'}）· ` +
          `第 1 句「${first.slice(0, 22)}…」· 第 2 句「${second.slice(0, 22)}…」· 撞他：${talk}`
      );
    }
  }

  // ── Z13 落地即拾取：牢房那一格上放着黄钥匙，落地就该拿在手里 ──
  //
  // 这条守的是 `travel.ts` 的 `arriveOnFloor()`：「走到物品上自动拾起获得」里，
  // **落地**也算走上去。丢掉它不会报错、也不会报警 —— 只是**少一件东西**：
  // 勇者会一辈子压在那一格的钥匙上（牢房 4 格里 3 格各放着一把，落点只能落在其中之一）。
  {
    const { s } = walkIntoAmbush();
    const before = newGame(data).keys.yellowKey;
    const gone = s.removed.has(entityKey(DROP.floor, DROP.x, DROP.y, 'item', 'yellowKey'));
    add(
      'Z13 落地即拾取：被关进牢房时正落在放着黄钥匙的那一格上，钥匙要真的进包',
      s.keys.yellowKey === before + 1 && gone,
      `黄钥匙 ${before} → ${s.keys.yellowKey}（应为 ${before + 1}）· ` +
        `落点 (${DROP.x},${DROP.y}) 上的道具实体已消失 ${gone ? '✓' : '✗'}`
    );
  }

  return out;
}
