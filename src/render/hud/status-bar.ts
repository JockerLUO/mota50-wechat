/**
 * 状态卡 —— 顶部那块：楼层徽章 / 区名与档位 / 四条数值 / 三枚钥匙。
 *
 * 从 `hud.ts` 拆出来的。它是五块面板里唯一「位置与尺寸全固定、内容全动态」的一块，
 * 也是唯一**不参与 A7 标题断言**的一块（它的标题按 40×40 楼层徽章的实测宽度往后量，
 * 与「短条 + 标题」不是同一种结构）—— 这份特殊性本身就值得一个单独的文件。
 */

import { Container, Graphics, Sprite, Text } from 'pixi.js';
import type { GameData } from '../../data';
import { regionOf } from '../../data';
import type { GameState } from '../../game/state';
import { atlas, fitSize } from '../atlas';
import { drawItemGlyph } from '../icons';
import { ACCENT, T, UI, type PanelRect } from '../theme';
import { LAYOUT } from './layout';
import { clip, label, panel } from './text';

/**
 * 状态卡内部的横向分区（相对卡片左边），**写死在这里而不是跟着文字长度走**。
 *
 * 早先的做法是「右栏从左边推开、左栏跟着文字宽度浮动」，两位数楼层（第 12 层）
 * 或长区名就会和右边挤在一起 —— 而这种碰撞只在特定楼层出现，很容易漏测。
 * 定死三段之后，任何文字长度都不会改变版面。
 */
const STATUS_TEXT_W = 234; // 左栏（区名 / 标题 / 档位）的右边界
// 234 是怎么来的：面板宽 380 − 右侧三个钥匙胶囊（3×38 + 2×6 + 右距 12 = 138）
// − 8 的呼吸位。上一版面板宽 396，所以是 250；面板一旦变窄而这里忘了改，
// 两位数楼层或长档位文字就会压到钥匙上 —— 而这只在特定楼层出现，很容易漏测。
const KEY_CHIP = { w: 38, h: 30, gap: 6, right: 12, y: 10 };

export class StatusBar extends Container {
  /**
   * 卡片矩形（见 theme.ts `UI.tag.rect`）。
   *
   * 状态卡不参与 A7（它的标题按 40×40 楼层徽章的实测宽度往后量，
   * 与「短条 + 标题」不是同一种结构），但**要参与 A8**：
   * A8 量的是「五块模块之间的间隙」，少了它就只剩四块。
   */
  readonly cardRect: PanelRect;
  /** 底板单独持有：位面变了要重画（见 `repaintCard`） */
  private cardGfx = new Graphics();
  private floorBadge = new Graphics();
  private floorText = label('1', UI.fs.badge, T.onDark, '800');
  private zoneText = label('', UI.fs.label, T.inkFaint, '600');
  private titleText = label('', UI.fs.title, T.ink, '800');
  private tierText = label('', UI.fs.label, T.gold, '700');

  private hpText = label('', UI.fs.value, T.danger, '700');
  private atkText = label('', UI.fs.value, T.info, '700');
  private defText = label('', UI.fs.value, T.ok, '700');
  private goldText = label('', UI.fs.value, T.gold, '700');
  /** 四个数值各自左侧的语义色点 —— 与数值同色，形成「点+名+数」的固定节奏 */
  private dots: Graphics[] = [];
  private caps: Text[] = [];

  private keyTexts: Text[] = [];
  private keyLayer = new Container();

  private readonly badge = { x: 12, y: 10, w: 40, h: 40 };

  constructor() {
    super();
    this.label = UI.tag.panel + 'hud';
    const { x, y, w, h } = LAYOUT.hud;
    this.cardRect = { x, y, w, h };
    this.repaintCard();
    this.addChild(this.cardGfx);

    // 楼层徽章：内边距与短条对齐（同一套 12px 网格）
    this.addChild(this.floorBadge);
    this.paintBadge(T.hero);
    this.floorText.anchor.set(0.5);
    this.addChild(this.floorText, this.zoneText, this.titleText, this.tierText);

    const bx = x + this.badge.x + this.badge.w + 10; // 徽章右缘 + 间距
    this.zoneText.x = bx;
    this.zoneText.y = y + 11;
    // 「收益档位」跟在区名后面同一行 —— 单占一行太奢侈，而它本来就只
    // 描述「本层属于哪一档」，与区名同级
    this.tierText.x = 0;
    this.tierText.y = y + 11;
    this.titleText.x = bx;
    this.titleText.y = y + 27;

    // 数值条：一条浅底 + 四等分格。分隔线是「同一种风格」的关键 ——
    // 之前四个数字只是并排飘着，和面板的卡片语言对不上
    const stripY = y + 52;
    const stripH = 30;
    const strip = new Graphics();
    strip.roundRect(x + 12, stripY, w - 24, stripH, UI.radiusInner).fill(T.panelAlt);
    strip.roundRect(x + 12, stripY, w - 24, stripH, UI.radiusInner).stroke({ width: 1, color: T.panelBorder, alpha: 0.7 });
    this.addChild(strip);

    const cells: [Text, string, number][] = [
      [this.hpText, '生命', T.danger],
      [this.atkText, '攻击', T.info],
      [this.defText, '防御', T.ok],
      [this.goldText, '金币', T.gold]
    ];
    const cellW = (w - 24) / 4;
    cells.forEach(([t, name, color], i) => {
      const cx = x + 12 + i * cellW;
      if (i > 0) {
        const sep = new Graphics();
        sep.rect(cx, stripY + 6, 1, stripH - 12).fill({ color: T.panelBorder, alpha: 0.9 });
        this.addChild(sep);
      }
      const dot = new Graphics();
      dot.circle(cx + 11, stripY + stripH / 2, 3).fill(color);
      this.dots.push(dot);
      t.anchor.set(1, 0.5);
      t.x = cx + cellW - 12;
      t.y = stripY + stripH / 2;
      const cap = label(name, UI.fs.label, T.inkMuted, '600');
      cap.x = cx + 20;
      cap.y = stripY + stripH / 2 - 7;
      this.caps.push(cap);
      this.addChild(dot, cap, t);
    });
    this.addChild(this.keyLayer);
  }

