/**
 * deluxe 源（h5mota 官方原版复刻数据）的对白 ↔ 本项目 NPC 对照分析器。
 *
 * ## 为什么先分析、不直接写数据
 *
 * 两个源的**地图是同一张**（97.03% 逐格一致，见 .workbuddy/memory 的当日日志），
 * 但**NPC 的落点并不一一对应**：本项目 sage 出现在 28 层，而 deluxe 的
 * `oldmanHints` 只有 23 层；本项目 2 层有 3 个 NPC，deluxe MT2 只有 1 个老人。
 *
 * ⇒ 直接照楼层号覆盖会**静默丢掉**本项目多出来的那些 NPC，也会把
 *   「本项目没有载体的提示」丢掉。所以先出一张**逐层对照表**：
 *   哪一条能落在本项目的哪个坐标上、哪一条落不下、为什么。
 *
 * ## 用法
 *
 *   node tools/analyze-deluxe-dialogue.mjs            # 只看报告
 *   node tools/analyze-deluxe-dialogue.mjs --json     # 额外输出 JSON 到 /tmp
 *
 * 数据来源与授权见 `reference/mota50-deluxe/ATTRIBUTION.md`。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'reference/mota50-deluxe/source/mota-data.js');
const FLOORS = path.join(ROOT, 'data/floors');

// ── 读 deluxe ────────────────────────────────────────────────────────
if (!fs.existsSync(SRC)) {
  console.error(`找不到 ${SRC}。见 reference/mota50-deluxe/ATTRIBUTION.md`);
  process.exit(2);
}
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: SRC });
const D = ctx.window.MOTA_DATA;

// ── 读本项目：每层的 NPC 实体（坐标 + id）────────────────────────────
const myFloor = {};
for (const f of fs.readdirSync(FLOORS)) {
  if (!/^floor-\d+\.json$/.test(f)) continue;
  const j = JSON.parse(fs.readFileSync(path.join(FLOORS, f), 'utf8'));
  myFloor[j.index] = j;
}
/** 本项目某层的某个 id 的 NPC 坐标列表 */
function myNpcAt(floor, id) {
  return (myFloor[floor]?.entities ?? [])
    .filter((e) => e.type === 'npc' && (!id || e.id === id))
    .map((e) => `${e.x},${e.y}`);
}
/** 本项目全塔某 id 的楼层集合 */
function myNpcFloors(id) {
  return Object.keys(myFloor)
    .map(Number)
    .filter((n) => myNpcAt(n, id).length)
    .sort((a, b) => a - b);
}

const out = [];
const P = (s = '') => out.push(s);

P('═'.repeat(78));
P('deluxe（h5mota 原版复刻）对白  ↔  本项目 NPC 逐层对照');
P('═'.repeat(78));
P(`deluxe commit: ${fs.existsSync(path.join(ROOT, 'reference/mota50-deluxe/COMMIT.txt'))
  ? fs.readFileSync(path.join(ROOT, 'reference/mota50-deluxe/COMMIT.txt'), 'utf8').trim()
  : '(未记录)'}`);
P();

// ── ① 智者提示（oldmanHints）→ sage.talkByFloor ──────────────────────
P('① 智者提示 oldmanHints（' + Object.keys(D.oldmanHints).length + ' 条）→ 本项目 sage.talkByFloor');
P('-'.repeat(78));
const sageFloors = myNpcFloors('sage');
P('   本项目 sage 出现在 ' + sageFloors.length + ' 层: ' + sageFloors.join(','));
P('   deluxe 提示楼层:      ' + Object.keys(D.oldmanHints).sort((a, b) => a - b).join(','));
P();

const oldmanRows = [];
for (const [floor, v] of Object.entries(D.oldmanHints).sort((a, b) => a - b)) {
  const n = Number(floor);
  const here = myNpcAt(n, 'sage');
  // deluxe 里有 oldman/trader 双栏的条目（6 / 31 / 39 / 45 层）
  const kind = v.text ? 'text' : (v.oldman && v.trader ? 'oldman+trader' : Object.keys(v).join('+'));
  const text = v.text || v.oldman || '';
  oldmanRows.push({ floor: n, kind, text, trader: v.trader || '', gift: v.gift || null, myPos: here });
  P(`   ${String(n).padStart(2)} 层  [${kind.padEnd(13)}]  本项目 sage ${here.length ? '@' + here.join('/') : '**不存在**'}`);
  P(`         ${text.slice(0, 64)}${text.length > 64 ? '…' : ''}`);
  if (v.trader) P(`         (trader 栏) ${v.trader.slice(0, 56)}${v.trader.length > 56 ? '…' : ''}`);
  if (v.gift) P(`         (gift) ${JSON.stringify(v.gift)}  ← 有附带效果，本轮不实现`);
}
P();
const canPlace = oldmanRows.filter((r) => r.myPos.length).length;
const noHome = oldmanRows.filter((r) => !r.myPos.length).map((r) => r.floor);
P(`   ⇒ 可直接落 ${canPlace} / ${oldmanRows.length}；无处可落 ${noHome.length ? noHome.join(',') + ' 层' : '（无）'}`);
const extraSage = sageFloors.filter((n) => !(n in D.oldmanHints));
P(`   ⇒ 本项目 sage 有、deluxe 无提示的 ${extraSage.length} 层: ${extraSage.join(',')}（保留现有自撰台词）`);
P();

