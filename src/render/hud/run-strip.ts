/**
 * 底部自动步数条 —— 「自动通关跑到第几步、停在哪儿、当时什么属性」那一行。
 *
 * ## 它解决的是哪个问题
 *
 * 自动通关在界面上跑起来之后，「它做错了」这句话**没法复现**：
 * 画面一帧一帧地变，玩家看到一个不对的动作时已经过去几十步，
 * 既说不清是第几步，也说不清当时站在哪儿 —— 而 headless 那套
 * （`npm run autoplay` 的报告）恰恰是按「第几步 + 在哪一格」定位问题的。
 * 于是界面上跑出来的问题**回不到报告里**，报告里的问题也没法在界面上看一眼。
 *
 * 这一条把 headless 报告里的**定位三元组**（步数 / 楼层 / 坐标）搬到屏幕上，
 * 另外补上当时的三围 —— 属性不同，同一个局面会得到不同的决策，
 * 不带属性的话「第 128 步」在别人机器上重放不出来。
 *
 * ## 两条与别处不同的规矩
 *
 * **① 停下之后不消失。** 自动通关自己判定「走投无路」停下时，玩家的第一反应
 *    正是去读这个数字 —— 那一刻把它清掉，等于把证据擦掉。
 *    所以它按「这次自动跑过没有」决定显示，只在**重开**与新一次自动开始时归零。
 *
 * **② 它不上版面。** 它落在设计稿最底下那 25px 自由留白里（见 `LAYOUT.run`），
 *    不参与 `__layout()` 的间隙断言，也不打面板标记 —— 它是一个**仪表**，
 *    不是第五块面板。底色的两种状态（在跑 / 上次跑完）与工具栏那颗按钮的
 *    高亮同色，于是「蓝色 = 自动通关正在跑」在屏幕上有两处相互印证。
 */

import { Container, Graphics, Text } from 'pixi.js';
import { T, UI } from '../theme';
import { LAYOUT } from './layout';
import { clip, label, unitsPerLine } from './text';

/** 一行能放几个单位 —— 与 `clip` 同一套口径，不另算一份 */
const LINE_UNITS = unitsPerLine(LAYOUT.run.w - 24, UI.fs.label);

export interface RunInfo {
  /** 自动通关**自己出手**的步数（不是 `stats.steps`，那里面混着玩家走的） */
  steps: number;
  floor: number;
  x: number;
  y: number;
  hp: number;
  atk: number;
  def: number;
  /** 还在跑？决定底色与文案前缀 */
  running: boolean;
}

export class RunStrip extends Container {
  private shell = new Graphics();
  private text: Text;
  /** 上一次画出来的签名 —— 内容没变就不重画（`sync()` 每走一步都会被调到） */
  private lastSig: string | null = null;

  constructor() {
    super();
    this.label = 'runStrip';
    const { x, y, h } = LAYOUT.run;
    // 底色是**整块**画的（而不是随文字宽度走）：它是一条贴在屏幕底边的横条，
    // 宽度跟着字数变会让它在每一步都抽动一下。
    this.text = label('', UI.fs.label, T.onDark, '700');
    this.text.anchor.set(0, 0.5);
    this.text.x = x + 12;
    this.text.y = y + h / 2;
    this.addChild(this.shell, this.text);
    this.visible = false;
  }

  /**
   * `info` 为 null ⇒ 整条不画（还没跑过自动通关）。
   *
   * 高度写死 20（`LAYOUT.run.h`）：它是仪表不是面板，**不参与纵向排版** ——
   * 所以这里没有 `cardRect` 回填，A8 量间隙时也看不到它。
   */
  update(info: RunInfo | null): void {
    if (!info) {
      this.visible = false;
      this.lastSig = null;
      return;
    }
    const prefix = info.running ? '自动' : '上次自动';
    const body = `${prefix} ${info.steps} 步 · 第 ${info.floor} 层 (${info.x},${info.y}) · HP ${info.hp} 攻 ${info.atk} 防 ${info.def}`;
    const sig = `${info.running}|${body}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.visible = true;
    this.text.text = clip(body, LINE_UNITS);
    this.paint(info.running);
  }

  private paint(running: boolean): void {
    const { x, y, w, h } = LAYOUT.run;
    this.shell.clear();
    // 与工具栏那颗高亮按钮同色同形（圆角 7 与道具栏的计数角标同一档）
    this.shell.roundRect(x, y, w, h, 7).fill(running ? T.hero : 0x64748b);
    this.shell.roundRect(x, y, w, h, 7).stroke({ width: 1, color: 0xffffff, alpha: 0.22 });
  }

  /**
   * 条上此刻那行字。供 `__probe()` 与判据读。
   *
   * 读**真正画出来**的 `text`（不是调用方传进来的 `RunInfo`）——
   * 传进来的那份是意图，`clip()` 之后画出去的才是玩家看到的，
   * 而判据要断言的是后者（同 `Toolbar.browseLabel` 的告诫）。
   */
  get labelText(): string {
    return this.text.text;
  }
}
