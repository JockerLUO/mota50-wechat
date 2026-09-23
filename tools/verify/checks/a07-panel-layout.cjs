/**
 * A7 面板版式：标题落在同一套坐标上
 *
 * 六块面板（detail / items / floor / dialogue / merchant / shop）的标题必须对齐 ——
 * 面板是同一个 `panel()` 底板函数画的，标题跑偏说明某个调用点自己算了坐标。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, check } = ctx;

  // ── A7：面板版式一致性 ────────────────────────────────────────
  //
  // 「六块面板看起来是同一套 UI」这件事，靠眼看是**不可靠**的：
  // 上一轮的交易浮层标题横向用了 `+UI.pad`(14)，而短条占 12..15 ——
  // 标题压在自己的短条上，差 1px，截图上根本看不出来，
  // 但同一时刻其它五块面板用的是 +23，「两套版式」是看得出来却又说不清在哪的。
  //
  // 所以这里量的是**渲染树里的真实坐标**：Game.__panels() 把每块面板的标题
  // 换算成「相对自己卡片左上角的偏移」。期望值在 Node 侧独立写死 ——
  // 与 theme.ts 的 UI.titleX / titleYTitle / titleYHead 一一对应，
  // 改了令牌而没同步这里，就是一条会红。
  //
  // ⚠️ 状态卡（StatusBar）**刻意不在这一组里**：它的左侧是 40×40 的楼层徽章，
  // 徽章就占着短条的位置，标题要按徽章实际宽度往后量（`STATUS_TEXT_W`）——
  // 与这六块「短条 + 标题」的面板不是同一种结构，硬套同一个偏移反而会错。
  const PANEL_LAYOUT = { dx: 23, dyBySize: { 15: 12, 12.5: 14 } };
  const EXPECTED_PANELS = ['detail', 'items', 'floor', 'dialogue', 'merchant', 'shop'];
  // 每块浮层都得先真的打开 —— 交易类浮层的卡片高度由 open() 现算，
  // 没开过的面板 `__panels()` 直接不出（卡片矩形还是 0，量出来会是「面板在 (0,0)」）。
  // 商人只在有货的层摆摊（第 6 层有蓝钥匙），商店在第 4 层。
  await page.evaluate(() => {
    const g = window.mota.game;
    g.__goto(6);
    g.openFloorPanel('browse');
    g.openMerchant();
    g.__goto(4);
    g.openShop();
  });

  const panels = await page.evaluate(() => window.mota.game.__panels());
  const seen = new Set(panels.map((p) => p.panel));
  const missing = EXPECTED_PANELS.filter((p) => !seen.has(p));
  const bad = panels.filter((p) => {
    const want = PANEL_LAYOUT.dyBySize[p.fontSize];
    return want === undefined || p.dx !== PANEL_LAYOUT.dx || p.dy !== want;
  });

  check(
    `A7 面板版式：${panels.length} 块面板的标题落在同一套坐标上（dx=${PANEL_LAYOUT.dx}）`,
    missing.length === 0 && bad.length === 0,
    missing.length > 0
      ? `没量到这些面板：${missing.join(', ')}`
      : bad.length === 0
        ? panels
            .map((p) => `${p.panel}(${p.dx},${p.dy})`)
            .join(' ')
        : `偏移不合令牌的：${JSON.stringify(bad)}`
  );

}

module.exports = { id: "a07-panel-layout", title: "A7 面板版式：标题落在同一套坐标上", run };
