#!/usr/bin/env node
/**
 * 读微信开发者工具落盘的探针记录 —— **不需要任何进程在监听**。
 *
 * ```bash
 * node tools/read-ide-storage.cjs          # 最新一份
 * node tools/read-ide-storage.cjs --list   # 列出所有候选
 * node tools/read-ide-storage.cjs --raw    # 原样打印时间线 JSON
 * node tools/read-ide-storage.cjs --png    # 把落盘的像素记录解成图（默认 assets/preview/ide-frame.png）
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
 * 3. **时间线是分段的**（`module → shim → hostModule → host → probe → boot → pixels`）。
 *    哪一段没出现，就死在那一趟 import / 那一步。本项目这一路修掉了七个错
 *    （`_a` → `Intl` → `navigator` → `unsafe-eval` → `document` → `performance` /
 *    `requestAnimationFrame` → `MouseEvent`）**全是串行的**：修掉一个才露下一个，
 *    所以「报错一模一样」的另一种解释是「还没修到会暴露它的那一步」。
 *    `boot` 出现 = 渲染器起来了；`pixels` 出现 = 真的画了帧（可 `--png` 看图）。
 *
 * 4. **`bare` 视图在 `shim` 段，不在 `module` 段。** 它由 `env.ts` 的
 *    `reportBareReachability()` 在模块作用域**直接读**裸标识符产生，所以必须等
 *    垫片装完才量得到。它比错误栈有用得多：一次列出**全部**缺口（本机 32 个），
 *    而不是一轮报一个。这份清单是「还要不要垫」的唯一依据，
 *    所以默认视图里**不截断**它。
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
 * 这一组是「每次排查都会先看」的：构建号、宿主事实、走过的几个坑。
 * 注意 `bare`（裸标识符视图）**不在这里** —— 它在 `shim` 段，见 printShim()。
 */
const MODULE_HIGHLIGHT = [
  'build',
  'writeSticks',
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
    console.log(`  ${k}: ${JSON.stringify(data[k])}`);
  }
  const others = Object.keys(data).filter((k) => !MODULE_HIGHLIGHT.includes(k));
  if (others.length) console.log(`  （另有 ${others.length} 个字段：${others.join(', ')}）`);
}

/**
 * `shim` 段的核心是 `bare` —— 由 `env.ts` 在模块作用域**直接读**每个裸标识符得到，
 * 等价于 pixi 面对的那条作用域链。三态的含义完全不同，不能混着看：
 *
 *   - `对象类型名` / `function`  → 裸读**拿得到**（可能是宿主自带，也可能是我们的垫片）
 *   - `undefined`               → 裸读拿得到但值是 undefined（属性路径有、裸路径也有，
 *                                 只是宿主没填内容）—— 与「垫片没接上」是两回事
 *   - `ReferenceError`          → 裸读**根本不存在**。要么该垫（且 pixi 真的会走到），
 *                                 要么按「选垫两条判据」确认它不会被走到。
 *
 * 所以这里**分组打印、不截断**：默认视图里被 slice(0,220) 砍掉一半的话，
 * 就没法判断「还有哪些没垫」，等于白量。
 */
