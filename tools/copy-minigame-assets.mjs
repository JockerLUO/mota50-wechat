/**
 * 把小游戏包内必须存在、但不参与打包的静态文件拷进 dist-minigame。
 *
 * 为什么不放在 vite 配置里：那是一份要经过 tsc 的 TS 配置，而项目没装 @types/node，
 * 引 `node:fs` 会直接报 TS2307。拆成一个 .mjs 脚本后，构建配置保持纯前端语义，
 * 拷文件这件事也变成一条显式的命令，比藏在插件的 closeBundle 里更好追。
 *
 * 用法：npm run build:minigame（内部自动调用）
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist-minigame');

if (!existsSync(OUT)) {
  console.error(`[minigame] 找不到 ${OUT}，请先运行 vite build --config vite.minigame.config.ts`);
  process.exit(1);
}

/** 图集：路径必须与 `vite.minigame.config.ts` 里写死的 `assets/<name>.png` 完全一致 */
const atlasSrc = join(ROOT, 'assets', 'atlas');
const atlasOut = join(OUT, 'assets');
mkdirSync(atlasOut, { recursive: true });

let bytes = 0;
let count = 0;
const wanted = new Set();
for (const file of readdirSync(atlasSrc)) {
  if (!file.endsWith('.png')) continue;
  wanted.add(file);
  const from = join(atlasSrc, file);
  copyFileSync(from, join(atlasOut, file));
  bytes += statSync(from).size;
  count += 1;
}

// 产物目录不再由 vite 清空（原因见 `vite.minigame.config.ts` 里 emptyOutDir 的说明），
// 所以「删掉已经不需要的图集」这件事必须有人做 —— 否则删掉一张图集后，
// 旧 PNG 会一直留在小游戏包里占额度，而且不会有任何提示。
const stale = readdirSync(atlasOut).filter((f) => f.endsWith('.png') && !wanted.has(f));
for (const f of stale) {
  rmSync(join(atlasOut, f));
  console.log(`[minigame] 清掉不再需要的图集：${f}`);
}

/**
 * 小游戏工程配置：由仓库里的 minigame/ 提供（那里是它的唯一来源）。
 *
 * ## 为什么要「保留 appid」而不是直接覆盖
 *
 * `appid` 描述的是**谁在跑**，不是**这个项目是什么**。仓库模板里写的是
 * `touristappid`（游客身份，免注册），而开发者一在 IDE 里导入工程，IDE 就会把它
 * 换成自己的真实 appid 写回本文件。此后每次 `npm run build:minigame` 如果无脑覆盖，
 * 就会把 appid 冲回 `touristappid` —— 表现是「重建一次，IDE 就要重新选一次 appid」，
 * 而且这个回退**不会报错**，只会让下一次打开工程时多一个说不清的提示。
 *
 * 所以：以仓库模板为准，但把已存在文件里的 appid / projectname 继承下来。
 * `dist-minigame/` 是构建产物（不入库），这个继承只影响本机。
 */
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

const kb = (bytes / 1024).toFixed(1);
console.log(`[minigame] 拷入包内：assets/*.png × ${count}（${kb} KB）、${configs.join('、')}`);
