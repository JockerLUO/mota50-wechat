/**
 * A15 对话折行：不超卡片内宽、无标点顶行首
 *
 * 中文行首禁则（不能以收尾标点开头）与行尾禁则（不能以开引号结尾）都要守。
 * 可用宽度**从渲染树量**（首行的 x 减去卡片 x），不是在这里再算一遍 padding ——
 * 硬编码 padding 会在版式微调后变成一条永远通过或永远失败的断言。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
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
    let firstRet = null;
    let maxKids = 0;
    const modalBefore = g.__probe().modal;
    for (const [floor] of g.data.floors) {
      for (const e of (g.data.floors.get(floor)?.entities ?? []).filter((x) => x.type === 'npc')) {
        g.__goto(floor);
        const ret = g.__talk(e.id);
        if (firstRet === null) firstRet = String(ret);
        maxKids = Math.max(maxKids, g.dialogue.body.children.length);
        for (const t of g.dialogue.body.children) {
          rows.push({ floor, id: e.id, text: t.text, w: Math.round(t.width), x: t.x });
        }
        g.dialogue.close();
        npcs++;
      }
    }
    const card = g.dialogue.cardRect;
    return { card, rows, npcs, firstRet, maxKids, modalBefore };
  });
  const firstRow = dia.rows[0];
  const padFromTree = firstRow ? firstRow.x - dia.card.x : null;
  const avail = padFromTree === null ? null : dia.card.w - padFromTree * 2;
  const BAD_START = '，。、！？：；）」』】》〉〗·…—～%℃′″';
  const BAD_END = '（「『【《〈〖';
  const over = avail === null ? [] : dia.rows.filter((r) => r.w > avail);
  const badStart = dia.rows.filter((r) => BAD_START.includes(r.text[0]));
  const badEnd = dia.rows.filter((r) => BAD_END.includes(r.text[r.text.length - 1]));
  const widest = dia.rows.reduce((m, r) => Math.max(m, r.w), 0);
  check(
    `A15 对话折行：${dia.npcs} 个 NPC / ${dia.rows.length} 行全部落在卡片内宽（最宽 ${widest}px ≤ ${avail}px）、无标点顶行首`,
    dia.npcs >= 40 && dia.rows.length > 0 && over.length === 0 && badStart.length === 0 && badEnd.length === 0,
    dia.npcs < 40 || dia.rows.length === 0
      ? `只采到 ${dia.npcs} 个 NPC / ${dia.rows.length} 行（最多一次长出 ${dia.maxKids} 个正文 Text），` +
        `前提不成立 —— 开始采样时 modal=${dia.modalBefore}，首次搭话返回「${dia.firstRet}」`
      : over.length
        ? `${over.length} 行超出 ${avail}px：` +
          over.slice(0, 2).map((r) => `第${r.floor}层「${r.text}」(${r.w}px)`).join(' ')
        : badStart.length
          ? `${badStart.length} 行以收尾标点开头（中文行首禁则）：` +
            badStart.slice(0, 2).map((r) => `「${r.text}」`).join(' ')
          : `${badEnd.length} 行以开引号/开括号结尾：` +
            badEnd.slice(0, 2).map((r) => `「${r.text}」`).join(' ')
  );

}

module.exports = { id: "a15-dialogue-wrap", title: "A15 对话折行：不超卡片内宽、无标点顶行首", run };
