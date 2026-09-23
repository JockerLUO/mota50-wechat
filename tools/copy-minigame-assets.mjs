/**
 * 把小游戏包内必须存在、但不参与打包的静态文件拷进 dist-minigame。
 *
 * 三类文件：
 *   1. `assets/atlas/*.png`   —— 图集（vite 把 import 换成 `assets/<name>.png` 字面量）
 *   2. `data/**`              —— 运行时数据（`source-minigame.ts` 用 readFileSync 读）
 *   3. `minigame/*.json`      —— 小游戏工程配置（game.json / project.config.json）
 *
 * 为什么不放在 vite 配置里：那是一份要经过 tsc 的 TS 配置，而项目没装 @types/node，
 * 引 `node:fs` 会直接报 TS2307。拆成一个 .mjs 脚本后，构建配置保持纯前端语义，
 * 拷文件这件事也变成一条显式的命令，比藏在插件的 closeBundle 里更好追。
 *
 * ## 为什么「拷数据」这件事非要有个脚本
 *
 * 网页端数据是 Vite 构建期内联的，不需要实体文件；小游戏端没有 bundler 之外
 * 的文件系统概念，数据要进代码包就得有实体文件。这是两端唯一的不对称，
 * 也是 `src/data/source.ts` 存在的理由。
 *
 * 关键在**清单的单一来源**：拷哪些文件由 `src/data/runtime-files.mjs` 决定，
 * 而那份清单同时被 `src/data/index.ts` 用来加载。两侧同一个文件 → 不可能出现
 * 「加了数据文件、网页端能跑、小游戏端读不到」这种只有真机才暴露的缺口。
 *
 * ## 清理：产物目录不由 vite 清空，所以必须有人负责删
 *
 * `vite.minigame.config.ts` 里 `emptyOutDir: false`（理由：IDE 会把 appid 写进
 * `project.config.json`，清空等于每次重建都让开发者重选一次 appid）。
 * 代价是残留文件会一直占主包额度，而且**不会有任何提示** ——
 * 所以这个脚本要顺手把「已经不该在包里」的东西清掉，并且**每删一个都打一行日志**
 *（静默删除比不删更难查：包突然小了，却不知道是谁删的）。
 *
 * 用法：npm run build:minigame（内部自动调用）
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_FLOOR_DIR, RUNTIME_TOP_JSON } from '../src/data/runtime-files.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-minigame');

if (!existsSync(OUT)) {
  console.error(`[minigame] 找不到 ${OUT}，请先运行 vite build --config vite.minigame.config.ts`);
  process.exit(1);
}

// ── 1. 图集 ────────────────────────────────────────────────────────
//
// 路径必须与 `vite.minigame.config.ts` 里写死的 `assets/<name>.png` 完全一致。

const atlasSrc = join(ROOT, 'assets', 'atlas');
const atlasOut = join(OUT, 'assets');
mkdirSync(atlasOut, { recursive: true });

let atlasBytes = 0;
let atlasCount = 0;
const wantedAtlas = new Set();
for (const file of readdirSync(atlasSrc)) {
  if (!file.endsWith('.png')) continue;
  wantedAtlas.add(file);
  const from = join(atlasSrc, file);
  copyFileSync(from, join(atlasOut, file));
  atlasBytes += statSync(from).size;
  atlasCount += 1;
}

const removed = [];
for (const f of readdirSync(atlasOut)) {
  if (f.endsWith('.png') && !wantedAtlas.has(f)) {
    rmSync(join(atlasOut, f));
    removed.push(`assets/${f}`);
  }
}

// ── 2. 运行时数据 ──────────────────────────────────────────────────
//
// 清单来自 `src/data/runtime-files.mjs`（与游戏代码共用同一个文件）。
//
// 顶层的每个 key 都按原路径拷；楼层目录整目录拷 ——
// 楼层文件是按索引里的 `id` 在**运行期**拼路径读的，源码里没有一份
// 「第几层叫什么文件名」的静态清单可抄，所以这里拷整个 `floors/` 并断言
// 目录里只有 `index.json` 与 `floor-<数字>.json`（多出来的东西必须当场报错，
// 否则它会静默进包、占主包额度）。

const dataSrc = join(ROOT, 'data');
const dataOut = join(OUT, 'data');

/** 本次**应该**在包里的 data/ 相对路径（用来清理多余文件） */
const wantedData = new Set();

