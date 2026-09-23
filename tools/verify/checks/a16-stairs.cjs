/**
 * A16 上下楼梯：两张不同形体，不是同一张图翻转
 *
 * 断言的**判据变过**，这点值得记住：
 * 旧画法（下＝原样、上＝垂直翻转）时判据是「下＝井（谷形剖面）」；
 * 下楼改成侧视竖井后，判据要换成「自左向右单调变暗」——
 * 否则它会继续保护一个已被换掉的形体（换画法时必须同步问「判据现在保护的是什么」）。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, check, MANIFEST, terrainPng, DIST, fs, path } = ctx;

  // ── A16 上下楼梯：两张不同形体，不是同一张图翻转 ──
  //
  // 旧写法是「下＝floor_ladder 原样，上＝同一张垂直翻转」。而 floor_ladder 近乎
  // 上下对称，翻转后肉眼读不出区别 —— 玩家在塔里分不清哪边往上走。
  // 这一版两张都手绘（下＝俯视竖井、上＝侧视梯段）。
  //
  // 断言**直接读发布出去的那张图集**：把 terrain.png 交给浏览器解码，按 MANIFEST
  // 的帧矩形切出两格，量各自的横剖面（每列平均亮度）走向。这样查的是真正落屏的
  // 像素，而不是构建脚本里的意图。判据四条：
  //   ① 两格不是同一张图；
  //   ② 上楼梯不是下楼梯的垂直翻转（旧写法正好卡在这一条）；
  //   ③ 下＝两端亮中间暗（井），上＝自左向右单调变亮（梯段）—— 形体走向相反；
  //   ④ MANIFEST 的 src 文案与「手绘」一致（防止改了脚本忘了重跑 assets）。
  const tDown = MANIFEST.terrain['3'];
  const tUp = MANIFEST.terrain['4'];
  const atlasReady = (await page.evaluate(() => window.mota.game.__probe())).atlasReady;
  const stair = terrainPng
    ? await page.evaluate(
        async ({ b64, a, b }) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
          const cv = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = cv.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          const all = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
          const lum = (i) => (0.2126 * all[i] + 0.7152 * all[i + 1] + 0.0722 * all[i + 2]) / 255;
          const cut = (r) => {
            const g = [];
            for (let y = 0; y < r.h; y++) {
              const row = [];
              for (let x = 0; x < r.w; x++) {
                const i = ((r.y + y) * bmp.width + (r.x + x)) * 4;
                row.push(all[i + 3] === 0 ? -1 : lum(i));
              }
              g.push(row);
            }
            return g;
          };
          const cols = (g) => {
            const out = [];
            for (let x = 0; x < g[0].length; x++) {
              let t = 0;
              let n = 0;
              for (let y = 0; y < g.length; y++) {
                if (g[y][x] < 0) continue;
                t += g[y][x];
                n++;
              }
              out.push(n ? t / n : 0);
            }
            return out;
          };
          const same = (p, q) => JSON.stringify(p) === JSON.stringify(q);
          const up = cut(b);
          const down = cut(a);
          return {
            same: same(up, down),
            isFlip: same(up, down.slice().reverse()),
            downCols: cols(down),
            upCols: cols(up)
          };
        },
        {
          b64: fs.readFileSync(path.join(DIST, 'assets', terrainPng)).toString('base64'),
          a: { x: tDown.x, y: tDown.y, w: tDown.w, h: tDown.h },
          b: { x: tUp.x, y: tUp.y, w: tUp.w, h: tUp.h }
        }
      )
    : null;

  const stairBad = [];
  if (!atlasReady) stairBad.push('图集没加载成功，落屏的是程序化兜底图形 —— 这条断言无从谈起');
  if (!stair) stairBad.push('dist 里找不到 terrain 图集，无法核对落屏像素');
  if (stair) {
    const dc = stair.downCols;
    const uc = stair.upCols;
    // 下＝侧视下沉：自左向右单调变暗（越往右下越深）
    let worstDown = 0;
    for (let i = 0; i < dc.length - 1; i++) worstDown = Math.max(worstDown, dc[i + 1] - dc[i]);
    const fall = dc[0] - dc[dc.length - 1];
    // 上＝侧视上升：自左向右单调变亮（越往右上越接近出口）
    let worst = 0;
    for (let i = 0; i < uc.length - 1; i++) worst = Math.max(worst, uc[i] - uc[i + 1]);
    const rise = uc[uc.length - 1] - uc[0];
    if (stair.same) stairBad.push('上楼梯与下楼梯是同一张图 —— 玩家分不清方向');
    else if (stair.isFlip) {
      stairBad.push(
        '上楼梯正好是下楼梯的垂直翻转 —— 翻转在 32px 上等价于同一张图，' +
          '这正是要修掉的那种写法（两者必须是不同形体）'
      );
    }
    if (fall < 0.15 || worstDown > 0.02) {
      stairBad.push(
        `下楼梯不是自左向右单调变暗（${dc[0].toFixed(3)} → ${dc[dc.length - 1].toFixed(3)}，` +
          `落差 ${fall.toFixed(3)}，最大回弹 ${worstDown.toFixed(3)}）—— 它必须是「往右下沉」的梯段`
      );
    }
    if (rise < 0.15 || worst > 0.02) {
      stairBad.push(`上楼梯不是自左向右单调变亮（落差 ${rise.toFixed(3)}，最大回退 ${worst.toFixed(3)}）`);
    }
  }
  const srcText = `${tDown.src ?? ''}|${tUp.src ?? ''}`;
  if (/翻转/.test(srcText)) {
    stairBad.push(`MANIFEST 里两张楼梯的 src 仍写着「翻转」：${srcText} —— 改了构建脚本但没重跑 assets`);
  } else if (String(tDown.src) === String(tUp.src)) {
    stairBad.push(`两张楼梯的 src 完全一样：${tDown.src}`);
  }
  check(
    `A16 上下楼梯：下沉梯段（${stair ? (stair.downCols[0] ?? 0).toFixed(2) : '?'} → ` +
      `${stair ? (stair.downCols[stair.downCols.length - 1] ?? 0).toFixed(2) : '?'}）与上升梯段` +
      `（${stair ? (stair.upCols[0] ?? 0).toFixed(2) : '?'} → ${stair ? (stair.upCols[stair.upCols.length - 1] ?? 0).toFixed(2) : '?'}）走向相反`,
    stairBad.length === 0,
    stairBad.slice(0, 3).join(' | ') || `${tDown.src} ／ ${tUp.src}`
  );

}

module.exports = { id: "a16-stairs", title: "A16 上下楼梯：两张不同形体，不是同一张图翻转", run };
