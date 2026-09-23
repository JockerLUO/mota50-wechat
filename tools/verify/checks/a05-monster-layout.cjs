/**
 * A6 BOSS 与倍数 / A5a 精灵装得进一格 / A5b 脚下干净
 *
 * 「大家伙」的判据绑在**落屏尺寸**上，不是 `drawScale > 2`：
 * 出图网格翻倍后 drawScale 变成小数，整数阈值会**静默**退化成「0 只大家伙」，
 * 于是 A5a 拿「必须装进一格」去卡 BOSS，红得莫名其妙（已踩过）。
 *
 * A5b 是**反向断言**（「脚下不许有 gradeDot」），所以带探针：
 * 同一条断言里数一个「同类但已知存在」的节点（NPC 名牌），探针为 0 就报红而不是跳过 ——
 * 否则 label 一改名，这条断言就会恒真。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, check, MANIFEST, sorted } = ctx;

  // ── A5 / A6：怪物布局 ───────────────────────────────────────────
  const bossIds = await page.evaluate(() => {
    const m = window.mota.game.data.monsters;
    return Object.keys(m).filter((k) => m[k] && m[k].boss);
  });
  // 「大家伙」= **落屏画得比一格大**。⚠️ 不能再用 `drawScale > 2` 判定：
  // 出图网格翻倍后 drawScale 变成小数（常规 0.5 / 大家伙 0.75），整数阈值
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

  const layoutBad = [];
  const withDot = [];
  const strayDraw = [];
  let monsterViews = 0;
  let floorsWithMonsters = 0;
  let bossRings = 0;
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
        const cellL = b.x + v.x * S;
        const cellT = b.y + v.y * S;
        out.push({
          id: v.monsterId,
          x: v.x,
          y: v.y,
          cellL,
          cellT,
          S,
          hasSprite: !!sp,
          spriteBottom: gb ? gb.maxY : null,
          spriteTop: gb ? gb.minY : null,
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
      const boss = bossIds.includes(m.id) && bigIds.includes(m.id);
      if (m.ringVisible) bossRings++;
      if (!m.hasSprite) {
        layoutBad.push({ ...m, why: '没有精灵（图集没就绪？）' });
        continue;
      }
      // 脚不能越过格子下沿：越过就说明「它站哪一格」在画面上不确定
      if (m.spriteBottom > m.cellT + m.S + 0.01) {
        layoutBad.push({ id: m.id, cell: [m.x, m.y], why: `脚越过下沿 ${(m.spriteBottom - m.cellT - m.S).toFixed(1)}px` });
      }
      if (!boss && m.spriteH > m.S + 0.01) {
        layoutBad.push({ id: m.id, cell: [m.x, m.y], why: `精灵高 ${m.spriteH}px > 格子 ${m.S}px` });
      }
      if (m.dotCount !== 0) withDot.push({ id: m.id, cell: [m.x, m.y], dotCount: m.dotCount });
      if (m.extraCount !== 0 || m.ringCount !== 1) {
        strayDraw.push({ id: m.id, cell: [m.x, m.y], extra: m.extraCount, rings: m.ringCount });
      }
    }
  }

  check(
    `A5a 怪物精灵：${monsterViews} 只（${floorsWithMonsters} 层）脚不越格、非 BOSS 装得进一格`,
    layoutBad.length === 0,
    layoutBad.length === 0
      ? '全部符合'
      : `${layoutBad.length} 只异常，前 3：${JSON.stringify(layoutBad.slice(0, 3))}`
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

module.exports = { id: "a05-monster-layout", title: "A6 BOSS 与倍数 / A5a 精灵装得进一格 / A5b 脚下干净", run };
