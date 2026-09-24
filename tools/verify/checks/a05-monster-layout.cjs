/**
 * A6 BOSS 与倍数 / A5a 精灵装得进一格 / A5b 脚下干净
 *
 * 「大家伙」的判据绑在**落屏尺寸**上，不是 `drawScale > 2`：
 * 出图网格翻倍后 drawScale 变成小数，整数阈值会**静默**退化成「0 只大家伙」，
 * 于是 A5a 拿「必须装进一格」去卡 BOSS，红得莫名其妙（已踩过）。
 *
 * A5a 从 2026-09-24 起分两种样本，因为 BOSS 从「画得比一格大但仍只占一格」
 * 变成了「占 3×3 格」：
 *   · 非 BOSS —— 精灵必须**装得进一格**（格子边界决定「走进哪格打谁」）；
 *   · BOSS   —— 精灵的包围盒必须**与它宣称占的那几格逐边重合**
 *     （`EntityView.footprint`，由渲染层从 `constants.json` 的
 *     `boss.footprintTiles` 算出来）。
 * 后者不能用「量边长」代替：96px 的精灵摆在 1×1 的容器里同样量得出 96px，
 * 而玩家看到的是「它站错了地方」。所以量的是**对齐**，不是大小。
 * ⚠️ 纵向要让出呼吸的 1px（刚体位移，随手一拍约一半概率拍到抬起的那一帧）——
 * 细节与「为什么只让位移不让尺寸」写在下面那段判据里。
 *
 * ⚠️ 这条断言有它特有的假绿：`v.footprint` / `v.boss` 一改名，BOSS 样本就永远为空，
 * 判据恒真。所以同一条断言里数一遍「页面上真的有几个 BOSS 视图」，
 * 与 `data/` 里**放置**的 BOSS 数量对拍，对不上就报红而不是跳过。
 *
 * A5b 是**反向断言**（「脚下不许有 gradeDot」），所以带探针：
 * 同一条断言里数一个「同类但已知存在」的节点（NPC 名牌），探针为 0 就报红而不是跳过 ——
 * 否则 label 一改名，这条断言就会恒真。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, check, MANIFEST, sorted, BOSS_IDS, BOSS_TILES, bossBlock, loadFloorEntities } = ctx;

  // ── A5 / A6：怪物布局 ───────────────────────────────────────────
  const bossIds = await page.evaluate(() => {
    const m = window.mota.game.data.monsters;
    return Object.keys(m).filter((k) => m[k] && m[k].boss);
  });
  // 「大家伙」= **落屏画得比一格大**。⚠️ 不能再用 `drawScale > 2` 判定：
  // 出图网格翻倍后 drawScale 变成小数（常规 0.5 / BOSS 1.0），整数阈值
  // 当场失效 —— 实测会静默变成「0 只大家伙」，于是 A5a 拿「必须装进一格」
  // 去卡 BOSS，红得莫名其妙。判据要落在**语义**上（画得多大），不是倍数上。
  const cellPx = Number(MANIFEST.meta.cell ?? 32);
  const bigIds = Object.keys(MANIFEST.monsters).filter((k) => {
    const n = MANIFEST.monsters[k];
    return n && n.frame.w * n.drawScale > cellPx + 1e-6;
  });
  const fakeBoss = bigIds.filter((k) => !bossIds.includes(k));
  check(
    `A6 BOSS 与倍数：画得比一格大的 ${bigIds.length} 只必须都是玩法 BOSS`,
    fakeBoss.length === 0,
    fakeBoss.length === 0
      ? `巨大化的都名副其实；另有 ${bossIds.length - bigIds.length} 只玩法 BOSS 未增大（见报告说明）`
      : `有非 BOSS 被画大：${fakeBoss.join(', ')}`
  );

  // 数据侧：**放置**在棋盘上的 BOSS 有几只 —— A5a 用它给「BOSS 样本」当探针。
  // 从 `data/floors/*.json` 数，不从浏览器里数：这正是「两个独立来源对撞」。
  const entities = loadFloorEntities();
  let placedBosses = 0;
  const placedBossCells = [];
  for (const [floor, list] of entities) {
    for (const e of list) {
      if (e.type !== 'monster' || !BOSS_IDS.includes(e.id)) continue;
      placedBosses++;
      placedBossCells.push({ floor, id: e.id, x: e.x, y: e.y, block: bossBlock(e.x, e.y) });
    }
  }

  const layoutBad = [];
  const withDot = [];
  const strayDraw = [];
  let monsterViews = 0;
  let floorsWithMonsters = 0;
  let bossRings = 0;
  let bossViews = 0;
  // 「按 label 找子节点」这套方法本身有效的证据（见 A5b 的说明）
  let npcPlateProbe = 0;

  for (const floor of sorted) {
    await page.evaluate((f) => window.mota.game.__goto(f), floor);
    const probe = await page.evaluate(() => {
      const g = window.mota.game;
      const b = g.board;
      const S = b.cellPx;
      const isSp = (n) => n && n.texture !== undefined && n.anchor !== undefined;
      // 生产构建会压缩类名（Graphics → H），所以不能看 constructor.name；
      // 渲染层给每种自绘标记设了唯一的 label（Pixi v8 用 label 不用 name），
      // 直接按 label 找 —— 这也是 A5b 能判「脚下干不干净」的前提。
      const isDot = (n) => n && n.label === 'gradeDot';
      const isRing = (n) => n && n.label === 'bossRing';
      const isNpcPlate = (n) => n && n.label === 'npcPlate';
      const out = [];
      for (const v of b.entityViews) {
        if (!v.node || !v.monsterId) continue;
        const kids = v.node.children || [];
        const sp = kids.find(isSp);
        const ring = kids.find(isRing);
        const gb = sp ? sp.getBounds() : null;
        // ── 占位块（棋盘格坐标）────────────────────────────────────
        // 杂兵没有 `footprint`（它的块就是自己那一格），按单格还原 ——
        // 于是两类样本用同一组式子，非 BOSS 的读数与改动前逐字一致。
        const fp = v.footprint ?? { x0: v.x, y0: v.y, x1: v.x, y1: v.y };
        const fw = fp.x1 - fp.x0 + 1;
        const fh = fp.y1 - fp.y0 + 1;
        const blockL = b.x + fp.x0 * S;
        const blockT = b.y + fp.y0 * S;
        out.push({
          id: v.monsterId,
          x: v.x,
          y: v.y,
          S,
          isBoss: !!v.boss,
          fp,
          blockL,
          blockT,
          blockW: fw * S,
          blockH: fh * S,
          hasSprite: !!sp,
          spriteLeft: gb ? gb.minX : null,
          spriteRight: gb ? gb.maxX : null,
          spriteTop: gb ? gb.minY : null,
          spriteBottom: gb ? gb.maxY : null,
          spriteW: gb ? gb.width : null,
          spriteH: gb ? gb.height : null,
          dotCount: kids.filter(isDot).length,
          ringCount: kids.filter(isRing).length,
          // 精灵与 BOSS 圈之外**任何**额外绘制物都算残留
          extraCount: kids.filter((n) => !isSp(n) && !isDot(n) && !isRing(n)).length,
          ringVisible: ring ? ring.getBounds().width > 0 : false
        });
      }
      // 顺带数一遍 NPC 的脚下名牌 —— 见 A5b 的「断言有效性」说明
      let npcPlates = 0;
      for (const v of b.entityViews) {
        if (!v.node || !v.npcId) continue;
        npcPlates += (v.node.children || []).filter(isNpcPlate).length;
      }
      return { mons: out, npcPlates };
    });
    const mons = probe.mons;
    npcPlateProbe += probe.npcPlates;

    if (mons.length) floorsWithMonsters++;
    monsterViews += mons.length;

    for (const m of mons) {
      const big = bossIds.includes(m.id) && bigIds.includes(m.id);
      if (m.ringVisible) bossRings++;
      if (m.isBoss) bossViews++;
      if (!m.hasSprite) {
        layoutBad.push({ ...m, why: '没有精灵（图集没就绪？）' });
        continue;
      }
      // 脚不能越过**占位块**的下沿：越过就说明「它占哪几格」在画面上不确定
      if (m.spriteBottom > m.blockT + m.blockH + 0.01) {
        layoutBad.push({
          id: m.id,
          cell: [m.x, m.y],
          why: `脚越过占位块下沿 ${(m.spriteBottom - m.blockT - m.blockH).toFixed(1)}px`
        });
      }
      if (!m.isBoss && m.spriteH > m.S + 0.01) {
        layoutBad.push({ id: m.id, cell: [m.x, m.y], why: `精灵高 ${m.spriteH}px > 格子 ${m.S}px` });
      }
      if (m.isBoss) {
        // BOSS：精灵包围盒必须与占位块**逐边重合**（呼吸那 1px 除外，见下）。
        // 这是「画出来的范围 == 走不进去的范围」在画面上的那一半 ——
        // 规则那一半由 A21 从引擎侧验（九格都走不进、击败后九格都走得进）。
        //
        // ⚠️ 纵向必须让出 **1px**：待机呼吸是渲染层的**刚体位移**
        //    （`board.update()` 里 `sp.y = restY - up`，up ∈ {0,1}，见 `bob.ts`），
        //    所以随手一拍有大约一半概率拍到「整体上抬 1px」的那一帧 ——
        //    实测 7 只 BOSS 里 3 只正是如此。判据若要求严格相等，就会随机红，
        //    而红的那几只看起来「什么问题都没有」。
        //    让路的是**位移**：宽/高/左沿仍必须严格相等 —— 呼吸只许平移，
        //    一旦有人把「上抬」实现成「下半身不动、上面抽一行」，高度会变，
        //    这里立刻报红（那也是玩家最早反馈过的「抖动时出现压缩」）。
        const BOB = 1; // 呼吸幅度上限（像素），由 A20 另行守着「不许改尺寸」
        const dL = m.spriteLeft - m.blockL;
        const dW = m.spriteW - m.blockW;
        const dH = m.spriteH - m.blockH;
        const dT = m.spriteTop - m.blockT;
        const dB = m.spriteBottom - (m.blockT + m.blockH);
        const ok =
          Math.abs(dL) <= 0.01 &&
          Math.abs(dW) <= 0.01 &&
          Math.abs(dH) <= 0.01 &&
          dT <= 0.01 &&
          dT >= -BOB - 0.01 &&
          dB <= 0.01 &&
          dB >= -BOB - 0.01;
        if (!ok) {
          layoutBad.push({
            id: m.id,
            cell: [m.x, m.y],
            why:
              `精灵 ${m.spriteW}×${m.spriteH} @(${m.spriteLeft},${m.spriteTop}) 与占位块 ` +
              `${m.blockW}×${m.blockH} @(${m.blockL},${m.blockT}) 不重合（左偏 ${dL.toFixed(1)}、` +
              `上偏 ${dT.toFixed(1)}、下偏 ${dB.toFixed(1)}、宽差 ${dW.toFixed(1)}、高差 ${dH.toFixed(1)}px；` +
              `纵向只允许呼吸的 0..${BOB}px）`
          });
        }
        // 占位块必须整个落在棋盘内：靠边的 BOSS（第 40 层在 (5,0)）要**整体平移**，
        // 而不是裁掉一角变成 2×3 —— 裁了精灵就会捅出去，规则与画面又对不上
        if (m.fp.x0 < 0 || m.fp.y0 < 0 || m.fp.x1 > 10 || m.fp.y1 > 10) {
          layoutBad.push({
            id: m.id,
            cell: [m.x, m.y],
            why: `占位块 x${m.fp.x0}..${m.fp.x1} y${m.fp.y0}..${m.fp.y1} 跑出棋盘`
          });
        }
      }
      if (m.dotCount !== 0) withDot.push({ id: m.id, cell: [m.x, m.y], dotCount: m.dotCount });
      if (m.extraCount !== 0 || m.ringCount !== 1) {
        strayDraw.push({ id: m.id, cell: [m.x, m.y], extra: m.extraCount, rings: m.ringCount });
      }
    }
  }

  // 探针：页面上的 BOSS 视图数必须与数据里**放置**的 BOSS 数一致。
  // 对不上有两种可能，都是要当场知道的：BOSS 们没被渲染（漏画 / 被过滤掉），
  // 或者 `v.boss` / `v.footprint` 这条路断了（于是上面那段对齐判据根本没跑）。
  const bossProbeOk = bossViews === placedBosses;
  check(
    `A5a 怪物精灵：${monsterViews} 只（${floorsWithMonsters} 层）脚不越格、非 BOSS 装得进一格、` +
      `BOSS 精灵与它的 ${BOSS_TILES}×${BOSS_TILES} 占位块逐边重合（BOSS 样本 ${bossViews}/${placedBosses}）`,
    layoutBad.length === 0 && bossProbeOk,
    (layoutBad.length ? `${layoutBad.length} 只异常，前 3：${JSON.stringify(layoutBad.slice(0, 3))}` : '') +
      (!bossProbeOk
        ? `${layoutBad.length ? ' ｜ ' : ''}断言无效：页面上只有 ${bossViews} 个 BOSS 视图，` +
          `而 data/floors 里放置了 ${placedBosses} 只（${placedBossCells
            .slice(0, 3)
            .map((p) => `第${p.floor}层 ${p.id}@(${p.x},${p.y})`)
            .join('、')}）—— ` +
          `多半是 v.boss / v.footprint 改了名，导致对齐判据无样本可判`
        : layoutBad.length
          ? ''
          : '全部符合')
  );

  // ── A5b：怪物脚下**必须干净** ────────────────────────────────────
  //
  // 这条断言在 2026-09-23 **反了过来**。改前它要求「每只怪恰好一个指示灯
  // （`gradeDot`）」，因为那时脚下确实画着一颗 6×4 的评级色点。玩家的反馈是
  // 「移除怪物脚底的点或者阴影」—— 那颗点的颜色是 `shade(怪物主色, -0.62)`，
  // 落在浅色地板上读起来就是一块脏东西，而不是一个评级标记（评级本来在
  // HUD 战斗面板里就有）。
  //
  // 现在它守的是**反向**的约束：脚下不许再出现任何标记。写成断言而不是
  // 删掉了事，是因为「脚下干净」是个容易被后人无意破坏的状态 ——
  // 想在脚下加点提示的人，会先在这里看到一条说明为什么不能加的红。
  //
  // ⚠️ 断言有效性：`dotCount === 0` 有可能是「因为 isDot 永远找不到东西」
  // 而恒真的假绿（比如 label 被改掉、或生产构建把 label 抹了）。
  // 所以同时探一下 **NPC 的脚下名牌**（`npcPlate`，另一处按 label 找的节点）：
  // 它必须数得出来。数不出来就说明「按 label 找子节点」这条路本身断了，
  // 这条断言也就不作数 —— 那时报红是对的。
  const dotOk = withDot.length === 0;
  const strayOk = strayDraw.length === 0;
  const probeOk = npcPlateProbe > 0;
  check(
    `A5b 怪物脚下无标记：精灵之外只留 BOSS 圈（探针：NPC 名牌 ${npcPlateProbe} 个）`,
    dotOk && strayOk && probeOk,
    !probeOk
      ? '断言无效：按 label 找不到 NPC 脚下名牌（npcPlate），说明 label 这条路断了，本判据不作数'
      : dotOk && strayOk
        ? `全部 ${monsterViews} 只脚下干净（BOSS 圈 ${bossRings} 个）`
        : `脚下仍有标记 ${withDot.length} 只、多余绘制物 ${strayDraw.length} 只，` +
          `前 3：${JSON.stringify((withDot.length ? withDot : strayDraw).slice(0, 3))}`
  );

}

module.exports = {
  id: "a05-monster-layout",
  title: "A6 BOSS 与倍数 / A5a 精灵装得进一格及其占位块 / A5b 脚下干净",
  run
};
