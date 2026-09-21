#!/usr/bin/env node
/**
 * 从 data/*.json 生成 tools/balance-check.html。
 *
 * 为什么要生成而不是手写：HTML 要能双击直接打开，就必须把数据内联进去，
 * 于是天然和数据源分成两份。与其靠人工同步，不如让数据源当唯一真相，
 * HTML 只作为产物 —— 这样「内联副本漂移」这个问题在设计上就不存在了。
 *
 * HTML 内部还会用内联的黄金用例自检自己的公式实现，防止公式逻辑漂移。
 *
 * 用法：node tools/build-balance-check.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const constants = read('data/constants.json');
const { monsters } = read('data/monsters.json');
const { items } = read('data/items.json');
const cases = read('data/combat-cases.json');
const placement = read('data/monster-placement.json');

const embed = (id, obj) =>
  `<script type="application/json" id="${id}">${JSON.stringify(obj)}</script>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>魔塔50层 · 数值校验台</title>
<style>
  :root {
    --bg: #f6f7f9;
    --panel: #ffffff;
    --line: #e3e6eb;
    --text: #1f2328;
    --muted: #6b7280;
    --accent: #2f6feb;
    --ok: #1a7f37;
    --warn: #9a6700;
    --danger: #cf222e;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    background: var(--bg); color: var(--text);
    font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 20px; }
  .panel {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 16px 18px; margin-bottom: 16px;
  }
  .row { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-end; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label { font-size: 12px; color: var(--muted); }
  input[type=number] {
    width: 104px; padding: 6px 8px; font: inherit;
    border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--text);
  }
  .checks { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; }
  .checks label { display: flex; align-items: center; gap: 5px; font-size: 13px; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 6px 8px; text-align: right; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { font-weight: 600; color: var(--muted); font-size: 12px; background: #fafbfc; position: sticky; top: 0; }
  th:first-child, td:first-child { text-align: left; }
  td.name { font-weight: 500; }
  tbody tr:hover { background: #f3f6fb; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; line-height: 18px; }
  .t-easy { background: #e6f4ea; color: var(--ok); }
  .t-ok { background: #eef2f7; color: var(--muted); }
  .t-high { background: #fff4d6; color: var(--warn); }
  .t-danger { background: #ffe2e0; color: var(--danger); }
  .t-fatal { background: #cf222e; color: #fff; }
  .t-blocked { background: #eaecef; color: #57606a; }
  .t-execute { background: #e7e0ff; color: #5b3fd6; }
  .bar { display: inline-block; height: 8px; border-radius: 4px; background: var(--accent); vertical-align: middle; }
  .scroll { max-height: 560px; overflow: auto; }
  .stat { display: inline-block; margin-right: 18px; }
  .stat b { font-size: 15px; }
  .ok { color: var(--ok); } .bad { color: var(--danger); }
  code { background: #f0f2f5; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .note { color: var(--muted); font-size: 12px; margin-top: 10px; }
  .warnbox { background: #fff8e5; border: 1px solid #f0e0b0; border-radius: 8px; padding: 10px 12px; font-size: 13px; }
</style>
</head>
<body>

<h1>魔塔50层 · 数值校验台</h1>
<div class="sub">
  数值取自原版《魔塔50层》源码与社区基准帖。本页由
  <code>tools/build-balance-check.mjs</code> 从 <code>data/*.json</code> 自动生成，内联数据与数据源一致。
</div>

<div class="panel">
  <h2>一、勇者属性与持有道具</h2>
  <div class="row">
    <div class="field"><label>生命 HP</label><input type="number" id="hp" value="1000"></div>
    <div class="field"><label>攻击 ATK</label><input type="number" id="atk" value="10"></div>
    <div class="field"><label>防御 DEF</label><input type="number" id="def" value="10"></div>
    <div class="field"><label>所在楼层</label><input type="number" id="floor" value="1" min="0" max="50"></div>
    <div class="field"><label>已购买次数 n</label><input type="number" id="buys" value="1" min="1"></div>
  </div>
  <div class="checks" style="margin-top:14px">
    <label><input type="checkbox" id="cross"> 十字架（克兽人/兽人武士/吸血鬼）</label>
    <label><input type="checkbox" id="dragonSlayer"> 屠龙剑（克魔龙）</label>
    <label><input type="checkbox" id="sacredShield"> 神圣盾（免疫领域）</label>
    <label><input type="checkbox" id="onlyReachable"> 只看「能打赢」的</label>
    <label><input type="checkbox" id="onlyFloor"> 只看当前楼层会遇到</label>
  </div>
</div>

<div class="panel">
  <h2>二、怪物战斗预览</h2>
  <div id="summary" style="margin-bottom:12px"></div>
  <div class="scroll">
    <table>
      <thead><tr>
        <th>怪物</th><th>出现层</th><th>HP</th><th>ATK</th><th>DEF</th>
        <th>回合</th><th>每回合</th><th>总损失</th><th>占生命</th><th>评级</th>
        <th>击破需 ATK</th><th>零损需 ATK</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div class="note">
    损失 = (回合数 − 1) × 每回合伤害，回合数 = ⌈怪HP / (勇者ATK − 怪DEF)⌉。
    勇者先手，所以怪物只完整出手「回合数 − 1」次。
  </div>
</div>

<div class="panel">
  <h2>三、商店计算器</h2>
  <div class="row">
    <div class="field"><label>当前金币</label><input type="number" id="gold" value="500"></div>
  </div>
  <div id="shop" style="margin-top:14px"></div>
  <div class="note">
    价格 = 10n(n−1) + 20，n 为已购买次数；收益 = 基础值 × (⌊楼层/10⌋ + 1)。
    增量随楼层放大、价格却只与购买次数挂钩 —— 这是原版「前期不买、留到后面买」策略的数学来源。
  </div>
</div>

<div class="panel">
  <h2>四、公式自检</h2>
  <div id="selftest"></div>
  <div class="note">
    用 data/combat-cases.json 的黄金用例验证本页的战斗与商店公式实现。
    其中大多数用例的期望值取自公开攻略里玩家实测的扣血量，属独立第三方数据。
  </div>
</div>

${embed('hero', constants.hero)}
${embed('monsters', monsters)}
${embed('items', items)}
${embed('cases', cases.cases)}
${embed('shopCases', cases.shopCases)}
${embed('placement', placement.placement)}
${embed('shopConfig', constants.shop)}
${embed('economy', constants.economy)}

<script>
const J = (id) => JSON.parse(document.getElementById(id).textContent);
const HERO_INIT = J('hero');
const MONSTERS = J('monsters');
const ITEMS = J('items');
const CASES = J('cases');
const SHOP_CASES = J('shopCases');
const PLACEMENT = J('placement');
const SHOP_CFG = J('shopConfig');
const ECONOMY = J('economy');

/* ─── 战斗公式：与 core/combat.mjs 保持一致 ─── */
function normalizeTraits(raw) {
  const flags = new Set(), auras = [], flanks = [], executes = [];
  for (const t of raw || []) {
    if (typeof t === 'string') { flags.add(t); continue; }
    if (t && typeof t === 'object') {
      if (t.type === 'aura') auras.push(t);
      else if (t.type === 'flank') flanks.push(t);
      else if (t.type === 'execute') executes.push(t);
    }
  }
  return { flags, auras, flanks, executes };
}

