/**
 * 楼层面板 —— 点「楼层浏览」或「楼层传送器」时盖住屏幕的那张卡片。
 *
 * 从 `hud.ts` 拆出来的。它是五块面板里**唯一带模态语义**的一块
 * （自己画满屏变暗层、自己管 open/close），也是一处**状态机风险点**：
 * 它的出口在工具栏那颗按钮上，不在面板里 —— 所以它和 `toolbar.ts` 是一对，
 * 拆在一起看才不容易把「唯一出口」写丢。
 */

import { Container, Graphics, Text } from 'pixi.js';
import type { GameData } from '../../data';
import type { GameState } from '../../game/state';
import { ACCENT, T, UI, type PanelRect } from '../theme';
import { LAYOUT } from './layout';
import { label, panel } from './text';

/**
 * 楼层面板卡片：51 层按 6 列排 9 行，行高 34 + 行距 4 → 8×38 + 34 = 338，
 * 加上头部 76 与底部留白，卡片高 460。纵向居中于设计稿。
 *
 * 写成常量是因为**两处都在用**：构造函数画卡片，rebuild() 摆格子。
 * 之前两处各写一遍 `22 / 150`，改一处另一处就错位。
 */
const FLOOR_CARD = {
  x: LAYOUT.pad,
  y: Math.round((LAYOUT.H - 460) / 2),
  w: LAYOUT.W - LAYOUT.pad * 2,
  h: 460,
  /** 头部高度：标题 + 提示行占到这里，格子从这往下排 */
  head: 76
};

export class FloorPanel extends Container {
  /** 卡片矩形（见 theme.ts `UI.tag.rect`）：版式断言据此换算标题偏移 */
  readonly cardRect: PanelRect;
  private grid = new Container();
  private title: Text;
  private hint: Text;
  /** 当前面板用途：传送（限已到过）或浏览（任意层） */
  mode: 'teleport' | 'browse' = 'browse';
  /**
   * 面板此刻**正在展示**哪一层（浏览态下与勇者所在层不同）。
   *
   * 为什么要单独存：这两个数是两件事 —— 「我在看第 7 层」和「勇者站在第 1 层」。
   * 旧版只画了后者（`isCurrent = i === state.floor`），于是浏览第 7 层时
   * 高亮的还是第 1 层，玩家看了一眼会以为没切过去。
   */
  private shown = 1;

  constructor(
    private data: GameData,
    private onPick: (floor: number) => void,
    private onClose: () => void
  ) {
    super();
    this.label = UI.tag.panel + 'floor';
    this.visible = false;
    const W = LAYOUT.W;
    const H = LAYOUT.H;
    const dim = new Graphics();
    dim.rect(0, 0, W, H).fill({ color: 0x0f172a, alpha: 0.45 });
    dim.eventMode = 'static';
    this.addChild(dim);

    const { x: px, y: py, w: pw, h: ph } = FLOOR_CARD;
    this.cardRect = { x: px, y: py, w: pw, h: ph };
    const bg = new Graphics();
    // 浮层同样走统一底板 —— 短条颜色由 panel() 一并画出（以前这里自己再画一根，
    // 两处画同一根短条迟早会分头改：改了一边，另一边就悄悄错位）
    panel(bg, px, py, pw, ph, ACCENT.detail, UI.radius);
    bg.eventMode = 'static';
    this.addChild(bg);

    this.title = label('', UI.fs.title, T.ink, '800');
    this.title.label = UI.tag.title;
    this.title.x = px + UI.titleX;
    this.title.y = py + UI.titleYTitle;
    this.addChild(this.title);

    this.hint = label('', UI.fs.label, T.inkMuted);
    this.hint.x = px + UI.pad;
    this.hint.y = py + 44;
    this.addChild(this.hint);

    const close = label('关闭', UI.fs.head, T.hero, '700');
    close.anchor.set(1, 0);
    close.x = px + pw - UI.pad;
    close.y = py + UI.accent.y - 1;
    close.eventMode = 'static';
    close.cursor = 'pointer';
    close.on('pointertap', () => this.onClose());
    this.addChild(close, this.grid);
  }

