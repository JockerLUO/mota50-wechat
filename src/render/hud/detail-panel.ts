/**
 * 详情卡 —— 棋盘下方那张卡：悬停/点击任何一格时，说清「这是什么、打了会怎样」。
 *
 * 从 `hud.ts` 拆出来的。它是五块面板里**文案逻辑最重**的一块（怪物/道具/NPC/地形
 * 四种分支 + 战报 + 交易预览），和「怎么画一个卡片」关系很小，所以拆开之后
 * 这个文件里几乎全是「把数据翻译成人话」的规则。
 *
 * ⚠️ 一条贯穿全文件的纪律：**先落字、再量宽**。
 *    Pixi 的 `Text.width` 是「当前内容」的度量，顺序反了会拿到上一只怪的宽度。
 *    这里踩过一次（战斗评级徽章的位置）。
 */

import { Container, Graphics, Text } from 'pixi.js';
import type { GameData, Stat } from '../../data';
import { hasNpcOnFloor } from '../../data';
// 价格与增量直接引用 core/shop.mjs，不在渲染层重写一遍公式 ——
// 这里原本内联了一份 `10 * n * (n - 1) + 20`，是明确的漂移风险
import { shopCost, shopGain } from '../../../core/shop.mjs';
import type { GameState } from '../../game/state';
import { npcLine } from '../../game/dialogue';
import { ACCENT, GRADE_STYLE, T, UI, npcRole, type PanelRect } from '../theme';
import { LAYOUT } from './layout';
import { TextPool, headerTitle, label, panel } from './text';

export type DetailTarget =
  | { kind: 'monster'; id: string; x: number; y: number }
  | { kind: 'item'; id: string; x: number; y: number }
  | { kind: 'npc'; id: string; x: number; y: number }
  | { kind: 'terrain'; char: string; x: number; y: number }
  | { kind: 'none' };

export interface BattleLike {
  canWin: boolean;
  reason: string | null;
  execute: boolean;
  rounds: number | null;
  perRound: number;
  hpLoss: number;
  hpLossMin: number;
  hpLossMax: number;
  remainingHp: number;
  flanked?: boolean;
  appliedCounters?: string[];
  grade: string;
}

export class DetailPanel extends Container {
  /** 卡片矩形（见 theme.ts `UI.tag.rect`）：版式断言据此换算标题偏移 */
  readonly cardRect: PanelRect;
  /** 底板单独持有：位面变了要重画 */
  private cardGfx = new Graphics();
  private title: Text;
  private badge = new Graphics();
  private badgeText: Text;
  private pool: TextPool;

  /** 标题基线：与左上角色条垂直居中 */
  private readonly titleY: number;

  constructor() {
    super();
    this.label = UI.tag.panel + 'detail';
    const { x, y, w, h } = LAYOUT.detail;
    this.cardRect = { x, y, w, h };
    this.repaintCard();
    this.addChild(this.cardGfx);

    this.title = headerTitle('');
    this.title.label = UI.tag.title;
    this.title.x = x + UI.titleX;
    this.titleY = y + UI.titleYHead;
    this.title.y = this.titleY;
    this.badgeText = label('', 11, T.onDark, '700');
    this.badgeText.anchor.set(0.5);
    this.addChild(this.badge, this.title, this.badgeText);

    // 五行文字池：126 高的卡片放得下「标题 38 + 5×17」
    this.pool = new TextPool(5, UI.fs.body, x + UI.pad, y + 38, 17);
    this.addChild(this.pool);
  }

  /** 重画底板（位面色调，见 StatusBar.repaintCard） */
  repaintCard(): void {
    const { x, y, w, h } = LAYOUT.detail;
    this.cardGfx.clear();
    panel(this.cardGfx, x, y, w, h, ACCENT.detail);
  }