function simulateBattle(hero, mon, counters) {
  const t = normalizeTraits(mon.traits);
  for (const e of t.executes) {
    if (typeof hero[e.stat] === 'number' && hero[e.stat] >= e.threshold) {
      return { execute: true, rounds: 1, enemyAttacks: 0, perRound: Math.max(0, mon.atk - hero.def),
               hpLoss: 0, hpLossMin: 0, hpLossMax: 0, effectiveAtk: hero.atk, canWin: true };
    }
  }
  let atk = hero.atk;
  for (const c of counters) if (t.flags.has(c.trait) && c.stat === 'atk') atk = Math.floor(atk * c.mul);
  const perHit = atk - mon.def;
  if (perHit <= 0) {
    return { execute: false, effectiveAtk: atk, perHit, rounds: null, enemyAttacks: null,
             perRound: Math.max(0, mon.atk - hero.def), hpLoss: Infinity,
             hpLossMin: Infinity, hpLossMax: Infinity, canWin: false, reason: 'unpierceable' };
  }
  const rounds = Math.ceil(mon.hp / perHit);
  const perRound = Math.max(0, mon.atk - hero.def);
  const flank = t.flanks.length ? t.flanks.reduce((m, f) => Math.max(m, f.chance || 1), 0) : 0;
  const base = rounds - 1;
  const hpLossMin = base * perRound;
  const hpLossMax = (base + (flank > 0 ? 1 : 0)) * perRound;
  const hpLoss = perRound === 0 ? 0 : Math.round(hpLossMin * (1 - flank) + hpLossMax * flank);
  const dead = hpLoss >= hero.hp;
  return { execute: false, effectiveAtk: atk, perHit, rounds, enemyAttacks: base,
           perRound, flanked: flank > 0, hpLoss, hpLossMin, hpLossMax,
           canWin: !dead, reason: dead ? 'heroDies' : null };
}

