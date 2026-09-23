/**
 * A19 墙是手绘错缝砌法，不是第三方位图的超采样
 *
 * 量两件事：调色板 ≥5 色（超采样出不来的颜色数）、相邻砌层的竖缝错开半块。
 * 这条判据的**存在理由**是「超采样不创造信息」——
 * 第三方 16×16 位图摊到 64 网格只是把同一批像素占的地方变小，细节密度不会涨。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, check, MANIFEST, terrainPng, DIST, fs, path } = ctx;

  // ── A19 墙是手绘错缝砌法，不是第三方位图的超采样 ──
  //
  // 墙是第二种满屏平铺的地形。它曾经直接取 0x72 的 wall_mid（16×16、三个颜色）
  // 再超采样 —— 超采样不产生新细节，量出来的「每 16 单元独立色数」几乎不动。
  // 这一版改成手绘错缝砌法。判据四条，全部直接读**发布出去的图集帧**：
  //   ① 调色板 ≥ 5 色 —— 第三方位图只有 3 色，超采样不会多出颜色，这条
  //      单独就能证明「不是那张位图」；
  //   ② 每一层砌层都有缝列（显著暗于砖身的整列）—— 没有 = 砌法没了；
  //   ③ **错缝**：第 0 层与第 2 层的缝列位置相同（同相）、与第 1 层不同
  //      （错开半块）—— 这正是 running bond 的定义，也是变体/平铺不露接缝的前提；
  //   ④ MANIFEST 的 src 写着「手绘」（防改了脚本没重跑 assets）。
  const wallTile = terrainPng
    ? await page.evaluate(
        async ({ b64, r }) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
          const cv = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = cv.getContext('2d');
          ctx.drawImage(bmp, 0, 0);
          const all = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
          const cols = new Map();
          for (let y = 0; y < r.h; y++) {
            for (let x = 0; x < r.w; x++) {
              const i = ((r.y + y) * bmp.width + (r.x + x)) * 4;
              if (all[i + 3] === 0) continue;
              cols.set(`${x},${y}`, (0.2126 * all[i] + 0.7152 * all[i + 1] + 0.0722 * all[i + 2]) / 255);
            }
          }
          const palette = new Set();
          for (let y = 0; y < r.h; y++) {
            for (let x = 0; x < r.w; x++) {
              const i = ((r.y + y) * bmp.width + (r.x + x)) * 4;
              palette.add(`${all[i]},${all[i + 1]},${all[i + 2]},${all[i + 3]}`);
            }
          }
          const course = r.h / 4; // 一层砌层 = 瓦片的四分之一
          const jointsOf = (L) => {
            const per = [];
            for (let x = 0; x < r.w; x++) {
              let t = 0;
              let n = 0;
              for (let y = L * course; y < (L + 1) * course; y++) {
                const v = cols.get(`${x},${y}`);
                if (v === undefined) continue;
                t += v;
                n++;
              }
              per.push(n ? t / n : 1);
            }
            const mean = per.reduce((a, b) => a + b, 0) / per.length;
            return per.map((v) => v < mean - 0.04);
          };
          const j0 = jointsOf(0);
          const j1 = jointsOf(1);
          const j2 = jointsOf(2);
          const eq = (p, q) => p.every((v, i) => v === q[i]);
          return {
            palette: palette.size,
            n0: j0.filter(Boolean).length,
            n1: j1.filter(Boolean).length,
            same02: eq(j0, j2),
            diff01: !eq(j0, j1)
          };
        },
        {
          b64: fs.readFileSync(path.join(DIST, 'assets', terrainPng)).toString('base64'),
          r: { x: MANIFEST.terrain['1'].x, y: MANIFEST.terrain['1'].y, w: MANIFEST.terrain['1'].w, h: MANIFEST.terrain['1'].h }
        }
      )
    : null;
  const wallBad = [];
  if (!wallTile) wallBad.push('dist 里找不到 terrain 图集，无法核对墙的像素');
  else {
    if (wallTile.palette < 5) {
      wallBad.push(
        `墙的调色板只有 ${wallTile.palette} 色 —— 0x72 位图超采样恰好是 3 色，` +
          `少于 5 色说明还是那张位图而不是手绘`
      );
    }
    if (wallTile.n0 === 0 || wallTile.n1 === 0) {
      wallBad.push(
        `砌层里找不到缝列（第 0 层 ${wallTile.n0} 列 / 第 1 层 ${wallTile.n1} 列）—— ` +
          `没有缝就没有砌法，墙会读成一块平板`
      );
    }
    if (!wallTile.same02 || !wallTile.diff01) {
      wallBad.push(
        `竖缝不是错缝（第 0/2 层同相=${wallTile.same02}，第 0/1 层不同=${wallTile.diff01}）—— ` +
          `不是 running bond，平铺时会读出规则的方格`
      );
    }
  }
  if (!/手绘/.test(String(MANIFEST.terrain['1']?.src ?? ''))) {
    wallBad.push(`墙的 src 仍是「${MANIFEST.terrain['1']?.src}」—— 改了构建脚本但没重跑 assets`);
  }
  check(
    'A19 墙是手绘错缝砌法：调色板 ' +
      (wallTile ? wallTile.palette : '?') +
      ' 色，相邻砌层的竖缝错开半块',
    wallBad.length === 0,
    wallBad.slice(0, 3).join(' | ') || '不是 0x72 位图的超采样'
  );

}

module.exports = { id: "a19-wall-masonry", title: "A19 墙是手绘错缝砌法，不是第三方位图的超采样", run };
