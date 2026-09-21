/**
 * 共用：解析 `playwright-core`，并找到一份可用的 Chromium。
 *
 * 这段逻辑原本在 `verify-minigame.cjs`、`verify-visual.cjs`、`shot-web.cjs`
 * 里各抄了一份（后来 `verify-dom-host.cjs` 又要用），四处一字不差 ——
 * 抽出来是为了以后只改一处。
 *
 * ## 为什么要「找」而不是直接用 `chromium.executablePath()`
 *
 * `playwright-core` 不自带浏览器，`executablePath()` 返回的是**该版本期望**的位置；
 * 本机装过多个版本、或浏览器装在别处时它会指向一个不存在的路径（直接抛）。
 * 所以先信 `executablePath()`，不成立再扫缓存目录，按版本号**从新到旧**试。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** `playwright-core` 可能不在本项目的 node_modules 里（依赖被提升到别处了）。 */
const SHARED_MODULES = [
  process.env.PLAYWRIGHT_MODULES,
  path.join(os.homedir(), '.workbuddy/binaries/node/workspace/node_modules'),
  path.join(__dirname, '..', '..', 'node_modules')
].filter(Boolean);

function resolvePlaywrightCore() {
  try {
    return require('playwright-core');
  } catch {
    /* 落到下面的共享目录 */
  }
  for (const base of SHARED_MODULES) {
    try {
      return require(require.resolve('playwright-core', { paths: [base] }));
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

const playwrightCore = resolvePlaywrightCore();

if (!playwrightCore) {
  console.error('找不到 playwright-core。已尝试的解析路径：');
  for (const p of SHARED_MODULES) console.error('  ' + p);
  console.error('可用 PLAYWRIGHT_MODULES=<node_modules 目录> 覆盖。');
  process.exit(2);
}

/**
 * 定位 Chromium 可执行文件。
 *
 * 兜底扫描按各平台的实际布局逐个试：同一份缓存目录下，浏览器可能在
 * `chrome-mac-arm64/`、也可能在 `chrome-mac/`（Intel 版本），
 * 装了新版也不会删旧版，所以要遍历而不是只看最新的那个。
 */
function findChromium() {
  const { chromium } = playwrightCore;
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* 版本不匹配时抛错，落到兜底扫描 */
  }
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), 'Library/Caches/ms-playwright'), // macOS
    path.join(os.homedir(), '.cache/ms-playwright'), // Linux
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null
  ].filter((p) => p && fs.existsSync(p));
  const layouts = [
    ['chrome-mac-arm64', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
    ['chrome-mac-arm64', 'Chromium.app/Contents/MacOS/Chromium'],
    ['chrome-mac', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
    ['chrome-mac', 'Chromium.app/Contents/MacOS/Chromium'],
    ['chrome-mac-x64', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'],
    ['chrome-mac-x64', 'Chromium.app/Contents/MacOS/Chromium'],
    ['chrome-linux', 'chrome'],
    ['chrome-win', 'chrome.exe']
  ];
  for (const root of caches) {
    const dirs = fs
      .readdirSync(root)
      .filter((x) => x.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const d of dirs) {
      for (const [sub, rel] of layouts) {
        const p = path.join(root, d, sub, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error(
    '找不到可用的 Chromium。请先执行：npx playwright install chromium\n' +
      '  若已装在别处，可用 PLAYWRIGHT_BROWSERS_PATH=<目录> 指定。'
  );
}

module.exports = { chromium: playwrightCore.chromium, findChromium, SHARED_MODULES };
