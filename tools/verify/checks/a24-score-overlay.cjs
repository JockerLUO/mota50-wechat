/**
 * A24 计分视图：徽标出现、按类别上色、算式进对话框；底部自动步数条
 *
 * ## 这条断言守的是什么
 *
 * 2026-09-27 把工具栏第一颗按钮从「编辑视图」改成「计分」，并把自动通关那套
 * 评分（`src/game/score.ts` 的三套刻度）接到棋盘上。它有三类**只会在界面上出现**
 * 的失败，headless 判据（`verify:autoplay`）一条都抓不到：
 *
 *   ① **数字不是那个数** —— 界面上自己又算了一遍，或者取了别的刻度/别的层。
 *      症状是「徽标写着 223、AI 却按 -180 行动」，而两边各自都对得上自己的期望值。
 *      所以这里拿**两个独立来源对撞**：`__scores()`（引擎算出来喂给棋盘的）
 *      vs `board.__scoreBadges()`（真的画在屏上的那一批，读渲染树节点）。
 *      中间那一步「数字 → 短字」的格式化规则在本文件里**独立重实现**一遍
 *      （见下面的 `fmtBadge`）—— 这正是「改了产出方、忘了改消费方」能被抓到的地方。
 *
 *   ② **画出来了但看不见** —— 徽标位置算错、被实体盖住、按类别上错色。
 *      所以位置要按 `cellPx` 独立算一遍（不抄源码里的式子），
 *      颜色要对上类别表，而且**至少要出现两种不同的颜色**
 *      （用户的口径原话：「不同类型的分显示不同的颜色」）。
 *
 *   ③ **算式没进对话框** —— 用户点名要的是「在对话框内显示分值的计算过程」。
 *      只断言 `modal === 'dialogue'` 等于没断言（框可以开着而里面是空的）。
 *      所以读的是 `dialogueLines` —— 面板**折行之后真正画出来**的那几行，
 *      并要求第一行是 `数字 = …（…）…` 的形态。
 *
 * 底部那条「自动 N 步」单列成第二半：它要回答「AI 做错事时是第几步、站在哪儿」，
 * 所以那个 N 必须与真实计数器逐字一致（`__probe().autoSteps`），
 * 而且**停下之后不许消失**（自动通关自己判定走投无路时，玩家正要读它）。
 *
 * ## 开头为什么要 `press('r')`
 *
 * 同 A13 / A23：前面 A1~A23 会跑遍全塔，途中可能阵亡、可能留下开着的浮层。
 * 而计分视图与步数条都是「一局之内」的状态，必须从干净的一局量起。
 *
 * ## 结尾要收干净
 *
 * 计分视图会**多画出隐藏实体**（埋在墙里的红钥匙与下飞行器）——
 * 留着它会让后面的判据看到一张不一样的棋盘。所以无论成败，末尾一律
 * 关视图 + 停自动 + 重开。
 */

/**
 * ⚠️ **本文件独立重实现**的短字格式（与 `app/score-overlay.ts` 的 `fmtScoreValue` 同规）。
 *
 * 抄一份到判据里是**故意**的：两边都由同一句自然语言派生（「≥10000 上 k、
 * ≥1e6 上 M、打不动是 ∞」），但派生路径不同，所以能抓到「改了实现忘了改另一处」。
 * 直接用被测实现来算期望值，期望值会跟着实现一起变 —— 那条判据就恒绿了。
 */