  render(
    state: GameState,
    data: GameData,
    target: DetailTarget,
    battle: BattleLike | null,
    opts: { browsing?: boolean; shownFloor?: number } = {}
  ): void {
    const { x, y } = LAYOUT.detail;
    const shownFloor = opts.shownFloor ?? state.floor;
    const browsing = opts.browsing ?? false;
    this.badge.clear();

    if (target.kind === 'none') {
      this.title.text = browsing ? `楼层浏览 · 第 ${shownFloor} 层` : '操作说明';
      this.badgeText.text = '';
      this.pool.set(0, '方向键 / WASD 移动　撞怪物即攻击　撞门自动用钥匙', T.inkMuted);
      this.pool.set(1, '点击地图可自动寻路走过去　点击道具栏图标使用道具', T.inkMuted);
      this.pool.set(2, `已到过 ${state.visited.length} 层　步数 ${state.stats.steps}　击杀 ${state.stats.kills}　累计掉血 ${state.stats.hpLost}`, T.inkMuted);
      // 只有真摆着商店的层才报商店价，否则玩家会照着提示在整层找商店
      const shopHere = hasNpcOnFloor(data, shownFloor, 'shop');
      this.pool.set(
        3,
        shopHere
          ? `本层商店第 ${state.buyTimes} 次：${shopCost(state.buyTimes)} 金币 → ` +
            `生命+${shopGain(shownFloor, 'hp')} 攻击+${shopGain(shownFloor, 'atk')} 防御+${shopGain(shownFloor, 'def')}`
          : '',
        T.gold
      );
      const note = data.floorNotes[String(shownFloor)]?.note;
      this.pool.set(4, note ? `本层机制：${String(note)}` : '', T.inkFaint);
      return;
    }

    const coord = `(${target.x}, ${target.y})`;

    if (target.kind === 'monster') {
      const mon = data.monsters[target.id];
      if (!mon) return;
      this.title.text = `${mon.name}${mon.boss ? ' · BOSS' : ''}　${coord}`;
      const gs = battle ? GRADE_STYLE[battle.grade] : null;
      if (gs) {
        // 先落字再量宽：Text 的 width 是「当前内容」的度量，顺序反了会拿到上一只怪的宽度
        this.badgeText.text = gs.label;
        const bw = Math.ceil(this.badgeText.width) + 20;
        const bx = x + LAYOUT.detail.w - bw - UI.pad;
        const by = y + UI.accent.y - 1;
        this.badge.roundRect(bx, by, bw, 18, 9).fill(gs.color);
        this.badgeText.x = bx + bw / 2;
        this.badgeText.y = by + 9;
      } else {
        this.badgeText.text = '';
      }
      this.pool.set(0, `生命 ${mon.hp}　攻击 ${mon.atk}　防御 ${mon.def}　金币 ${mon.gold}　原版编号 ${mon.roleId}`, T.ink);
      if (!battle) return;
      if (battle.reason === 'unpierceable') {
        this.pool.set(1, `打不动：需要攻击 ≥ ${mon.def + 1}，当前 ${state.atk}（差 ${mon.def + 1 - state.atk}）`, T.doorPrison, '700');
        this.pool.set(2, `想零损失击杀需要攻击 ≥ ${mon.def + mon.hp}`, T.inkFaint);
      } else {
        const after = state.hp - (battle.execute ? 0 : battle.hpLoss);
        this.pool.set(
          1,
          battle.execute
            ? `一击必杀：攻击 ${state.atk} 已达阈值，零损失通过`
            : `${battle.rounds} 回合　每回合挨 ${battle.perRound}　总损失 ${battle.hpLossMin}${battle.flanked ? `~${battle.hpLossMax}（夹击有概率多挨一次）` : ''}`,
          battle.execute ? T.ok : T.ink
        );
        this.pool.set(
          2,
          `战后生命 ${after}（当前 ${state.hp}，占 ${Math.round((after / Math.max(1, state.hp)) * 100)}%）${battle.appliedCounters?.length ? `　特攻生效：${battle.appliedCounters.join('、')}` : ''}`,
          after <= 0 ? T.danger : after / Math.max(1, state.hp) < 0.3 ? T.warn : T.inkMuted
        );
      }
      this.pool.set(3, mon.traits.length ? `特性：${mon.traits.map(traitCn).join('、')}` : '特性：无', T.inkFaint);
      this.pool.set(4, mon.note ? mon.note : '', T.inkFaint);
      return;
    }

    if (target.kind === 'item') {
      const it = data.items[target.id];
      if (!it) return;
      this.title.text = `${it.name}　${coord}`;
      this.badgeText.text = '';
      const kindName = { pickup: '拾取即生效', usable: '可使用', passive: '持有即生效' }[it.kind] ?? it.kind;
      this.pool.set(0, `${kindName}${it.sourceId !== undefined ? `　原版编号 ${it.sourceId}` : ''}`, T.ink);
      this.pool.set(1, (it.effects ?? []).map((e) => describeEffect(data, e)).join('；') || '—', T.info);
      this.pool.set(2, it.note ?? '', T.inkFaint);
      this.pool.set(3, '', T.inkMuted);
      this.pool.set(4, '', T.inkMuted);
      return;
    }

    if (target.kind === 'npc') {
      const npc = data.npcs[target.id];
      const role = npcRole(target.id);
      this.title.text = `${npc?.name ?? target.id} · ${role.label}　${coord}`;
      this.badgeText.text = '';
      const shown = opts.shownFloor ?? state.floor;
      // 与对话框同源：台词轮换只在 dialogue.ts 里算一次，这里读到的一定是
      // 「撞上去会看到的那一句」。悬停预览与真实对话因此不可能不一致。
      this.pool.set(0, npcLine(state, data, target.id, shown).text, T.ink);
      const goods = npc?.goodsByFloor as Record<string, { goods?: unknown[]; gifts?: unknown[] }> | undefined;
      const rows = goods?.[String(shown)];
      if (rows) {
        const items = [...(rows.goods ?? []), ...(rows.gifts ?? [])]
          .map((g0) => describeEffect(data, g0 as { op: string; [k: string]: unknown }))
          .join('；');
        this.pool.set(1, `本层交易：${items}`, T.gold);
      } else {
        this.pool.set(1, goods ? `本层不提供交易（全塔共 ${Object.keys(goods).length} 层有商品，可用「楼层浏览」去看）` : '', T.inkFaint);
      }
      this.pool.set(2, '', T.inkMuted);
      this.pool.set(3, '', T.inkMuted);
      this.pool.set(4, '', T.inkMuted);
      return;
    }

    // 地形
    const info = data.tiles.find((t) => t.char === target.char);
    this.title.text = `${info?.name ?? target.char}　${coord}`;
    this.badgeText.text = '';
    this.pool.set(0, `通行：${info?.passable ? '可以走过' : '不可通行'}${info?.key ? '　需要 1 把钥匙' : ''}`, T.ink);
    this.pool.set(1, info?.note ?? '', T.inkFaint);
    this.pool.set(2, '', T.inkMuted);
    this.pool.set(3, '', T.inkMuted);
    this.pool.set(4, '', T.inkMuted);
  }
}

