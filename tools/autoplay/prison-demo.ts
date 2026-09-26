/**
 * 「第 2 层 → 第 3 层伏击 → 被关进牢房 → 小偷的暗道越狱 → 再上来不会被关第二次」
 * 的**剧本回放**（`--prison`）。
 *
 * ## 为什么在 Z6–Z13 八条判据之外还要有它
 *
 * 判据回答的是「成不成立」（布尔）。剧情这种东西，**给玩家看的那几行字本身
 * 就是验收对象**：被关的时候听见了什么、牢房里是谁在说话、走出去之后落在哪 ——
 * 判据全绿而台词是乱的，一样是坏的，而那种坏法判据永远抓不到。
 *
 * 所以这里走一遍**玩家会走的那些步**（上楼 → 向右走到触发格 → 读台词 → 撞小偷 →
 * 向左走到主竖井 → 再上来一次），把引擎 log 与楼层图原样打出来。
 * 它是 `--prison` 的实现，不是判据的替代品：「会不会退化」由 Z 段守，
 * 「跑起来什么样」由这里看。
 *
 * ## 只有一件事写死
 *
 * 起点 `(0,9)` —— 为了让「玩家从哪儿出发」可读。触发格、暗道位置、向左走几步
 * **全部从数据/状态里读**：旁白和画面对不上就是这条回放唯一的失效方式，而写死坐标
 * 是它最容易发生的走法（第一版就是这么坏的：落点已经改成 (2,4) 之后，旁白还在说
 * 「向左一步捡走钥匙」，实际那一步撞的是假墙）。
 *
 * 要复现别的处境请改这里的参数，**不要**去改剧情数据。
 */

import { loadData } from '../../src/data';
import { newGame, step } from '../../src/game/engine';
import { arriveOnFloor } from '../../src/game/engine/travel';
import { entityAt, tileAt, type GameState } from '../../src/game/state';
import type { GameData } from '../../src/data';

/** 画一层地图（含实体），勇者画成 `@`。比 `diag.ts` 的 `dumpFloor` 小一号，够用就行 */
function mapOf(state: GameState, data: GameData, floor: number): string {
  if (!data.floors.has(floor)) return `      （第 ${floor} 层不存在）`;
  const rows: string[] = [];
  for (let y = 0; y < 11; y++) {
    let row = '';
    for (let x = 0; x < 11; x++) {
      if (state.floor === floor && state.pos.x === x && state.pos.y === y) {
        row += '@';
        continue;
      }
      const e = entityAt(state, data, floor, x, y);
      row += e ? (e.type === 'monster' ? 'M' : e.type === 'npc' ? 'N' : '*') : tileAt(state, data, floor, x, y);
    }
    rows.push(`      ${row}`);
  }
  return rows.join('\n');
}

/**
 * 一步的「人话」。
 *
 * ⚠️ `StepResult.message` 是**可选**的：只有战斗、开门、撞墙、楼梯这几类会填它，
 * `move` / `pickup` / `fakewall` 这些「顺利走掉了」的分支一律不填（`moveOnto` 只返回
 * `{ kind, moved: true }`）。直接打印会得到一串 `undefined` —— 那不是坏掉，
 * 是「这一步没有需要提示玩家的话」，下面紧跟着的 log 才是正主。
 */
function desc(r: { kind: string; message?: string }): string {
  return r.message ? `${r.kind}：${r.message}` : `${r.kind}（没有额外提示，见下面这条 log）`;
}

