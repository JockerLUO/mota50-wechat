/**
 * HUD 门面（barrel）。
 *
 * ## 这个文件为什么存在
 *
 * `hud.ts` 曾经是一个 1270 行的单文件，里面塞了六件互相无关的事。
 * 拆成目录之后，**外部调用方的 import 路径一个字都不用改** ——
 * `./render/hud` 会解析到这里的 `index.ts`，导出面与拆分前完全一致。
 * 这是「拆分不产生改动涟漪」的关键：`src/app/` / `src/render/board/` / `backdrop.ts` /
 * `dialogue-panel.ts` / `trade.ts` 五处引用全部原样保留。
 *
 * ## 目录职责
 *
 *   layout.ts       版式契约（LAYOUT / boardBox）—— 五块面板 + 背景 + 棋盘 + 断言共用
 *   text.ts         字与卡片底（label / panel）+ 宽度估算（clip / wrap / unitsPerLine）
 *   status-bar.ts   状态卡（唯一位置全固定的一块）
 *   detail-panel.ts 详情卡（文案逻辑最重的一块）
 *   item-bar.ts     道具栏（唯一高度动态的一块）
 *   toolbar.ts      工具栏 + 可复用按钮 Pill（对话框脚部也在用）
 *   floor-panel.ts  楼层面板（唯一带模态语义的一块）
 *
 * 拆分的判据不是行数，而是**依赖方向**：`layout` 与 `text` 是被依赖的，
 * 其余五块互不依赖、只向上依赖这两者。任何一层想反向 import 都说明边界错了。
 */

export { LAYOUT, boardBox } from './layout';
export {
  TextPool,
  clip,
  headerTitle,
  label,
  panel,
  setTextResolution,
  textResolution,
  unitsPerLine,
  wrap
} from './text';
export { StatusBar } from './status-bar';
export { DetailPanel, describeEffect, statCn, type BattleLike, type DetailTarget } from './detail-panel';
export { ItemBar, itemBoxHeight } from './item-bar';
export { Pill, Toolbar } from './toolbar';
export { FloorPanel } from './floor-panel';