// ── ② 商人商品（traders）→ merchant.goodsByFloor ─────────────────────
P('② 商人商品 traders（' + Object.keys(D.traders).length + ' 条）↔ 本项目 merchant.goodsByFloor');
P('-'.repeat(78));
const MINE = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/npcs.json'), 'utf8'));
const myGoods = MINE.npcs.merchant.goodsByFloor || {};
P('   本项目 merchant 楼层:  ' + Object.keys(myGoods).sort((a, b) => a - b).join(','));
P('   deluxe traders 楼层:   ' + Object.keys(D.traders).sort((a, b) => a - b).join(','));
P();
for (const [floor, t] of Object.entries(D.traders).sort((a, b) => a - b)) {
  const mine = myGoods[floor];
  const mineStr = mine?.goods
    ? mine.goods.map((g) => `${g.op}(${g.item ?? g.stat}${g.count ? '×' + g.count : ''}@${g.price})`).join(' ')
    : (mine?.gifts ? 'gifts:' + JSON.stringify(mine.gifts).slice(0, 40) : '**无**');
  const give = Object.entries(t.give).map(([k, v]) => `${k}${v === 1 ? '' : '×' + v}`).join('+');
  const flag = mine && (mine.goods || mine.gifts) ? '' : '  ⚠️ 本项目缺';
  P(`   ${String(floor).padStart(2)} 层  deluxe: ${give} @${t.cost}金币   |   本项目: ${mineStr}${flag}`);
}
const deluxeTraderFloors = Object.keys(D.traders).map(Number);
const mineExtra = Object.keys(myGoods).map(Number).filter((n) => !deluxeTraderFloors.includes(n));
const mineMissing = deluxeTraderFloors.filter((n) => !myGoods[String(n)]);
P();
P(`   ⇒ 本项目多出的商人楼层: ${mineExtra.join(',') || '（无）'}`);
P(`   ⇒ deluxe 有、本项目缺:  ${mineMissing.join(',') || '（无）'}`);
P();

// ── ③ 祭坛 / 商店（shrines）→ shop ─────────────────────────────────
P('③ 祭坛 shrines（' + Object.keys(D.shrines).length + ' 条）↔ 本项目 shop');
P('-'.repeat(78));
const shopFloors = myNpcFloors('shop');
P('   本项目 shop 楼层:   ' + shopFloors.join(','));
for (const [fid, s] of Object.entries(D.shrines)) {
  const n = Number(fid.replace('MT', ''));
  const here = myNpcAt(n, 'shop');
  P(`   deluxe ${fid}  ratio=${s.ratio}  loc=${JSON.stringify(s.loc)} → 本项目 (${s.loc[0] - 1},${s.loc[1] - 1})  ` +
    (here.length ? `本项目 shop@${here.join('/')} ✅` : '⚠️ 本项目该层无 shop'));
}
P();

// ── ④ 剧情对白（cutscenes + step 的 text）────────────────────────────
P('④ 剧情对白（text 操作）—— 本轮只统计，不带触发条件的一律不落');
P('-'.repeat(78));
const texts = [];
const walk = (v, where) => {
  if (Array.isArray(v)) v.forEach((x) => walk(x, where));
  else if (v && typeof v === 'object') {
    if (v.t === 'text') texts.push({ where, who: v.who || '', text: v.text });
    for (const [k, x] of Object.entries(v)) if (k !== 'text') walk(x, where);
  }
};
for (const [id, cs] of Object.entries(D.cutscenes)) walk(cs, 'cutscene:' + id);
for (const f of D.floors) {
  for (const [k, v] of Object.entries(f.talk || {})) walk(v, `MT${f.n}:talk@${k}`);
  for (const [k, v] of Object.entries(f.step || {})) walk(v, `MT${f.n}:step@${k}`);
}
const byWhere = {};
for (const t of texts) (byWhere[t.where] = byWhere[t.where] || []).push(t);
P(`   共 ${texts.length} 条，分布在 ${Object.keys(byWhere).length} 处：`);
for (const [w, arr] of Object.entries(byWhere)) {
  P(`     ${w.padEnd(26)} ${String(arr.length).padStart(2)} 条  ${arr.map((t) => t.who || '旁白').join('/')}`);
}
P();

// ── 汇总 ────────────────────────────────────────────────────────────
P('═'.repeat(78));
P('汇总');
P('═'.repeat(78));
P(`  ① 智者提示    可落 ${canPlace} / ${oldmanRows.length} 条` + (noHome.length ? `（${noHome.join(',')} 层无载体）` : ''));
P(`  ② 商人商品    本项目缺 ${mineMissing.length} 条、多 ${mineExtra.length} 层`);
P(`  ③ 祭坛        ${Object.keys(D.shrines).length} 条`);
P(`  ④ 剧情对白    ${texts.length} 条（带条件的需引擎支持，本轮不落）`);

const report = out.join('\n');
console.log(report);

if (process.argv.includes('--json')) {
  const p = '/tmp/m50-deluxe-analysis.json';
  fs.writeFileSync(p, JSON.stringify({ oldmanRows, traders: D.traders, shrines: D.shrines, texts }, null, 1));
  console.log('\n(JSON 已写出 ' + p + ')');
}
