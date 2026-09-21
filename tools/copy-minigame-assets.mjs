/**
 * 把小游戏包内必须存在、但不参与打包的静态文件拷进 dist-minigame。
 *
 * 为什么不放在 vite 配置里：那是一份要经过 tsc 的 TS 配置，而项目没装 @types/node，
 * 引 `node:fs` 会直接报 TS2307。拆成一个 .mjs 脚本后，构建配置保持纯前端语义，
 * 拷文件这件事也变成一条显式的命令，比藏在插件的 closeBundle 里更好追。
 *
 * 用法：npm run build:minigame（内部自动调用）
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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
for (const file of readdirSync(atlasSrc)) {
  if (!file.endsWith('.png')) continue;
  const from = join(atlasSrc, file);
  copyFileSync(from, join(atlasOut, file));
  bytes += statSync(from).size;
  count += 1;
}

/** 小游戏工程配置：由仓库里的 minigame/ 提供（那里是它的唯一来源） */
const configs = [];
for (const file of ['game.json', 'project.config.json']) {
  const src = join(ROOT, 'minigame', file);
  if (!existsSync(src)) continue;
  copyFileSync(src, join(OUT, file));
  configs.push(file);
}

const kb = (bytes / 1024).toFixed(1);
console.log(`[minigame] 拷入包内：assets/*.png × ${count}（${kb} KB）、${configs.join('、')}`);
