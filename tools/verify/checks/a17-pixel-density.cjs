/**
 * A17 像素密度：网格翻倍，落屏尺寸一点不变
 *
 * 图集帧 = 原始素材 × supersample，drawScale 同比缩小 ——
 * 量「落屏尺寸」才是要保护的不变量，量帧尺寸会随 SS 一起变、等于没测。
 * 怪物落屏分两种样本（2026-09-24 起 BOSS 从「64px 两格」改成「占 3×3 格」）：
 *   · 非 BOSS —— 帧在 rasterTile 网格上，落屏一格（或旧的「大家伙」1.5 格）；
 *   · BOSS   —— 落屏 = `格子 × 占位格数`（= 96px，正好盖住 3×3），
 *     帧 = 落屏 × `meta.bossSupersample`（2026-09-25 起 ≥2）。
 *     **不再允许 BOSS 落屏 64px**：那正是这次改动要消掉的旧版尺寸，
 *     而旧版判据把它当合法档放行（见下面那一段注释）。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

/** BOSS 帧相对落屏的**最低**超采样倍数。2 与杂兵一致（帧 64 / 落屏 32）。 */
const BOSS_SS_MIN = 2;

async function run(ctx) {
  const { page, check, MANIFEST, terrainPng, ROOT, DIST, fs, path, BOSS_IDS, BOSS_TILES } = ctx;

  // ── A17 像素密度：网格翻倍，但落屏尺寸一点不变 ──
  //
  // 「画面更精细」有两条路，代价差一个量级，容易走错：
  //   ① 把设计稿放大 —— 五块面板全部重排，版面与断言跟着动一片；
  //   ② 把**素材网格**翻倍 —— 出图从 16 网格升到 32 网格，drawScale 相应减半，
  //      落屏的设计像素数不变（16×2 = 32×1）。
  // 这一版走 ②。所以这条断言要同时钉住两件事，缺一条就是假的：
  //   密 —— 图集帧的边长必须是原始素材的 supersample 倍（真的多画了像素）；
  //   不变 —— 帧边长 × drawScale 必须仍等于格子边长（否则版面全歪）。
  //
  // 光看画面分不出这两件事：32 网格的图按 1:1 画、和 16 网格的图按 2× 画，
  // 落屏**一模一样**。所以只能靠断言，不能靠眼看。
  const meta = MANIFEST.meta ?? {};
  const ss = Number(meta.supersample ?? 1);
  const rasterTile = Number(meta.rasterTile ?? meta.baseTile ?? 16);
  const cell = Number(meta.cell ?? 32);
  const densBad = [];
  if (ss < 2) densBad.push(`MANIFEST.supersample=${ss} —— 图集仍是绘制网格，没有超采样`);
  if (rasterTile !== Number(meta.baseTile) * ss) {
    densBad.push(`rasterTile(${rasterTile}) ≠ baseTile(${meta.baseTile}) × supersample(${ss})`);
  }
  // 逐条地形帧：边长 = rasterTile，且 drawScale = cell / rasterTile（落屏仍是一格）
  const wantScale = cell / rasterTile;
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const thinTerrain = Object.entries(MANIFEST.terrain).filter(
    ([k, v]) => v && (v.w !== rasterTile || v.h !== rasterTile || !near(v.drawScale, wantScale))
  );
  if (thinTerrain.length) {
    densBad.push(
      `地形帧没有全部升到 ${rasterTile} 网格 / drawScale=${wantScale}：` +
        thinTerrain.slice(0, 3).map(([k, v]) => `${k}=${v.w}×${v.h}×${v.drawScale}`).join(' ')
    );
  }
  // 角色：走路帧宽 = rasterTile、drawScale = 1（勇者落屏必须还是 32×52）
  const heroNode = MANIFEST.actors?.hero;
  const heroFrame0 = heroNode?.walk?.down?.[0];
  if (!heroFrame0 || heroFrame0.w !== rasterTile || !near(heroNode.drawScale, wantScale)) {
    densBad.push(
      `勇者帧 ${heroFrame0?.w}×${heroFrame0?.h} × drawScale ${heroNode?.drawScale} —— ` +
        `应当是 ${rasterTile} 网格 × ${wantScale}`
    );
  }
  // 怪物：帧与落屏尺寸按「是不是 BOSS」分两套，两边都不是拍脑袋放行 ——
  //   · 非 BOSS：帧 = rasterTile 网格（超采样的产物），落屏一格(32)或 1.5 格(48)。
  //     1.5 格那一档是旧的「大家伙」尺寸，现已无怪使用（留着兼容手工试验）。
  //   · BOSS：落屏 = `格子 × 占位格数`（96，正好盖住 3×3），帧 = 落屏 × **超采样倍数**。
  //
  // ⚠️ 这一条曾经硬编码「BOSS 的两格(64)」。BOSS 从 64px 长到 96px 时它是
  //    **唯一报红的**判据 —— 也就是说，旧版把它写成「合法档」之后，
  //    「BOSS 悄悄缩回两格」就再没有判据管了（A6 只看「有没有比一格大」，
  //    64px 当然比 32px 大，会通过）。所以现在改成从
  //    `data/constants.json` 的 `boss.footprintTiles` 推：素材网格、落屏尺寸、
  //    棋盘占位三方必须是同一个数字，谁掉队这里就报谁。
  //    这里量的是 MANIFEST（构建期自述），A5a 量的是真正落屏的包围盒 ——
  //    两边都对上了，「画出来的范围 == 走不进去的范围」才算成立。
  //
  // 2026-09-25 补：判据从「帧 == 96」改成「**落屏 == 96** 且 **帧 = 落屏 × SS(≥2)**」。
  //    原因：BOSS 源图是 192×192 的**平滑插画**，帧只存 1 倍（96）再由 GPU 拉到
  //    288 设备像素时边缘必糊（玩家报的「周边线条模糊」）。加了超采样之后
  //    「帧 == 96」这条会**误杀**正确实现 —— 而它本来要保护的是
  //    「精灵与占位块一样大」（落屏那件事），帧边长只是中间量（铁律 #12）。
  //    SS 从 MANIFEST 自述读，不在这里硬编码；下限 2 才是真的设计要求。
  const bossFrame = cell * BOSS_TILES;
  const bossSS = MANIFEST.meta.bossSupersample;
  const monBad = [];
  if (!(bossSS >= BOSS_SS_MIN)) {
    monBad.push(
      `BOSS 超采样倍数 ${bossSS} < ${BOSS_SS_MIN} —— 帧只比落屏大 ${bossSS} 倍时，` +
        `平滑插画的边缘在 dpr≥2 上会被 GPU 拉成灰阶渐变（「周边线条模糊」）。` +
        `杂兵走的就是 2 倍（帧 64 / 落屏 32），BOSS 没理由更低`
    );
  }
  for (const [id, node] of Object.entries(MANIFEST.monsters)) {
    if (!node) continue;
    const isBoss = BOSS_IDS.includes(id);
    const onScreen = node.frame.w * node.drawScale;
    if (isBoss) {
      if (node.frame.w !== node.frame.h) {
        monBad.push(
          `${id} 帧 ${node.frame.w}×${node.frame.h} 不是正方形 —— 占位块是 ` +
            `${BOSS_TILES}×${BOSS_TILES}，精灵比它高或矮都会捅出去`
        );
      } else if (!near(onScreen, bossFrame)) {
        monBad.push(
          `${id} 落屏 ${onScreen}（帧 ${node.frame.w} × drawScale ${node.drawScale}）` +
            ` ≠ 占位块 ${bossFrame}（= 格子 ${cell} × 占位 ${BOSS_TILES} 格）—— BOSS 必须 ` +
            `1:1 盖住它占的 ${BOSS_TILES}×${BOSS_TILES} 格（改大之后它同时是「这 ` +
            `${BOSS_TILES} 格都是它的」的唯一提示）`
        );
      } else if (bossSS >= BOSS_SS_MIN && node.frame.w !== bossFrame * bossSS) {
        monBad.push(
          `${id} 帧 ${node.frame.w} ≠ 落屏 ${bossFrame} × 超采样 ${bossSS} ` +
            `（应为 ${bossFrame * bossSS}）—— 「帧 = 落屏 × SS」是全项目统一的规则，` +
            `BOSS 不该是例外`
        );
      }
    } else if (node.frame.w !== rasterTile) {
      monBad.push(`${id} 帧 ${node.frame.w} 不是 ${rasterTile} 网格`);
    } else if (!near(onScreen, cell) && !near(onScreen, cell * 1.5)) {
      monBad.push(
        `${id} 落屏 ${onScreen} 既不是一格(${cell})也不是大家伙(${cell * 1.5}) —— ` +
          `非 BOSS 不许画得比一格大（谁允许画大另有 A6 把关）`
      );
    }
  }
  if (monBad.length) densBad.push(`怪物网格/落屏不对：${monBad.slice(0, 3).join(' ')}`);

  // 「密」的实证：拿发布出去的图集帧，和**第三方原始素材**比边长。
  // 只看 MANIFEST 的数字等于只信构建脚本的自述；这里量的是两张真图。
  // 地板、墙都已改成**手绘**（不再来自第三方位图），所以参照物换成仍在走
  // 超采样的岩浆：它的源 wall_goo 是 16×16，出图必须落到 16 × supersample。
  const rawLava = path.join(ROOT, 'assets/raw/0x72/frames/wall_goo.png');
  let rawCmp = null;
  if (fs.existsSync(rawLava) && terrainPng) {
    const rawB64 = fs.readFileSync(rawLava).toString('base64');
    const atlasB64 = fs.readFileSync(path.join(DIST, 'assets', terrainPng)).toString('base64');
    rawCmp = await page.evaluate(
      async ({ raw, atlas, rect }) => {
        const side = async (b64) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
          return { w: bmp.width, h: bmp.height };
        };
        return { raw: await side(raw), frame: rect };
      },
      { raw: rawB64, atlas: atlasB64, rect: { w: MANIFEST.terrain['5'].w, h: MANIFEST.terrain['5'].h } }
    );
    if (rawCmp.frame.w !== rawCmp.raw.w * ss) {
      densBad.push(
        `岩浆帧 ${rawCmp.frame.w} ≠ 原始 wall_goo ${rawCmp.raw.w} × ${ss} —— 网格没有真的翻倍`
      );
    }
  } else {
    densBad.push(`找不到 ${path.relative(ROOT, rawLava)} 或发布图集，无法核对网格`);
  }

  // 「不变」的实证：量落屏的勇者。A14 已经量过形体，这里量的是**尺寸数值** ——
  // 网格翻倍若把落屏一起放大了，这里会立刻变成 64×104。
  const heroNow = await page.evaluate(() => window.mota.game.board.__hero());
  if (!heroNow || Math.round(heroNow.size.w) !== 32 || Math.round(heroNow.size.h) !== 52) {
    densBad.push(`勇者落屏 ${heroNow ? `${heroNow.size.w}×${heroNow.size.h}` : '?'} —— 应当是 32×52（与翻倍前一致）`);
  }

  check(
    `A17 像素密度：图集 ${rasterTile} 网格（原始 ${meta.baseTile} ×${ss}）、drawScale=${meta.drawScale}，` +
      `BOSS 落屏 ${bossFrame}px = 占位 ${BOSS_TILES} 格（图集帧 ${bossFrame * bossSS} = 落屏 × SS ${bossSS}）；` +
      `落屏勇者仍 ${heroNow ? `${Math.round(heroNow.size.w)}×${Math.round(heroNow.size.h)}` : '?'}`,
    densBad.length === 0,
    densBad.slice(0, 3).join(' | ') ||
      `岩浆 ${rawCmp ? `${rawCmp.raw.w} → ${rawCmp.frame.w}` : '?'}，格子 ${cell}px 不变`
  );

}

module.exports = { id: "a17-pixel-density", title: "A17 像素密度：网格翻倍，落屏尺寸一点不变", run };
