/**
 * 评分系统的 headless 断言 —— 逐条对应用户 2026-09-26 的口径。
 *
 * 这些性质**必须**被机器检查，理由是它们全是「看起来对」的那类约定：
 * 分数是个数，写错了不会抛异常，只会让 AI 做出没人看得懂的选择。
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadData } from '../../src/data';
import { newGame } from '../../src/game/engine';
import { arriveOnFloor } from '../../src/game/engine/travel';
import { DIRS, entityKey, tileAt } from '../../src/game/state';
import {
  BLOCK_BONUS,
  CATEGORY_ORDER,
  NO_THREAT_SCORE,
  THRESHOLD,
  UNREACHABLE_SCORE,
  blockingMonsters,
  gateMonsters,
  itemScore,
  monsterScore,
  npcScore,
  rawItemWorth
} from '../../src/game/score';
import { debugTargets } from '../../src/game/planner';
import type { GameData, GameState } from '../../src/data';
import type { Zone1Check } from './zone1';

export function scoreVerifications(): Zone1Check[] {
  const data: GameData = loadData();
  const out: Zone1Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });

  /** 站在 (x,y) 的相邻格，返回一个「能站」的位置（用来构造特定局面） */
  const standNear = (s: GameState, floor: number, x: number, y: number) => {
    for (const [dir, v] of Object.entries(DIRS) as ['up' | 'down' | 'left' | 'right', { dx: number; dy: number }][]) {
      const sx = x - v.dx;
      const sy = y - v.dy;
      if (sx < 0 || sy < 0 || sx > 10 || sy > 10) continue;
      if (data.byChar[data.floors.get(floor)!.terrain[sy][sx]]?.passable !== true) continue;
      if (data.floors.get(floor)!.entities.some((e) => e.x === sx && e.y === sy)) continue;
      arriveOnFloor(s, data, floor, sx, sy);
      void dir;
      return true;
    }
    return false;
  };

  // ── S1 三类刻度**不通用**：三套门槛、四类次序，且各自响应各自的输入 ──
  {
    const s = newGame(data);
    const keysOk = ['item', 'monster', 'npc'].every((k) => typeof THRESHOLD[k] === 'number');
    const orderOk = CATEGORY_ORDER.length === 4 && CATEGORY_ORDER.includes('stairs');
    // 同一状态下三类分数各自算得出来（不是「一个函数换个名字」）
    const it = itemScore(s, data, { itemId: 'redGem', costHp: 0 });
    const mo = monsterScore(s, data, 'greenSlime');
    const np = npcScore(s, data, 'sage', 1);
    const categories = [it.category, mo.category, np.category].join(',');
    add(
      'S1 三类分数不通用：三套门槛、四类次序，且各自带类别标记',
      keysOk && orderOk && categories === 'item,monster,npc',
      `门槛 ${JSON.stringify(THRESHOLD)}｜次序 ${CATEGORY_ORDER.join('>')}｜类别 ${categories}`
    );
  }

  // ── S2 不掉血的怪 ⇒ 分数**为负**（用户明确要求） ──
  {
    const s = newGame(data);
    // 把防御堆到史莱姆打不动：绿史莱姆 atk 18
    s.def = 999;
    const sc = monsterScore(s, data, 'greenSlime');
    const hasNoThreatPart = sc.parts.some((p) => p.value === NO_THREAT_SCORE);
    add(
      'S2 不掉血的怪：分数为负（硬保证，不被金币收益顶成正数）',
      sc.total < 0 && hasNoThreatPart,
      `绿史莱姆（def 999 时）总分 ${sc.total}｜${sc.parts.map((p) => `${p.label} ${Math.round(p.value)}`).join(' · ')}`
    );
  }

  // ── S3 打不动 ⇒ 极负 ──
  {
    const s = newGame(data);
    s.atk = 1;
    const sc = monsterScore(s, data, 'skeletonCaptain');
    add(
      'S3 打不动的怪：分数极负（不可选）',
      sc.total <= UNREACHABLE_SCORE,
      `骷髅队长（atk 1 时）总分 ${sc.total}`
    );
  }

  // ── S4 守护：怪分**上升**、道具分**下降**，且转移的是同一份价值 ──
  {
    const s = newGame(data);
    // 大乌贼 def 高，基础三围下「打不动」—— 那样两组分数都是 -1e9，比不出差别。
    // 把三围拉到能打，才是在比较「守护加成」这一项本身。
    s.atk = 300;
    s.def = 400;
    s.hp = 9999;
    const bare = monsterScore(s, data, 'kraken');
    const guarding = monsterScore(s, data, 'kraken', { guards: 'shovel' });
    const itemFree = itemScore(s, data, { itemId: 'shovel', costHp: 0, guarded: false });
    const itemGuarded = itemScore(s, data, { itemId: 'shovel', costHp: 0, guarded: true });
    const moved = guarding.total - bare.total;
    const cut = itemFree.total - itemGuarded.total;
    add(
      'S4 守护道具：怪分上升、道具分下降，且两边转移的是同一份价值',
      moved > 0 && cut > 0 && Math.abs(moved - cut) < 1,
      `怪 ${bare.total.toFixed(0)} → ${guarding.total.toFixed(0)}（+${moved.toFixed(0)}）· ` +
        `道具 ${itemFree.total.toFixed(0)} → ${itemGuarded.total.toFixed(0)}（−${cut.toFixed(0)}）`
    );
  }

  // ── S5 挡路：判据只能标「杀掉它就能通」的怪，不能把整层都标进来 ──
  //
  // ⚠️ 这条是**回归判据**：第一版判据是「不战斗时到不了上楼梯 + 贴在可达边界上」，
  // 第 1 层 11 只怪全被标成挡路、各拿 +2500 ⇒ 「绕过可跳过的怪」变成「清光整层」。
  {
    const s = newGame(data);
    arriveOnFloor(s, data, 1, 5, 10);
    const blocked = blockingMonsters(s, data, 1);
    const all = (data.floors.get(1)?.entities ?? []).filter((e) => e.type === 'monster').length;
    // 第 1 层的上楼梯 (0,0) 是被墙与门挡住的，不是被某一只怪堵住的 ⇒ 集合必须为空
    add(
      'S5 挡路：只标「杀掉它上楼梯就通」的怪（第 1 层不该有任何一只）',
      blocked.size === 0,
      `第 1 层怪 ${all} 只，判为挡路 ${blocked.size} 只${blocked.size ? `（${[...blocked].join(' ')}）` : ''}`
    );
  }

  // ── S5b 挡路：真正堵住上楼梯的那只怪，必须被判出来 ──
  {
    const s = newGame(data);
    // 第 10 层：把中央脊骨清空、只留 (5,3) 的骷髅队长；它正堵在通往上层区的必经格上
    // （第 10 层的上楼梯由事件生成，这里用「本层上楼梯不存在 ⇒ 集合为空」的反面来做：
    //   改用一个有静态上楼梯、且出口单一的楼层 —— 第 9 层落点口袋）
    arriveOnFloor(s, data, 9, 5, 0);
    const blocked = blockingMonsters(s, data, 9);
    // 第 9 层落点四周全是门（不是怪），所以也应为空 —— 这条验的是「门不算怪挡路」
    add(
      'S5b 挡路：被**门**围住的落点不产生「挡路怪」（门不是怪）',
      blocked.size === 0,
      `第 9 层落点口袋判为挡路 ${blocked.size} 只`
    );
  }

  // ── S6 商店分随金币单调，且买不起一定是负分 ──
  {
    const s = newGame(data);
    arriveOnFloor(s, data, 4, 4, 0);
    s.gold = 0;
    const poor = npcScore(s, data, 'shop', 4);
    s.gold = 1000;
    const rich = npcScore(s, data, 'shop', 4);
    add(
      'S6 商店分：随所持金币单调上升，且买不起时为负',
      poor.total < 0 && rich.total > poor.total,
      `金币 0 → ${poor.total}（应 <0）· 金币 1000 → ${rich.total}（应更高）`
    );
  }

  // ── S7 分数随属性变化：攻击越过门槛时，道具分必须有跳变 ──
  {
    const s = newGame(data);
    // 骷髅士兵 def 12：atk 11 时打不动，atk 12 时可打
    s.atk = 11;
    const before = rawItemWorth(s, data, 'redGem');
    s.atk = 30;
    const after = rawItemWorth(s, data, 'redGem');
    add(
      'S7 分数随角色属性变化：同一件道具在不同三围下分值不同（不是固定价目表）',
      before !== after,
      `红宝石面值：atk11 → ${Math.round(before)}；atk30 → ${Math.round(after)}`
    );
  }

  // ── S8 机动类道具都必须有价值（迁移时最容易整档丢掉的一类） ──
  //
  // ⚠️ 这条守的是一个**真实的迁移事故**（2026-09-27）：把第一代估价
  // （`autoplay.itemHpValue`）统一到 `score.effectValue` 时只搬了
  // `openFloorSelect`（楼层传送器），漏掉 `changeFloor`（上/下飞行器）与
  // `teleportSymmetric`（镜像飞行器）—— 它们掉进 `default` 分支、价值恒为 **0**。
  // 不报错、不报警，只是 AI 从此不再专程去拿飞行器；而「这一区打不动 →
  // 回低层补强再回来」是分层贪心第 ④ 步的命脉，全靠这类道具。
  // 数据里三件都在（`upFlyer` / `downFlyer` / `mirrorFlyer`），所以这是**掉功能**。
  {
    const s = newGame(data);
    const tp = rawItemWorth(s, data, 'floorTeleporter');
    const up = rawItemWorth(s, data, 'upFlyer');
    const down = rawItemWorth(s, data, 'downFlyer');
    const mirror = rawItemWorth(s, data, 'mirrorFlyer');
    add(
      'S8 机动类道具都有价值：传送器 ≥ 上/下飞行器 > 镜像（漏一条就退化成 0 分）',
      tp > 0 && up > 0 && down > 0 && mirror > 0 && tp >= up && up >= mirror,
      `传送器 ${Math.round(tp)} · 上飞 ${Math.round(up)} · 下飞 ${Math.round(down)} · 镜像 ${Math.round(mirror)}`
    );
  }

  // ── S9 守门怪名单**从事件表反推**，不是手写 ──
  //
  // 与 `blockingMonsters`（几何口径）不是一回事：守门怪挡的是**事件**。
  // 第 8 层那两只初级卫兵就不在通往楼梯的几何路径上，却挡着红钥匙。
  // 名单手写的必然结局是「加了新事件忘了加名字」，而那不会报错（铁律 #23）。
  {
    const gates = gateMonsters(data);
    const expect = new Set<string>();
    for (const ev of data.events) {
      if (ev.trigger.op === 'defeated') expect.add(ev.trigger.id);
      else if (ev.trigger.op === 'allDefeated') for (const id of ev.trigger.ids) expect.add(id);
    }
    for (const [id, m] of Object.entries(data.monsters)) if (m.boss) expect.add(id);
    const same = gates.size === expect.size && [...expect].every((id) => gates.has(id));
    add(
      'S9 守门怪名单从 data/events 反推（含所有 BOSS；第 8 层 juniorGuard 必须在）',
      same && expect.size > 0 && gates.has('juniorGuard'),
      `${gates.size} 只｜juniorGuard ${gates.has('juniorGuard') ? '在' : '不在'}｜` +
        `${[...gates].slice(0, 5).join('、')}${gates.size > 5 ? '…' : ''}`
    );
  }

  // ── S10 估价**只有一份**（架构约束，只能静态读源码） ──
  //
  // ⚠️ 2026-09-27 之前，`planner.ts` import 的是 `autoplay` 的**第一代估价**
  // （`statPrices` / `itemHpValue` / 重名 `keyValue` / `guardsItem`），而贪心走
  // `score.ts` —— 两套刻度同时在跑，`keyValue` 有两个定义（改一边不红）。
  // 动态判据测不出「以后又写了第二份」，所以这条**必须**读源码。
  //
  // ⚠️ 读不到文件要**报红而不是跳过**（铁律 #16）：路径一变就静默恒绿的判据
  // 比没有更坏。`cwd` 在 npm script 里是仓库根。
  {
    const root = process.cwd();
    const read = (p: string) => {
      try {
        return fs.readFileSync(path.join(root, p), 'utf8');
      } catch {
        return null;
      }
    };
    const plannerSrc = read('src/game/planner.ts');
    const autoplaySrc = read('src/game/autoplay.ts');
    const readable = plannerSrc !== null && autoplaySrc !== null;
    //
    // ⚠️ **先剥注释再匹配**。文件里**允许**在注释中提到这些名字（那里写着迁移
    // 说明与「别再往这个文件里加估价」的告诫），全文匹配会被自己的注释判红
    // —— 那种红指向完全错误的方向。
    //
    // 剥完注释仍然匹配 ⇒ 真的又写了一份实现（复制粘贴 / 重新定义），这才该红。
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
    const legacy = /statPrices|itemHpValue|guardsItem/;
    const cleanPlanner = !!plannerSrc && !legacy.test(stripComments(plannerSrc));
    // autoplay 那边同理：只看「还在不在导出」
    const cleanAutoplay =
      !!autoplaySrc && !/export function (statPrices|itemHpValue|guardsItem)\b/.test(autoplaySrc);
    add(
      'S10 估价只有一份：planner 里不再有第一代估价（剥掉注释后仍匹配才算红）',
      readable && cleanPlanner && cleanAutoplay,
      `源码可读 ${readable ? '✓' : `✗（cwd=${root}）`}｜planner 干净 ${cleanPlanner ? '✓' : '✗'}｜` +
        `autoplay 不再导出 ${cleanAutoplay ? '✓' : '✗'}`
    );
  }

  // ── S11 目标排序按**类别**（统一到一套刻度在排序上的落点） ──
  //
  // 三个 `gain` 量纲不同（血当量 / 优先级 / 金币余量），直接比大小就是偷偷
  // 把它们当成同一个刻度用。所以排序必须先看 `CATEGORY_ORDER`、同类内才比 gain
  // —— 与贪心的目标排序同一张表。
  {
    //
    // ⚠️ 局面必须**同时**满足两件事，否则这条判据是空转的（铁律 #12 / #49）：
    //   ① 目标**多于一类的**（才谈得上跨类次序）；
    //   ② 存在一个 `gain` 大到能越过所有 item 的 **up 楼梯**（启发式给 10000）——
    //      退回「只比 gain」时它会冲到最前，次序才**真的**被违反。
    //
    // 第 3 层只有 down 楼梯（gain −1000，本来就该排最后）⇒ 两种排序结果**相同**、
    // 判据看不出差别。这是实测出来的：探针把排序改回「只比 gain」，S11 照样绿。
    // 所以用第 6 层（有 up 楼梯 + 道具 + 怪）。
    const s = newGame(data);
    s.atk = 22;
    s.def = 10;
    s.hp = 500;
    arriveOnFloor(s, data, 6, 0, 0);
    const ts = debugTargets(s, data);
    const order = ts.map((t) => t.category);
    const kinds = new Set(order);
    const hasUpStair = ts.some((t) => t.id.startsWith('stair:') && t.gain > 0);
    const rank = (c: string) => CATEGORY_ORDER.indexOf(c as never);
    let sorted = true;
    for (let i = 1; i < order.length; i++) if (rank(order[i]) < rank(order[i - 1])) sorted = false;
    add(
      'S11 planner 的目标排序按类别（同类内才比 gain）：多类 + 有 up 楼梯时 stairs 必须最后',
      ts.length > 0 && kinds.size >= 2 && hasUpStair && sorted && order.every((c) => rank(c) >= 0),
      `${ts.length} 个目标 / ${kinds.size} 类：${order.join('>') || '（空）'}｜up 楼梯 ${hasUpStair ? '在' : '不在'}`
    );
  }

  void entityKey;
  void tileAt;
  void standNear;
  return out;
}
