#!/usr/bin/env node
/**
 * 由 data/npcs.json 生成「对白总览」页面 → docs/npc-dialogue.html
 *
 * 用途：本轮把原版对白（h5mota 官方原版复刻数据）搬进 data/npcs.json 之后，
 *      需要一份**人读的验收材料** —— 哪些层有台词、哪几句是新加的、哪几句是替换的。
 *
 * 生成物不手改（与 tools/build-balance-check.mjs 同一约定）：
 *   改 data/npcs.json → 重跑本脚本 → 再跑 npm run validate（H 段不检查本文件，无防漂移负担）
 *
 * 用法：node tools/build-dialogue-report.mjs [--write]
 *      默认只打印摘要；--write 才落盘 docs/npc-dialogue.html
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NPCS = path.join(ROOT, 'data', 'npcs.json');
const OUT = path.join(ROOT, 'docs', 'npc-dialogue.html');

/** 本轮从原版复刻数据「新增」与「替换」的层（人工核对过的清单，用于页面上打标） */
const REPLACED = {
  sage: {
    2: { was: '二层是第一道坎…（自撰）', why: '该层实际是领礼物 → 原版台词与效果对得上' },
    3: { was: '再往上就要见到打不动的怪物了…（自撰）', why: '该层实际是给怪物手册 → 原版台词与效果对得上' },
  },
};

