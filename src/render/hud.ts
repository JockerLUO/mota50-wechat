/**
 * HUD —— 状态栏 / 详情卡 / 道具栏 / 工具栏 / 浮层面板。
 *
 * 全部用 PixiJS 画在 canvas 上（不用 DOM），原因：目标平台是微信小游戏，
 * 那里没有 DOM。原型阶段就用 canvas 做 UI，可以避免后期整体重写一遍。
 *
 * 文字对象都是**预建 + 改 text**，不在每次刷新时销毁重建 —— 悬停会高频触发，
 * 反复 new Text() 会造成明显的 GC 抖动。
 *
 * 所有面板走**同一套版式**（见 `theme.ts` 的 `UI` 令牌 + 本文件的 `panel()`）：
 * 白卡片、1px 冷灰描边、极浅投影、左上角一道主题色短条。这里不写死圆角与内边距，
 * 一律从令牌取 —— 曾经各面板各写各的，画面就散成了好几种风格。
 */

import { Container, Graphics, Sprite, Text, type TextStyleOptions } from 'pixi.js';
import type { GameData, Stat } from '../data';
import { hasNpcOnFloor, regionOf } from '../data';
// 价格与增量直接引用 core/shop.mjs，不在渲染层重写一遍公式 ——
// 这里原本内联了一份 `10 * n * (n - 1) + 20`，是明确的漂移风险
import { shopCost, shopGain } from '../../core/shop.mjs';
import type { GameState } from '../game/state';
import { npcLine } from '../game/dialogue';
import { atlas, fitSize } from './atlas';
import { drawItemGlyph, itemCategoryOf, itemColorOf } from './icons';
import { ACCENT, GRADE_STYLE, T, UI, npcRole, realm, type PanelRect } from './theme';

// ── 版式 ────────────────────────────────────────────────────────────
//
// 420×940 的设计稿，从上到下：状态卡 → 棋盘 → 操作条 → 详情卡 → 道具栏。
//
// **道具栏是唯一高度可变的一块**：没有可用道具时它连底板一起不画，
// 那段高度（798..912）直接成为位面背景。其余四块位置恒定 ——
// 「拿到一件道具时整屏往上跳一下」是比「底部空一块」严重得多的体验问题。
//
// ## 三个数决定一切
//
//   pad = 20   左右边距（面板 x）= 面板宽 380 的来源
//   gap = 28   模块之间的**垂直间隙**，含顶部与底部留白 —— 五处完全相同
//
// 上一版是 780 高、间隙 20/20/6/6，最下面两块挤在一起；而且棋盘那圈塔壁
// （城垛 10 + 壁厚 14）是**溢出**格子区画的，实际视觉间隙＝20−24＝−4，
// 城垛直接压到状态卡上。所以这一版把「棋盘的视觉盒子」也算进版面：
//
//   格子区高 352（= 32 × 11，**一格没缩**）
//   视觉盒高 388 = 城垛 8 + 壁厚 14 + 352 + 壁厚 14
//
// ## 为什么画布能长高，而棋盘不会变小
//
// 画布是按 `min(w/W, h/H)` 等比缩放居中的：手机竖屏（约 390×844）比
// 1.857 的设计稿更瘦长，缩放系数一直是**由宽度**定下的 0.93 ——
// 也就是说原来上下各有 60~120px 的黑边没被用上。把设计稿加高到 940
// （比例 2.238，接近手机竖屏的 2.16）只是把这些黑边吃回来：
// 在 390×844 上缩放系数 0.898，画布铺满 377×844，屏上元素的实际尺寸
// 与原来相差不到 3%。**棋盘与面板一格没缩，多出来的全是间隙。**
//
// 五块面板共用一套纵向节奏：边距 20、面与面之间 28（棋盘前后 40），卡片内边距由 UI.pad 决定。