  /**
   * 重画底板。卡片底色随位面微调（地底暖白 / 星界冷白），
   * 所以换层跨过位面锚点时要重画一次 —— 否则永远停在开局那一刻的色。
   */
  repaintCard(): void {
    const { x, y, w, h } = LAYOUT.hud;
    this.cardGfx.clear();
    panel(this.cardGfx, x, y, w, h, ACCENT.status);
  }

  /** 徽章底色单独抽出来：update 里「浏览别的楼层」要把它变灰 */
  private paintBadge(fill: number): void {
    const { x, y } = LAYOUT.hud;
    const b = this.badge;
    this.floorBadge.clear();
    this.floorBadge.roundRect(x + b.x, y + b.y, b.w, b.h, UI.radiusInner).fill(fill);
    this.floorBadge
      .roundRect(x + b.x, y + b.y, b.w, b.h, UI.radiusInner)
      .stroke({ width: 1, color: 0xffffff, alpha: 0.3 });
    this.floorText.x = x + b.x + b.w / 2;
    this.floorText.y = y + b.y + b.h / 2;
  }

  /** shownFloor / browsing 服务于「楼层浏览」：画面是别的层，但属性仍是勇者本人的 */
  update(state: GameState, data: GameData, shownFloor = state.floor, browsing = false): void {
    const { x, y, w } = LAYOUT.hud;
    const f = data.floorIndex[shownFloor];
    this.paintBadge(browsing ? 0x64748b : T.hero);
    this.floorText.text = String(shownFloor);
    this.zoneText.text = clip(
      browsing ? `${regionOf(data, shownFloor)} · 浏览中` : `${regionOf(data, shownFloor)} · 第 ${shownFloor} 层`,
      8
    );
    this.titleText.text = f?.title ?? '';
    const tier = data.constants.shop.tiers.find((t) => shownFloor >= t.floorFrom && shownFloor <= t.floorTo);
    // 措辞刻意不含「商店」：它描述的是**本层所属的收益档位**，
    // 而全塔只有 4 / 12 / 32 / 46 层真的摆了商店。
    // 浏览模式下换成「勇者在第几层」—— 那时玩家最需要知道的就是这件事。
    this.tierText.text = browsing
      ? `勇者在 ${state.floor} 层`
      : tier
        ? `收益档位 ×${tier.mul}`
        : '';
    this.tierText.style.fill = browsing ? T.warn : T.gold;
    // 右对齐到左栏右缘（KEY_BLOCK 之前），而不是跟着区名右缘 ——
    // 跟着区名时位置随文字长度浮动，两位数楼层就会和右边钥匙块挤在一起
    this.tierText.x = x + STATUS_TEXT_W - Math.ceil(this.tierText.width);
    this.tierText.y = y + 11;

    this.hpText.text = String(state.hp);
    // 血量偏低时数值转红，色点保持语义色（否则「红色 = 生命」这条规律就断了）
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
      // 三枚钥匙做成右上角的三个小格：与数值条同底、同圆角、同描边 ——
      // 「同一种风格」靠的就是这些重复出现的小控件，而不是每一块各画各的
      const right = x + w - KEY_CHIP.right;
      for (let i = 0; i < 3; i++) {
        const chipX = right - (3 - i) * KEY_CHIP.w - (2 - i) * KEY_CHIP.gap;
        const chipY = y + KEY_CHIP.y;
        // ⚠️ 顺序即层序：底板必须先加，否则后加的底板会**盖住**先加的图标。
        // 这里踩过一次：图标在渲染树里存在、visible=true、alpha=1，
        // 但屏幕上是三个空盒子 —— 因为面板底把它们糊掉了。
        const chip = new Graphics();
        chip.roundRect(chipX, chipY, KEY_CHIP.w, KEY_CHIP.h, UI.radiusInner).fill(T.panelAlt);
        chip.roundRect(chipX, chipY, KEY_CHIP.w, KEY_CHIP.h, UI.radiusInner).stroke({ width: 1, color: T.panelBorder });
        this.keyLayer.addChild(chip);

        // 三色钥匙在道具表里就有素材（yellowKey / blueKey / redKey），直接用真图，
        // 不必再画一个「通用钥匙 + 染色」的程序化版本
        const ktex = atlas.ready ? atlas.item(keys[i][0]) : null;
        if (ktex) {
          const size = fitSize(ktex.width, ktex.height, 16);
          const sp = new Sprite(ktex);
          sp.anchor.set(0.5);
          sp.x = chipX + 12;
          sp.y = chipY + KEY_CHIP.h / 2;
          sp.width = size.w;
          sp.height = size.h;
          this.keyLayer.addChild(sp);
        } else {
          const gk = new Graphics();
          gk.x = chipX;
          gk.y = chipY;
          drawItemGlyph(gk, 'key', 12, KEY_CHIP.h / 2, 7, keys[i][2]);
          this.keyLayer.addChild(gk);
        }
        const t = label('0', UI.fs.head, T.ink, '700');
        t.x = chipX + 27;
        t.y = chipY + KEY_CHIP.h / 2 - 8;
        this.keyLayer.addChild(t);
        this.keyTexts.push(t);
      }
    }
    keys.forEach(([, n], i) => {
      this.keyTexts[i].text = String(n);
    });
  }
}
