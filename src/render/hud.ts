/**
 * HUD —— 状态栏 / 详情卡 / 道具栏 / 消息条 / 楼层面板。
 *
 * 全部用 PixiJS 画在 canvas 上（不用 DOM），原因：目标平台是微信小游戏，
 * 那里没有 DOM。原型阶段就用 canvas 做 UI，可以避免后期整体重写一遍。
 *
 * 文字对象都是**预建 + 改 text**，不在每次刷新时销毁重建 —— 悬停会高频触发，
 * 反复 new Text() 会造成明显的 GC 抖动。
 */

import { Container, Graphics, Sprite, Text, type TextStyleOptions } from 'pixi.js';
import type { GameData, Stat } from '../data';
import { hasNpcOnFloor, regionOf } from '../data';
// 价格与增量直接引用 core/shop.mjs，不在渲染层重写一遍公式 ——
// 这里原本内联了一份 `10 * n * (n - 1) + 20`，是明确的漂移风险
import { shopCost, shopGain } from '../../core/shop.mjs';
import type { GameState } from '../game/state';
import { atlas, fitSize } from './atlas';
import { drawItemGlyph, itemCategoryOf, itemColorOf } from './icons';
import { GRADE_STYLE, T } from './theme';

// ── 版式 ────────────────────────────────────────────────────────────

export const LAYOUT = {
  W: 420,
  H: 780,
  hud: { x: 0, y: 0, w: 420, h: 96 },
  board: { x: 34, y: 100, cell: 32 },
  toolbar: { x: 12, y: 458, w: 396, h: 26 },
  detail: { x: 12, y: 490, w: 396, h: 140 },
  items: { x: 12, y: 636, w: 396, h: 92 },
  log: { x: 12, y: 734, w: 396, h: 40 }
} as const;

const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif';

export function label(text: string, size: number, fill: number, weight: TextStyleOptions['fontWeight'] = '500'): Text {
  // resolution 提到 2，让中文在 canvas 上不发虚（Pixi 的文本默认按 1x 光栅化）
  return new Text({
    text,
    resolution: 2,
    style: { fontFamily: FONT, fontSize: size, fill, fontWeight: weight }
  });
}

export function card(g: Graphics, x: number, y: number, w: number, h: number, radius = 12, fill: number = T.panel): Graphics {
  g.roundRect(x, y, w, h, radius).fill(fill);
  g.roundRect(x, y, w, h, radius).stroke({ width: 1, color: T.panelBorder });
  return g;
}

// ── 状态栏 ──────────────────────────────────────────────────────────

export class StatusBar extends Container {
  private floorBadge = new Graphics();
  private floorText = label('1', 21, T.onDark, '800');
  private zoneText = label('', 11.5, T.inkMuted, '600');
  private titleText = label('', 14, T.ink, '700');
  private tierText = label('', 11, T.gold, '700');

  private hpText = label('', 15, T.danger, '700');
  private atkText = label('', 15, T.info, '700');
  private defText = label('', 15, T.ok, '700');
  private goldText = label('', 15, T.gold, '700');

  private keyTexts: Text[] = [];
  private keyLayer = new Container();

  constructor() {
    super();
    const g = new Graphics();
    g.rect(0, 0, LAYOUT.hud.w, LAYOUT.hud.h).fill(T.panel);
    g.rect(0, LAYOUT.hud.h - 1, LAYOUT.hud.w, 1).fill(T.panelBorder);
    this.addChild(g);

    this.addChild(this.floorBadge);
    this.floorText.anchor.set(0.5);
    this.addChild(this.floorText, this.zoneText, this.titleText, this.tierText);
    this.zoneText.x = 64;
    this.zoneText.y = 12;
    this.titleText.x = 64;
    this.titleText.y = 27;
    this.tierText.x = 64;
    this.tierText.y = 46;

    const cells: [Text, string][] = [
      [this.hpText, '生命'],
      [this.atkText, '攻击'],
      [this.defText, '防御'],
      [this.goldText, '金币']
    ];
    const sep = new Graphics();
    cells.forEach(([t, name], i) => {
      const cx = 16 + i * 101;
      const cap = label(name, 10.5, T.inkFaint, '600');
      cap.x = cx;
      cap.y = 60;
      t.x = cx;
      t.y = 73;
      this.addChild(cap, t);
      if (i > 0) sep.rect(cx - 8, 58, 1, 32).fill(T.panelBorder);
    });
    this.addChild(sep);
    this.addChild(this.keyLayer);
  }

