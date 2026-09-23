/**
 * 应用编排门面（barrel）。
 *
 * `app.ts` 曾是一个 1013 行的单文件。拆成目录后外部 import 路径不用改：
 * `./app` 解析到这里，而 `Game` 仍然是那个 `Game`。
 *
 *   game.ts           编排层本体（输入分发 / 主循环 / 状态机）
 *   pathing.ts        点击寻路（纯算法）
 *   death-overlay.ts  阵亡遮罩（纯绘制）
 *   probe.ts          只读快照（探针）
 *
 * ⚠️ 这个目录**只导出 `Game`**。其余三块是内部实现，不是公共 API ——
 *    想让别处直接 import `pathing.ts`，先问「它为什么会知道寻路」。
 */

export { Game } from './game';
