/**
 * 文字与面板底板 —— HUD 里所有「字」和所有「卡片底」的唯一来源。
 *
 * ## 为什么单独一个文件
 *
 * 原来这些散在 `hud.ts` 的四个不同位置（版式之后、文字池附近、详情卡之前）。
 * 它们其实是**同一条约定**的两半：
 *   - `label()` / `panel()` 规定「字长什么样、卡片底长什么样」；
 *   - `clip()` / `wrap()` / `unitsPerLine()` 规定「一行能放几个字」。
 * 任何一块面板都无法只用其中一半，所以它们必须待在一起。
 *
 * ## 两条贯穿全项目的硬约定
 *
 * **① 文字对象预建 + 改 text，不在每次刷新时销毁重建。**
 *    悬停会高频触发刷新，反复 `new Text()` 会造成明显的 GC 抖动。
 *    `TextPool` 就是这条约定的泛化：固定行数的池子，永久复用。
 *
 * **② 所有面板走同一套底板（`panel()`），不写死圆角与内边距。**
 *    曾经各面板各写各的，画面就散成了好几种风格。
 */

import { Container, Graphics, Text, type TextStyleOptions } from 'pixi.js';
import { T, UI, realm } from '../theme';

const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif';

/**
 * 文本光栅化分辨率。
 *
 * 以前这里**写死 2**：手机是 dpr=3，文字按 2× 光栅化之后上屏还要再被拉 1.5 倍 ——
 * 中文笔画本来就细，这一道拉伸就是「文字发虚」的全部来源，而它影响的是**每一块面板**。
 * 现在跟随渲染器分辨率，由 `src/app/game.ts` 在 init 之后写进来。
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

/** 面板小标题：色条后面那行字。原先在 `hud.ts` 里是私有的，拆文件后要跨模块用。 */
export function headerTitle(text: string, fill = T.ink): Text {
  return label(text, UI.fs.head, fill, '700');
}

// ── 通用浮层文字池 ──────────────────────────────────────────────────

/** 固定行数的文字池，避免高频刷新时反复创建 Text */
export class TextPool extends Container {
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

// ── 宽度估算（clip / wrap / unitsPerLine 必须共用同一套单位口径）────────

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