  /** shownFloor / browsing 服务于「楼层浏览」：画面是别的层，但属性仍是勇者本人的 */
  update(state: GameState, data: GameData, shownFloor = state.floor, browsing = false): void {
    const f = data.floorIndex[shownFloor];
    this.floorBadge.clear();
    const badgeFill = browsing ? 0x64748b : T.hero;
    this.floorBadge.roundRect(12, 12, 42, 46, 10).fill(badgeFill);
    this.floorBadge.roundRect(12, 12, 42, 46, 10).stroke({ width: 1, color: 0xffffff, alpha: 0.28 });
    this.floorText.text = String(shownFloor);
    this.floorText.x = 33;
    this.floorText.y = 35;
    this.zoneText.text = browsing
      ? `${regionOf(data, shownFloor)} · 浏览中（勇者在 ${state.floor} 层）`
      : `${regionOf(data, shownFloor)} · 第 ${shownFloor} 层`;
    this.titleText.text = f?.title ?? '';
    const tier = data.constants.shop.tiers.find((t) => shownFloor >= t.floorFrom && shownFloor <= t.floorTo);
    // 措辞刻意不含「商店」：它描述的是**本层所属的收益档位**，
    // 而全塔只有 4 / 12 / 32 / 46 层真的摆了商店
    this.tierText.text = tier ? `收益档位 ×${tier.mul}` : '';

    this.hpText.text = String(state.hp);
    this.hpText.style.fill = state.hp < 200 ? T.danger : T.ink;
    this.atkText.text = String(state.atk);
    this.defText.text = String(state.def);
    this.goldText.text = String(state.gold);

    const keys: [string, number, number][] = [
      ['yellowKey', state.keys.yellowKey, T.doorYellow],
      ['blueKey', state.keys.blueKey, T.doorBlue],
      ['redKey', state.keys.redKey, T.doorRed]
    ];
    if (this.keyTexts.length === 0) {
      for (let i = 0; i < 3; i++) {
        const gk = new Graphics();
        gk.x = LAYOUT.hud.w - 122 + i * 38;
        gk.y = 30;
        // 三色钥匙在道具表里就有素材（yellowKey / blueKey / redKey），直接用真图，
        // 不必再画一个「通用钥匙 + 染色」的程序化版本
        const ktex = atlas.ready ? atlas.item(keys[i][0]) : null;
        if (ktex) {
          const size = fitSize(ktex.width, ktex.height, 18);
          const sp = new Sprite(ktex);
          sp.anchor.set(0.5);
          sp.x = gk.x + 10;
          sp.y = gk.y + 10;
          sp.width = size.w;
          sp.height = size.h;
          this.keyLayer.addChild(sp);
        } else {
          drawItemGlyph(gk, 'key', 10, 10, 8, keys[i][2]);
        }
        const t = label('0', 13, T.ink, '700');
        t.x = gk.x + 22;
        t.y = 21;
        this.keyLayer.addChild(gk, t);
        this.keyTexts.push(t);
      }
    }
    keys.forEach(([, n], i) => {
      this.keyTexts[i].text = String(n);
    });
  }
}

// ── 通用浮层文字池 ──────────────────────────────────────────────────

/** 固定行数的文字池，避免高频刷新时反复创建 Text */
class TextPool extends Container {
  private rows: Text[] = [];
  private maxUnits: number;
  constructor(count: number, size: number, x: number, y: number, gap: number, maxUnits = 30) {
    super();
    this.maxUnits = maxUnits;
    for (let i = 0; i < count; i++) {
      const t = label('', size, T.inkMuted);
      t.x = x;
      t.y = y + i * gap;
      this.addChild(t);
      this.rows.push(t);
    }
  }
  set(i: number, text: string, fill?: number, weight?: TextStyleOptions['fontWeight']): void {
    const t = this.rows[i];
    if (!t) return;
    t.text = clip(text, this.maxUnits);
    t.visible = t.text.length > 0;
    if (fill !== undefined) t.style.fill = fill;
    if (weight) t.style.fontWeight = weight;
  }
  count(): number {
    return this.rows.length;
  }
}