/* ─── 商店公式 ─── */
const shopCost = (n) => 10 * n * (n - 1) + 20;
const cumulativeCost = (n) => n <= 0 ? 0 : (10 * n * (n + 1) * (n - 1)) / 3 + 20 * n;
const tierMul = (f) => Math.floor(f / 10) + 1;
const shopGain = (f, stat) => ({ hp: 100, atk: 2, def: 4 })[stat] * tierMul(f);
const maxPurchases = (gold) => { let n = 0; while (cumulativeCost(n + 1) <= gold) n++; return n; };

/* ─── 状态 ─── */
const $ = (id) => document.getElementById(id);
const countersOf = () => {
  const out = [];
  if ($('cross').checked) out.push({ trait: 'crossVulnerable', stat: 'atk', mul: 2 });
  if ($('dragonSlayer').checked) out.push({ trait: 'dragon', stat: 'atk', mul: 2 });
  return out;
};
const heroOf = () => ({ hp: +$('hp').value || 0, atk: +$('atk').value || 0, def: +$('def').value || 0 });

function gradeOf(pv, hero) {
  if (pv.reason === 'unpierceable') return ['blocked', '打不动'];
  if (pv.reason === 'heroDies') return ['fatal', '必死'];
  if (pv.execute) return ['execute', '零损秒杀'];
  const r = pv.hpLoss / hero.hp;
  if (r > 0.3) return ['danger', '危险 ' + (r * 100).toFixed(1) + '%'];
  if (r > 0.15) return ['high', '偏高 ' + (r * 100).toFixed(1) + '%'];
  if (r >= 0.05) return ['ok', '合适 ' + (r * 100).toFixed(1) + '%'];
  return ['easy', '轻松 ' + (r * 100).toFixed(1) + '%'];
}

