/**
 * 道具栏 —— 底部那块可点击的可用道具格。
 *
 * 从 `hud.ts` 拆出来的。它是**唯一高度动态**的一块面板：没有可用道具时
 * 整栏（连底板）都不画，高度返回 0，那段版面还给位面背景。
 * 「按需占位而不是常驻 18 个空格子」是本项目一条被明确记录过的设计决定，
 * 而它牵动的正是这个文件里的 `itemBoxHeight()` —— 独立成文件才看得清。
 */

import { Container, Graphics, Sprite, Text } from 'pixi.js';
import type { GameData } from '../../data';
import type { GameState } from '../../game/state';
import { atlas, fitSize } from '../atlas';
import { drawItemGlyph, itemCategoryOf, itemColorOf } from '../icons';
import { ACCENT, T, UI, type PanelRect } from '../theme';
import { LAYOUT } from './layout';
import { headerTitle, label, panel } from './text';

/**
 * 槽位尺寸：9 列 × 36 + 8 × 3 = 348，落在卡片 352 的内容宽内。
 *
 * ⚠️ 这里**不再有「两行共 18 格」这个概念**。上一版把 18 个空格子常驻画出来，
 * 玩家一进游戏看到的就是一整片空槽 —— 那是「容量展示」，代价是 114px 的版面
 * 常年被一块空卡片占着。现在卡片高度由**实际持有件数**算出来，
 * 一件都没有时整栏不占位（高度 0），空出来的地方还给位面背景。
 */
const SLOT = { size: 36, gap: 3, perRow: 9 };
/** 第一行槽位的 y 偏移（短条 + 标题占掉的高度） */
const ITEM_HEAD = 34;
/**
 * 最后一行槽位与卡片底的内边距。
 *
 * 这个 5 不是随手写的，是从**版面节奏倒推**出来的：本作可用道具一共 12 种
 * （`data/items.json` 里 `kind: 'usable'`），最多占 2 行，而
 *   34（头）+ 36×2 + 3（行距）+ 5 = 114 = (940 − 28) − 798
 * 正好让两行时的卡片底落在 `H − gap`，也就是**底部留白与其它模块同节奏**。
 * 改 SLOT.size / ITEM_HEAD 时这个值要一起重算，A8 会红。
 */
const ITEM_PAD_BOTTOM = 5;

/** 持有 n 件可用道具时，道具栏需要的卡片高度。**n = 0 → 0（整栏不占位）** */
export function itemBoxHeight(n: number): number {
  if (n <= 0) return 0;
  const rows = Math.ceil(n / SLOT.perRow);
  return ITEM_HEAD + rows * SLOT.size + (rows - 1) * SLOT.gap + ITEM_PAD_BOTTOM;
}

export class ItemBar extends Container {
  /**
   * 卡片矩形（见 theme.ts `UI.tag.rect`）：版式断言据此换算标题偏移。
   *
   * **它是动态的** —— `update()` 每次按件数改写。断言读到 h = 0 就意味着
   * 「这一栏现在不占位」，所以 A8 量间隙时要跳过它
   * （见 tools/verify/checks/a08-board-layout.cjs）。
   */
  readonly cardRect: PanelRect;
  /** 底板单独持有：位面变了要重画 */
  private cardGfx = new Graphics();
  private slotLayer = new Container();
  private title: Text;
  private countText: Text;
  /** null 而不是 '' —— 初始「空背包」的签名也是 ''，用 '' 会让第一次 update 直接 return */
  private lastSig: string | null = null;

  constructor(private onUse: (id: string) => void) {
    super();
    this.label = UI.tag.panel + 'items';
    const { x, y, w } = LAYOUT.items;
    this.cardRect = { x, y, w, h: 0 };
    this.visible = false;
    this.addChild(this.cardGfx);

    this.title = headerTitle('道具');
    this.title.label = UI.tag.title;
    this.title.x = x + UI.titleX;
    this.title.y = y + UI.titleYHead;
    this.countText = label('', UI.fs.label, T.inkFaint, '600');
    this.countText.anchor.set(1, 0);
    this.countText.x = x + w - UI.pad;
    this.countText.y = y + UI.accent.y + 2;
    this.addChild(this.title, this.countText, this.slotLayer);
  }

  /**
   * 重画底板（位面色调，见 StatusBar.repaintCard）。
   *
   * 高度取 `cardRect.h` 而不是 `LAYOUT.items.h` —— 后者只是基准位置，
   * 真实高度由件数决定。这里读 cardRect 才不会有「底板和内容不一样高」。
   */
  repaintCard(): void {
    const { x, y, w } = LAYOUT.items;
    const h = this.cardRect.h;
    this.cardGfx.clear();
    if (h > 0) panel(this.cardGfx, x, y, w, h, ACCENT.items);
  }

  update(state: GameState, data: GameData): void {
    const entries = Object.entries(state.bag).filter(([, n]) => n > 0);
    const sig = entries.map(([id, n]) => `${id}:${n}`).join('|');
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    // 空背包 = 整栏不占位。**不要留一张空卡片** —— 上一版常驻 18 个空格子，
    // 玩家看到的第一屏里有一整块什么都不放的地方。
    const h = itemBoxHeight(entries.length);
    (this.cardRect as PanelRect).h = h;
    this.visible = h > 0;
    this.repaintCard();
    if (h === 0) {
      this.slotLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
      return;
    }

    this.slotLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.countText.text = `${entries.length} 件`;

    const { x, y } = LAYOUT.items;
    const slot = SLOT.size;
    const gap = SLOT.gap;
    const perRow = SLOT.perRow;
    entries.forEach(([id, count], i) => {
      const item = data.items[id];
      if (!item) return;
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const sx = x + UI.pad + col * (slot + gap);
      const sy = y + ITEM_HEAD + row * (slot + gap);

      const c = new Container();
      c.x = sx;
      c.y = sy;
      const tex = atlas.ready ? atlas.item(id) : null;
      const bg = new Graphics();
      const paint = (hover: boolean): void => {
        bg.clear();
        bg.roundRect(0, 0, slot, slot, UI.radiusInner).fill(hover ? 0xeaf1fb : T.panel);
        bg.roundRect(0, 0, slot, slot, UI.radiusInner).stroke({
          width: hover ? 2 : 1,
          color: hover ? T.hero : T.panelBorder
        });
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
