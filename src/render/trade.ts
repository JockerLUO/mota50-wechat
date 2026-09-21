/**
 * 交易类浮层 —— 商人（分楼层商品）与商店（三选一买属性）。
 *
 * 与 hud.ts 的分工：hud 画常驻信息，这里画**模态浮层**。
 *
 * 这两块面板有一条硬纪律：**只画引擎算好的报价，不自己重算价格、也不自己判断能不能买。**
 * 「可成交与否」由 `engine.merchantOffers()` / `engine.shopOptions()` 决定后带进来
 * （`blocked` / `affordable` 字段），否则 UI 和规则迟早会算出两个答案 ——
 * 而商店定价又同时被 Node 校验台引用（core/shop.mjs），一处算错就会漂移三处。
 */

import { Container, Graphics, Rectangle, Sprite, Text } from 'pixi.js';
import type { GameData, ItemDef, Stat } from '../data';
import type { MerchantOffer, ShopOption, ShopView } from '../game/engine';
import { LAYOUT, card, clip, label } from './hud';
import { atlas, fitSize } from './atlas';
import { drawItemGlyph, itemCategoryOf, itemColorOf, type ItemCategory } from './icons';
import { T } from './theme';

// ── 版式常量 ────────────────────────────────────────────────────────

const CARD_X = 22;
const CARD_W = LAYOUT.W - CARD_X * 2;
const PAD = 14;
const INNER_X = CARD_X + PAD;
const INNER_W = CARD_W - PAD * 2;

/** 三个属性的主色：生命=危险红（血条语义）、攻击=信息蓝、防御=安全绿 */
const STAT_COLOR: Record<Stat, number> = { hp: T.danger, atk: T.info, def: T.ok };

const DISABLED = 0xc3cddb;

