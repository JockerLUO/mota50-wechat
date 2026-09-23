/**
 * 工具栏 —— 棋盘下方那三颗等宽按钮（编辑视图 / 楼层浏览 / 重开）。
 *
 * 从 `hud.ts` 拆出来的。这里的核心是一个**可复用按钮**（`Pill`）：
 * 工具栏用它、对话框脚部也用它，所以它必须和工具栏本身分得开
 * （对话框不该为了一个按钮去 import 整条工具栏）。
 *
 * ⚠️ 这里原本还有一条「消息条」（LogStrip）：底部一张卡，滚动显示最近两条
 * 事件文本（「踏入第 2 层」「拾得黄钥匙」…）。已按玩家要求整条删除 ——
 * 理由是那两行和状态卡重复（楼层、步数、金币状态卡都有），却常年占着 40px。
 * 删除后 `state.log` 仍在记录（引擎的事件台账，`__probe().lastLog` 与自动化
 * 校验都读它），只是**不再有任何一处把它画到屏幕上**。
 *
 * 工具栏本身也从「一排胶囊按钮 + 右侧一句灰色提示」改成三个等宽按钮：
 * 胶囊是 iOS 的语言，而这里的卡片是方角圆角，两者放一起就是「不像一个人做的」。
 */

import { Container, Graphics, Text } from 'pixi.js';
import { T, UI } from '../theme';
import { LAYOUT } from './layout';
import { label } from './text';

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