function fmtBadge(v) {
  if (v <= -1e8) return '∞'; // 打不动（UNREACHABLE_SCORE = -1e9）
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}${Math.round(a / 1e6)}M`;
  if (a >= 10000) return `${sign}${Math.round(a / 1000)}k`;
  return `${sign}${Math.round(a)}`;
}

/** 类别配色 —— 与 `theme.ts` 的 `SCORE_STYLE[*].chip` 独立写死一份，用来对撞 */
const CHIP = { item: 0xfbbf24, monster: 0xfca5a5, npc: 0x6ee7a8 };

async function run(ctx) {
  const { page, check } = ctx;

  /** 一次「像手指那样」的点击（Pixi 每帧才刷新命中目标，见 A23 的说明） */
  const tap = async (x, y) => {
    await page.mouse.move(x, y);
    await page.waitForTimeout(60);
    await page.mouse.down();
    await page.waitForTimeout(60);
    await page.mouse.up();
  };

  const snap = () =>
    page.evaluate(() => {
      const g = window.mota.game;
      const p = g.__probe();
      return {
        floor: p.floor,
        pos: p.pos,
        atk: p.atk,
        gold: p.gold,
        scoreView: p.scoreView,
        scoreLabel: p.toolbarScoreLabel,
        buttons: p.toolbarButtons,
        cell: g.board.cellPx,
        badges: g.board.__scoreBadges(),
        scores: g.__scores(),
        modal: p.modal,
        dialogue: p.dialogue,
        lines: p.dialogueLines,
        run: p.runStrip,
        autoSteps: p.autoSteps,
        autoRunning: p.autoRunning
      };
    });

  const bad = [];
  const note = [];

  await page.keyboard.press('r');
  await page.waitForTimeout(250);

  // ── ① 关闭态的基线 ────────────────────────────────────────────────
  const before = await snap();
  if (before.scoreView) bad.push('重开后计分视图仍是开着的');
  if (before.scoreLabel !== '计分') bad.push(`初始按钮文案是「${before.scoreLabel}」而不是「计分」`);
  if (before.badges.length !== 0) bad.push(`没开计分视图却画了 ${before.badges.length} 枚徽标`);
  if (before.run.visible) bad.push('重开后底部步数条还留着');

  const scoreBtn = before.buttons.find((b) => b.id === 'score');
  if (!scoreBtn) {
    check('A24 计分视图：徽标、配色、算式、步数条', false, '工具栏里找不到 id === "score" 的按钮');
    return;
  }

  // ── ② 点按钮（真实点击，几何从渲染层取） ──────────────────────────
  await tap(scoreBtn.x + scoreBtn.w / 2, scoreBtn.y + scoreBtn.h / 2);
  await page.waitForTimeout(300);
  const on = await snap();

  if (!on.scoreView) bad.push('点了「计分」但 scoreView 仍是 false');
  if (on.scoreLabel !== '关闭计分') bad.push(`点了之后按钮文案是「${on.scoreLabel}」—— 没变身`);
  if (on.scores.length === 0) bad.push('第 1 层一个可计分的目标都没有（判据前提不成立）');
  if (on.badges.length !== on.scores.length) {
    bad.push(`画出来的徽标 ${on.badges.length} 枚 ≠ 算出来的分数 ${on.scores.length} 条`);
  }
  // 开启时就该把「怎么算的」摊开一次 —— 用户要的是「在对话框内显示计算过程」
  if (!on.dialogue) bad.push('开启计分视图后没有弹出对话框（算式没地方显示）');
  const eq = on.lines[0] ?? '';
  if (!/^-?(∞|\d[\d.,]*k?M?) = .+（.+）/.test(eq)) {
    bad.push(`对话框第一行不是算式形态：「${eq}」`);
  }

  // ── ③ 徽标 ↔ 分数逐条对账（数字 / 类别 / 颜色） ──────────────────
  const byKey = new Map(on.scores.map((s) => [s.key, s]));
  const unknown = [];
  const wrongText = [];
  const wrongColor = [];
  const colors = new Set();
  for (const b of on.badges) {
    const s = byKey.get(b.key);
    if (!s) {
      unknown.push(b.key);
      continue;
    }
    const want = fmtBadge(s.total);
    if (b.text !== want) wrongText.push(`${b.key}：画的是「${b.text}」，应为「${want}」`);
    if (b.color !== CHIP[s.type]) {
      wrongColor.push(`${b.key}（${s.type}）：颜色 0x${b.color.toString(16)} ≠ 0x${CHIP[s.type].toString(16)}`);
    }
    colors.add(b.color);
  }
  if (unknown.length) bad.push(`${unknown.length} 枚徽标挂在算不出来的格子上：${unknown.slice(0, 2).join(' ')}`);
  if (wrongText.length) bad.push(`${wrongText.length} 枚数字不符：${wrongText.slice(0, 2).join('；')}`);
  if (wrongColor.length) bad.push(`${wrongColor.length} 枚颜色不符：${wrongColor.slice(0, 2).join('；')}`);
  // 「不同类型的分显示不同的颜色」—— 样本里至少要出现两类，否则这条判据是空的
  if (colors.size < 2) bad.push(`屏上只有 ${colors.size} 种徽标颜色（本层应当同时有道具与怪物）`);

  // ── ④ 位置：徽标落在它那一格的底边中点（按 cellPx 独立算） ────────
  const offPos = [];
  for (const b of on.badges) {
    const s = byKey.get(b.key);
    if (!s) continue;
    const wantX = (s.x + 0.5) * on.cell;
    const wantY = (s.y + 1) * on.cell - 6;
    if (Math.abs(b.x - wantX) > 1 || Math.abs(b.y - wantY) > 1) {
      offPos.push(`${b.key}：画在 (${b.x},${b.y})，应在 (${wantX},${wantY})`);
    }
  }
  if (offPos.length) bad.push(`${offPos.length} 枚徽标不在自己那一格脚下：${offPos.slice(0, 2).join('；')}`);

  // ── ⑤ 属性一变就重算 ─────────────────────────────────────────────
  //
  // 落在**第 1 层**、用 `__grant('redGem')`（攻击 +2）来改三围。
  //
  // ⚠️ 这条判据的第一版在**第 2 层** `__gold(3000)`，两处都选错了，实测：
  //   · 第 1 层给金币 —— **一条分都不动**（本层没有商人，唯一的 NPC 是恒 -1 的稻草人，
  //     怪物分里的「金币 × 金价」只是不构成理由的那一项），于是判据自己红了而功能是好的；
  //   · 第 2 层给金币 —— 只有那笔 `price=0 / goldDelta=1000` 的赠礼让「金币余量」项动，
  //     而它是**点击后**才结算的，给金币本身不改变任何一行分。
  // 挑局面要挑「两种实现会给出不同结果」的那个（铁律 #49）——
  // 第 1 层有红宝石，`__grant` 走的是 `state` 改动 + `sync()`，与玩家捡宝石同一条路，
  // 实测 **16 条**分数跟着变。
  await page.evaluate(() => window.mota.game.__goto(1));
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const st0 = await snap();
  const atk0 = st0.atk;
  const pairA = new Map(st0.scores.map((s) => [s.key, s.total]));
  await page.evaluate(() => window.mota.game.__grant('redGem'));
  await page.waitForTimeout(250);
  const st1 = await snap();
  const changed = st1.scores.filter((s) => pairA.has(s.key) && pairA.get(s.key) !== s.total);
  if (st1.atk === atk0) bad.push('__grant(红宝石) 没改动攻击（判据前提不成立）');
  if (changed.length < 5) bad.push(`攻击 +2 之后只有 ${changed.length} 条分数跟着变（实测应有十几条）`);
  // 光「分数变了」不够 —— 用户要的是**界面上**那个数跟着变。逐条对账，
  // 屏上还挂着旧值的徽标要指名道姓报出来（不然只是「引擎重算了、画面没刷」）。
  const stale = [];
  for (const bd of st1.badges) {
    const s = st1.scores.find((x) => x.key === bd.key);
    if (s && bd.text !== fmtBadge(s.total)) stale.push(`${bd.key}：屏上「${bd.text}」应为「${fmtBadge(s.total)}」`);
  }
  if (stale.length) bad.push(`分数变了但屏上 ${stale.length} 枚徽标还是旧值：${stale.slice(0, 2).join('；')}`);
  note.push(`攻击 ${atk0}→${st1.atk} 后有 ${changed.length} 条分数变化`);

  // ── ⑥ 「持续显示」：手动走一格之后徽标还在 ────────────────────────
  // 「走一格」必须**真的走**：站桩不动也能让徽标留着，那就等于没验。
  // 方向逐个试（第 1 层出生点四邻未必都可通行），走动了才停。
  const beforeWalk = await snap();
  const walk = await page.evaluate(() => {
    const g = window.mota.game;
    const p0 = g.__probe().pos;
    for (const d of ['left', 'right', 'up', 'down']) {
      g.__step(d);
      const p1 = g.__probe().pos;
      if (p1.x !== p0.x || p1.y !== p0.y) return `${d} (${p0.x},${p0.y})→(${p1.x},${p1.y})`;
    }
    return null;
  });
  await page.waitForTimeout(200);
  const afterWalk = await snap();
  if (!walk) bad.push('四个方向都走不动，没法验证「走一步之后徽标还在」（判据前提不成立）');
  if (afterWalk.badges.length === 0) {
    bad.push(`走了一步之后徽标全没了（${beforeWalk.badges.length} → 0）`);
  }
  if (afterWalk.badges.length !== afterWalk.scores.length) {
    bad.push(`走一步后徽标 ${afterWalk.badges.length} 枚 ≠ 分数 ${afterWalk.scores.length} 条（不再一一对应）`);
  }

  // ── ⑦ 点目标 → 算式；点墙 → 不弹 ─────────────────────────────────
  const target = afterWalk.scores.find((s) => s.type === 'monster') ?? afterWalk.scores[0];
  let clickOk = false;
  if (target) {
    const modal = await page.evaluate((p) => window.mota.game.__click(p.x, p.y), target);
    await page.waitForTimeout(200);
    const cl = await snap();
    const first = cl.lines[0] ?? '';
    clickOk = modal === 'dialogue' && /^-?(∞|\d[\d.,]*k?M?) = /.test(first);
    if (!clickOk) {
      bad.push(`点目标 (${target.x},${target.y}) 之后 modal=${modal}、正文首行「${first}」`);
    } else if (cl.lines.join('').indexOf('（') < 0) {
      bad.push('算式里没有分项说明（「值（来路）」那一套）');
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  } else {
    bad.push('当前层没有可点的目标（判据前提不成立）');
  }
  // 点一格墙：不该弹对话框（说明「点空格照常寻路」这条没被计分视图改坏）
  const wall = await page.evaluate(() => {
    const g = window.mota.game;
    const f = g.data.floors.get(g.__probe().floor);
    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 11; x++) {
        if (f.terrain[y][x] === '#') return { x, y };
      }
    }
    return null;
  });
  if (wall) {
    const modal = await page.evaluate((p) => window.mota.game.__click(p.x, p.y), wall);
    if (modal !== 'none') bad.push(`点墙 (${wall.x},${wall.y}) 也弹了「${modal}」—— 计分视图不该拦下所有点击`);
  }

  // ── ⑧ 底部自动步数条 ─────────────────────────────────────────────
  //
  // ⚠️ 这条判据的第一版是**在第 2 层**跑自动，实测第 1 步就自己停了
  // （日志：「自动通关停止：第 2 层无路可走」—— 那一层 up / down 楼梯都要蓝钥匙），
  // 于是 `autoRunning` 恒为 false，判据自己红了而功能是好的。
  // 要让自动**真的跑起来**得回到第 1 层（实测 4 秒能走到第 3 层，稳）。
  await page.keyboard.press('Escape');
  await page.waitForTimeout(120);
  await page.evaluate(() => window.mota.game.__goto(1));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.mota.game.__auto(true));
  await page.waitForTimeout(1200);
  const run1 = await snap();
  if (!run1.run.visible) bad.push('自动通关跑起来了，底部步数条却没出现');
  if (!run1.autoRunning) bad.push('__auto(true) 没让它跑起来（判据前提不成立）');
  if (run1.autoSteps <= 0) bad.push(`自动在跑，但 autoSteps 还是 ${run1.autoSteps}（读数没在动）`);
  const m = /^(自动|上次自动) (\d+) 步 · 第 (\d+) 层 \((\d+),(\d+)\) · HP (\d+) 攻 (\d+) 防 (\d+)$/.exec(run1.run.text);
  if (!m) {
    bad.push(`底部条文案不符合形态：「${run1.run.text}」`);
  } else {
    if (Number(m[2]) !== run1.autoSteps) {
      bad.push(`条上写「${m[2]} 步」，而真实计数器是 ${run1.autoSteps}`);
    }
    if (Number(m[3]) !== run1.floor || Number(m[4]) !== run1.pos.x || Number(m[5]) !== run1.pos.y) {
      bad.push(`条上的位置「第 ${m[3]} 层 (${m[4]},${m[5]})」与真实 (${run1.floor}, ${run1.pos.x},${run1.pos.y}) 不符`);
    }
  }
  await page.screenshot({ path: 'assets/preview/score-view.png' });

  await page.evaluate(() => window.mota.game.__auto(false));
  await page.waitForTimeout(300);
  const run2 = await snap();
  if (run2.autoRunning) bad.push('__auto(false) 没停下');
  if (!run2.run.visible) bad.push('停下之后底部步数条消失了（那一刻正要看这个数）');
  if (!run2.run.text.startsWith('上次自动')) bad.push(`停下后文案没有变成「上次自动…」：「${run2.run.text}」`);

  // ── ⑨ 收干净：关视图 + 重开 ──────────────────────────────────────
  await page.evaluate(() => window.mota.game.__scoreView(false));
  await page.keyboard.press('r');
  await page.waitForTimeout(250);
  const final = await snap();
  if (final.scoreView) bad.push('关闭计分视图失败');
  if (final.scoreLabel !== '计分') bad.push(`关闭后按钮文案是「${final.scoreLabel}」`);
  if (final.badges.length !== 0) bad.push(`关闭后还剩 ${final.badges.length} 枚徽标没擦掉`);
  if (final.run.visible) bad.push('重开后底部步数条还在');

  check(
    'A24 计分视图：徽标出现在每格脚下、按类别上色、算式进对话框；底部自动步数条' +
      `（第 1 层 ${on.badges.length} 枚徽标 / ${colors.size} 种颜色；` +
      `跑了 ${run1.autoSteps} 步；${note.join('，')}）`,
    bad.length === 0,
    (bad.length ? bad.slice(0, 4).join(' | ') + ' ⟵ ' : '') +
      `首行算式「${eq}」` +
      (clickOk && target ? `；点 (${target.x},${target.y}) 给出算式` : '') +
      `；条「${run1.run.text}」→「${run2.run.text}」`
  );
}

module.exports = {
  id: 'a24-score-overlay',
  title: 'A24 计分视图：徽标 / 配色 / 算式 / 底部步数条',
  run
};