function traitCn(t: unknown): string {
  if (typeof t === 'string') {
    return (
      {
        crossVulnerable: '十字架克制',
        undead: '亡灵',
        dragon: '龙系',
        boss: 'BOSS'
      }[t] ?? t
    );
  }
  const o = t as { type: string; damage?: number; chance?: number; stat?: string; threshold?: number };
  if (o.type === 'aura') return `领域 每步 −${o.damage}`;
  if (o.type === 'flank') return `夹击 ${Math.round((o.chance ?? 0) * 100)}%`;
  if (o.type === 'execute') return `${o.stat} ≥ ${o.threshold} 斩杀`;
  return o.type;
}

/** 效果算子 → 中文描述。交易面板也复用它，避免两处各写一套文案。 */
export function describeEffect(data: GameData, e: { op: string; [k: string]: unknown }): string {
  switch (e.op) {
    case 'addStat':
      return `${statCn(e.stat as Stat)} +${e.value}`;
    case 'mulStat':
      return `${statCn(e.stat as Stat)} ×${e.value}`;
    case 'addKey':
      return `${keyCn(String(e.key))} +${e.value}`;
    case 'clearTerrain': {
      const t = data.tiles.find((x) => data.codeOf[x.char] === e.terrain);
      return `清除本层 ${t?.name ?? e.terrain}`;
    }
    case 'breakWall':
      return '挖掉相邻的墙';
    case 'bomb':
      return '炸掉相邻非 BOSS 怪物';
    case 'teleportSymmetric':
      return '传送到本层中心对称点';
    case 'changeFloor':
      return `${(e.delta as number) > 0 ? '上' : '下'}一层`;
    case 'openFloorSelect':
      return `选择已到过的楼层（${(e.range as number[])?.[0]}~${(e.range as number[])?.[1]}）`;
    case 'mulGoldGain':
      return `击杀金币 ×${e.value}`;
    case 'traitCounter':
      return `对「${e.trait}」攻击 ×${e.mul}`;
    case 'immune':
      return `免疫${e.to}`;
    case 'toggleUi':
      return '开启界面';
    case 'buyItem':
      return `购买 ${e.item ?? ''}${e.count ? ` ×${e.count}` : ''}${e.price ? `（${e.price} 金币）` : ''}`;
    case 'sellItem':
      return `出售 ${e.item ?? ''}${e.count ? ` ×${e.count}` : ''}${e.price ? `（${e.price} 金币）` : ''}`;
    case 'buyStat':
      return `购买 ${statCn(e.stat as Stat)} +${e.value}（${e.price} 金币）`;
    default:
      return e.op;
  }
}

/** 金币也走 addStat（第 2 层商人赠礼就是 `{op:'addStat', stat:'gold'}`），所以这里要有 gold */
export function statCn(s: string): string {
  return { hp: '生命', atk: '攻击', def: '防御', gold: '金币' }[s] ?? s;
}
function keyCn(s: string): string {
  return { yellowKey: '黄钥匙', blueKey: '蓝钥匙', redKey: '红钥匙' }[s] ?? s;
}