export const LAYOUT = {
  W: 420,
  H: 940,
  /** 左右边距；面板宽 = W - 2 * pad */
  pad: 20,
  /**
   * 面板之间的垂直间隙（含顶部与底部留白）—— 处处相等。
   *
   * 这个数还有第二个作用：**让背景露出来**。间隙就是玩家能看见
   * 「上部星空 / 下部绝地」的地方，缝越窄场景越像不存在。
   * 所以这里的取舍不是"紧凑 vs 松散"，而是"UI 占比 vs 场景可见度"。
   */
  gap: 28,
  /**
   * 棋盘**上下**的留白 —— 比 `gap` 大一档（40）。
   *
   * 两处不同是有意的：
   *  - 棋盘是画面的视觉中心，"不要挤占游戏地图的空间"指的就是它上下要被让开，
   *    所以它前后的两条缝最宽；
   *  - 这两条缝正好是**位面最显眼的两条横带** —— 上面一条是星空（城垛后面的天），
   *    下面一条是绝地（塔壁脚下的地）。背景只在缝里露出来，把最宽的两条缝
   *    留在棋盘前后，位面感才立得住。
   */
  boardGap: 40,
  hud: { x: 20, y: 28, w: 380, h: 88 },
  /** 棋盘**格子区**原点与格宽。塔壁是往外画的，见 parapet */
  board: { x: 34, y: 178, cell: 32 },
  /** 塔壁：壁厚 t、城垛高 merlon（都画在格子区之外，必须计入版面） */
  parapet: { t: 14, merlon: 8 },
  toolbar: { x: 20, y: 584, w: 380, h: 32 },
  detail: { x: 20, y: 644, w: 380, h: 126 },
  /**
   * 道具栏的**基准位置**。`h` 在这里是「两行槽位时的最大高度」，
   * **不是实际画出来的高度** —— 真实高度由 `itemBoxHeight(件数)` 算：
   * 一件可用道具都没有时它等于 0，整栏连底板一起不画，
   * 798..912 这段还给位面背景（见 `ItemBar`）。
   *
   * 它是最后一个模块，所以「自己的高度」不影响自己的 y ——
   * 这也是为什么动态高度在这里特别便宜：没有任何模块需要跟着挪。
   */
  items: { x: 20, y: 798, w: 380, h: 117 }
} as const;

/**
 * 棋盘**含塔壁**的视觉矩形。
 *
 * 版面计算与断言都必须用它，而不是 `LAYOUT.board` —— 后者只是格子区，
 * 塔壁向外还多占 14（四边）+ 8（顶部城垛）。上一版就是拿格子区当边界算间隙，
 * 于是「间隙 20」在屏幕上实际是 −4：城垛压在状态卡上而没人发现。
 */
export function boardBox(): { x: number; y: number; w: number; h: number } {
  const { t: thick, merlon } = LAYOUT.parapet;
  const span = LAYOUT.board.cell * 11;
  return {
    x: LAYOUT.board.x - thick,
    y: LAYOUT.board.y - thick - merlon,
    w: span + thick * 2,
    h: span + thick * 2 + merlon
  };
}

const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif';

/**
 * 文本光栅化分辨率。
 *
 * 以前这里**写死 2**：手机是 dpr=3，文字按 2× 光栅化之后上屏还要再被拉 1.5 倍 ——
 * 中文笔画本来就细，这一道拉伸就是「文字发虚」的全部来源，而它影响的是**每一块面板**。
 * 现在跟随渲染器分辨率，由 `app.ts` 在 init 之后写进来。
 *
 * 夹在 [2,3]：低于 2 中文会出毛边；高于 3 纹理开销翻一倍却换不来可见差别。
 */
let TEXT_RESOLUTION = 2;

export function setTextResolution(r: number): void {
  if (!Number.isFinite(r) || r <= 0) return;
  TEXT_RESOLUTION = Math.min(3, Math.max(2, Math.round(r)));
}

/** 给验证脚本读 —— 「文字分辨率是否跟上了屏幕」必须有断言，不能靠眼看。 */
export function textResolution(): number {
  return TEXT_RESOLUTION;
}

export function label(text: string, size: number, fill: number, weight: TextStyleOptions['fontWeight'] = '500'): Text {
  return new Text({
    text,
    resolution: TEXT_RESOLUTION,
    style: { fontFamily: FONT, fontSize: size, fill, fontWeight: weight }
  });
}

/**
 * 统一面板底板 —— **所有卡片都走这一个函数**。
 *
 * 画三层：投影 → 面板（白底 + 1px 描边）→ 左上角主题色短条。
 * 短条不随内容变，位置固定，于是五块面板的「视觉锚点」在同一处，
 * 扫一眼就知道这是同一套 UI。
 *
 * @param accent 短条颜色。传 `null` 表示不画 —— 这只是「这块面板用别的颜色表达
 *               职责」时才用（比如遮罩型浮层的短条另有来源），**不是**「临时先不画」。
 *               历史上有一个固定不画短条的 `card()` 兼容入口，谁顺手拿它写新面板，
 *               新面板就会缺掉那根短条、长出一副「不是这套 UI」的样子 —— 已删除。
 */