  /**
   * 打开面板。`shownFloor` 是「现在棋盘上显示的是哪一层」——
   * 浏览态下选完一层会再次调用它，好让高亮跟着走。默认就是勇者所在层。
   */
  open(state: GameState, mode: 'teleport' | 'browse', shownFloor?: number): void {
    this.mode = mode;
    this.shown = shownFloor ?? state.floor;
    this.visible = true;
    this.rebuild(state);
  }

  close(): void {
    this.visible = false;
  }

  private rebuild(state: GameState): void {
    this.grid.removeChildren().forEach((c) => c.destroy({ children: true }));
    const cols = 6;
    const cw = 50;
    const ch = 34;
    const gap = 4;
    // 格子块在卡片里**水平居中**：6 列 × 50 + 5 × 4 = 320，卡片内容宽 352
    const blockW = cols * cw + (cols - 1) * gap;
    const px = FLOOR_CARD.x + Math.round((FLOOR_CARD.w - blockW) / 2);
    const py = FLOOR_CARD.y + FLOOR_CARD.head;

    this.title.text = this.mode === 'teleport' ? '楼层传送器' : '楼层浏览';
    // 提示是单行、不换行（面板高度按单行算），所以文案要自己控制长度
    this.hint.text =
      this.mode === 'teleport'
        ? `已到过 ${state.visited.length} / 51 层。传送器只能去这些层，不能向上推进。`
        // 选完面板会收起，出口挪到了工具栏那颗按钮上 —— 提示必须说清楚在哪，
        // 否则「选完就没退路」的观感又回来了（哪怕实际是有退路的）
        : '只切换显示，不移动勇者。选一层后看棋盘，点工具栏那颗「返回」回到自己那层。';

    // 浏览态下「看着的那层」与「勇者站的那层」都要标出来，所以两个记号并存：
    //   跟随高亮（主色实底）= 现在画面在放哪一层
    //   金色描边           = 勇者真的站在哪一层
    // 少任何一个都会让人误判：只画前者会以为人跟着过去了，
    // 只画后者会以为没切换成功（旧版就是后者的毛病）。
    const browsing = this.mode === 'browse' && this.shown !== state.floor;

    for (let i = 0; i < 51; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const bx = px + col * (cw + gap);
      const by = py + row * (ch + gap);
      const visited = state.visited.includes(i);
      const usable = this.mode === 'browse' ? true : visited;
      const isShown = i === this.shown;
      const isHome = i === state.floor;

      const c = new Container();
      c.x = bx;
      c.y = by;
      const g = new Graphics();
      const fill = isShown ? T.hero : visited ? 0xeaf1fb : T.panelAlt;
      g.roundRect(0, 0, cw, ch, 9).fill(fill);
      g.roundRect(0, 0, cw, ch, 9).stroke({ width: 1, color: usable ? T.panelBorder : 0xdfe5ee });
      // 已到过的层左下角一个小圆点（自己站的那格另有金环，不重复画）
      if (visited && !isShown && !isHome) g.circle(7, ch - 7, 2.6).fill(T.ok);
      // 勇者真正所在的层：金色内环。浏览态下它才可能与高亮分开，所以只在分开时画
      if (browsing && isHome) {
        g.roundRect(2, 2, cw - 4, ch - 4, 7).stroke({ width: 2, color: T.gold });
      }
      c.addChild(g);

      const t = label(String(i), 14, isShown ? T.onDark : usable ? T.ink : 0xc3cddb, usable ? '700' : '500');
      t.anchor.set(0.5);
      t.x = cw / 2;
      t.y = ch / 2 - 1;
      c.addChild(t);

      const info = this.data.floorIndex[i];
      const sub = label(`${info?.monsters ?? 0}怪`, 8, isShown ? 0xdbeafe : T.inkFaint, '500');
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