function copyDataFile(rel) {
  const from = join(dataSrc, rel);
  const to = join(dataOut, rel);
  if (!existsSync(from)) {
    console.error(
      `[minigame] ✗ 清单里的 data/${rel} 不存在。\n` +
        `  → src/data/runtime-files.mjs 与实际数据不一致；游戏启动时会读不到它。`
    );
    process.exit(1);
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  wantedData.add(rel.split('\\').join('/'));
}

for (const key of RUNTIME_TOP_JSON) {
  if (key.startsWith(`${RUNTIME_FLOOR_DIR}/`)) continue; // 楼层目录在下面整目录处理
  copyDataFile(key);
}

const floorSrc = join(dataSrc, RUNTIME_FLOOR_DIR);
if (!existsSync(floorSrc)) {
  console.error(`[minigame] ✗ 找不到 ${floorSrc}（楼层数据目录）`);
  process.exit(1);
}
const FLOOR_FILE = /^(index|floor-\d+)\.json$/;
let floorCount = 0;
for (const file of readdirSync(floorSrc)) {
  if (!FLOOR_FILE.test(file)) {
    console.error(
      `[minigame] ✗ data/${RUNTIME_FLOOR_DIR}/ 里有不认识的 ${file}。\n` +
        `  → 这个目录按约定只放 index.json 与 floor-<数字>.json。\n` +
        `     要么改名，要么把它的拷贝写进本脚本（不要让它悄悄进包）。`
    );
    process.exit(1);
  }
  copyDataFile(`${RUNTIME_FLOOR_DIR}/${file}`);
  if (file !== 'index.json') floorCount += 1;
}

// 清理：包内多出来的数据文件（删掉某个数据文件后，旧副本会一直留着占额度）
function sweepDataDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(dataOut, abs).split('\\').join('/');
    if (entry.isDirectory()) {
      sweepDataDir(abs);
      if (readdirSync(abs).length === 0) rmSync(abs, { recursive: true });
      continue;
    }
    if (!wantedData.has(rel)) {
      rmSync(abs);
      removed.push(`data/${rel}`);
    }
  }
}
if (existsSync(dataOut)) sweepDataDir(dataOut);

// ── 3. 小游戏工程配置 ──────────────────────────────────────────────
//
// 由仓库里的 minigame/ 提供（那里是它的唯一来源）。
//
// ## 为什么要「保留 appid」而不是直接覆盖
//
// `appid` 描述的是**谁在跑**，不是**这个项目是什么**。仓库模板里写的是
// `touristappid`（游客身份，免注册），而开发者一在 IDE 里导入工程，IDE 就会把它
// 换成自己的真实 appid 写回本文件。此后每次 `npm run build:minigame` 如果无脑覆盖，
// 就会把 appid 冲回 `touristappid` —— 表现是「重建一次，IDE 就要重新选一次 appid」，
// 而且这个回退**不会报错**，只会让下一次打开工程时多一个说不清的提示。
//
// 所以：以仓库模板为准，但把已存在文件里的 appid / projectname 继承下来。
// `dist-minigame/` 是构建产物（不入库），这个继承只影响本机。

const configs = [];
for (const file of ['game.json', 'project.config.json']) {
  const src = join(ROOT, 'minigame', file);
  if (!existsSync(src)) continue;
  const dst = join(OUT, file);
  let text = readFileSync(src, 'utf8');

  if (file === 'project.config.json' && existsSync(dst)) {
    try {
      const prev = JSON.parse(readFileSync(dst, 'utf8'));
      const cur = JSON.parse(text);
      const kept = [];
      if (prev.appid && prev.appid !== cur.appid) {
        kept.push(`appid=${prev.appid}`);
        cur.appid = prev.appid;
      }
      if (prev.projectname && prev.projectname !== cur.projectname) {
        kept.push(`projectname=${prev.projectname}`);
        cur.projectname = prev.projectname;
      }
      if (kept.length) {
        text = JSON.stringify(cur, null, 2) + '\n';
        console.log(`[minigame] 保留 IDE 侧配置：${kept.join('、')}`);
      }
    } catch {
      /* 旧文件坏了就按模板写，不值得因此中断构建 */
    }
  }

  writeFileSync(dst, text);
  configs.push(file);
}

// ── 4. 清掉包内已经不该有的 js ─────────────────────────────────────
//
// 产物从「单文件 IIFE」改成了 `game.js` + `boot.js`（CJS），
// 但 `emptyOutDir: false` 意味着**旧产物不会被清掉**。
// 最典型的一个：早期开过 sourcemap 时留下的 `game.js.map` ——
// 它单独就有 3MB 上下，躺在包内、占主包额度、而且没人会注意到。
//
// 这里只删**明确认识且不该在**的文件，不做通配删 ——
// 将来真需要多一个 js 产物时，应该改这里（让「包里有哪些 js」保持可读）。

const EXPECTED_JS = new Set(['game.js', 'boot.js']);
for (const f of readdirSync(OUT)) {
  if (!f.endsWith('.js') && !f.endsWith('.map')) continue;
  if (EXPECTED_JS.has(f)) continue;
  rmSync(join(OUT, f));
  removed.push(f);
}

if (removed.length) {
  console.log(`[minigame] 清掉不再需要的文件：${removed.join('、')}`);
}

const kb = (bytes) => (bytes / 1024).toFixed(1);
const dataBytes = [...wantedData].reduce((n, rel) => n + statSync(join(dataOut, rel)).size, 0);
console.log(
  `[minigame] 拷入包内：assets/*.png × ${atlasCount}（${kb(atlasBytes)} KB）、` +
    `data/*.json × ${wantedData.size}（含 ${floorCount} 层，${kb(dataBytes)} KB）、` +
    `${configs.join('、')}`
);