export function panel(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  accent: number | null,
  radius: number = UI.radius,
  fill?: number
): Graphics {
  // 卡片底色随**位面**微调（地底偏暖白、星界偏冷白）。幅度刻意压得很小：
  // 它是「场景与 UI 有呼应」的手段，不是换主题 —— 相邻两层的差别几乎看不出来，
  // 但从第 1 层走到第 50 层能感觉到画面在变冷。
  const face = fill ?? realm().card;
  for (const s of UI.shadow) {
    g.roundRect(x, y + s.dy, w, h, radius).fill({ color: T.panelShadow, alpha: s.alpha });
  }
  g.roundRect(x, y, w, h, radius).fill(face);
  g.roundRect(x, y, w, h, radius).stroke({ width: UI.border, color: realm().cardEdge });
  if (accent !== null) {
    g.roundRect(x + UI.accent.x, y + UI.accent.y, UI.accent.w, UI.accent.h, UI.accent.w / 2).fill(accent);
  }
  return g;
}

/** 面板小标题：色条后面那行字 */
function headerTitle(text: string, fill = T.ink): Text {
  return label(text, UI.fs.head, fill, '700');
}

// ── 状态栏 ──────────────────────────────────────────────────────────

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

  private readonly badge = { x: 12, y: 10, w: 40, h: 40 };  constructor() {
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
    units += unitOf(s[i]);
    if (units > maxUnits) return s.slice(0, i) + '…';
  }
  return s;
}

/**
 * 「一行放得下几个单位」的定义式：可用像素宽 ÷ 该行字号。
 *
 * 为什么要有个函数而不是各处写常量 —— 那些常量全都写错过：
 * 对话框 352px 可用宽、正文 11.5px，硬编码的 `LINE_UNITS = 32` 实际能排到
 * 368px，46 个 NPC 里有 42 行**捅出卡片右边缘**（实测，见 §对话折行）。
 * 1 个单位 ≈ 1 个字号宽，是因为 `unitOf` 把中文记作 1；所以只要把
 * 「可用宽度 ÷ 字号」算出来，单位数天然就落在可用宽以内。
 */
export function unitsPerLine(px: number, fontSize: number): number {
  return Math.floor(px / fontSize);
}

/**
 * 不能出现在**行首**的标点（中文排版「行首禁则」）。
 * 折行点正好落在这些字前面时，必须把它拉回上一行 —— 否则会出现
 * 一整行以「，」开头的句子，中文读起来是明显的排版事故。
 */
const NO_LINE_START = '，。、！？：；）」』】》〉〗·…—～%℃′″';
/** 不能出现在**行尾**的标点（行尾禁则）：开引号/开括号吊在行尾同样难看 */
const NO_LINE_END = '（「『【《〈〖';

/**
 * 折行成多行（不做省略）。单位口径与 `clip` 完全一致，外加中文禁则。
 *
 * 对话框要按宽度把台词折成若干行 —— 而 Pixi 的 Text 不会自动换行
 * （`wordWrap: true` 走的是它自己的断行规则，中文标点会乱掉），
 * 所以这里自己折，和 UI 里其余地方的宽度估算保持同一套算法。
 *
 * 关于禁则：撞上禁则时**把一个字挪到下一行**（而不是让标点溢出一格）。
 * 溢出会捅破卡片，挪字只会让上一行少一个字 —— 前者是 bug，后者只是呼吸感。
 * 本行只剩一个字时不挪（挪了就是空行），这种极端只可能出现在 maxUnits=1。
 */
export function wrap(s: string, maxUnits: number): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let units = 0;

  for (const ch of s) {
    const u = unitOf(ch);
    if (cur.length > 0 && units + u > maxUnits) {
      const tail = cur[cur.length - 1];
      const forbidden = NO_LINE_START.indexOf(ch) >= 0 || NO_LINE_END.indexOf(tail) >= 0;
      if (forbidden && cur.length > 1) {
        cur.pop();
        out.push(cur.join(''));
        cur = [tail, ch];
        units = unitOf(tail) + u;
        continue;
      }
      out.push(cur.join(''));
      cur = [ch];
      units = u;
      continue;
    }
    cur.push(ch);
    units += u;
  }
  if (cur.length) out.push(cur.join(''));
  return out;
}

