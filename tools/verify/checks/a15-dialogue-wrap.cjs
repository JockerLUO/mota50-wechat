/**
 * A15 对话折行：不超卡片内宽、无标点顶行首
 *
 * 中文行首禁则（不能以收尾标点开头）与行尾禁则（不能以开引号结尾）都要守。
 * 可用宽度**从渲染树量**（首行的 x 减去卡片 x），不是在这里再算一遍 padding ——
 * 硬编码 padding 会在版式微调后变成一条永远通过或永远失败的断言。
 *
 * 代码主体逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 *
 * 2026-09-27 补了一处**采样守卫**（不是改判据口径）：`lifecycle: 'once'` 的 NPC
 * 撞过就消失，重复撞同一格只会走上去 —— 那时若照旧读 `dialogue.body`，量到的是
 * 上一个 NPC 留下的残留行。现在「框没开」就不采，并把这种情形报成红。
 */

async function run(ctx) {
  const { page, check } = ctx;

  // ── A15 对话折行：不超卡片内宽，且守住中文行首/行尾禁则 ──
  //
  // 「NPC 对话内容不会换行」的根因是 `LINE_UNITS` 写死 32，而卡片正文可用宽只有
  // 352px / 正文 11.5px ≈ 30 个单位 —— 于是 46 个 NPC 里 42 行**捅出卡片右边缘**
  // （实测最宽 368px）。现在单位数由几何算出来（hud.ts `unitsPerLine`）。
  //
  // 可用宽度**从渲染树反推**（正文 Text 的 x 减卡片左边 = UI.pad），
  // 不在这里抄一份 `14` —— 抄一份就多一个漂移点。
  const dia = await page.evaluate(() => {
    const g = window.mota.game;
    const rows = [];
    let npcs = 0;
    const skipped = [];
    let firstRet = null;
    let maxKids = 0;
    const modalBefore = g.__probe().modal;
    for (const [floor] of g.data.floors) {
      for (const e of (g.data.floors.get(floor)?.entities ?? []).filter((x) => x.type === 'npc')) {
        g.__goto(floor);
        const ret = g.__talk(e.id);
        if (firstRet === null) firstRet = String(ret);
        //
        // ⚠️ 只有**真的开了框**才采行。
        //
        // `dialogue.close()` 只把 visible 置 false，**不清正文**；而 `body.children`
        // 是「上一次 open() 留下的那一批」。所以「没开成框」时读它，量到的是
        // **上一个 NPC 的残留行** —— 断言照旧通过，但它量的已经不是这一位了。
        //
        // 这条守卫是 2026-09-27 加的：那时起 `lifecycle: 'once'` 的 NPC 撞过就
        // 从地图上消失，重复撞同一格只会走上去。`__talk` 已经改成滤掉离场的实体，
        // 所以正常情况下 skipped 应当为空 —— 它会出现在消息里，不为空就报红。
        if (!g.dialogue.isOpen) {
          skipped.push(`第${floor}层 ${e.id}(${e.x},${e.y})：${String(ret)}`);
          g.dialogue.close();
          continue;
        }
        maxKids = Math.max(maxKids, g.dialogue.body.children.length);
        // `i` = 这一段里的第几行。行首禁则**只对 `i > 0` 成立**，理由见下面 badStart。
        g.dialogue.body.children.forEach((t, i) => {
          rows.push({ floor, id: e.id, i, text: t.text, w: Math.round(t.width), x: t.x });
        });
        g.dialogue.close();
        npcs++;
      }
    }
    const card = g.dialogue.cardRect;
    return { card, rows, npcs, skipped, firstRet, maxKids, modalBefore };
  });
  const firstRow = dia.rows[0];
  const padFromTree = firstRow ? firstRow.x - dia.card.x : null;
  const avail = padFromTree === null ? null : dia.card.w - padFromTree * 2;
  const BAD_START = '，。、！？：；）」』】》〉〗·…—～%℃′″';
  const BAD_END = '（「『【《〈〖';
  const over = avail === null ? [] : dia.rows.filter((r) => r.w > avail);
  //
  // ⚠️ 行首禁则只对**折行断出来的行首**成立 —— 也就是 `i > 0` 那些行。
  //
  // 每段的第 0 行不是排出来的，是**作者写的那一句的开头**：它以什么字符起头由
  // `npcs.json` 决定，折行算法对它没有任何发言权。拿它去撞行首禁则等于「不许
  // 台词以……开头」，而中文里段首的省略号恰恰是最常见的停顿写法。
  //
  // 这不是假想的：第 26 层公主的第一句就是「……你真的上来了。…」。在此之前这条
  // 判据**从来没有量到过她**（她被一圈岩浆封着，`__talk` 站不到旁边），所以这条
  // 一直没响；2026-09-27 `__talk` 补了越位站位档之后第一次采到她，它就红了 ——
  // 红的是期望值，不是折行（实测折行结果逐字正确）。
  //
  // 反过来也守得住：真出问题的折行（把「，」挤到下一行行首）一定发生在 `i > 0`
  // 上；而如果第 0 行是空的、内容全挤到第 1 行去，那个行首照样会被抓。
  //
  const innerRows = dia.rows.filter((r) => r.i > 0);
  const badStart = innerRows.filter((r) => BAD_START.includes(r.text[0]));
  // 行尾禁则相反：它只管「这一行**断**在哪」，任何一行（含第 0 行）都不许以开引号收尾
  const badEnd = dia.rows.filter((r) => BAD_END.includes(r.text[r.text.length - 1]));
  const widest = dia.rows.reduce((m, r) => Math.max(m, r.w), 0);
  check(
    `A15 对话折行：${dia.npcs} 个 NPC / ${dia.rows.length} 行全部落在卡片内宽（最宽 ${widest}px ≤ ${avail}px）、无标点顶行首`,
    dia.npcs >= 40 && dia.skipped.length === 0 && dia.rows.length > 0 && over.length === 0 && badStart.length === 0 && badEnd.length === 0,
    dia.npcs < 40 || dia.rows.length === 0
      ? `只采到 ${dia.npcs} 个 NPC / ${dia.rows.length} 行（最多一次长出 ${dia.maxKids} 个正文 Text），` +
        `前提不成立 —— 开始采样时 modal=${dia.modalBefore}，首次搭话返回「${dia.firstRet}」`
      : dia.skipped.length
        ? `${dia.skipped.length} 个 NPC 没采到（撞了但框没开，采它只会量到上一个 NPC 的残留行）：` +
          dia.skipped.slice(0, 3).join(' ｜ ')
      : over.length
        ? `${over.length} 行超出 ${avail}px：` +
          over.slice(0, 2).map((r) => `第${r.floor}层「${r.text}」(${r.w}px)`).join(' ')
          : badStart.length
          ? `${badStart.length} 行折行后以收尾标点开头（中文行首禁则）：` +
            badStart.slice(0, 2).map((r) => `「${r.text}」`).join(' ')
          : `${badEnd.length} 行以开引号/开括号结尾：` +
            badEnd.slice(0, 2).map((r) => `「${r.text}」`).join(' ')
  );

}

module.exports = { id: "a15-dialogue-wrap", title: "A15 对话折行：不超卡片内宽、无标点顶行首", run };