/**
 * 单行截断。中文按 1 个单位、西文数字按 0.55 个单位估算，
 * 这样「生命 1000　攻击 10」这类混合串不会因为按字符数截断而误伤。
 */
export function clip(s: string, maxUnits: number): string {
  let units = 0;
  for (let i = 0; i < s.length; i++) {
    units += s.charCodeAt(i) < 0x2e80 ? 0.55 : 1;
    if (units > maxUnits) return s.slice(0, i) + '…';
  }
  return s;
}

// ── 详情卡 ──────────────────────────────────────────────────────────

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
  private title: Text;
  private badge = new Graphics();
  private badgeText: Text;
  private pool: TextPool;

  constructor() {
    super();
    const { x, y, w, h } = LAYOUT.detail;
    const g = new Graphics();
    card(g, x, y, w, h);
    this.addChild(g);

    this.title = label('', 15, T.ink, '700');
    this.title.x = x + 14;
    this.title.y = y + 10;
    this.badgeText = label('', 11, T.onDark, '700');
    this.badgeText.anchor.set(0.5);
    this.addChild(this.badge, this.title, this.badgeText);

    this.pool = new TextPool(5, 12, x + 14, y + 34, 20);
    this.addChild(this.pool);
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
        const bw = gs.label.length * 12 + 18;
        this.badge.roundRect(x + LAYOUT.detail.w - bw - 14, y + 10, bw, 21, 11).fill(gs.color);
        this.badgeText.text = gs.label;
        this.badgeText.x = x + LAYOUT.detail.w - bw / 2 - 14;
        this.badgeText.y = y + 21;
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
      this.title.text = `${npc?.name ?? target.id}　${coord}`;
      this.badgeText.text = '';
      this.pool.set(0, npc?.note ?? '', T.ink);
      const goods = npc?.goodsByFloor as Record<string, { goods?: unknown[]; gifts?: unknown[] }> | undefined;
      const rows = goods?.[String(shownFloor)];
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

// ── 道具栏 ──────────────────────────────────────────────────────────

export class ItemBar extends Container {
  private slotLayer = new Container();
  private emptyHint: Text;
  private lastSig = '';

  constructor(private onUse: (id: string) => void) {
    super();
    const { x, y, w, h } = LAYOUT.items;
    const g = new Graphics();
    card(g, x, y, w, h);
    this.addChild(g);

    this.emptyHint = label('还没有可使用的道具。钥匙直接进状态栏，宝石与剑盾拾取即生效。', 11, T.inkFaint);
    this.emptyHint.x = x + 16;
    this.emptyHint.y = y + 38;
    this.addChild(this.emptyHint, this.slotLayer);
  }

  update(state: GameState, data: GameData): void {
    const entries = Object.entries(state.bag).filter(([, n]) => n > 0);
    const sig = entries.map(([id, n]) => `${id}:${n}`).join('|');
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    this.slotLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.emptyHint.visible = entries.length === 0;

    const { x, y } = LAYOUT.items;
    const slot = 40;
    const gap = 4;
    const perRow = 8;
    entries.forEach(([id, count], i) => {
      const item = data.items[id];
      if (!item) return;
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const sx = x + 10 + col * (slot + gap);
      const sy = y + 6 + row * (slot + gap);

      const c = new Container();
      c.x = sx;
      c.y = sy;
      const tex = atlas.ready ? atlas.item(id) : null;
      const bg = new Graphics();
      const paint = (hover: boolean): void => {
        bg.clear();
        bg.roundRect(0, 0, slot, slot, 9).fill(hover ? 0xeaf1fb : T.panelAlt);
        bg.roundRect(0, 0, slot, slot, 9).stroke({ width: hover ? 2 : 1, color: hover ? T.hero : T.panelBorder });
        // 有素材就不画程序化图标，避免两套图标叠在一起
        if (!tex) {
          drawItemGlyph(bg, itemCategoryOf(id, item.name), slot / 2, slot / 2 - 2, 11, itemColorOf({ ...item, id }));
        }
      };
      paint(false);
      c.addChild(bg);

      if (tex) {
        const size = fitSize(tex.width, tex.height, slot - 10);
        const sp = new Sprite(tex);
        sp.anchor.set(0.5);
        sp.x = slot / 2;
        sp.y = slot / 2 - 2;
        sp.width = size.w;
        sp.height = size.h;
        c.addChild(sp);
      }

      const cnt = label(`${count}`, 10, T.onDark, '700');
      cnt.anchor.set(1, 1);
      cnt.x = slot - 2;
      cnt.y = slot - 1;
      const cntBg = new Graphics();
      cntBg.roundRect(slot - 20, slot - 16, 20, 15, 7).fill({ color: T.hero, alpha: 0.92 });
      c.addChild(cntBg, cnt);

      c.eventMode = 'static';
      c.cursor = 'pointer';
      c.on('pointertap', () => this.onUse(id));
      c.on('pointerover', () => paint(true));
      c.on('pointerout', () => paint(false));
      this.slotLayer.addChild(c);
    });
  }
}

// ── 消息条 ──────────────────────────────────────────────────────────

const LOG_COLOR: Record<string, number> = {
  info: T.inkMuted,
  battle: T.danger,
  loot: T.gold,
  warn: T.warn,
  talk: T.info,
  floor: T.ok
};

export class LogStrip extends Container {
  private pool: TextPool;
  private lastSeq = -1;

  constructor() {
    super();
    const { x, y, w, h } = LAYOUT.log;
    const g = new Graphics();
    card(g, x, y, w, h, 10, T.panelAlt);
    this.addChild(g);
    this.pool = new TextPool(2, 11.5, x + 14, y + 7, 16, 36);
    this.addChild(this.pool);
  }

  update(state: GameState): void {
    const last = state.log[state.log.length - 1];
    if (!last || last.seq === this.lastSeq) return;
    this.lastSeq = last.seq;
    const recent = state.log.slice(-2);
    for (let i = 0; i < 2; i++) {
      const e = recent[i];
      this.pool.set(i, e ? e.text : '', e ? LOG_COLOR[e.kind] ?? T.inkMuted : T.inkMuted);
    }
  }
}

// ── 工具栏 ──────────────────────────────────────────────────────────

export class Pill extends Container {
  private bg = new Graphics();
  private t: Text;
  private active: boolean;
  private w: number;

  constructor(text: string, width: number, private onClick: () => void, active = false) {
    super();
    this.w = width;
    this.active = active;
    this.t = label(text, 11, T.ink, '700');
    this.t.anchor.set(0.5);
    this.t.x = width / 2;
    this.t.y = 9;
    this.addChild(this.bg, this.t);
    this.eventMode = 'static';
    this.cursor = 'pointer';
    this.on('pointertap', () => this.onClick());
    this.on('pointerover', () => this.paint(true));
    this.on('pointerout', () => this.paint(false));
    this.paint(false);
  }

  private paint(hover: boolean): void {
    const { h } = LAYOUT.toolbar;
    this.bg.clear();
    const fill = this.active ? T.hero : hover ? 0xe8f0fc : T.panelAlt;
    this.bg.roundRect(0, 0, this.w, h, h / 2).fill(fill);
    this.bg.roundRect(0, 0, this.w, h, h / 2).stroke({ width: 1, color: this.active ? T.hero : T.panelBorder });
    this.t.style.fill = this.active ? T.onDark : T.ink;
  }

  setActive(v: boolean): void {
    this.active = v;
    this.paint(false);
  }
}

export class Toolbar extends Container {
  readonly revealPill: Pill;
  readonly browsePill: Pill;
  readonly restartPill: Pill;

  constructor(handlers: { onToggleReveal: () => void; onBrowse: () => void; onRestart: () => void }) {
    super();
    const { x, y } = LAYOUT.toolbar;
    let cx = x;
    const mk = (text: string, fn: () => void, active = false): Pill => {
      const w = text.length * 12 + 20;
      const p = new Pill(text, w, fn, active);
      p.x = cx;
      p.y = y;
      cx += w + 6;
      this.addChild(p);
      return p;
    };
    this.revealPill = mk('编辑视图', handlers.onToggleReveal);
    this.browsePill = mk('楼层浏览', handlers.onBrowse);
    this.restartPill = mk('重开', handlers.onRestart);

    const hint = label('点击地图自动寻路', 10.5, T.inkFaint);
    hint.anchor.set(1, 0.5);
    hint.x = x + LAYOUT.toolbar.w;
    hint.y = y + LAYOUT.toolbar.h / 2;
    this.addChild(hint);
  }
}

// ── 楼层面板（传送 / 浏览） ─────────────────────────────────────────

export class FloorPanel extends Container {
  private grid = new Container();
  private title: Text;
  private hint: Text;
  /** 当前面板用途：传送（限已到过）或浏览（任意层） */
  mode: 'teleport' | 'browse' = 'browse';

  constructor(
    private data: GameData,
    private onPick: (floor: number) => void,
    private onClose: () => void
  ) {
    super();
    this.visible = false;
    const W = LAYOUT.W;
    const H = LAYOUT.H;
    const dim = new Graphics();
    dim.rect(0, 0, W, H).fill({ color: 0x0f172a, alpha: 0.45 });
    dim.eventMode = 'static';
    this.addChild(dim);

    const px = 22;
    const py = 150;
    const pw = W - 44;
    const ph = 460;
    const bg = new Graphics();
    card(bg, px, py, pw, ph, 16);
    bg.eventMode = 'static';
    this.addChild(bg);

    this.title = label('', 17, T.ink, '800');
    this.title.x = px + 20;
    this.title.y = py + 18;
    this.addChild(this.title);

    this.hint = label('', 11.5, T.inkMuted);
    this.hint.x = px + 20;
    this.hint.y = py + 44;
    this.addChild(this.hint);

    const close = label('关闭', 12, T.hero, '700');
    close.anchor.set(1, 0);
    close.x = px + pw - 18;
    close.y = py + 18;
    close.eventMode = 'static';
    close.cursor = 'pointer';
    close.on('pointertap', () => this.onClose());
    this.addChild(close, this.grid);
  }

  open(state: GameState, mode: 'teleport' | 'browse'): void {
    this.mode = mode;
    this.visible = true;
    this.rebuild(state);
  }

  close(): void {
    this.visible = false;
  }

  private rebuild(state: GameState): void {
    this.grid.removeChildren().forEach((c) => c.destroy({ children: true }));
    const px = 22 + 22;
    const py = 150 + 76;
    const cols = 6;
    const cw = 50;
    const ch = 34;
    const gap = 4;

    this.title.text = this.mode === 'teleport' ? '楼层传送器' : '楼层浏览';
    // 提示是单行、不换行（面板高度按单行算），所以文案要自己控制长度
    this.hint.text =
      this.mode === 'teleport'
        ? `已到过 ${state.visited.length} / 51 层。传送器只能去这些层，不能向上推进。`
        : '只切换显示，不移动勇者。按 Esc 或「关闭」返回。';

    for (let i = 0; i < 51; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const bx = px + col * (cw + gap);
      const by = py + row * (ch + gap);
      const visited = state.visited.includes(i);
      const usable = this.mode === 'browse' ? true : visited;
      const isCurrent = i === state.floor;

      const c = new Container();
      c.x = bx;
      c.y = by;
      const g = new Graphics();
      const fill = isCurrent ? T.hero : visited ? 0xeaf1fb : T.panelAlt;
      g.roundRect(0, 0, cw, ch, 9).fill(fill);
      g.roundRect(0, 0, cw, ch, 9).stroke({ width: 1, color: usable ? T.panelBorder : 0xdfe5ee });
      // 已到过的层左下角一个小圆点
      if (visited && !isCurrent) g.circle(7, ch - 7, 2.6).fill(T.ok);
      c.addChild(g);

      const t = label(String(i), 14, isCurrent ? T.onDark : usable ? T.ink : 0xc3cddb, usable ? '700' : '500');
      t.anchor.set(0.5);
      t.x = cw / 2;
      t.y = ch / 2 - 1;
      c.addChild(t);

      const info = this.data.floorIndex[i];
      const sub = label(`${info?.monsters ?? 0}怪`, 8, isCurrent ? 0xdbeafe : T.inkFaint, '500');
      sub.anchor.set(0.5, 0);
      sub.x = cw / 2;
      sub.y = ch - 11;
      c.addChild(sub);

      if (usable) {
        c.eventMode = 'static';
        c.cursor = 'pointer';
        c.on('pointertap', () => this.onPick(i));
      }
      this.grid.addChild(c);
    }
  }
}