export function prisonDemo(): string {
  const data: GameData = loadData();
  const out: string[] = [];
  const line = (t = '') => out.push(t);

  // 触发格与暗道的位置**从事件里读**，不在旁白里写死。
  // 写死的话，改了数据这条回放就开始骗人 —— 而它的全部价值就是「原样给你看」。
  const ambush = data.events.find((e) => e.id === 'f3-ambush-prison');
  if (!ambush || ambush.trigger.op !== 'enterTile') {
    throw new Error('data/events.json 里找不到 enterTile 触发的 f3-ambush-prison');
  }
  const trapX = ambush.trigger.x;
  const trapY = ambush.trigger.y;
  const tunnel = ambush.effects.find((e) => e.op === 'setTerrain' && e.terrain === 'w');
  if (!tunnel || tunnel.op !== 'setTerrain') {
    throw new Error('f3-ambush-prison 里没有 setTerrain(w) —— 小偷挖的那条暗道不见了');
  }
  const { x: tunnelX, y: tunnelY } = tunnel;

  /** log 只留最近 60 条（`state.ts` 的 `pushLog` 会裁），所以按自增的 `seq` 取增量 */
  let lastSeq = 0;
  const flushLog = (s: GameState, indent = '        ') => {
    for (const l of s.log.filter((x) => x.seq > lastSeq)) line(`${indent}「${l.kind}」${l.text}`);
    if (s.log.length) lastSeq = s.log[s.log.length - 1].seq;
  };

  const s = newGame(data);
  arriveOnFloor(s, data, 2, 0, 9);

  line('① 第 2 层：(0,9) —— 再往下一步就是上楼梯 (0,10)');
  line(mapOf(s, data, 2));
  line('      （图例：@ 勇者　N NPC　M 怪　* 道具　D 牢门）');
  line('      到此为止的 log（开局事件）：');
  flushLog(s);
  line();

  line('② 踩上楼梯 (0,10) —— 上第 3 层（原版攻略：「02层：直接向下走，上03层」）');
  const r1 = step(s, data, 'down');
  line(`      引擎返回 ${desc(r1)}　现在在：第 ${s.floor} 层 (${s.pos.x},${s.pos.y})`);
  flushLog(s);
  line();

  line(`③ 第 3 层：从 (0,10) 一路向右走到触发格 (${trapX},${trapY}) —— 走一步打一步`);
  line('      （每步都可能是「剧情自动触发」那一刻；触发格从事件里读，不写死）');
  let r3: ReturnType<typeof step> | null = null;
  for (let x = 1; x <= trapX; x++) {
    const prevFloor = s.floor;
    const r = step(s, data, 'right');
    const now = `第 ${s.floor} 层 (${s.pos.x},${s.pos.y})`;
    line(`      第 ${x} 步 → ${desc(r)}　现在在：${now}`);
    if (r.npc || s.floor !== prevFloor) {
      line('      ↑↑ 就是这一步：人还在走，剧情自己响了');
      r3 = r;
      break;
    }
  }
  if (r3?.npc?.lines) {
    line(`      ↑ 这一步交回界面的台词（对话框会按这个逐段显示，说话人：${r3.npc.name}）——`);
    for (const [i, t] of r3.npc.lines.entries()) line(`        ${i + 1}. ${t}`);
  } else if (r3) {
    line('      ⚠️ 没有台词交回界面 —— 玩家只会看到画面一跳，没有任何交代');
  }
  line('      引擎真正做的顺序（log 增量）：');
  flushLog(s);
  line();

  line(`④ 现在在：第 ${s.floor} 层 (${s.pos.x},${s.pos.y})，hp ${s.hp}`);
  line(mapOf(s, data, 2));
  line('      牢房四格是 (2,3)(3,3)(2,4)(3,4)，四周 8 格 = 6 面墙 + 1 扇落锁牢门 (4,4) + 1 面假墙 (1,4)');
  line('      同牢房里那一位就是小偷：他被关在这儿，暗道是他挖的');
  line('      ↑ 注意上面那条「loot」：那把黄钥匙是**落地那一刻**就进包的 ——');
  line('        官方规则「走到物品上自动拾起获得」里的「走上去」包含被扔上去（travel.ts 的 pickUpAt）');
  line();

  line('⑤ 先撞小偷（就在右边）—— 他说的正是原版那两句');
  // 这里**不**再 `arriveOnFloor()` 摆位：被扔进来的落点就是现在站的地方，
  // 重摆一次只会多一条假的「进入第 2 层」log（第一版的旁白因此和画面对不上）。
  const r4 = step(s, data, 'right');
  line(`      引擎返回 ${desc(r4)}`);
  flushLog(s);
  line();
  const stayX = s.pos.x;
  const stayY = s.pos.y;

  line('⑥ 再撞一次，听第二句（铁剑 5 楼 / 铁盾 9 楼）');
  const r5 = step(s, data, 'right');
  line(`      引擎返回 ${desc(r5)}`);
  line(`      （NPC 不可踩踏：撞完人还留在 (${stayX},${stayY})）`);
  flushLog(s);
  line();

  line('⑦ 掉头向左走 —— 一直走到 x=0 那条主竖井（第一步就该撞上那面「假墙」）');
  // 走位**不写死步数**：从落点向左一直走到 x=0 为止。写死「两步」的话，
  // 换个落点旁白就开始骗人（本项目在别处踩过：铁律 #27 失效的地图比没有更坏）。
  for (let i = 1; s.pos.x > 0 && i <= 6; i++) {
    const r = step(s, data, 'left');
    line(
      `      第 ${i} 步 → ${desc(r)}` +
        (r.kind === 'fakewall' ? '　← **这就是小偷挖的暗道**：一撞即通，之后常通' : '')
    );
    flushLog(s, '        ');
  }
  line(`      现在站在 (${s.pos.x},${s.pos.y}) —— 这是第 2 层的 x=0 主竖井：`);
  line('      (0,0) 是下楼梯（回第 1 层）、(0,10) 是上楼梯（回第 3 层），两个都重新在手');
  line();

  line(`⑧ 第 2 层全景（越狱之后 —— 注意 (${tunnelX},${tunnelY}) 已经变成空地，暗道从此常通）`);
  line(mapOf(s, data, 2));
  line();

  line(`⑨ 再走过 (${trapX},${trapY}) —— **不会被关第二次**（事件是 once）`);
  arriveOnFloor(s, data, 3, trapX - 1, trapY);
  const r9 = step(s, data, 'right');
  line(`      引擎返回 ${desc(r9)}　现在在：第 ${s.floor} 层 (${s.pos.x},${s.pos.y})`);
  line('      这正是原版「以后还要经过这个地方」的那条路：过一次剧情，之后畅通');
  line();
  line(`      最终状态：血 ${s.hp} · 攻 ${s.atk} · 防 ${s.def} · 金币 ${s.gold} · 步数 ${s.stats.steps}`);
  return out.join('\n');
}
