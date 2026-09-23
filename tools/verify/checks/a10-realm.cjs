/**
 * A10 位面：地平线随楼层单调上移且可复现
 *
 * 查三件事：单调上移、同一层两次读数一致（可复现）、**背景跟随显示层**
 * （浏览第 3 层时画的是第 3 层的位面，不是当前所在层）。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, check } = ctx;

  // ── A10 位面：越往上星空越多 ──
  //
  // 背景的地平线高度由楼层位面决定。三条硬指标：
  //   ① 同一层重复问，画出来的地平线一致（背景是确定性的，星点也不该跳）；
  //   ② 从第 1 层到第 50 层，地平线**单调不升**（星空占比只增不减）；
  //   ③ 背景真的画的是当前显示层（`paintedFloor` 与 displayFloor 一致），
  //      否则换层后背景会慢一拍 —— 这种 bug 只有把两者分开报才抓得住。
  const realms = await page.evaluate(() => {
    const g = window.mota.game;
    const at = (f) => {
      g.__goto(f);
      return g.__probe().realm;
    };
    const f1 = at(1);
    at(2); // 中间穿插一层，确保第二次回到第 1 层是**真的重绘**过
    const f1again = at(1);
    const f13 = at(13);
    const f26 = at(26);
    const f50 = at(50);
    const bad = at(3);
    return { f1, f1again, f13, f26, f50, bad };
  });
  const hz = [realms.f1.horizon, realms.f13.horizon, realms.f26.horizon, realms.f50.horizon];
  const monotone = hz.every((v, i) => i === 0 || v <= hz[i - 1] + 1e-9);
  // 离开一层再回来，地平线必须回到同一个值 —— 星点用的是固定种子的
  // mulberry32，整层背景因此是可复现的（否则每次回来星星都换位置）
  const stable = realms.f1.horizon === realms.f1again.horizon;
  // 背景画的是不是"当前显示层"：`paintedFloor` 由 Backdrop 自己报，
  // 与 state.floor 分开报，才有可能发现"背景慢一拍"
  const followed = realms.bad.paintedFloor === 3;
  check(
    `A10 位面：地平线随楼层上移（第 1 层 ${hz[0].toFixed(2)} → 第 50 层 ${hz[3].toFixed(2)}）且可复现`,
    monotone && stable && followed,
    `单调=${monotone} 可复现=${stable}（1 层 ${realms.f1.horizon} / 回来 ${realms.f1again.horizon}）` +
      ` 背景跟随=${followed}（第 3 层时 paintedFloor=${realms.bad.paintedFloor}）`
  );

}

module.exports = { id: "a10-realm", title: "A10 位面：地平线随楼层单调上移且可复现", run };
