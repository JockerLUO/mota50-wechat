#!/usr/bin/env node
/**
 * 读微信开发者工具落盘的探针记录 —— **不需要任何进程在监听**。
 *
 * ```bash
 * node tools/read-ide-storage.cjs          # 最新一份
 * node tools/read-ide-storage.cjs --list   # 列出所有候选
 * node tools/read-ide-storage.cjs --raw    # 原样打印时间线 JSON
 * ```
 *
 * ## 为什么需要它
 *
 * 探针有两条通道：HTTP 回本机（`tools/wx-beacon-server.cjs`）与 `wx.setStorageSync`。
 * **只有后者是可靠的** —— 前者要求服务端恰好在监听，而 IDE 只在点「编译」时重载游戏，
 * 那一刻服务端在不在取决于人和机器的时序。实测就栽过一次：用户在 IDE 点编译时服务端没起，
 * 错误信息**直接蒸发**，时间线里只剩一条 `module`，只知道「炸了」不知道炸在哪。
 *
 * IDE 把存储写到（按项目 hash 分目录，所以用 glob）：
 *
 *   ~/Library/Application Support/微信开发者工具/<hash>/
 *     WeappSimulator/WeappStorage/storage_<...>.json
 *
 * ## 读的时候要注意的三件事
 *
 * 1. **一次编译可能在两个上下文里跑两遍**（白名单沙箱 + 带原生 DOM 的上下文），
 *    而两者**共用同一份 storage**（后写的覆盖前面的）。所以「只有一条记录」
 *    既可能是「跑了一次」，也可能是「另一个上下文把它盖掉了」。
 * 2. **先看构建号。** 它回答的是「IDE 到底在跑哪一份产物」——
 *    没有它就没法区分「修了没用」和「跑的还是旧包」。每次让人点编译前先记下当前构建号。
 * 3. **时间线是分段的**（`module → shim → hostModule → host → probe → boot`）。
 *    哪一段没出现，就死在那一趟 import / 那一步。本项目四个错
 *    （`_a` → `Intl` → `navigator` → `unsafe-eval`）**是串行的**，修掉一个才露下一个，
 *    所以「报错一模一样」的另一种解释是「还没修到会暴露它的那一步」。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT_DIR = path.join(os.homedir(), 'Library', 'Application Support', '微信开发者工具');
const BEACON_KEY = '__motaBeacon';
const PX_KEY = '__motaBeaconPx';

/** 所有 IDE 项目 hash 目录下的 storage_*.json，按修改时间从新到旧。 */
function findStores() {
  const out = [];
  let hashes = [];
  try {
    hashes = fs.readdirSync(ROOT_DIR);
  } catch {
    return out;
  }
  for (const h of hashes) {
    const dir = path.join(ROOT_DIR, h, 'WeappSimulator', 'WeappStorage');
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^storage_.*\.json$/.test(f)) continue;
      const abs = path.join(dir, f);
      try {
        out.push({ abs, hash: h, mtime: fs.statSync(abs).mtimeMs });
      } catch {
        /* 刚被 IDE 重写，跳过 */
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * IDE 的存储是 `{ "0": { "__motaBeacon": { data: "<json 字符串>" } } }`。
 * 但 `data` 有可能是真对象（探针在个别路径下直接存对象），两种都吃。
 */
function readBeacon(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const bucket of Object.values(raw)) {
    if (!bucket || typeof bucket !== 'object') continue;
    const entry = bucket[BEACON_KEY];
    if (!entry) continue;
    let value = entry;
    if (entry && typeof entry === 'object' && 'data' in entry) value = entry.data;
    if (typeof value === 'string') value = JSON.parse(value);
    // 同一份文件里像素记录是另一个键，带上标记方便统计
    const pxEntry = bucket[PX_KEY];
    let px = null;
    if (pxEntry) {
      px = typeof pxEntry === 'object' && 'data' in pxEntry ? pxEntry.data : pxEntry;
    }
    return { records: value, px };
  }
  return null;
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}

/**
 * module 阶段的字段很多，但不是都值得一眼看到。
 * 这一组是「每次排查都会先看」的：构建号、宿主事实、两个错过的坑、以及裸标识符视图。
 */
const MODULE_HIGHLIGHT = [
  'build',
  'writeSticks',
  'bare',
  'hasWx',
  'wxKeys',
  'hasGameGlobal',
  'hasWindow',
  'hasDocument',
  'hasPerformance',
  'hasRAF',
  'navigator',
  'env'
];

function printModule(data) {
  console.log('── module 阶段（构建号 / 宿主事实 / 裸标识符）──');
  if (data.build) console.log(`  构建号: ${data.build}   ← 先比这个，确认 IDE 跑的是不是刚构建的包`);
  for (const k of MODULE_HIGHLIGHT) {
    if (!(k in data)) continue;
    const v = data[k];
    if (k === 'bare') {
      const bad = Object.entries(v).some(([, s]) => s === 'ReferenceError' || s === 'EvalError');
      console.log(
        `  bare（作用域链视图，new Function 裸读）: ${JSON.stringify(v)}` +
          (bad ? '   ← 有标识符在裸读路径上读不到/构造器被禁' : '')
      );
      continue;
    }
    if (k === 'env' || k === 'navigator') {
      console.log(`  ${k}: ${JSON.stringify(v)}`);
      continue;
    }
    console.log(`  ${k}: ${JSON.stringify(v)}`);
  }
  const others = Object.keys(data).filter((k) => !MODULE_HIGHLIGHT.includes(k));
  if (others.length) console.log(`  （另有 ${others.length} 个字段：${others.join(', ')}）`);
}

function printTimeline(records) {
  console.log('\n── 时间线 ──');
  const stages = records.map((r) => r.stage);
  console.log(`  ${stages.join(' → ') || '（空）'}`);
  // 「走到哪一段」比「报了什么错」更能定位：串行链上，缺哪段就死在哪段。
  const KNOWN = ['module', 'shim', 'hostModule', 'host', 'probe', 'boot', 'pixels'];
  const missing = KNOWN.filter((k) => !stages.includes(k));
  if (missing.length && missing.length < KNOWN.length) {
    console.log(`  未出现: ${missing.join(', ')}   ← 很可能死在「第一个未出现的那段的入口」`);
  }
  console.log('');
  for (const r of records) {
    if (r.stage === 'module') continue;
    const t = r.t != null ? `t=${r.t}` : '';
    if (r.message || r.stack) {
      console.log(`  [${r.stage}] ${t}`);
      console.log(`      ${String(r.message || '').slice(0, 300)}`);
      if (r.stack) {
        const lines = String(r.stack).split('\n').slice(0, 6);
        for (const l of lines) console.log(`      ${l.trim().slice(0, 180)}`);
      }
    } else if (r.data) {
      console.log(`  [${r.stage}] ${t}  ${JSON.stringify(r.data).slice(0, 220)}`);
    } else {
      console.log(`  [${r.stage}] ${t}`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const stores = findStores();
  if (!stores.length) {
    console.error(`没找到落盘记录。查过：${ROOT_DIR}/*/WeappSimulator/WeappStorage/storage_*.json`);
    console.error('（先在 IDE 里点一次「编译」，探针才会写进去。）');
    process.exit(1);
  }
  if (args.includes('--list')) {
    for (const s of stores) {
      let tag = '';
      try {
        const got = readBeacon(s.abs);
        const rec = got && got.records && got.records[0];
        if (rec && rec.data && rec.data.build) tag = `  build=${rec.data.build}`;
      } catch {
        tag = '  （读不出 __motaBeacon）';
      }
      console.log(`${fmtTime(s.mtime)}  ${path.basename(s.abs)}${tag}`);
    }
    return;
  }

  const target = stores[0];
  const got = readBeacon(target.abs);
  if (!got) {
    console.error(`最新那份里没有 ${BEACON_KEY}：${target.abs}`);
    console.error('说明这一份产物没带探针（用 npm run build:minigame:beacon 构建），或还没跑起来。');
    process.exit(1);
  }
  const { records, px } = got;

  console.log(`来源：${target.abs}`);
  console.log(`改动：${fmtTime(target.mtime)}   （IDE 写入时刻，不是构建时刻）`);
  console.log(`记录数：${records.length}`);
  if (px != null) {
    const len = typeof px === 'string' ? px.length : JSON.stringify(px).length;
    console.log(`像素记录：${PX_KEY} 存在，约 ${(len / 1024).toFixed(0)} KB`);
  }
  console.log('');

  if (args.includes('--raw')) {
    console.log(JSON.stringify(records, null, 1));
    return;
  }

  const mod = records.find((r) => r.stage === 'module');
  if (mod && mod.data) printModule(mod.data);
  printTimeline(records);
}

main();