function printShim(data) {
  console.log('\n── shim 阶段（裸标识符可达性：模块作用域直接读，不用 typeof 守卫）──');
  const bare = data && data.bare;
  if (!bare || typeof bare !== 'object') {
    console.log('  （没有 bare 字段 —— 说明这一份产物还是旧的探针，或垫片段没跑到）');
    return;
  }
  const groups = { ok: [], undef: [], missing: [] };
  for (const [k, v] of Object.entries(bare)) {
    if (v === 'ReferenceError') groups.missing.push(k);
    else if (v === 'undefined') groups.undef.push(k);
    else groups.ok.push(`${k}=${v}`);
  }
  console.log(`  ✅ 裸读拿得到（${groups.ok.length}）: ${groups.ok.join('  ')}`);
  console.log(`  ➖ 拿得到但值 undefined（${groups.undef.length}）: ${groups.undef.join('  ') || '（无）'}`);
  console.log(
    `  ⛔ 裸读不存在 ReferenceError（${groups.missing.length}）: ${
      groups.missing.join('  ') || '（无）'
    }`
  );
  // 垫片名单**不在这里另抄一份**：从 `src/minigame/env/lexical-shims.json` 现读
  // （与 `PRELUDE` 由构建期断言对齐）。写死的那一版 2026-09-24 漏了 `URL` 而**没报错** ——
  // 名单里没有的名字，这里问不到，于是「漏查」表现为一片安静的绿。
  const SHIMMED = require('../src/minigame/env/lexical-shims.json').names;
  const notReachable = SHIMMED.filter((k) => !(k in bare) || bare[k] === 'ReferenceError' || bare[k] === 'undefined');
  console.log(
    notReachable.length
      ? `  ⛔ 已垫的 ${SHIMMED.length} 项里有 ${notReachable.length} 项在裸路径上仍不可用：${notReachable.join(', ')}   ← 垫片没接上`
      : `  ✅ 已垫的 ${SHIMMED.length} 项在裸路径上全部可用（${SHIMMED.join(' / ')}）`
  );
}

/**
 * `boot` 段的字段要**逐条**打，不能用通用的 `JSON.stringify(...).slice(0, 220)`。
 *
 * 原因很具体：这一段的字段顺序是「渲染器 → 分辨率 → 屏幕 → 楼层 → 位置 → 血量 →
 * 图集 → 触摸桥」，而后两项恰好是排查「素材没上 / 点不动」时唯一要看的东西 ——
 * 它们排在末尾，被 220 字符的截断正好丢掉（本轮就是这么漏掉 `touch` 的）。
 *
 * 另外这两项各自的「不好看的值」都值得单独提示，因为它们的失败形态都是**静默**的：
 *   - `atlasReady=false`：画面只是变朴素（回退程序化图形），不报错；
 *   - `canReal=false` 且 `nativeDom=true`：上屏画布不是宿主真 canvas，
 *     我们合成的真事件到不了 Pixi 挂在原生 document/window 上的监听 → 点不动。
 */
