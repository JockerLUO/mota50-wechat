/**
 * A23 自动通关：按钮够得着、真的会走、说停就停
 *
 * ## 这条断言守的是什么
 *
 * 2026-09-26 把「自动通关」接进界面（工具栏从三颗变四颗）。它有三类**只会在界面上
 * 出现**的失败，headless 判据（`verify:autoplay`）一条都抓不到：
 *
 *   ① **按钮点不着** —— 工具栏几何变了（三颗各 120 → 四颗各 87），
 *      而坐标写在别处就会点到按钮之间的缝里。症状是「按了没反应」，
 *      看起来像功能坏了，其实是布局变了。所以这里**从渲染层取真实几何**。
 *   ② **亮灯但不动** —— 决策器跑起来了、按钮也高亮了，而执行器那一段没接上
 *      （忘记调 `doStep` / 被 `modal` 挡住 / 每帧空转）。只断言 `autoRunning === true`
 *      会**恒真**：那是状态位，不是行为。所以必须断言**步数真的在涨**。
 *   ③ **停不下来** —— 再点一次只是把状态位翻回去，而 ticker 里仍在出手
 *      （或者反过来：状态位没翻、按钮文案没复位），玩家就被锁在一个
 *      自己停不掉的循环里。所以停之后要**再等一段时间确认步数不再涨**。
 *
 * ## 为什么「停下」这一半必须用「等一段再量」而不是「立刻量」
 *
 * 立刻量只能证明那一刻它没动；而 ticker 是按 `AUTO_STEP_MS`（110ms）出手的，
 * 紧接着的那一拍完全可能再走一格。判据要盖住**一个完整周期以上**，
 * 与铁律 #14 里 `BOB_WINDOW_MS` 要盖住一个呼吸周期是同一条道理。
 *
 * ## 开头为什么要 `press('r')`
 *
 * 同 A13：A1~A22 会跑遍全塔，途中可能阵亡，而死亡遮罩是满屏 `hitArea`，
 * 会吃掉所有点击 —— 于是这一条会红成「按钮点不着」，指向完全错误的方向。
 */

async function run(ctx) {
  const { page, check } = ctx;

  /**
   * 一次「像手指那样」的点击：移动 → 停一帧 → 按下 → 停一帧 → 抬起。
   *
   * ⚠️ 不能用 `page.mouse.click()`：Pixi 的 `EventBoundary` 是**每帧**才刷新
   * 命中目标的，down/up 与 move 同 tick 会用到上一帧的 target（见 A13 的详细记录）。
   */
  const tap = async (x, y) => {
    await page.mouse.move(x, y);
    await page.waitForTimeout(60);
    await page.mouse.down();
    await page.waitForTimeout(60);
    await page.mouse.up();
  };

  const snap = () =>
    page.evaluate(() => {
      const p = window.mota.game.__probe();
      return {
        steps: p.steps,
        floor: p.floor,
        pos: p.pos,
        hp: p.hp,
        running: p.autoRunning,
        autoLabel: p.toolbarAutoLabel,
        buttons: p.toolbarButtons
      };
    });

  await page.keyboard.press('r');
  await page.waitForTimeout(250);

  const bad = [];
  const before = await snap();

  // ── ① 几何：四颗按钮必须都在工具栏矩形内、互不重叠 ──
  //
  // 这一条与「点得着」是两件事：按钮出界时点击仍可能落在棋盘上（看得见、点不着），
  // 而重叠时最上面那颗会吃掉另一颗的点击。
  const rect = await page.evaluate(() => window.mota.game.__layout().modules.find((m) => m.id === 'toolbar'));
  if (!before.buttons || before.buttons.length !== 4) {
    bad.push(`工具栏按钮数 ${before.buttons?.length} ≠ 4`);
  } else {
    const out = before.buttons.filter((b) => b.x < rect.x - 0.5 || b.x + b.w > rect.x + rect.w + 0.5);
    if (out.length) bad.push(`按钮出界：${out.map((b) => b.id).join('/')}`);
    for (let i = 0; i < before.buttons.length - 1; i++) {
      const a = before.buttons[i];
      const b = before.buttons[i + 1];
      if (a.x + a.w > b.x + 0.5) bad.push(`按钮重叠：${a.id} 与 ${b.id}`);
    }
    const auto = before.buttons.find((b) => b.id === 'auto');
    if (!auto) bad.push('没有 id === "auto" 的按钮');
  }

  const autoBtn = before.buttons.find((b) => b.id === 'auto');
  if (!autoBtn) {
    check('A23 自动通关：按钮可达、真的会走、说停就停', false, bad.join(' | ') || '找不到 auto 按钮');
    return;
  }

  // ── ② 点「自动通关」→ 按钮变身 + 步数真的涨 ──
  await tap(autoBtn.x + autoBtn.w / 2, autoBtn.y + autoBtn.h / 2);
  await page.waitForTimeout(1500); // ≈ 13 拍，足够走出好几格（包括「撞怪不动」的那种拍子）
  const running = await snap();

  if (!running.running) bad.push('点了按钮但 autoRunning 仍是 false');
  if (running.autoLabel !== '停止自动') bad.push(`按钮文案没变身：「${running.autoLabel}」`);
  if (running.steps <= before.steps) {
    bad.push(`自动通关跑了 1.5s，步数 ${before.steps} → ${running.steps}（亮灯但没动）`);
  }
  // 取证截图拍**运行中**的这一态：按钮高亮成「停止自动」才是这个功能的样子。
  // 放在这一步（而不是停下之后）是有意的 —— 停下来的画面和普通状态没有区别。
  await page.screenshot({ path: 'assets/preview/autoplay-ui.png' });

  // ── ③ 再点一次 → 停下来，且**再等一个周期以上**确认真的不动了 ──
  await tap(autoBtn.x + autoBtn.w / 2, autoBtn.y + autoBtn.h / 2);
  await page.waitForTimeout(200);
  const stopped = await snap();
  if (stopped.running) bad.push('第二次点击没有停（autoRunning 仍为 true）');
  if (stopped.autoLabel !== '自动通关') bad.push(`停下后按钮文案是「${stopped.autoLabel}」—— 状态没复位`);

  // 停下的那一刻之后再等 1s（≈9 拍），步数必须一动不动
  await page.waitForTimeout(1000);
  const afterWait = await snap();
  if (afterWait.steps !== stopped.steps) {
    bad.push(`停止后仍在走：步数 ${stopped.steps} → ${afterWait.steps}`);
  }


  check(
    'A23 自动通关：按钮可达、真的会走、说停就停' +
      `（点击后 1.5s 走了 ${running.steps - before.steps} 步，停止后再等 1s 步数不动）`,
    bad.length === 0,
    (bad.length ? bad.slice(0, 3).join(' | ') + ' ⟵ ' : '') +
      `buttons=${before.buttons.map((b) => `${b.id}@${b.x}+${b.w}`).join(' ')} ` +
      `run=${running.running}/${running.autoLabel} stop=${stopped.running}/${stopped.autoLabel} ` +
      `steps ${before.steps}→${running.steps}→${afterWait.steps}`
  );
}

module.exports = { id: 'a23-autoplay-ui', title: 'A23 自动通关：按钮可达、真的会走、说停就停', run };
