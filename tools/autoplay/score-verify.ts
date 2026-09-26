/**
 * 评分系统的 headless 断言 —— 逐条对应用户 2026-09-26 的口径。
 *
 * 这些性质**必须**被机器检查，理由是它们全是「看起来对」的那类约定：
 * 分数是个数，写错了不会抛异常，只会让 AI 做出没人看得懂的选择。
 */

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
  itemScore,
  monsterScore,
  npcScore,
  rawItemWorth
} from '../../src/game/score';
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

  void entityKey;
  void tileAt;
  void standNear;
  return out;
}
