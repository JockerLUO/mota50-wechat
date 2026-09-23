/**
 * A17 像素密度：网格翻倍，落屏尺寸一点不变
 *
 * 图集帧 = 原始素材 × supersample，drawScale 同比缩小 ——
 * 量「落屏尺寸」才是要保护的不变量，量帧尺寸会随 SS 一起变、等于没测。
 * 怪物落屏允许三档：一格 32 / 大家伙 48 / BOSS 的两格 64。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, check, MANIFEST, terrainPng, ROOT, DIST, fs, path } = ctx;

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
  // 怪物：帧一律 = rasterTile 网格；落屏要么一格、要么「大家伙」1.5 格、
  // 要么 BOSS 的两格。三段尺寸各有出处，不是拍脑袋放行：
  //   · 一格(32)    —— 普通怪，必须装进格子（格子边界决定「走进哪格打谁」）；
  //   · 1.5 格(48)  —— 旧的「大家伙」档（现已无怪使用，留着兼容手工试验）；
  //   · 两格(64)    —— BOSS：画在 64 网格、1:1 落屏（`BOSS_DRAW_SCALE = 1.0`）。
  //     ⚠️ BOSS 从 48px 长到 64px 时，这条判据是**唯一报红的**（它硬编码了
  //     「大家伙 = 1.5 格」）。放行 64 不会放过杂兵：谁允许画大由 A6 单独把关
  //     （「画得比一格大的必须都是玩法 BOSS」），两条判据是互补的。
  const monBad = [];
  for (const [id, node] of Object.entries(MANIFEST.monsters)) {
    if (!node) continue;
    const onScreen = node.frame.w * node.drawScale;
    if (node.frame.w !== rasterTile) {
      monBad.push(`${id} 帧 ${node.frame.w} 不是 ${rasterTile} 网格`);
    } else if (
      !near(onScreen, cell) && !near(onScreen, cell * 1.5) && !near(onScreen, cell * 2)
    ) {
      monBad.push(
        `${id} 落屏 ${onScreen} 既不是一格(${cell})、大家伙(${cell * 1.5})，也不是 BOSS 的两格(${cell * 2})`
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
      `落屏勇者仍 ${heroNow ? `${Math.round(heroNow.size.w)}×${Math.round(heroNow.size.h)}` : '?'}`,
    densBad.length === 0,
    densBad.slice(0, 3).join(' | ') ||
      `岩浆 ${rawCmp ? `${rawCmp.raw.w} → ${rawCmp.frame.w}` : '?'}，格子 ${cell}px 不变`
  );

}

module.exports = { id: "a17-pixel-density", title: "A17 像素密度：网格翻倍，落屏尺寸一点不变", run };
