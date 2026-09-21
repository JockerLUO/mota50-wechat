/**
 * NPC 对话框 —— 撞到 NPC 时弹出来的那块。
 *
 * ## 为什么要有它（而不是继续把台词塞在详情卡里）
 *
 * 上一版撞到 NPC 只做两件事：往底部消息条写一行、商人/商店直接弹交易面板。
 * 于是「对话」这件事**根本没有发生**：台词一闪而过，玩家还没读完，
 * 交易界面已经盖在脸上了。这一版把顺序倒过来 —— 先说话，
 * 玩家自己按「交易」才开摊（原版魔塔就是这个顺序）。
 *
 * ## 与 hud.ts 的分工
 *
 * 版式令牌、`panel()` / `label()` / `wrap()` / `Pill` 全部来自 hud.ts，
 * 这里只负责「把一段台词摆好看」。它不读游戏状态、不做任何判断 ——
 * 台词是引擎的 `NpcTalk` 算好的，`tradeLabel` 由编排层决定。
 * 这样「换一句台词」永远只改 `src/game/dialogue.ts` 一处。
 */

import { Container, Graphics, Text } from 'pixi.js';
import { LAYOUT, Pill, label, panel, wrap } from './hud';
import { T, UI, type PanelRect } from './theme';

export interface DialogueScript {
  /** NPC 名（标题） */
  name: string;
  /** 职能章：名字与颜色都来自 theme.ts 的 NPC_ROLE */
  role: { label: string; color: number };
  /** 台词正文。可以多段 —— 第一段是台词，后面几段是功能引导 */
  lines: string[];
  /** 左下角的状态小字，如「首次见面」「本层专说」 */
  hint?: string;
  /** 给了就显示交易按钮（本层真的摆摊时才给） */
  tradeLabel?: string;
  onTrade?: () => void;
}

/**
 * 卡片高度与最多行数要一起算：正文首行在 CARD_Y+56，行距 18，
 * 脚部按钮占最后 50px。7 行 × 18 = 126 → 56+126 = 182 < 236-50 = 186 ✓
 */
// 与主面板同栏（左右边距 LAYOUT.pad），底边留 LAYOUT.pad —— 弹出时正好
// 压在道具栏上，与它左右对齐，看着是"从底部升起来的一张卡"
const CARD = { x: LAYOUT.pad, w: LAYOUT.W - LAYOUT.pad * 2, h: 236 };
const CARD_Y = LAYOUT.H - LAYOUT.pad - CARD.h;
/** 正文行距与最多行数：再长的台词会被截断，篇幅由数据作者控制 */
const LINE_H = 18;
const MAX_LINES = 7;
/** 正文每行最多多少「单位」（见 hud.ts 的 wrap） */
const LINE_UNITS = 32;
/** 脚部按钮高度（比工具栏那行高一点，手指好按） */
const BTN_H = 38;

export class DialoguePanel extends Container {
  /** 卡片矩形（见 theme.ts `UI.tag.rect`）：版式断言据此换算标题偏移 */
  readonly cardRect: PanelRect;
  private body = new Container();
  private shell = new Graphics();
  private nameText: Text;
  private roleChip = new Graphics();
  private roleText: Text;
  private hintText: Text;
  private closePill: Pill;
  private tradePill: Pill;
  private btnY = CARD_Y + CARD.h - 12 - BTN_H;
  /** 点「交易」时调这个 —— 由编排层在 open() 时换上去 */
  private trade: (() => void) | null = null;

  constructor(private notify: () => void = () => {}) {
    super();
    this.label = UI.tag.panel + 'dialogue';
    this.cardRect = { x: CARD.x, y: CARD_Y, w: CARD.w, h: CARD.h };
    this.visible = false;

    const dim = new Graphics();
    dim.rect(0, 0, LAYOUT.W, LAYOUT.H).fill({ color: 0x0f172a, alpha: 0.45 });
    dim.eventMode = 'static';
    dim.on('pointertap', () => this.close());
    this.addChild(dim);

    this.shell.eventMode = 'static';
    this.addChild(this.shell);
    this.paintShell(T.hero);

    this.nameText = label('', UI.fs.title, T.ink, '800');
    this.nameText.label = UI.tag.title;
    this.nameText.x = CARD.x + UI.titleX;
    this.nameText.y = CARD_Y + UI.titleYTitle;
    this.roleText = label('', UI.fs.label, T.onDark, '700');
    this.roleText.anchor.set(0.5);
    this.addChild(this.roleChip, this.nameText, this.roleText);

    const sep = new Graphics();
    sep.rect(CARD.x + UI.pad, CARD_Y + 44, CARD.w - UI.pad * 2, 1).fill(T.panelBorder);
    this.addChild(sep, this.body);

    this.hintText = label('', UI.fs.label, T.inkFaint, '600');
    this.hintText.x = CARD.x + UI.pad;
    this.hintText.y = CARD_Y + CARD.h - 29;
    this.addChild(this.hintText);

    this.closePill = new Pill('结束对话', 'auto', () => this.close(), false, BTN_H);
    this.tradePill = new Pill('交易', 'auto', () => {
      const fn = this.trade;
      this.close();
      fn?.();
    }, true, BTN_H);
    this.tradePill.visible = false;
    this.addChild(this.tradePill, this.closePill);
  }

  /** 底板自绘：左上角那道短条要跟着 NPC 职能色变，所以不能只画一次 */
  private paintShell(accent: number): void {
    this.shell.clear();
    panel(this.shell, CARD.x, CARD_Y, CARD.w, CARD.h, accent);
  }

  get isOpen(): boolean {
    return this.visible;
  }

  open(script: DialogueScript): void {
    this.visible = true;
    this.trade = script.onTrade ?? null;
    this.nameText.text = script.name;
    this.paintShell(script.role.color);

    // 职能章：宽度按实测文字算（中文宽度不可硬算），右对齐到卡片内边距
    this.roleText.text = script.role.label;
    const chipW = Math.ceil(this.roleText.width) + 18;
    const chipH = 20;
    const chipX = CARD.x + CARD.w - UI.pad - chipW;
    const chipY = CARD_Y + 11;
    this.roleChip.clear();
    this.roleChip.roundRect(chipX, chipY, chipW, chipH, chipH / 2).fill(script.role.color);
    this.roleText.x = chipX + chipW / 2;
    this.roleText.y = chipY + chipH / 2;

    this.hintText.text = script.hint ?? '';

    // 正文：逐段折行；首行颜色更深，其余作补充说明
    this.body.removeChildren().forEach((c) => c.destroy({ children: true }));
    const rows: string[] = [];
    for (const para of script.lines) rows.push(...wrap(para, LINE_UNITS));
    rows.slice(0, MAX_LINES).forEach((line, i) => {
      const t = label(line, UI.fs.body, i === 0 ? T.ink : T.inkMuted, i === 0 ? '600' : '500');
      t.x = CARD.x + UI.pad;
      t.y = CARD_Y + 56 + i * LINE_H;
      this.body.addChild(t);
    });

    // 按钮右对齐排布；只有「交易」时才需要两列
    if (script.tradeLabel) {
      this.tradePill.setLabel(script.tradeLabel);
      this.tradePill.visible = true;
      this.closePill.x = CARD.x + CARD.w - UI.pad - this.closePill.width;
      this.tradePill.x = this.closePill.x - 8 - this.tradePill.width;
    } else {
      this.tradePill.visible = false;
      this.closePill.x = CARD.x + CARD.w - UI.pad - this.closePill.width;
    }
    this.closePill.y = this.btnY;
    this.tradePill.y = this.btnY;
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.trade = null;
    this.notify();
  }
}