function printBoot(data) {
  const j = (v) => JSON.stringify(v);
  console.log('  [boot] 启动快照');
  console.log(`      rendererType=${data.rendererType}  resolution=${data.resolution}  屏幕=${j(data.screen)}`);
  console.log(`      floor=${data.floor}（显示 ${data.displayFloor}）  位置=${j(data.pos)}  hp=${data.hp}`);
  console.log(
    `      图集 atlasReady=${data.atlasReady}` +
      (data.atlasReady
        ? ''
        : `   ← 回退程序化图形（界面会显得简陋）${data.atlasError ? `：${data.atlasError}` : '（未上报原因）'}`)
  );
  const t = data.touch;
  if (t && t.hooked) {
    // 新版自述（env.ts 的 `__motaTouch.probe()`）：坑位接管 + 画布形态。
    const h = t.hooked;
    console.log(
      `      事件坑位接管 canvas=${h.canvas}  document=${h.document}  global=${h.global}` +
        `　派发 realDispatch=${t.realDispatch} 已派发=${t.sent}`
    );
    const c = t.canvas;
    if (c) {
      console.log(
        `      上屏画布 ctor=${c.ctor}  isHTMLCanvasElement=${c.isHTMLCanvasElement}` +
          `  hasAddEventListener=${c.hasAddEventListener}  hasDispatchEvent=${c.hasDispatchEvent}  isConnected=${c.isConnected}`
      );
    }
    if (!(h.canvas && h.document && h.global)) {
      console.log('        ⚠️ 有坑位没接管上：那类事件送不到 Pixi（缺 canvas → 按下收不到；');
      console.log('           缺 document → 悬停/详情面板不更新；缺 global → 抬手收不到，而 pointertap 正是抬手时生成的）。');
    }
    if (t.pointerBranch === false) {
      console.log('      （本宿主没有 PointerEvent → Pixi 走 mouse 分支，派发的事件名必须是 mousedown/mousemove/mouseup）');
    }
  } else if (t) {
    // 旧版自述（只有 canReal）：读完这次就请重新构建 —— 保留分支是为了让工具在
    // 「IDE 还在跑上一份产物」时也能给出可读输出，而不是打一串 undefined。
    console.log(
      `      触摸桥 pointerBranch=${t.pointerBranch}  nativeDom=${t.nativeDom}  canReal=${t.canReal}  ` +
        `realDispatch=${t.realDispatch}  已派发=${t.sent}   ← 旧版自述（重新构建可获得坑位接管信息）`
    );
  } else {
    console.log('      触摸桥：未上报（wx 缺失，或 env.ts 的垫片没装上）');
  }
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
    // module 与 shim 各自有专用打印（见 printModule / printShim）：
    // 前者字段太多要挑重点，后者的 bare 清单必须完整不许截断；
    // boot 也有专用打印（图集 / 触摸桥两项不能被 220 字符截掉）。
    if (r.stage === 'module' || r.stage === 'shim') continue;
    if (r.stage === 'boot' && r.data) {
      printBoot(r.data);
      continue;
    }
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

/**
 * 把落盘的像素记录写成 PNG —— 「IDE 里到底画了什么」唯一能直接看的东西。
 *
 * 记录形如 `{cols, rows, px, distinctColors, nonBlackRatio, …}`，`px` 是 cols×rows 个
 * 6 位十六进制 RGB 拼成的长串（行优先）。**探针侧已经翻好上下**（WebGL 原点在左下、
 * 人看图从上往下），所以这里直接铺，不用再 flip —— 多翻一次就会把画面倒过来。
 *
 * cols/rows 优先从记录自己身上取；取不到就退回 `pixels` 段（那一份没有 px，但有格子尺寸）。
 */
function writePng(pxRaw, outPath, pixelsStage) {
  if (pxRaw == null) {
    console.error('\n没有像素记录，解不出图。');
    console.error('要点：时间线里得先出现 pixels 段（说明游戏真的画了帧），');
    console.error('且产物是探针版 —— npm run build:minigame:beacon 构建。');
    return;
  }
  let rec = pxRaw;
  if (typeof rec === 'string') {
    try {
      rec = JSON.parse(rec);
    } catch {
      /* 万一存的就是裸 px 串，按裸串处理 */
    }
  }
  if (typeof rec === 'string') rec = { px: rec };

  const cols = rec.cols || (pixelsStage && pixelsStage.cols);
  const rows = rec.rows || (pixelsStage && pixelsStage.rows);
  if (!cols || !rows || typeof rec.px !== 'string') {
    console.error('\n像素记录里缺 cols/rows/px，解不出图。实际字段：' + JSON.stringify(Object.keys(rec)));
    return;
  }

  const { pngFromHexGrid } = require('./lib/png.cjs');
  const { png, width, height } = pngFromHexGrid(rec.px, cols, rows, 3);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, png);

  console.log('\n── 像素记录 → PNG ──');
  console.log(`  网格 ${cols}×${rows} → ${width}×${height}（探针已翻好上下，直接铺）`);
  if (rec.resolution != null) console.log(`  resolution: ${rec.resolution}`);
  if (rec.distinctColors != null) console.log(`  颜色种类: ${rec.distinctColors}`);
  if (rec.nonBlackRatio != null) console.log(`  非黑占比: ${rec.nonBlackRatio}`);
  console.log(`  已写出: ${outPath}`);
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
  const shim = records.find((r) => r.stage === 'shim');
  if (shim) printShim(shim.data || {});
  printTimeline(records);

  if (args.includes('--png')) {
    const outArg = args.find((a) => a.startsWith('--out='));
    const outPath = outArg
      ? path.resolve(outArg.slice('--out='.length))
      : path.resolve('assets/preview/ide-frame.png');
    writePng(px, outPath, records.find((r) => r.stage === 'pixels') || null);
  }
}

main();
