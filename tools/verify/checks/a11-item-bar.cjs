/**
 * A11 道具栏：按需占位
 *
 * 空背包整块 0px 不占位、1 件 75px、10 件 114px 且底距 28px。
 * 期望高度在 Node 侧按「头部 + ceil(n/9) 行 × 槽」独立算一遍，不是读渲染层的函数。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, check } = ctx;

  // ── A11 道具栏：按需占位（空背包时整块不占位） ──
  //
  // 玩家原话是「移除无用的道具栏」。它不是没用 —— 可用道具（铁锹 / 地震卷轴 /
  // 炸药 / 上下飞行器 / 楼层传送器…共 12 种）只能从这一栏使用。真正的问题是
  // **它空着的时候也占着一整块版面**：上一版常驻 18 个空格子、高度写死 114px，
  // 一进游戏就有一块什么都不放的地方。
  //
  // 期望值在这里**独立重算**（与 hud.ts 的 itemBoxHeight 对撞）：
  //   空背包 → 0；1 件 → 1 行；10 件 → 2 行。
  // 最后一条还要检查「两行时卡片底正好距画布底 28」—— 那是版面节奏本身，
  // 只验高度看不出卡片跑偏。
  const ITEM_HEAD = 34;
  const SLOT_SIZE = 36;
  const SLOT_GAP = 3;
  const PER_ROW = 9;
  const PAD_BOTTOM = 5;
  const expectItemH = (n) => {
    if (n <= 0) return 0;
    const rows = Math.ceil(n / PER_ROW);
    return ITEM_HEAD + rows * SLOT_SIZE + (rows - 1) * SLOT_GAP + PAD_BOTTOM;
  };
  const itemFlow = await page.evaluate((ids) => {
    const g = window.mota.game;
    const snap = () => {
      const l = g.__layout();
      const m = l.modules.find((x) => x.id === 'items');
      const bag = g.__probe().bag;
      return {
        h: m.h,
        y: m.y,
        H: l.H,
        hidden: l.itemsHidden,
        placed: l.placed.join(','),
        bag: bag.length,
        // ⚠️ 光记个数不够：「空背包时本该是 0、实际是 1」这种失败，**必须当场说出
        //    是哪一件**，否则要跨十几个判据去追是谁把东西塞进来的（2026-09-26 实测：
        //    第 37 层 __goto 的落点压着炸弹，一路追到这里才看清）。同族的正面判据
        //    是 A1b（调试传送不改背包）——这里只负责把话说清楚。
        bagIds: bag.join('+')
      };
    };
    const none = snap();
    g.__grant(ids[0]);
    const one = snap();
    for (const id of ids.slice(1)) g.__grant(id); // 补到 10 件
    const ten = snap();
    return { none, one, ten };
  }, ['shovel', 'snowflake', 'bomb', 'quakeScroll', 'upFlyer', 'downFlyer',
      'mirrorFlyer', 'floorTeleporter', 'holyWater', 'goldenKey']);
  // ① 空背包：高度 0、不参与排版、渲染层也不可见
  const noBagOk =
    itemFlow.none.h === 0 &&
    itemFlow.none.hidden === true &&
    !itemFlow.none.placed.split(',').includes('items') &&
    itemFlow.none.bag === 0;
  // ② 1 件：一行高
  const oneOk =
    itemFlow.one.h === expectItemH(1) &&
    itemFlow.one.hidden === false &&
    itemFlow.one.placed.includes('items');
  // ③ 10 件：两行高，且卡片底与画布底的距离回到 28（与其它模块同节奏）
  const bottomGap = itemFlow.ten.H - (itemFlow.ten.y + itemFlow.ten.h);
  const tenOk =
    itemFlow.ten.bag === 10 &&
    itemFlow.ten.h === expectItemH(10) &&
    itemFlow.ten.h === 114 &&
    bottomGap === 28;
  check(
    `A11 道具栏：空背包不占位（0px）、1 件 ${expectItemH(1)}px、10 件 ${expectItemH(10)}px 且底距 ${bottomGap}px`,
    noBagOk && oneOk && tenOk,
    !noBagOk
      ? `空背包时：h=${itemFlow.none.h} hidden=${itemFlow.none.hidden} placed=${itemFlow.none.placed} ` +
        `bag=${itemFlow.none.bag}（${itemFlow.none.bagIds || '空'}）` +
        (itemFlow.none.bag
          ? '　← 背包不该有东西：多半是前面某个判据把它弄脏了，先看 A1b'
          : '')
      : !oneOk
        ? `1 件时：h=${itemFlow.one.h}（应 ${expectItemH(1)}）hidden=${itemFlow.one.hidden}`
        : !tenOk
          ? `10 件时：h=${itemFlow.ten.h}（应 ${expectItemH(10)}=114）bag=${itemFlow.ten.bag} 底距=${bottomGap}（应 28）`
          : `空背包 0 → 1 件 ${itemFlow.one.h} → 10 件 ${itemFlow.ten.h}`
  );

}

module.exports = { id: "a11-item-bar", title: "A11 道具栏：按需占位", run };
