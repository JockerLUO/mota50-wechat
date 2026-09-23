/**
 * A8 版面：间隙相等、棋盘没被挤小、棋盘盒与面板同栏
 *
 * 依赖 A11 的结论（空背包不占位）——空背包若仍占位，「间隙相等」量的就是错的东西。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, check } = ctx;

  // ── A8 版面：间隙相等、棋盘没被挤小、棋盘盒与面板同上下一栏 ──
  //
  // 玩家这一轮的原话是「各模块间隙加大，不要挤占游戏地图的空间」。
  // 两件事都要能量：间隙读的是**渲染树里各面板回填的卡片矩形**，
  // 棋盘那一块用 `boardBox()`（格子区 + 塔壁 + 城垛的整体视觉盒）。
  //
  // ⚠️ 必须用视觉盒而不是格子区：上一版就是拿格子区当边界算间隙，
  // 而塔壁向上还多占 24px（城垛 10 + 壁厚 14），于是"间隙 20"在屏幕上
  // 实际是 −4 —— 城垛压在状态卡上，看单个文件发现不了。
  //
  // 棋盘 352 / 格子 32 是**上一版的值**，写死在这里当锚点：
  // 这一版加间隙的来源是"把设计稿的黑边吃回来"，不是缩棋盘。
  const layout = await page.evaluate(() => window.mota.game.__layout());
  const BOARD_SPAN_KEPT = 352;
  const BOARD_CELL_KEPT = 32;
  // 期望值在这里**独立写死**（与 hud.ts 的 LAYOUT.gap / LAYOUT.boardGap 一一对应）。
  // `after` 指的是「这一项之后那段缝」：top = 状态卡之前、hud = 状态卡与棋盘之间…
  //
  // ⚠️ **模块序列末尾那一条不算「间距」**，它是自由留白：
  // 空背包时道具栏整块不占位（见 A11），`detail` 之后就是到底边的一片场景（170px）；
  // 有道具时又回到 28。按构造它恒等于 `H −（最后一个模块的底）`，
  // 拿它做相等断言是同义反复，所以只量**模块之间**那几条。
  // 判据用「最后一个真的参与排版的模块」来定位，而不是写死索引 ——
  // 道具栏在不在序列里是动态的。
  const GAP_BETWEEN = { top: 28, hud: 40, board: 40, toolbar: 28, detail: 28, items: 28 };
  const lastPlaced = layout.placed[layout.placed.length - 1];
  const gapBad = layout.gaps
    .filter((g) => g.after !== lastPlaced)
    .filter((g) => g.value !== GAP_BETWEEN[g.after]);
  const boardKept = layout.boardSpan === BOARD_SPAN_KEPT && layout.boardCell === BOARD_CELL_KEPT;
  // 棋盘视觉盒的宽 = 面板宽 → 两者左右两端对齐，是「同一栏」的硬指标
  const aligned = layout.boardBox.w === layout.modules[0].w;
  // 棋盘前后那两条缝必须比面板之间更宽 —— 「不挤占地图空间」就是这一条
  const boardRoomier =
    layout.gaps.find((g) => g.after === 'hud').value >
    layout.gaps.find((g) => g.after === 'toolbar').value;
  // 空背包这一条要真的成立，A8 量的间隙才有意义
  const itemsDetached = !layout.itemsHidden || !layout.placed.includes('items');
  check(
    `A8 版面：间隙 ${GAP_BETWEEN.top}px、棋盘前后 ${GAP_BETWEEN.hud}px，棋盘 ${layout.boardSpan}px（未缩）、与面板同栏`,
    gapBad.length === 0 && boardKept && aligned && boardRoomier && itemsDetached,
    gapBad.length > 0
      ? `间隙不合：${gapBad.map((g) => `${g.after}=${g.value}（应 ${GAP_BETWEEN[g.after]}）`).join(' ')}`
      : !boardKept
        ? `棋盘被改了：span=${layout.boardSpan}（应 ${BOARD_SPAN_KEPT}）cell=${layout.boardCell}（应 ${BOARD_CELL_KEPT}）`
        : !aligned
          ? `棋盘盒宽 ${layout.boardBox.w} ≠ 面板宽 ${layout.modules[0].w}`
          : !boardRoomier
            ? '棋盘前后那两条缝没有比面板之间更宽'
            : !itemsDetached
              ? `道具栏空着但还占在排版序列里：placed=${layout.placed.join(',')}`
              : layout.gaps.map((g) => `${g.after}=${g.value}`).join(' ')
  );

}

module.exports = { id: "a08-board-layout", title: "A8 版面：间隙相等、棋盘没被挤小、棋盘盒与面板同栏", run };