/** 每点属性多少金币 —— 小于 10 保留两位，否则一位，够 README 级的精度了 */
function fmtPerPoint(v: number): string {
  return v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/**
 * 折行。中文按 1 单位、西文按 0.55 单位估算宽度 —— 与 hud.ts 的 `clip` 同一套口径，
 * 这样「生命 1000 → 3000」这类混合串不会被按字符数误判。
 */
function wrap(s: string, maxUnits: number): string[] {
  const lines: string[] = [];
  let cur = '';
  let units = 0;
  for (const ch of s) {
    const u = ch.charCodeAt(0) < 0x2e80 ? 0.55 : 1;
    if (units + u > maxUnits && cur) {
      lines.push(cur);
      cur = '';
      units = 0;
    }
    cur += ch;
    units += u;
  }
  if (cur) lines.push(cur);
  return lines;
}

// ── 模态外壳 ────────────────────────────────────────────────────────

/**
 * 遮罩 + 卡片 + 标题 + 备注 + 关闭。
 *
 * 遮罩必须吃掉点击：不加这一层，点在卡片外的位置会穿透到棋盘触发自动寻路，
 * 玩家会看到勇者在面板后面偷偷跑掉。
 */
class ModalShell extends Container {
  readonly body = new Container();
  private dim = new Graphics();
  private bg = new Graphics();
  private titleText: Text;
  private noteText: Text;
  private closeText: Text;

  constructor(onClose: () => void) {
    super();
    // ⚠️ 这里**不能**设 this.visible = false。
    // 外壳是面板的子节点，一旦它自己不可见，Pixi 的命中测试会在第一步就把它剪掉 ——
    // 面板看着"打开了"，实际既画不出来也点不动。可见性统一由外层面板控制。

    this.dim.rect(0, 0, LAYOUT.W, LAYOUT.H).fill({ color: 0x0f172a, alpha: 0.45 });
    this.dim.eventMode = 'static';
    this.dim.hitArea = new Rectangle(0, 0, LAYOUT.W, LAYOUT.H);

    this.bg.eventMode = 'static';

    this.titleText = label('', 17, T.ink, '800');
    this.noteText = label('', 11, T.inkMuted);
    this.closeText = label('关闭', 12, T.hero, '700');
    this.closeText.anchor.set(1, 0);
    this.closeText.eventMode = 'static';
    this.closeText.cursor = 'pointer';
    this.closeText.hitArea = new Rectangle(-50, -8, 58, 28);
    this.closeText.on('pointertap', () => onClose());

    this.addChild(this.dim, this.bg, this.titleText, this.noteText, this.closeText, this.body);
  }

  /** 按内容高度重画卡片；返回卡片顶边 y，子类据此定位自己的行 */
  layout(cardH: number, title: string, note: string | null): number {
    const top = Math.max(88, Math.round((LAYOUT.H - cardH) / 2));
    this.bg.clear();
    card(this.bg, CARD_X, top, CARD_W, cardH, 16);
    this.bg.hitArea = new Rectangle(CARD_X, top, CARD_W, cardH);

    this.titleText.text = title;
    this.titleText.x = INNER_X;
    this.titleText.y = top + 18;

    const clipped = note ? clip(note, 36) : '';
    this.noteText.text = clipped;
    this.noteText.visible = clipped.length > 0;
    this.noteText.x = INNER_X;
    this.noteText.y = top + 45;

    this.closeText.x = CARD_X + CARD_W - PAD;
    this.closeText.y = top + 20;
    return top;
  }

  /**
   * 卸下 body 里的内容。**只脱离、不销毁** —— 外壳不拥有这些对象的所有权，
   * 它们归子类。这里如果顺手 destroy 掉，子类持有的那个 rowLayer 就会被连根销毁，
   * 之后再往里 addChild 全部加在游离容器上：面板能打开，但一片空白。
   */
  clearBody(): void {
    this.body.removeChildren();
  }
}

// ── 商人交易面板 ────────────────────────────────────────────────────

export class MerchantPanel extends Container {
  private shell: ModalShell;
  private rowLayer = new Container();

  constructor(
    private data: GameData,
    private onTrade: (index: number) => void,
    onClose: () => void
  ) {
    super();
    this.visible = false;
    this.shell = new ModalShell(onClose);
    this.shell.body.addChild(this.rowLayer);
    this.addChild(this.shell);
  }

  close(): void {
    this.visible = false;
  }

  /**
   * 重画整块面板。每次成交后都要重调一次 —— 因为成交会改变金币、持有量、
   * 以及各条的 `blocked`，报价本身就已经不同了。
   */
  open(offers: MerchantOffer[], note: string | null, gold: number): void {
    this.visible = true;
    this.shell.clearBody();
    // 重新挂回：clearBody 只脱离不销毁，不接回来的话第二次 open 起就是空面板
    this.shell.body.addChild(this.rowLayer);
    this.rowLayer.removeChildren().forEach((c) => c.destroy({ children: true }));

    const rowH = 58;
    const gap = 8;
    const headH = 76;
    const footH = 50;
    const cardH = headH + offers.length * (rowH + gap) - gap + footH;
    const top = this.shell.layout(cardH, '商人', note);

    offers.forEach((o, i) => {
      this.rowLayer.addChild(this.buildRow(o, top + headH + i * (rowH + gap), rowH));
    });

    const foot = label(`持有 ${gold} 金币`, 12, T.gold, '700');
    foot.x = INNER_X;
    foot.y = top + cardH - 34;
    this.rowLayer.addChild(foot);

    const tip = label(`本层 ${offers.length} 项 · 可重复交易`, 10.5, T.inkFaint);
    tip.anchor.set(1, 0);
    tip.x = CARD_X + CARD_W - PAD;
    tip.y = top + cardH - 33;
    this.rowLayer.addChild(tip);
  }

  /** 报价条目 → 一行可点击的卡片 */
  private buildRow(o: MerchantOffer, ry: number, rowH: number): Container {
    const c = new Container();
    c.x = INNER_X;
    c.y = ry;

    const enabled = o.blocked === null;
    const claimed = o.blocked === '已领取';
    const { cat, color } = this.glyphFor(o);
    const iconId = this.iconIdFor(o);
    const iconTex = atlas.ready && iconId ? atlas.item(iconId) : null;

    const g = new Graphics();
    const paint = (hover: boolean): void => {
      const lit = hover && enabled;
      g.clear();
      g.roundRect(0, 0, INNER_W, rowH, 10).fill(lit ? 0xeaf1fb : T.panelAlt);
      g.roundRect(0, 0, INNER_W, rowH, 10).stroke({
        width: lit ? 2 : 1,
        color: lit ? T.hero : T.panelBorder
      });
      // 图标底板
      g.roundRect(12, 14, 30, 30, 8).fill(T.panel);
      g.roundRect(12, 14, 30, 30, 8).stroke({ width: 1, color: T.panelBorder });
      if (!iconTex) {
        drawItemGlyph(g, cat, 27, 29, 10, enabled || claimed ? color : DISABLED);
      }
      // 右下角按钮
      g.roundRect(INNER_W - 12 - 58, rowH - 34, 58, 24, 12).fill(enabled ? T.hero : DISABLED);
    };
    paint(false);
    c.addChild(g);

    if (iconTex) {
      const size = fitSize(iconTex.width, iconTex.height, 24);
      const sp = new Sprite(iconTex);
      sp.anchor.set(0.5);
      sp.x = 27;
      sp.y = 29;
      sp.width = size.w;
      sp.height = size.h;
      // 买不起 / 已领取：压成灰调，一眼看出这行不能点
      if (!enabled && !claimed) sp.tint = DISABLED;
      else if (claimed) sp.tint = 0xa8b4c7;
      c.addChild(sp);
    }

    const title = label(clip(o.title, 13), 13, enabled ? T.ink : T.inkFaint, '700');
    title.x = 54;
    title.y = 9;
    c.addChild(title);

    // 副标题在有阻塞原因时让位给原因 —— 「金币不足（还差 100）」比「买后 ×2」更急
    const sub = o.blocked ? o.blocked : o.detail;
    const subText = label(clip(sub, 21), 10.5, o.blocked ? T.warn : T.inkFaint);
    subText.x = 54;
    subText.y = 30;
    c.addChild(subText);

    const price = label(o.price > 0 ? `${o.price} 金币` : '免费', 13, enabled ? T.gold : T.inkFaint, '700');
    price.anchor.set(1, 0);
    price.x = INNER_W - 14;
    price.y = 9;
    c.addChild(price);

    const verb = claimed ? '已领取' : o.verb;
    const bt = label(verb, 12, enabled ? T.onDark : T.inkMuted, '700');
    bt.anchor.set(0.5);
    bt.x = INNER_W - 12 - 29;
    bt.y = rowH - 34 + 12;
    c.addChild(bt);

    if (enabled) {
      c.eventMode = 'static';
      c.cursor = 'pointer';
      c.hitArea = new Rectangle(0, 0, INNER_W, rowH);
      c.on('pointertap', () => this.onTrade(o.index));
      c.on('pointerover', () => paint(true));
      c.on('pointerout', () => paint(false));
    }
    return c;
  }

  /**
   * 图标 = 商品本身。非道具类（45 层的属性兑换）按属性配剑/盾/药水，
   * 赠礼统一用金币 —— 视觉上要能一眼分清「买的是东西」还是「换的是属性」。
   */
  private glyphFor(o: MerchantOffer): { cat: ItemCategory; color: number } {
    const id = o.raw.item ? String(o.raw.item) : null;
    if (id) {
      const def: ItemDef = this.data.items[id] ?? { name: id, kind: 'pickup' };
      return { cat: itemCategoryOf(id, def.name), color: itemColorOf({ ...def, id }) };
    }
    if (o.op === 'buyStat') {
      const s = String(o.raw.stat) as Stat;
      return { cat: s === 'hp' ? 'potion' : s === 'atk' ? 'sword' : 'shield', color: STAT_COLOR[s] ?? T.gold };
    }
    return { cat: 'gold', color: T.gold };
  }

  /**
   * 这一行该显示哪张素材图。
   *
   * 卖真道具用道具自己的图；45 层那种「买属性」没有对应道具，就按属性挑一张
   * 代表性图标 —— 生命给药水、攻击给剑、防御给盾，赠礼给金币。
   * 这套对应关系与 `glyphFor()` 的程序化兜底是同一套语义，两条路径不会画出两种意思。
   */
  private iconIdFor(o: MerchantOffer): string | null {
    const id = o.raw.item ? String(o.raw.item) : null;
    if (id) return id;
    if (o.op === 'buyStat') {
      const s = String(o.raw.stat) as Stat;
      return s === 'hp' ? 'redPotion' : s === 'atk' ? 'ironSword' : 'ironShield';
    }
    return 'bigGold';
  }
}

// ── 商店三选一面板 ──────────────────────────────────────────────────

export class ShopPanel extends Container {
  private shell: ModalShell;
  private rowLayer = new Container();

  constructor(
    private onBuy: (stat: Stat) => void,
    onClose: () => void
  ) {
    super();
    this.visible = false;
    this.shell = new ModalShell(onClose);
    this.shell.body.addChild(this.rowLayer);
    this.addChild(this.shell);
  }

  close(): void {
    this.visible = false;
  }

  open(view: ShopView): void {
    this.visible = true;
    this.shell.clearBody();
    // 同上：必须把 rowLayer 接回 body
    this.shell.body.addChild(this.rowLayer);
    this.rowLayer.removeChildren().forEach((c) => c.destroy({ children: true }));

    const rowH = 76;
    const gap = 10;
    const headH = 86;
    const advice = wrap(view.advice, 34);
    const footH = 40 + advice.length * 17;

    const cardH = headH + view.options.length * (rowH + gap) - gap + footH;
    const header = `第 ${view.n} 次购买 · 本次 ${view.cost} 金币 · ${view.tierNote}`;
    const top = this.shell.layout(cardH, '商店', header);

    view.options.forEach((opt, i) => {
      this.rowLayer.addChild(this.buildOption(opt, top + headH + i * (rowH + gap), rowH));
    });

    const footY = top + headH + view.options.length * (rowH + gap) - gap + 12;
    const gold = label(`金币 ${view.gold}`, 12.5, T.gold, '700');
    gold.x = INNER_X;
    gold.y = footY;
    this.rowLayer.addChild(gold);

    // 「还能买几次」用了 maxPurchasesFrom（扣掉已花掉的钱），不是 maxPurchases
    const rest = label(
      view.remaining > 0 ? `按现价还能买 ${view.remaining} 次 · 之后每次更贵（下次 ${view.nextCost}）` : `金币不足，最便宜的一次要 ${view.cost}`,
      10.5,
      view.remaining > 0 ? T.inkFaint : T.warn
    );
    rest.anchor.set(1, 0);
    rest.x = CARD_X + CARD_W - PAD;
    rest.y = footY + 1;
    this.rowLayer.addChild(rest);

    advice.forEach((line, i) => {
      const t = label(line, 10.5, T.info);
      t.x = INNER_X;
      t.y = footY + 22 + i * 16;
      this.rowLayer.addChild(t);
    });
  }

  /**
   * 一个属性一行。这里刻意把「单价 / 每点成本 / 买后数值」都摆出来 ——
   * 原版商店的核心决策就是「现在买还是留着钱到高层买」，
   * 而这三项正是做这个判断需要的全部数据。
   */
  private buildOption(opt: ShopOption, ry: number, rowH: number): Container {
    const c = new Container();
    c.x = INNER_X;
    c.y = ry;
    const color = STAT_COLOR[opt.stat] ?? T.ink;
    const enabled = opt.affordable;

    const g = new Graphics();
    const paint = (hover: boolean): void => {
      const lit = hover && enabled;
      g.clear();
      g.roundRect(0, 0, INNER_W, rowH, 12).fill(lit ? 0xf0f6ff : T.panelAlt);
      g.roundRect(0, 0, INNER_W, rowH, 12).stroke({
        width: lit ? 2 : 1,
        color: lit ? color : T.panelBorder
      });
      // 属性色标（左侧竖条）：让三行不需要读字就能区分
      g.roundRect(0, 12, 4, rowH - 24, 2).fill(enabled ? color : DISABLED);
      g.roundRect(16, 14, 56, 26, 8).fill(enabled ? color : DISABLED);
    };
    paint(false);
    c.addChild(g);

    const chip = label(opt.label, 12.5, T.onDark, '700');
    chip.anchor.set(0.5);
    chip.x = 44;
    chip.y = 27;
    c.addChild(chip);

    const gain = label(`+${opt.gain}`, 21, enabled ? color : T.inkFaint, '800');
    gain.x = 84;
    gain.y = 10;
    c.addChild(gain);

    const after = label(`${opt.label} ${opt.after - opt.gain} → ${opt.after}`, 11, disabledInk(enabled, T.inkMuted), '600');
    after.x = 84;
    after.y = 42;
    c.addChild(after);

    const cost = label(`${opt.cost} 金币`, 14, enabled ? T.gold : T.danger, '700');
    cost.anchor.set(1, 0);
    cost.x = INNER_W - 14;
    cost.y = 12;
    c.addChild(cost);

    const per = label(`${fmtPerPoint(opt.goldPerPoint)} 金币/点`, 10.5, T.inkFaint);
    per.anchor.set(1, 0);
    per.x = INNER_W - 14;
    per.y = 38;
    c.addChild(per);

    if (opt.affordable) {
      c.eventMode = 'static';
      c.cursor = 'pointer';
      c.hitArea = new Rectangle(0, 0, INNER_W, rowH);
      c.on('pointertap', () => this.onBuy(opt.stat));
      c.on('pointerover', () => paint(true));
      c.on('pointerout', () => paint(false));
    }
    return c;
  }
}

/** 买不起时整行压成灰调，但仍要能读清数字 —— 纯灰会让玩家以为界面坏了 */
function disabledInk(enabled: boolean, color: number): number {
  return enabled ? color : 0xa9b4c4;
}
