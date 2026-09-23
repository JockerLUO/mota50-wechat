/**
 * A13 楼层浏览：选完还能返回，返回后输入复活
 *
 * **状态机死路**的回归判据：退出「查看别处」模式的入口必须在常驻 UI 上（工具栏），
 * 不能放进浮层里。所以最后一步是「返回后**真的能走一格**（步数 0→1）」，
 * 而不是只判「调了 returnFromBrowse」——后者在勇者被隐藏、输入门死的情况下照样能通过。
 *
 * 开头的 `press()` 是必要的：A1~A12 会跑遍全塔，死亡遮罩是满屏 hitArea，会吃掉所有点击。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, check } = ctx;

  // ── A13 楼层浏览：选完还能返回，返回后输入复活 ──
  //
  // 修的是一条**死路**：选完楼层后面板收起，而 `browseFloor` 仍非空 —— 于是
  // 「唯一能返回的入口」消失了，棋盘输入又被 `browseFloor` 全量挡掉（所有入口
  // 都写 `browseFloor !== null` 就 return），勇者还被隐藏了。触摸设备没有 Esc，
  // 玩家彻底卡死。实测症状是「点棋盘步数 0 → 0」这种**静默**的没反应。
  //
  // 修法不是「别收面板」，而是**把出口挪到一个收起来也还在的地方**：
  // 工具栏中间那颗按钮在浏览态下变成「返回第 N 层」并高亮。收面板反而是必须的 ——
  // 面板卡片 y=240..700 会把棋盘（178..544）和工具栏（584..616）一起盖住，
  // 留着它既看不清点开的那一层，也按不到那颗返回键（实测：点上去毫无反应，
  // Pixi `hitTest` 命中的是面板自己的全屏遮罩）。
  //
  // 断言只看行为，不看代码：
  //   ① 选完这一层后面板收起、棋盘真的换成了第 7 层、勇者被隐藏；
  //   ② 工具栏摆出「返回第 1 层」——文案报的是**要回到哪一层**（勇者自己那层）；
  //   ③ 点它之后回到自己那层、**勇者回来了**；
  //   ④ 然后棋盘**真的能走**（步数变了）—— 这才是「无法继续操作」的正面反驳。
  //
  // ⚠️ 顺带抓住一个真 bug：`Toolbar.browseLabel` 一度写成读 `browsePill.label`
  //    （Pixi `Container.label`，渲染树标记字符串），于是这条断言永远看到标记而
  //    不是文案。所以这里比的是**完整文案**，不是「非空」。
  const cellCenter = (cx, cy) => ({ x: 34 + cx * 32 + 16, y: 178 + cy * 32 + 16 });
  /**
   * 一次「像手指那样」的点击：移动 → 停一帧 → 按下 → 停一帧 → 抬起。
   *
   * ⚠️ 不能图省事用 `page.mouse.click()` —— 它在同一毫秒里发完 move/down/up，
   *    而 Pixi 的事件边界是在**帧**里更新命中目标的：down 会沿用上一次移动
   *    算出来的那个目标。实测后果是「点面板里的楼层格子毫无反应」，而且
   *    `page.mouse.click()` 点工具栏却是好的（因为那一下之前刚移动过），
   *    于是症状看着像「面板坏了」。中间留一帧就正常了。
   */
  const tap = async (x, y) => {
    await page.mouse.move(x, y);
    await page.waitForTimeout(60);
    await page.mouse.down();
    await page.waitForTimeout(60);
    await page.mouse.up();
  };
  const browseBtn = { x: 20 + 120 + 10 + 60, y: 584 + 16 }; // 工具栏三按钮的中间那颗
  const floorCell = (i) => ({
    // FLOOR_CARD x=20 y=240 w=380 head=76；6 列 × 50 宽、间距 4；格高 34、行距 38
    x: 20 + Math.round((380 - (6 * 50 + 5 * 4)) / 2) + (i % 6) * 54 + 25,
    y: 240 + 76 + Math.floor(i / 6) * 38 + 17
  });

  // ⚠️ 先把游戏**重开**，否则这一组断言会红得莫名其妙。
  //
  // A1~A12 会 `__goto` 跑遍全塔，而有些楼层的落点正好在**巫师领域**里 ——
  // 于是勇者在中途阵亡，`showDeath()` 往 `deathLayer`（舞台最顶层）铺了一张
  // 满屏 `eventMode='static'` + `hitArea` 的 Graphics。那张遮罩是全屏的，
  // 它会**吃掉所有点击**，症状就是「点面板里的楼层格子毫无反应」——
  // 实测排查时 Pixi 的 `hitTest` 命中的正是 `root.children[10].children[0]`。
  // `r` 走的是游戏自己的重开路径（清 deathLayer、复位状态、回到第 1 层），
  // 比在测试里手动拆遮罩更贴近真实 —— 玩家也是这么复活的。
  await page.keyboard.press('r');
  await page.waitForTimeout(250);

  const snap = () =>
    page.evaluate(() => {
      const g = window.mota.game;
      const p = g.__probe();
      // `floorPanel` 是 TS private，运行时可直接读；用 `visible` 而不是另加探针字段 ——
      // 面板开没开这件事本身就写在渲染树上，加一层转发只会多一个漂移点。
      return {
        browsing: p.browsing,
        displayFloor: p.displayFloor,
        floor: p.floor,
        steps: p.steps,
        modal: p.modal,
        dead: p.dead,
        label: String(p.toolbarBrowseLabel ?? ''),
        panelOpen: g.floorPanel.visible,
        panelMode: g.floorPanel.mode,
        // 「返回后角色没了」是用户的原话，所以直接把勇者层的可见性量出来 ——
        // 它比任何间接推断都更贴题（`heroLayer` 是 TS private，运行时可直接读）
        heroVisible: g.board.heroLayer.visible
      };
    });

  await tap(browseBtn.x, browseBtn.y); // 「楼层浏览」
  await page.waitForTimeout(180);
  const opened = await snap();
  await tap(floorCell(7).x, floorCell(7).y); // 「第 7 层」格
  await page.waitForTimeout(220);
  const afterPick = await snap();

  // 此刻工具栏中间那颗按钮已经变成「返回第 1 层」—— 文案报的是**要回到哪一层**
  // （勇者自己那层），不是正在看的那一层。这一点写错会让断言一直红得很冤枉。
  const wantBack = `返回第 ${afterPick.floor} 层`;
  await tap(browseBtn.x, browseBtn.y); // 此时它就是「返回」
  await page.waitForTimeout(240);
  const afterReturn = await snap();

  const beforeWalk = afterReturn.steps;
  const upCell = cellCenter(5, 9); // 第 1 层勇者站在 (5,10)，正上方就是可走的空地
  await tap(upCell.x, upCell.y);
  await page.waitForTimeout(700);
  const afterWalk = await snap();

  const a13Bad = [];
  if (opened.dead || afterPick.steps !== 0) {
    a13Bad.push(
      `重开之后不干净（dead=${opened.dead} steps=${afterPick.steps}）—— ` +
        `多半是前面某条断言把勇者留在了阵亡状态，那张死亡遮罩会吃掉全部点击`
    );
  }
  if (opened.panelOpen !== true) a13Bad.push('点「楼层浏览」后面板没打开');
  // 选完必须收起面板：面板卡片 y=240..700 会把棋盘（178..544）和工具栏（584..616）
  // 一起盖住 —— 留着面板，既看不清点开的那一层，也按不到工具栏上的「返回」。
  if (afterPick.panelOpen !== false) {
    a13Bad.push('选完楼层后面板没收起 —— 它盖着棋盘也让工具栏的「返回」按不着');
  }
  if (afterPick.browsing !== true) a13Bad.push(`选完楼层后 browsing=${afterPick.browsing}（没进入浏览态）`);
  if (afterPick.displayFloor !== 7) a13Bad.push(`选完第 7 层后棋盘显示的是第 ${afterPick.displayFloor} 层`);
  if (afterPick.floor !== 1) a13Bad.push(`浏览不该改变勇者所在层，但它变成了第 ${afterPick.floor} 层`);
  if (afterPick.heroVisible !== false) {
    a13Bad.push('浏览别的层时勇者不该还站在棋盘上（这一格是那一层的地形）');
  }
  if (afterReturn.heroVisible !== true) {
    a13Bad.push('返回后勇者没有回到棋盘上 —— 这就是用户说的「返回后角色没了」');
  }
  if (afterPick.label !== wantBack) {
    a13Bad.push(`选完之后工具栏文案是「${afterPick.label}」而不是「${wantBack}」—— 返回入口没摆出来`);
  }
  if (afterReturn.browsing !== false) a13Bad.push(`点了返回但仍在浏览态（browsing=${afterReturn.browsing}）`);
  if (afterReturn.displayFloor !== 1) a13Bad.push(`返回后棋盘还停在第 ${afterReturn.displayFloor} 层`);
  if (afterReturn.label !== '楼层浏览') a13Bad.push(`返回后工具栏文案是「${afterReturn.label}」—— 状态没复位`);
  if (afterReturn.panelOpen !== false) a13Bad.push('点了返回面板还开着');
  if (afterWalk.steps <= beforeWalk) {
    a13Bad.push(`返回后点棋盘步数 ${beforeWalk} → ${afterWalk.steps}，人还是不动`);
  }
  check(
    `A13 楼层浏览：选完第 7 层后面板收起、工具栏摆出「${afterPick.label}」；` +
      `返回后勇者归位且棋盘恢复可走（步数 ${beforeWalk} → ${afterWalk.steps}）`,
    a13Bad.length === 0,
    (a13Bad.length ? a13Bad.slice(0, 3).join(' | ') + ' ⟵ ' : '') +
      `opened=${JSON.stringify(opened)} pick=${JSON.stringify(afterPick)} ` +
      `ret=${JSON.stringify(afterReturn)} steps ${beforeWalk}→${afterWalk.steps}`
  );

}

module.exports = { id: "a13-floor-browse", title: "A13 楼层浏览：选完还能返回，返回后输入复活", run };
