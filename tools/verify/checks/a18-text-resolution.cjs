/**
 * A18 文字光栅化分辨率跟随设备像素比
 *
 * 要**真的再开一个 dsf=3 的页面**量，不能在同一个页面里改参数 ——
 * 分辨率是建 Text 时就定下的，写死 2 在 dsf=3 的机型上就是糊的。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, browser, check, PORT } = ctx;

  // ── A18 文字光栅化分辨率跟随屏幕 ──
  //
  // 这一条以前是**写死 2**：手机 dpr=3，文字按 2× 光栅化后上屏还要再拉 1.5 倍。
  // 中文笔画细，这一道拉伸就是「面板文字发虚」的全部来源，而且它影响的是每一块面板。
  // 只在本页（dsf=2）断言会恒绿 —— 写死 2 也能过。所以**另开一个 dsf=3 的页面**：
  // 那里期望值必须是 3，写死 2 的实现会当场挂掉。
  const trBad = [];
  const main = await page.evaluate(() => window.mota.game.__probe());
  const expectMain = Math.min(3, Math.max(2, Math.round(main.resolution)));
  if (main.textResolution !== expectMain) {
    trBad.push(`dsf=${main.resolution}：文字分辨率 ${main.textResolution}，应为 ${expectMain}`);
  }
  const page3 = await browser.newPage({ viewport: { width: 420, height: 1024 }, deviceScaleFactor: 3 });
  let hi = null;
  try {
    await page3.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
    await page3.waitForFunction(() => !!(window.mota && window.mota.game), null, { timeout: 20000 });
    hi = await page3.evaluate(() => window.mota.game.__probe());
  } finally {
    await page3.close();
  }
  if (!hi) trBad.push('dsf=3 的页面没能起来，无法验证高像素比下的文字分辨率');
  else if (hi.resolution !== 3) trBad.push(`dsf=3 的页面报出的 resolution=${hi.resolution}，设备像素比没生效`);
  else if (hi.textResolution !== 3) {
    trBad.push(`dsf=3 时文字仍按 ${hi.textResolution}× 光栅化 —— 又被拉伸了 3/${hi.textResolution} 倍`);
  }
  check(
    `A18 文字分辨率跟随屏幕：dsf=${main.resolution} → ${main.textResolution}×，dsf=3 → ${hi ? hi.textResolution : '?'}×`,
    trBad.length === 0,
    trBad.slice(0, 3).join(' | ') || '两个像素比下都等于屏幕的 dpr'
  );

}

module.exports = { id: "a18-text-resolution", title: "A18 文字光栅化分辨率跟随设备像素比", run };