function render() {
  const hero = heroOf();
  const counters = countersOf();
  const onFloor = +$('floor').value || 0;
  const onlyWin = $('onlyReachable').checked;
  const onlyHere = $('onlyFloor').checked;

  const rows = [];
  let wins = 0, blocked = 0, fatal = 0, totalLoss = 0;

  for (const [id, m] of Object.entries(MONSTERS)) {
    const pv = simulateBattle(hero, m, counters);
    const place = PLACEMENT[id];
    if (onlyHere && place && !place.floors.includes(onFloor)) continue;
    if (onlyWin && !pv.canWin) continue;
    if (pv.canWin) { wins++; totalLoss += pv.hpLoss; } else if (pv.reason === 'unpierceable') blocked++; else fatal++;

    const [cls, label] = gradeOf(pv, hero);
    const ratio = pv.hpLoss === Infinity ? Infinity : pv.hpLoss / hero.hp;
    const barW = ratio === Infinity ? 100 : Math.min(100, ratio * 100 / 0.5 * 100 / 100);
    const floorText = place ? (place.floors.length > 4
      ? place.floors[0] + '~' + place.floors[place.floors.length - 1] + ' (' + place.count + '只)'
      : place.floors.join(',') + ' (' + place.count + '只)') : '未使用';

    rows.push(\`<tr>
      <td class="name">\${m.name}\${m.boss ? ' <span class="tag t-danger">BOSS</span>' : ''}</td>
      <td>\${floorText}</td>
      <td>\${m.hp}</td><td>\${m.atk}</td><td>\${m.def}</td>
      <td>\${pv.rounds ?? '—'}</td>
      <td>\${pv.perRound}</td>
      <td>\${pv.hpLoss === Infinity ? '∞' : pv.hpLoss}\${pv.flanked ? ' <span class="tag t-high">夹击</span>' : ''}</td>
      <td>\${ratio === Infinity ? '∞' : (ratio * 100).toFixed(1) + '%'}
          <span class="bar" style="width:\${barW}px;background:\${cls === 'fatal' ? '#cf222e' : cls === 'danger' ? '#e5534b' : cls === 'high' ? '#d4a72c' : '#2f6feb'}"></span></td>
      <td><span class="tag t-\${cls}">\${label}</span></td>
      <td>\${m.def + 1}</td>
      <td>\${m.def + m.hp}</td>
    </tr>\`);
  }

  $('rows').innerHTML = rows.join('');
  $('summary').innerHTML =
    \`<span class="stat">能打赢 <b class="ok">\${wins}</b> 只</span>\` +
    \`<span class="stat">打不动 <b>\${blocked}</b> 只</span>\` +
    \`<span class="stat">会致死 <b class="bad">\${fatal}</b> 只</span>\` +
    \`<span class="stat">全清损失合计 <b>\${totalLoss.toLocaleString()}</b> / 生命 \${hero.hp.toLocaleString()}
       = <b class="\${totalLoss > hero.hp ? 'bad' : 'ok'}">\${(totalLoss / hero.hp * 100).toFixed(0)}%</b></span>\`;

  renderShop();
}

function renderShop() {
  const floor = +$('floor').value || 1;
  const gold = +$('gold').value || 0;
  let n = Math.max(1, +$('buys').value || 1);
  const mul = tierMul(floor);
  const rows = [];
  let left = gold, count = 0, spent = 0;

  while (shopCost(n) <= left && count < 20) {
    const c = shopCost(n);
    rows.push(\`<tr>
      <td>第 \${n} 次</td><td>\${c}</td>
      <td>+\${shopGain(floor, 'hp')}</td><td>+\${shopGain(floor, 'atk')}</td><td>+\${shopGain(floor, 'def')}</td>
      <td>\${(c / shopGain(floor, 'atk')).toFixed(1)}</td>
      <td>\${(c / shopGain(floor, 'def')).toFixed(1)}</td>
    </tr>\`);
    left -= c; spent += c; count++; n++;
  }

  const goldPerAtk = (shopCost(n) / shopGain(floor, 'atk')).toFixed(1);
  const goldPerDef = (shopCost(n) / shopGain(floor, 'def')).toFixed(1);
  const nextAtFloor1 = (shopCost(n) / (2 * tierMul(1))).toFixed(1);
  const nextAtFloor50 = (shopCost(n) / (2 * tierMul(50))).toFixed(1);

  $('shop').innerHTML = \`
    <div style="margin-bottom:10px">
      <span class="stat">第 \${floor} 层倍率 <b>×\${mul}</b></span>
      <span class="stat">本次金币可买 <b>\${count}</b> 次</span>
      <span class="stat">花掉 <b>\${spent}</b>，剩余 <b>\${left}</b></span>
    </div>
    \${rows.length ? \`<table>
      <thead><tr><th>次数</th><th>价格</th><th>生命</th><th>攻击</th><th>防御</th>
      <th>每点攻击价</th><th>每点防御价</th></tr></thead>
      <tbody>\${rows.join('')}</tbody></table>\` : '<div class="warnbox">金币不足以再购买一次 —— 第 ' + n + ' 次需要 ' + shopCost(n) + ' 金币。</div>'}
    <div class="note">
      全游戏总金币 \${ECONOMY.totalGoldInGame.toLocaleString()}，按公式最多购买
      <b>\${ECONOMY.maxPurchasesIfAllGoldSpent}</b> 次属性（累计 \${cumulativeCost(ECONOMY.maxPurchasesIfAllGoldSpent).toLocaleString()}）。
      下一次购买每点攻击要 \${goldPerAtk} 金币、每点防御 \${goldPerDef} 金币；
      同样的钱若等到第 50 层买，每点攻击只要 \${nextAtFloor50} 金币，而在第 1 层买要 \${nextAtFloor1} 金币 ——
      相差约 \${(nextAtFloor1 / nextAtFloor50).toFixed(1)} 倍。
    </div>\`;
}

function selfTest() {
  const results = [];
  let pass = 0, failCount = 0;

  for (const c of CASES) {
    const pv = simulateBattle(c.hero, c.monster, c.counters || []);
    const e = c.expected;
    const diffs = [];
    const chk = (k, got, want) => { if (want !== undefined && got !== want) diffs.push(k + ' ' + got + '≠' + want); };
    chk('回合', pv.rounds, e.rounds);
    chk('出手', pv.enemyAttacks, e.enemyAttacks);
    chk('每回合', pv.perRound, e.perRound);
    chk('可胜', pv.canWin, e.canWin);
    chk('原因', pv.reason || undefined, e.reason);
    chk('斩杀', pv.execute, e.execute);
    chk('有效ATK', pv.effectiveAtk, e.effectiveAtk);
    chk('夹击', pv.flanked, e.flanked);
    chk('最小损失', pv.hpLossMin, e.hpLossMin);
    chk('最大损失', pv.hpLossMax, e.hpLossMax);
    if (e.loss === null) { if (pv.hpLoss !== Infinity) diffs.push('损失应为∞'); }
    else chk('损失', pv.hpLoss, e.loss);
    if (diffs.length) { failCount++; results.push(['bad', c.name + ' → ' + diffs.join('，')]); }
    else { pass++; results.push(['ok', c.name + ' → 通过']); }
  }

  for (const c of SHOP_CASES) {
    const got = c.n !== undefined
      ? (c.name.indexOf('累计') >= 0 ? cumulativeCost(c.n) : shopCost(c.n))
      : shopGain(c.floor, c.stat);
    if (got !== c.expected) { failCount++; results.push(['bad', c.name + ' → ' + got + '≠' + c.expected]); }
    else { pass++; results.push(['ok', c.name + ' → 通过']); }
  }

  $('selftest').innerHTML =
    \`<div style="margin-bottom:10px"><span class="stat">通过 <b class="\${failCount ? '' : 'ok'}">\${pass}</b></span>
     <span class="stat">失败 <b class="\${failCount ? 'bad' : ''}">\${failCount}</b></span>
     <span class="stat">共 \${pass + failCount} 条</span></div>\` +
    \`<div class="scroll" style="max-height:220px"><table><tbody>\` +
    results.map(([k, t]) => \`<tr><td class="name \${k === 'ok' ? 'ok' : 'bad'}">\${t}</td></tr>\`).join('') +
    \`</tbody></table></div>\` +
    (failCount ? '<div class="warnbox" style="margin-top:10px">自检失败：本页公式实现已与数据漂移，请重新运行 tools/build-balance-check.mjs。</div>'
               : '<div class="note">✓ 本页公式实现与黄金用例完全一致。</div>');
}

document.querySelectorAll('input').forEach((el) => {
  el.addEventListener('input', render);
  el.addEventListener('change', render);
});
render();
selfTest();
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, 'tools/balance-check.html'), html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log('✓ 已生成 tools/balance-check.html');
console.log(`  大小 ${kb} KB，内联数据：`);
console.log(`    怪物 ${Object.keys(monsters).length} 只`);
console.log(`    道具 ${Object.keys(items).length} 项`);
console.log(`    战斗用例 ${cases.cases.length} 条 + 商店用例 ${cases.shopCases.length} 条`);
console.log(`    怪物出现层索引 ${Object.keys(placement.placement).length} 条`);