/** 有意不采用的来源条目（写在页面上，避免后人「怎么漏了这条」） */
const SKIPPED = [
  ['1 层 · 作者', '「欢迎来到《魔塔50层》原版复刻」', '那是 deluxe 复刻项目自己的标语（作者口吻），本项目同为复刻，引用它语义错位；且 1 层 (6,9) 站的是 sage，没有 author 实体'],
  ['23 层 · 智者', '（原版有提示）', '本项目第 23 层没有 sage 实体，落表即「写了没人读」的死数据'],
  ['15 / 35 层 · 小偷', '（原版有台词）', '这两层没有 thief 实体'],
  ['29 层 · 小偷', '（原版有台词）', '属剧情分支，非本层常规对话'],
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function load() {
  const doc = JSON.parse(fs.readFileSync(NPCS, 'utf8'));
  return doc;
}

function asLines(v) {
  return Array.isArray(v) ? v : [v];
}

function renderNpc(key, npc) {
  const t = npc.talkByFloor || {};
  const floors = Object.keys(t).map(Number).sort((a, b) => a - b);
  if (!floors.length) return '';
  const repl = REPLACED[key] || {};
  const rows = floors.map((f) => {
    const lines = asLines(t[String(f)]);
    const badge = repl[f]
      ? '<span class="tag tag-repl">替换</span>'
      : '<span class="tag tag-add">原版</span>';
    const old = repl[f] ? `<div class="old">原自撰：${esc(repl[f].was)}<br><span class="why">替换理由：${esc(repl[f].why)}</span></div>` : '';
    return `      <tr>
        <td class="floor">${f} 层</td>
        <td class="line">${lines.map((l) => `<p>${esc(l)}</p>`).join('')}${old}</td>
        <td class="src">${badge}</td>
      </tr>`;
  }).join('\n');
  return `  <section class="npc">
    <h3>${esc(npc.name || key)} <code>${esc(key)}</code> <span class="count">${floors.length} 层</span></h3>
    <table>
      <thead><tr><th>楼层</th><th>台词</th><th>来源</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </section>`;
}

function build(doc) {
  const npcs = doc.npcs;
  const order = ['sage', 'merchant', 'thief', 'princess'];
  const sections = order.filter((k) => npcs[k]).map((k) => renderNpc(k, npcs[k])).join('\n');
  const total = order.reduce((n, k) => n + Object.keys(npcs[k]?.talkByFloor || {}).length, 0);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NPC 对白总览 —— 《魔塔50层》</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 80px; background: #f6f7f9; color: #1f2328;
         font: 15px/1.7 -apple-system, "PingFang SC", "Helvetica Neue", Arial, sans-serif; }
  main { max-width: 940px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  h2 { font-size: 19px; margin: 40px 0 12px; padding-bottom: 8px; border-bottom: 1px solid #e3e6ea; }
  h3 { font-size: 16px; margin: 28px 0 10px; }
  code { font: 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace; background: #eceff2;
         padding: 2px 5px; border-radius: 4px; color: #4b5563; }
  .lede { color: #5b6470; margin: 0 0 4px; }
  .meta { color: #7a838f; font-size: 13px; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 18px 20px; margin: 18px 0; }
  .card.warn { background: #fffaf0; border-color: #f0dcb4; }
  .card.ok { background: #f2fbf5; border-color: #b9e6c9; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e3e6ea;
          border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eef0f3; vertical-align: top; }
  th { background: #f9fafb; font-weight: 600; font-size: 13px; color: #5b6470; }
  tr:last-child td { border-bottom: none; }
  td.floor { white-space: nowrap; font-weight: 600; color: #2f6feb; width: 62px; }
  td.line p { margin: 0 0 6px; }
  td.line p:last-child { margin-bottom: 0; }
  td.src { width: 76px; }
  .count { font-size: 12px; color: #7a838f; font-weight: 400; }
  .tag { display: inline-block; font-size: 11px; padding: 2px 7px; border-radius: 20px; white-space: nowrap; }
  .tag-add { background: #e7f0ff; color: #1a5fd0; }
  .tag-repl { background: #fff1e0; color: #b45309; }
  .old { margin-top: 8px; padding: 8px 10px; background: #f9fafb; border-left: 3px solid #f0dcb4;
         border-radius: 4px; font-size: 13px; color: #6b7280; }
  .why { color: #9aa3ae; }
  ul { padding-left: 20px; }
  li { margin: 6px 0; }
  b.k { color: #111827; }
</style>
</head>
<body>
<main>
  <h1>NPC 对白总览</h1>
  <p class="lede">数据源：<code>data/npcs.json</code> · 对白来源：<code>reference/mota50-deluxe/</code>（h5mota 官方原版复刻数据）</p>
  <p class="meta">本页由 <code>node tools/build-dialogue-report.mjs --write</code> 生成，请勿手改。</p>

  <div class="card ok">
    <b class="k">本轮覆盖</b>：智者 <b class="k">${Object.keys(npcs.sage?.talkByFloor || {}).length}</b> 层 ·
    商人 <b class="k">${Object.keys(npcs.merchant?.talkByFloor || {}).length}</b> 层 ·
    小偷 <b class="k">3</b> 句 · 公主 <b class="k">1</b> 句 —— 共 <b class="k">${total}</b> 个楼层有对白。
    <br>其中 <b class="k">2</b> 句是<strong>替换</strong>（原本是本项目自撰的过渡话术），其余全部为<strong>原版台词</strong>。
  </div>

  <div class="card">
    <b class="k">取值链</b>（<code>src/game/dialogue.ts</code>）：
    <code>talkByFloor</code>（本层特供，最优先）→ <code>greet</code>（首次）→ <code>repeat</code>（之后轮流）；
    商人走 <code>goodsByFloor</code>。所以下表里的台词是<strong>该层实际会显示的那一句</strong>。
  </div>

  <h2>逐层对白</h2>
${sections}

  <h2>有意不采用的原版内容</h2>
  <div class="card warn">
    <ul>
${SKIPPED.map(([who, what, why]) => `      <li><b class="k">${esc(who)}</b>：${esc(what)}<br><span class="why">不采用原因：${esc(why)}</span></li>`).join('\n')}
    </ul>
  </div>

  <h2>尚未落地（需要引擎支持）</h2>
  <div class="card">
    原版对白之外的<strong>事件演出</strong>本轮<strong>未做</strong>（用户选择「先补对白内容」）。
    它们需要给引擎补 <code>set</code>（放置实体）/ <code>hide</code>（删除实体）/ <code>shop</code> /
    <code>exitNext</code> / 条件分支这几样：
    <ul>
      <li>第 20 层「蝙蝠群汇聚成吸血鬼」——原版完整序列已还原（见 <code>docs/known-gaps.md</code> §2）</li>
      <li>14 / 34 / 39 层的自动开门</li>
      <li>23 层的暗墙迷宫（原版 43 处运行时 <code>closeWall</code>）</li>
      <li>49 / 50 层的真假魔王双结局（13 条 <code>cutscenes</code>）</li>
    </ul>
  </div>
</main>
</body>
</html>
`;
}

const doc = load();
const html = build(doc);

const npcs = doc.npcs;
const summary = ['sage', 'merchant', 'thief', 'princess']
  .map((k) => `${k}=${Object.keys(npcs[k]?.talkByFloor || {}).length}层`)
  .join(' · ');
console.log(`[dialogue-report] ${summary} · html ${html.length} B`);

if (process.argv.includes('--write')) {
  fs.writeFileSync(OUT, html);
  console.log(`[dialogue-report] 已写入 ${path.relative(ROOT, OUT)}`);
} else {
  console.log('[dialogue-report] dry-run（加 --write 才落盘）');
}
