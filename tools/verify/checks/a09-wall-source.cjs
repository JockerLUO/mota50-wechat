/**
 * A9 塔壁与地图内墙同源
 *
 * 比的是 `source.uid`（同一张素材）而不是颜色：颜色可能凑巧相近，uid 不会。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, check } = ctx;

  // ── A9 塔壁与地图内墙同源 ──
  //
  // 「地图周边的墙和地图的风格一致」：这一版的做法是让塔壁**直接平铺地图
  // 那面墙的贴图**，而不是调一个相近的颜色。所以断言比的是两张 Texture 的
  // `source`（base texture）—— 相同就意味着它们字面意义上是同一张图上的像素。
  // 有人把塔壁换成纯色几何体、或换成另一套素材，这条就会红。
  const walls = await page.evaluate(() => window.mota.game.board.__wallSources());
  check(
    'A9 塔壁与地图内墙同源（同一张素材图）',
    walls.parapet !== null && walls.parapet === walls.inner,
    walls.parapet === null
      ? '图集未加载，塔壁走的是程序化兜底 —— 这条断言无从谈起'
      : `parapet source=${walls.parapet} / 地图内墙 source=${walls.inner}`
  );

}

module.exports = { id: "a09-wall-source", title: "A9 塔壁与地图内墙同源", run };