/** 单字符占几个「单位」：中文/全角 1，西文与数字 0.55 */
function unitOf(ch: string): number {
  return ch.charCodeAt(0) < 0x2e80 ? 0.55 : 1;
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
      const shownFloor = opts.shownFloor ?? state.floor;
      // 与对话框同源：台词轮换只在 dialogue.ts 里算一次，这里读到的一定是
      // 「撞上去会看到的那一句」。悬停预览与真实对话因此不可能不一致。
      this.pool.set(0, npcLine(state, data, target.id, shownFloor).text, T.ink);
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
   * 「这一栏现在不占位」，所以 A8 量间隙时要跳过它（见 tools/verify-visual.cjs）。
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

// ── 工具栏 ──────────────────────────────────────────────────────────
//
// ⚠️ 这里原本还有一条「消息条」（LogStrip）：底部一张卡，滚动显示最近两条
// 事件文本（「踏入第 2 层」「拾得黄钥匙」…）。已按玩家要求整条删除 ——
// 理由是那两行和状态卡重复（楼层、步数、金币状态卡都有），却常年占着 40px。
// 删除后 `state.log` 仍在记录（引擎的事件台账，`__probe().lastLog` 与自动化
// 校验都读它），只是**不再有任何一处把它画到屏幕上**。
//
// 工具栏本身也从「一排胶囊按钮 + 右侧一句灰色提示」改成三个等宽按钮：
// 胶囊是 iOS 的语言，而这里的卡片是方角圆角，两者放一起就是「不像一个人做的」。

export class Pill extends Container {
  private bg = new Graphics();
  private t: Text;
  private active: boolean;
  private w: number;
  private hh: number;
  /**
   * 构造时传的是固定宽度（不是 `'auto'`）就记下来。
   *
   * `setLabel()` 只重排文字，**不重新量宽** —— 工具栏那三颗是按版面算出来的
   * 等宽（各 120，正好铺满 380），跟着文字宽度走的话，「楼层浏览」换成
   * 「返回第 50 层」就会把整行挤歪。对话框脚部那两颗用的是 `'auto'`，
   * 它们需要跟着文案变，所以只有固定宽度的这一支要守住原宽。
   */
  private fixedW: number | null;

  /**
   * @param width 固定宽度，或 `'auto'` 按文字实际宽度 + 边距自适应。
   *              中文在不同字体下的实际宽度与「字符数 × 12」常有偏差，
   *              用 Text 实测宽度比硬算更稳，能避免右侧被切掉。
   * @param height 默认取工具栏那一行的高度；对话框脚部的按钮略高，用同一个类
   *              才能保证「所有按钮长一个样」。
   */
  constructor(
    text: string,
    width: number | 'auto',
    private onClick: () => void,
    active = false,
    height: number = LAYOUT.toolbar.h
  ) {
    super();
    this.active = active;
    this.hh = height;
    this.t = label(text, UI.fs.head, T.ink, '700');
    this.t.anchor.set(0.5);
    this.fixedW = width === 'auto' ? null : width;
    this.w = width === 'auto' ? Math.ceil(this.t.width) + 28 : width;
    this.t.x = this.w / 2;
    // 文字垂直居中。Pixi Text 的锚点是几何中心，但不同字体的 descent 会让
    // 底部笔画冒出去，所以留 0.5px 余量偏上。
    this.t.y = height / 2 - 0.5;
    this.addChild(this.bg, this.t);
    this.eventMode = 'static';
    this.cursor = 'pointer';
    this.on('pointertap', () => this.onClick());
    this.on('pointerover', () => this.paint(true));
    this.on('pointerout', () => this.paint(false));
    this.paint(false);
  }

  private paint(hover: boolean): void {
    const h = this.hh;
    this.bg.clear();
    // 圆角与卡片一致（UI.radiusInner），不再用 h/2 的胶囊
    const r = UI.radiusInner;
    const fill = this.active ? T.hero : hover ? 0xe8f0fc : T.panel;
    // 与面板同款投影 —— 按钮和卡片是同一族元素，只是尺寸小一圈
    for (const s of UI.shadow) {
      this.bg.roundRect(0, s.dy, this.w, h, r).fill({ color: T.panelShadow, alpha: s.alpha });
    }
    this.bg.roundRect(0, 0, this.w, h, r).fill(fill);
    this.bg.roundRect(0, 0, this.w, h, r).stroke({ width: 1, color: this.active ? T.hero : T.panelBorder });
    this.t.style.fill = this.active ? T.onDark : T.ink;
  }

  setActive(v: boolean): void {
    this.active = v;
    this.paint(false);
  }

  /**
   * 换文案。
   *
   * 对话框脚部那两个按钮的文案不是固定的（「交易」后面可能跟货量），
   * 换字之后宽度必须跟着变，否则文字会顶出底板 —— 而 `'auto'` 只在构造时算一次。
   *
   * 固定宽度的按钮（工具栏那三颗）反过来：宽度由版面决定，换文案只重新居中。
   */
  setLabel(text: string): void {
    this.t.text = text;
    // 固定宽度的**不**重新量宽：见 fixedW 的说明。文字超宽时会被裁在按钮里，
    // 所以文案长度由调用方负责（工具栏那几条都控制在 8 个单位以内）。
    this.w = this.fixedW ?? Math.ceil(this.t.width) + 28;
    this.t.x = this.w / 2;
    this.paint(false);
  }

  /**
   * 当前文案。
   *
   * 不叫 `text` 是因为 `Container.label` 已经在 Pixi 里占了一格语义，
   * 再加一个近义名容易读错（`label` 是给渲染树打标记用的，不是给人看的字）。
   */
  get labelText(): string {
    return this.t.text;
  }
}

export class Toolbar extends Container {
  readonly revealPill: Pill;
  readonly browsePill: Pill;
  readonly restartPill: Pill;

  constructor(handlers: { onToggleReveal: () => void; onBrowse: () => void; onRestart: () => void }) {
    super();
    const { x, y, w } = LAYOUT.toolbar;
    // 三个等宽按钮铺满整行：宽度由版面算出来，不跟着文字长度走 ——
    // 「重开」只有两个字，跟着文字走会变成一个挤在左边的窄块，整行看着就散了
    const gap = 10;
    const btnW = Math.floor((w - gap * 2) / 3); // 380 → 三个 120，正好铺满
    const mk = (text: string, i: number, fn: () => void, active = false): Pill => {
      const p = new Pill(text, btnW, fn, active);
      p.x = x + i * (btnW + gap);
      p.y = y;
      this.addChild(p);
      return p;
    };
    this.revealPill = mk('编辑视图', 0, handlers.onToggleReveal);
    this.browsePill = mk('楼层浏览', 1, handlers.onBrowse);
    this.restartPill = mk('重开', 2, handlers.onRestart);
  }

  /**
   * 浏览态：中间那颗「楼层浏览」变成「返回第 N 层」并高亮。
   *
   * ## 为什么让它就地变身，而不是新加一颗返回按钮
   *
   * 三颗按钮正好铺满 380 宽（各 120 + 间距 10），加一颗就要重排整个版面，
   * 而版面是「模块间隙处处相等」的断言对象 —— 为了一个临时状态动版面不划算。
   * 更要紧的是**手指位置**：玩家点开浏览用的就是这一颗，返回键出现在同一位置，
   * 不用去找。这和「盖住屏幕的浮层用 Esc 返回」是两回事：
   * 触摸设备上没有 Esc，所以返回键必须是看得见、按得着的。
   *
   * 超过两位数的楼层文案会变长（「返回第 100 层」是不可能的，塔只有 51 层），
   * 最长「返回第 51 层」≈ 6.2 个单位 × 12.5px ≈ 78px，稳在 120 里。
   */
  setBrowsing(on: boolean, floor: number): void {
    this.browsePill.setLabel(on ? `返回第 ${floor} 层` : '楼层浏览');
    this.browsePill.setActive(on);
  }

  /**
   * 中间那颗按钮此刻的文案（浏览态下是「返回第 N 层」）。供 `__probe()` 断言。
   *
   * 必须读 `labelText`（按钮上真正画出来的那串字）—— 写成 `browsePill.label`
   * 会读到 Pixi `Container.label`（渲染树标记字符串，如 `'pill'`），
   * 于是断言永远看到标记而不是文案，等于没断言。踩过。
   */
  get browseLabel(): string {
    return this.browsePill.labelText;
  }
}

// ── 楼层面板（传送 / 浏览） ─────────────────────────────────────────

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
