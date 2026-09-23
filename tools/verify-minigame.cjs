/**
 * 小游戏产物「无 DOM 环境」实测 —— 驱动脚本。
 *
 * 三件事：
 *   1. 起静态服务器，把 `dist-minigame/`（游戏产物）与 `tools/minigame-harness/`
 *      （无 DOM 宿主 + 最小 wx 垫片）一起伺服；
 *   2. 用 Chromium 打开宿主页，等 Worker 里的实测报告通过 HTTP 回传；
 *   3. 按预先写死的判据逐条判定，并保存截图。
 *
 * 为什么宿主是 Worker 而不是页面：页面的 `document` 是 `[LegacyUnforgeable]`
 * 自有属性，删不掉也覆盖不了（第一版就是这么失败的，见 worker.js 文件头）。
 * Worker 是真实的无 DOM realm。
 *
 * 为什么用 .cjs：浏览器相关逻辑在 `tools/lib/chromium.cjs` 里共享，那里用 CJS
 * 的 `require.resolve(..., {paths})` 解析 WorkBuddy 的共享 node 工作区；本脚本
 * 因此可以留在仓库里，并与其它的 Chromium 驱动脚本共用同一套定位逻辑。
 *
 * 用法：npm run verify:minigame
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
// 清单要从 `src/data/runtime-files.mjs` 现读（它是 ESM，只能动态 import）——
// 这份清单是**单一来源**，游戏代码与拷贝脚本都按它办事，判据也必须按它，不能另抄一份。
const { pathToFileURL } = require('node:url');
const { chromium, findChromium } = require('./lib/chromium.cjs');
const { inlineAsJs, collectJsSources, collectDataFiles } = require('./lib/package-tables.cjs');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist-minigame');
const HARNESS = path.join(ROOT, 'tools', 'minigame-harness');
const OUT = path.join(ROOT, 'assets', 'preview');
const PORT = Number(process.env.PORT || 4190);

if (!fs.existsSync(path.join(DIST, 'game.js'))) {
  console.error(`找不到 ${path.join(DIST, 'game.js')}，请先运行 npm run build:minigame`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

// ── 静态服务 ────────────────────────────────────────────────────────
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

let resolveResult;
const resultPromise = new Promise((r) => {
  resolveResult = r;
});

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'POST' && url === '/__result') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(204).end();
      try {
        resolveResult(JSON.parse(body));
      } catch (e) {
        resolveResult({ problems: [`报告不是合法 JSON: ${e.message}`] });
      }
    });
    return;
  }

  if (url === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }

  // ── 包内文件表：源码 + 数据，供宿主**同步**取用 ────────────────────
  //
  // 产物是 CJS 多文件（`game.js` require `./boot.js`），而 `require` 是同步调用；
  // 数据又是用 `wx.getFileSystemManager().readFileSync()` 同步读的。
  // Worker 里没有同步 fetch —— 所以由服务器当场把包内文件内联成两张表，
  // 宿主 `importScripts` 一次就拿全。
  //
  // 两张表都是**枚举产物目录**得到的，所以它们就是「包里有什么」的事实描述，
  // 换 chunk 划分、增删数据文件时这里不用改任何代码。
  // 完整理由见 tools/lib/package-tables.cjs 文件头。
  //
  // 与图集一样，这里不写死文件名。
  if (url === '/__sources.js') {
    res.writeHead(200, { 'content-type': MIME['.js'] });
    res.end(inlineAsJs('__motaSources', collectJsSources(DIST)));
    return;
  }
  if (url === '/__data.js') {
    res.writeHead(200, { 'content-type': MIME['.js'] });
    res.end(inlineAsJs('__motaData', collectDataFiles(DIST)));
    return;
  }

  // 先找游戏产物，再找宿主文件
  const candidates =
    url === '/' || url === '/index.html'
      ? [path.join(HARNESS, 'index.html')]
      : [path.join(DIST, url), path.join(HARNESS, url)];

  const file = candidates.find((p) => {
    const resolved = path.resolve(p);
    if (!resolved.startsWith(DIST) && !resolved.startsWith(HARNESS)) return false; // 目录穿越防护
    return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  });

  if (!file) {
    res.writeHead(404).end('not found: ' + url);
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

// ── 主流程 ──────────────────────────────────────────────────────────
(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const base = `http://127.0.0.1:${PORT}/`;

  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });

  const consoleMsgs = [];
  page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
  page.on('console', async (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    if (m.text().includes('favicon')) return; // 浏览器自动请求，与本次无关
    // 警告有时是 Error 对象，m.text() 只给 stack；把 args 也 stringify 出来
    const args = await Promise.all(
      m.args().map((h) =>
        h.evaluate((a) => {
          if (a === undefined) return 'undefined';
          if (a === null) return 'null';
          if (typeof a === 'object' && a !== null && a.stack) return a.toString() + '\n' + a.stack;
          try {
            return typeof a === 'object' ? JSON.stringify(a) : String(a);
          } catch {
            return '[object]';
          }
        })
      )
    );
    consoleMsgs.push(`[${m.type()}] ${args.join(' ')}`);
  });

  await page.goto(base, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => {
    const orig = console.warn;
    console.warn = (...args) => {
      const s = args
        .map((a) => {
          if (a === undefined) return 'undefined';
          if (a === null) return 'null';
          if (typeof a === 'object' && a.stack) return a.stack;
          try {
            return typeof a === 'object' ? JSON.stringify(a) : String(a);
          } catch {
            return '[object]';
          }
        })
        .join(' ');
      orig('WARN-CAPTURED:', s);
    };
  });

  const report = await Promise.race([
    resultPromise,
    new Promise((r) => setTimeout(() => r({ problems: ['等待报告超时（90s）'] }), 90000))
  ]);

  await page.screenshot({ path: path.join(OUT, 'minigame-board.png') });
  await browser.close();
  server.close();

  // ── 判定 ─────────────────────────────────────────────────────────
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  /** 探针自采像素重建出来的图，非空时在结尾一并报出来 */
  let beaconFrame = null;

  const workerLogs = report.logs || [];
  const logErrors = workerLogs.filter((l) => l.startsWith('[error]'));
  const problems = [...(report.problems || []), ...consoleMsgs, ...logErrors];
  add('无报错 / 无异常', problems.length === 0, problems.slice(0, 4).join(' | ') || '干净');

  add(
    '启动没有弹「启动失败」',
    !report.bootFailed,
    report.bootFailed ? JSON.stringify(report.bootFailed) : '无弹窗'
  );

  const probe = report.probe || {};
  add(
    '渲染器是 webgl（不是静默降级的 canvas）',
    probe.rendererType === 'webgl',
    `rendererType=${probe.rendererType}`
  );
  add('分辨率 = 设备像素比 3', probe.resolution === 3, `resolution=${probe.resolution}`);

  const px = report.pixels;
  add(
    '帧缓冲里有实际画面（非背景色像素 > 30%）',
    px && px.nonClearRatio > 0.3,
    px ? `${px.nonClear}/${px.total} = ${(px.nonClearRatio * 100).toFixed(1)}%` : '没拿到像素'
  );
  add('画面不是纯色块（颜色种类 > 20）', px && px.distinctColors > 20, px ? `${px.distinctColors} 种颜色` : '-');

  const srcs = report.imageSrcs || [];
  const badSrc = srcs.filter((s) => !/^assets\/[a-z]+\.png$/.test(s));
  add(
    '图集走包内相对路径（无前导斜杠、无 hash）',
    srcs.length >= 4 && badSrc.length === 0,
    srcs.length ? srcs.join(', ') : '没有图片被加载'
  );
  // 「路径写对了」和「图真的到手了」是两件事，必须分开断言。
  //
  // 图集加载失败时 `atlas.ready` 保持 false，渲染层**静默**换用 `icons.ts` 的
  // 程序化图形 —— 画面照旧出得来，棋盘也是完整的，只是美术不对。
  // 只看截图的话，这一条永远发现不了；而它一旦漏到线上，
  // 表现就是「美术全没了但没人知道为什么」。
  add(
    '图集真的加载成功（不是静默回退成程序化图形）',
    probe.atlasReady === true,
    probe.atlasReady === true ? 'atlas.ready = true' : 'atlas.ready = false —— 当前画面是程序化图形，不是美术'
  );

  // ── 包里的图集必须是**刚出的那一份** ────────────────────────────────
  //
  // 上面那条只能证明「图集加载成功了」，证明不了「加载的是哪一版」。
  // 而这两件事的差距，就是本轮用户反馈的「新的素材在模拟器中没有生效」：
  //
  //   `dist-minigame/assets/*.png` 是 `build:minigame` 时由
  //   `tools/copy-minigame-assets.mjs` **拷过去的一份副本**。
  //   只跑 `npm run assets`（重建图集）或只跑 `npm run build`（网页版）
  //   都不会刷新它 —— 包内还是上一版美术。
  //
  // 症状之所以隐蔽：IDE 里一切正常（无报错、`atlasReady=true`、棋盘完整），
  // 只是画的是旧画。不看对比图根本发现不了。
  //
  // 判据用内容哈希，不看时间戳：时间戳会被 checkout / 复制 / 打包抹掉，
  // 而「字节一致」才是「模拟器里看到的就是我刚画的那份」的准确表述。
  const atlasSrcDir = path.join(ROOT, 'assets', 'atlas');
  const atlasDstDir = path.join(DIST, 'assets');
  const hash12 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
  const staleAtlas = [];
  for (const file of fs.readdirSync(atlasSrcDir)) {
    if (!file.endsWith('.png')) continue;
    const dst = path.join(atlasDstDir, file);
    if (!fs.existsSync(dst)) {
      staleAtlas.push(`${file} 不在包内`);
      continue;
    }
    const a = hash12(path.join(atlasSrcDir, file));
    const b = hash12(dst);
    if (a !== b) staleAtlas.push(`${file} 源=${a} 包=${b}`);
  }
  add(
    '包内图集与 assets/atlas 逐字节一致（不是上一版美术）',
    staleAtlas.length === 0,
    staleAtlas.length
      ? `${staleAtlas.join(' | ')} —— 重建过图集就要跑一次 npm run build:minigame`
      : '一致'
  );

  add('离屏画布确实拿到了（createCanvas ≥ 2 次）', report.canvasCreates >= 2, `createCanvas × ${report.canvasCreates}`);
  add('场景图里有精灵', report.spriteCount > 20, `Sprite 节点 ${report.spriteCount} 个`);
  const naturallyGone = report.removedNaturally || [];
  add(
    '宿主本来就没有 DOM（不用伪造）',
    naturallyGone.includes('document') && naturallyGone.includes('window') && naturallyGone.length >= 10,
    `${naturallyGone.length} 个：${naturallyGone.join(', ')}`
  );

  // ── 宿主缺失的全局：`Intl`（判「测试本身有没有效」）────────────────
  //
  // 真机小游戏**没有** `Intl`，而 Pixi 在**模块求值期**就读它的裸标识符：
  // esbuild 降到 es2015 时把 `typeof Intl?.Segmenter === 'function'` 改写成了
  // `typeof (Intl == null ? void 0 : Intl.Segmenter) === 'function'` ——
  // `typeof` 那层保护被绕掉（`typeof Intl` 本来是不抛的，`Intl == null` 会），
  // 于是 `ReferenceError: Intl is not defined`，整个包起不来。IDE 里的实测症状
  // 就是这一句 + 黑屏。
  //
  // 这条判据的真正作用不是「检 Intl」，而是**证明宿主确实复现了小游戏的处境**：
  // 必须 `hostHadIntl === true`（宿主本来有，说明删掉它这个动作有意义）
  // 且 `intlGone === true`（真的删干净了 —— 只置 `undefined` 会让
  // `Intl == null` 成立、错误消失，判据却还在报「通过」）。
  // 两个条件缺一，上面那条「无报错 / 无异常」就是**假绿**，比不测更糟。
  add(
    '宿主本来有 Intl，且已真删（证明本轮的「无异常」不是假绿）',
    report.hostHadIntl === true && report.intlGone === true,
    `hostHadIntl=${report.hostHadIntl} intlGone=${report.intlGone}` +
      (report.intlGone === false ? ' —— 只置了 undefined，这条路径没被真正测到' : '')
  );
  // 与上一条配对：删掉之后**必须由垫片补上**。
  //
  // 注意别在启动后去查 `'Intl' in globalThis` 为假 —— 那是在等一个错误的结论：
  // 垫片补上它才是对的，真值在这里恰恰是「通过」的证据。
  add(
    'Intl 缺失时由垫片补上（所以启动成功不是靠宿主自带）',
    report.intlAfterBoot === true,
    `启动后 typeof Intl = ${report.intlAfterBoot ? 'object（垫片）' : 'undefined'}`
  );

  // ── 禁用 unsafe-eval：`pixi.js/unsafe-eval` 有没有真的接管 ──────────────
  //
  // 这一组是 2026-09-21 IDE 第四轮报错的对症判据。当时 pad 好 Intl/navigator 之后
  // 时间线一路走到了 `probe`，然后死在 `Game.create()` 里：
  //
  //   Error: Current environment does not allow unsafe-eval,
  //          please use pixi.js/unsafe-eval module to enable support.
  //
  // （同一条落盘记录里 `bare.Intl = "no-new-function"` 互证了 CSP 禁 eval 这件事。）
  //
  // ⚠️ 这里**不能**用「产物里搜 `new Function`」当判据 —— 原实现是死代码，
  //    被 polyfill 在原型上覆盖，Rollup tree-shake 不掉，搜了必然还是能搜到。
  //    唯一有效的是**行为判据**：让 `new Function` 执行期抛 EvalError，看它还起不起得来。
  //
  // 三条必须一起看，缺一条都可能是假绿：
  //   ① 禁令真的装上了（否则测的是「宿主允许 eval」，等于没测）
  //   ② 启动后禁令仍然有效（否则可能是产物把 `Function` 换回去换来的成功）
  //   ③ `Function` 没被替换（`instanceof` 等语义没被顺手弄坏）
  add(
    '宿主已禁 unsafe-eval（`new Function` 抛 EvalError）—— 本组判据的前提',
    report.evalBanned === true,
    `evalBanned=${report.evalBanned}`
  );
  add(
    '启动后禁令仍有效（成功不是靠把 eval 要回来）',
    report.evalStillBannedAfterBoot === true,
    `evalStillBannedAfterBoot=${report.evalStillBannedAfterBoot}`
  );
  add(
    '`globalThis.Function` 没被产物替换（禁的是 eval，不是 Function 本身）',
    report.functionWasSwapped === false,
    `functionWasSwapped=${report.functionWasSwapped}`
  );

  // ── 工程配置（这两条看着像「配置检查」，其实是环境正确性判据）────────
  //
  // 开发者工具是**按 appid 的 `gameApp` 属性**决定项目类型的，`compileType` 只表达意图：
  //   checkAppIdTypeVaild()：选了小游戏 → appid.gameApp 必须为 true，否则报错并回退
  //   refreshMenuSelectedWithCorrectAppID()：回退动作就是 selectMenu("miniprogram")
  // 回退后编译管线走小程序那条路，去找 `app.json` —— 而小游戏只需要 `game.json`。
  // 于是症状是「导入后报『未找到 app.json』，无法调试」，和产物本身毫无关系。
  //
  // `touristappid` 是**小程序**的游客号（小游戏的是 wx6ac3f5090a6b99c5），
  // 写进小游戏工程必然触发上面这条链。判据放在这里，是为了让这个坑
  // 在本地就红掉，而不是等导入 IDE 才由人发现。
  const projectConfigPath = path.join(DIST, 'project.config.json');
  let projectConfig = null;
  try {
    projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
  } catch {
    projectConfig = null;
  }
  add(
    'project.config.json 声明 compileType=game',
    projectConfig && projectConfig.compileType === 'game',
    projectConfig ? `compileType=${projectConfig.compileType}` : '读不到 / 不是合法 JSON'
  );
  add(
    'appid 没被写成小程序游客号（touristappid）',
    !!projectConfig && projectConfig.appid !== 'touristappid',
    !projectConfig
      ? '-'
      : projectConfig.appid
        ? `appid=${projectConfig.appid}（须是「小游戏」类型账号，否则工具仍会判成小程序）`
        : 'appid 留空 —— 导入时由 IDE 取「小游戏」测试号'
  );

  // ── 产物语法地板 ────────────────────────────────────────────────────
  //
  // 这条判据的由来是一次**只有微信侧才能发现的失败**：代码在上传/预览时会先过一遍
  // 微信云端的语法检查，而那个检查器不接受 ES2020 语法。症状是在 IDE 里点「编译」
  // 立刻失败，且与游戏逻辑毫无关系：
  //
  //   task type:upload exec error Error: invalid file: game.js, 13:9
  //   SyntaxError: Unexpected token .        ← 指向 `wx?.request?.(` 里的 `?`
  //
  // 报错码是服务端的 `DEV_COMPILE_INVALID_FILE`（-80057）。根因是
  // `vite.minigame.config.ts` 里写过的 `target: 'es2020'` —— 那个字段只管**本地**
  // 打包，管不到云端这一步。现在两边都钉在 ES2015。
  //
  // 一个可用的旁证：报错精确停在文件里**第一个** ES2020 token 上（第 13 行），
  // 而它前面 12 行的箭头函数、`const` 都过了 —— 说明检查器的地板落在
  // ES2015 与 ES2020 之间，ES2015 是它明确能吃下的。
  //
  // 判定手法：**不能直接 grep**。`?.` / `??` 在注释和字符串里是合法文本
  // （pixi 的 JSDoc 里就有一处 `exec(value)?.[1] ?? '1'`，worker 源码常量里还有
  // `async function`），裸 grep 必然假报。这里改用 esbuild 以**地板目标复算一遍**：
  // 产物里若真有高于地板的语法，复算会把它降掉 → token 计数变少 → 判负；
  // 而注释/字符串里的同名字符串在两边原样保留 → 计数相同 → 不误伤。
  const SYNTAX_FLOOR = 'es2015'; // ⚠️ 必须与 vite.minigame.config.ts 的 build.target 一致
  //
  // ⚠️ 必须**逐个 js 文件**查，不能只查入口。云端检查器看的是包内**所有**文件，
  //    而拆包之后 `boot.js` 才是体积最大、语法最杂的那一个（pixi 全在里面）。
  //    只查 game.js 的话，「pixi 带进来高版本语法」本地永远发现不了 ——
  //    症状与下面记录的完全同构，只是报错文件名变成 `invalid file: boot.js`，
  //    而且晚一步（要等上传/预览才炸）。
  {
    const norm = (s) => s.replace(/\s+/g, '');
    const cnt = (s, p) => s.split(p).length - 1;
    // `**` 刻意不在列表里：JSDoc 的 `/**` 本身就含它，打印器对注释的重排会改变计数。
    const PATTERNS = ['?.', '??', 'catch{'];

    for (const file of ['game.js', 'boot.js']) {
      const abs = path.join(DIST, file);
      if (!fs.existsSync(abs)) {
        add(`${file} 语法不高于 ${SYNTAX_FLOOR}`, false, '文件不在包内 —— 拆包没成功');
        continue;
      }
      const raw = fs.readFileSync(abs, 'utf8');

      let lowered = null;
      let lowerErr = null;
      try {
        lowered = (await require('esbuild').transform(raw, { target: SYNTAX_FLOOR, loader: 'js', minify: false })).code;
      } catch (e) {
        lowerErr = e;
      }

      if (!lowered) {
        add(
          `${file} 语法不高于 ${SYNTAX_FLOOR}`,
          false,
          `无法用 esbuild 复算（esbuild 是 vite 的传递依赖，缺失时本判据失效）：${lowerErr && lowerErr.message}`
        );
        continue;
      }
      const drift = PATTERNS.map((p) => [p, cnt(norm(raw), p), cnt(norm(lowered), p)]).filter(([, a, b]) => a !== b);
      add(
        `${file} 语法不高于 ${SYNTAX_FLOOR}（微信云端检查器的地板）`,
        drift.length === 0,
        drift.length
          ? drift.map(([p, a, b]) => `${p}: ${a}→${b}`).join('  ') + '（被降级 = 产物里存在高于地板的语法）'
          : `${(raw.length / 1024).toFixed(0)}KB 复算无差异；${PATTERNS.join(' / ')} 计数不变`
      );
    }
  }

  // ── 包结构：拆包边界 +「数据是运行期读的，不是构建期内联的」──────────────
  //
  // 这一组是 2026-09-23 那次拆包的**正面判据**。
  //
  // 拆包前的产物是一个 2.1MB 的单文件 `game.js`（IIFE），全部数据和第三方库
  // 都糊在里面 —— 想看一眼「第 20 层放了哪些怪」得先翻两万行 pixi。拆完之后是
  // `game.js`（入口）+ `boot.js`（垫片 + env 适配 + pixi）+ `data/*.json`。
  //
  // ## 为什么必须在这里判，而不是「看文件名对了就算成」
  //
  // 拆包这类改动最典型的失败**不是崩溃，而是「看起来成了、其实没生效」**：
  //   · 数据拷进了包，却仍在构建期被内联进入口 → 改 json 不影响运行结果；
  //   · 数据改成运行期读，但读的是另一份拷贝 → 改 json 还是不影响运行结果；
  //   · 入口 require 不到 boot（路径写错）→ 只是「另一条路崩」，报错还不在本地。
  // 三种都不报错、截图照样对。所以判据要**同时**看：读没读、有没有内联、清单对不对。
  //
  // ## ⚠️ 反向断言必须带探针（本项目纪律）
  //
  // 「game.js 里搜不到数据」是个反向断言，它有一种特有的假绿：**搜错了词**。
  // 于是同一组里既要报「入口没有」，也要报「同一次搜法在数据文件里搜得到」。
  //
  // 本轮就真的踩到过一次，记在这里免得下次再踩：
  // 一开始拿 `demonKingTrue` 当探针，结果它在 `game.js` 里**确实存在** ——
  // 但来源不是游戏数据，而是 `assets/MANIFEST.json`（图集清单，被 `atlas.ts`
  // 静态 import 烘进了入口）。**图集在入口里是正常的，游戏数据在入口里才是问题。**
  // 所以探针要取「只可能来自 data/ 的那类文本」，见下面的 `dataNeedle`。
  {
    const jsFiles = report.packageJs || [];
    add(
      '包内 js 恰好是 game.js + boot.js 两个模块（拆包成功）',
      jsFiles.length === 2 && jsFiles.includes('/game.js') && jsFiles.includes('/boot.js'),
      jsFiles.length ? `${jsFiles.length} 个：${jsFiles.join(', ')}` : '宿主没枚举到任何 js'
    );

    // 入口该是「能直接读的那一份」。体积差是这条最直白的证据
    //（pixi 一千多 KB，业务代码两百多 KB）。真正的结构判据在 verify:sandbox 里
    // （按标记函数找 pixi 在哪），这里只做包内体积分工的交叉核对。
    const sizeOf = (name) => {
      const p = path.join(DIST, name);
      return fs.existsSync(p) ? fs.statSync(p).size : 0;
    };
    const entrySize = sizeOf('game.js');
    const bootSize = sizeOf('boot.js');
    add(
      '入口 game.js 明显小于 boot.js（pixi 不在入口里）',
      entrySize > 0 && bootSize > entrySize * 3,
      `game.js ${(entrySize / 1024).toFixed(1)}KB / boot.js ${(bootSize / 1024).toFixed(1)}KB`
    );

    // ── 清单：源码声明 == 包内实际 ────────────────────────────────────
    // 期望清单不是在这里另抄一份，而是从 `src/data/runtime-files.mjs` 现读
    //（游戏代码与拷贝脚本用的是同一份）。楼层文件名由 `floors/index.json`
    // 的 `id` 推出 —— 与 `src/data/index.ts` 的推法一致。
    const { RUNTIME_FLOOR_DIR, RUNTIME_TOP_JSON } = await import(
      pathToFileURL(path.join(ROOT, 'src', 'data', 'runtime-files.mjs')).href
    );
    const srcIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'floors', 'index.json'), 'utf8'));
    /** key（相对 data/）→ 源码文件绝对路径 */
    const expected = new Map();
    for (const key of RUNTIME_TOP_JSON) expected.set(key, path.join(ROOT, 'data', key));
    for (const entry of srcIndex.floors) {
      const key = `${RUNTIME_FLOOR_DIR}/${entry.id}.json`;
      expected.set(key, path.join(ROOT, 'data', RUNTIME_FLOOR_DIR, `${entry.id}.json`));
    }

    const pkgData = report.packageData || [];
    const actualSet = new Set(pkgData);
    const missing = [...expected.keys()].filter((k) => !actualSet.has(`data/${k}`));
    const extra = pkgData.filter((k) => !expected.has(k.replace(/^data\//, '')));
    add(
      '包内 data/ 与源码清单逐一对应（不多不少）',
      missing.length === 0 && extra.length === 0 && pkgData.length > 0,
      missing.length || extra.length || !pkgData.length
        ? `缺 ${missing.length} 个${missing.length ? `（${missing.slice(0, 3).join(', ')}…）` : ''}` +
            ` / 多 ${extra.length} 个${extra.length ? `（${extra.slice(0, 3).join(', ')}…）` : ''}`
        : `${pkgData.length} 个 json（顶层 ${RUNTIME_TOP_JSON.length} + 楼层 ${srcIndex.floors.length}）`
    );

    // ── 内容：包内那份必须是**刚出的**那一版 ──────────────────────────
    //
    // 与「包内图集必须是最新一份」完全同源：`dist-minigame/data/` 是
    // `copy-minigame-assets.mjs` 拷过去的**副本**，改完 `data/*.json`
    // 不跑 `build:minigame` 就还是旧的。上面那条只证明「清单对」，
    // 证明不了「内容对」——两者失败原因不同，报错指向也不同，所以要分开。
    const driftData = [];
    for (const [key, srcPath] of expected) {
      const dstPath = path.join(DIST, 'data', key);
      if (!fs.existsSync(dstPath)) {
        driftData.push(`${key} 不在包内`);
        continue;
      }
      const a = hash12(srcPath);
      const b = hash12(dstPath);
      if (a !== b) driftData.push(`${key} 源=${a} 包=${b}`);
    }
    add(
      '包内 data/*.json 与 data/ 源码逐字节一致（不是上一版数据）',
      driftData.length === 0,
      driftData.length
        ? `${driftData.slice(0, 3).join(' | ')}${driftData.length > 3 ? ` …共 ${driftData.length} 个` : ''}` +
            ' —— 改过数据就要跑一次 npm run build:minigame'
        : `${expected.size} 个文件全部一致`
    );

    // ── 正面：启动过程真的去读了代码包 ────────────────────────────────
    //
    // 判据数的是宿主桩里 `readFileSync` 的调用次数（`report.readFileCalls`），
    // 期望值 = 顶层数 + 楼层数（每个文件恰好读一次）。
    // 路径必须全部以 `data/` 开头、不带 `./` `../` `/` 前缀 ——
    // 这是官方「访问代码包文件」的硬要求，桩里也会当场报红，这里再正向确认一遍。
    const readPaths = report.readFilePaths || [];
    const reads = report.readFileCalls || 0;
    const wantReads = RUNTIME_TOP_JSON.length + srcIndex.floors.length;
    const badPaths = readPaths.filter((p) => !/^data\//.test(p));
    add(
      '数据是启动期真读代码包读出来的（不是构建期内联）',
      reads >= wantReads && badPaths.length === 0,
      `${reads} 次 readFileSync（期望 ≥ ${wantReads} = 顶层 ${RUNTIME_TOP_JSON.length} + 楼层 ${srcIndex.floors.length}）` +
        (badPaths.length
          ? `；${badPaths.length} 次路径不合规：${badPaths.slice(0, 2).join(', ')}`
          : '；路径全部形如 data/…')
    );

    // ── 反面（带探针）：入口里没有数据原文 ────────────────────────────
    // 探针现取：从 `data/tiles.json` 里截第一段 ≥12 个连续汉字。
    // 这类文本（`$comment` 的中文说明）只可能来自数据 —— 它既不在业务代码里，
    // 也不在图集清单里，而且被内联后**原文照样是这些汉字**（压缩只动引号空格）。
    const tilesRaw = fs.readFileSync(path.join(ROOT, 'data', 'tiles.json'), 'utf8');
    const dataNeedle = (tilesRaw.match(/[\u4e00-\u9fa5]{12,}/) || [])[0];
    const entrySrc = fs.readFileSync(path.join(DIST, 'game.js'), 'utf8');
    const inEntry = !!dataNeedle && entrySrc.includes(dataNeedle);
    const inPkgData = !!dataNeedle && fs.readFileSync(path.join(DIST, 'data', 'tiles.json'), 'utf8').includes(dataNeedle);
    add(
      '数据没有在构建期内联进 game.js（入口里没有数据原文）',
      inPkgData && !inEntry,
      dataNeedle
        ? `探针「${dataNeedle}」：包内 data/tiles.json ${inPkgData ? '有' : '没有（探针失效，本条不可信）'}、` +
            `game.js ${inEntry ? '有 —— 数据被内联了' : '没有'}`
        : '从 data/tiles.json 里取不到中文探针（数据格式变了？本条不可信）'
    );
  }

  const moves = report.moves || [];
  const moved = moves.filter((m) => m.moved);
  const wrongDir = moved.filter((m) => !m.closer);

  // 画布序：这条约束被打破时画面是对的、什么都看不出来，所以必须单独判。
  add(
    '上屏画布 = wx.createCanvas() 的第一块',
    report.displayIsAppCanvas === true,
    report.displayIsAppCanvas
      ? `#1 ${report.appCanvasSize.w}×${report.appCanvasSize.h}`
      : `渲染目标尺寸 ${JSON.stringify(report.appCanvasSize)} 与第一块 ${JSON.stringify(report.canvasSize)} 不一致`
  );

  // 「点击送到哪一格」与「有没有走成」必须分开判：
  //   - 送到哪一格 → 只考事件链 + 坐标映射（本适配任务的责任范围）
  //   - 有没有走   → 还掺进游戏规则（那格可不可走、路通不通）
  // 越界格（棋盘外的目标）被忽略是**正确行为**，所以只对界内目标断言。
  const inBoard = moves.filter((m) => m.inBounds);
  const arrived = inBoard.filter((m) => m.arrived);
  // 界内探针数固定为 5（6 个探针里有 1 个是刻意越界的）。
  // 只断言「界内的每一次点击都落到预期格」——远格是否**走得到**取决于地形
  // （floor 1 从起点起可达的格子只有 6 个），那属于游戏规则，不归适配层管。
  add(
    '触摸点击精确落到预期格子（含远距离格）',
    inBoard.length >= 5 && arrived.length === inBoard.length,
    inBoard.length
      ? `${arrived.length}/${inBoard.length} 命中：` +
          inBoard.map((m) => `${m.dir}→${m.hit ? `(${m.hit.x},${m.hit.y})` : 'null'}`).join(' ')
      : '一次都没送到 —— 事件链断了'
  );
  add(
    '越界点击被正确忽略（没有误判成界内格子）',
    moves.filter((m) => !m.inBounds).every((m) => !m.arrived && !m.moved),
    `${moves.filter((m) => !m.inBounds).length} 次越界点击，均未产生动作`
  );

  add(
    '触摸事件能驱动游戏（至少一次有效移动）',
    moved.length > 0,
    moved.length ? `${moved.length}/${moves.length} 次点击产生了移动` : '一次都没动'
  );
  add(
    '移动方向与点击方向一致（坐标映射没偏）',
    moved.length > 0 && wrongDir.length === 0,
    wrongDir.length ? `有 ${wrongDir.length} 次跑反了：${JSON.stringify(wrongDir)}` : '全部正确'
  );

  // ── 取证探针（只有 `--mode wxbeacon` 的产物才有）──────────────────
  //
  // 这里考的不是游戏，而是**取证链路本身**。
  //
  // 背景：IDE 的服务端口默认关闭，在外部驱动不了模拟器；唯一可靠的观测手段是
  // 「让游戏把结果写进小游戏存储」，再由 IDE 落到 WeappStorage/*.json。
  // 那条通道一旦写坏，在 IDE 里的表现是「什么都没收到」—— 和「探针根本没跑」
  // 长得一模一样，而 IDE 里没法调试它。所以放在这里先验一遍：
  // 本地过了，IDE 里的结论才有依据。
  const bs = report.beaconStorage || {};
  const bsKeys = Object.keys(bs).sort();
  if (bsKeys.length) {
    const parse = (s) => {
      try {
        return JSON.parse(s || 'null');
      } catch {
        return null;
      }
    };
    const timeline = parse(bs.__motaBeacon);
    const pxRec = parse(bs.__motaBeaconPx);

    add(
      '取证：时间线是合法 JSON 数组',
      Array.isArray(timeline) && timeline.length > 0,
      Array.isArray(timeline) ? `${timeline.length} 条：${timeline.map((r) => r.stage).join(' → ')}` : '解析失败'
    );
    const stages = Array.isArray(timeline) ? timeline.map((r) => r.stage) : [];
    // `shim` / `hostModule` 是**模块求值期**的两个埋点（见 pixi-adapter.ts / host.ts）：
    // 顶层异常时入口函数体根本跑不到，时间线会只剩一条 `module`，
    // 有这两个点才能把「六个 import 的黑盒」切成三段。
    const LADDER = ['module', 'shim', 'hostModule', 'host', 'probe', 'boot'];
    add(
      '取证：时间线覆盖 module → shim → hostModule → host → probe → boot',
      LADDER.every((s) => stages.includes(s)),
      stages.join(' → ')
    );
    // 裸标识符视图（`env.ts` 在自己的模块作用域里量、挂在 `globalThis.__motaEnvBare`，
    // 由探针在 `shim` 埋点取走）。这里是**唯一**能一次看清「本宿主还有哪些全局的裸路径是死的」
    // 的地方 —— 省掉「一轮报一个 xxx is not defined」的来回。判读方式见 `no-unsafe-eval.js` 同级的说明。
    const shimRec = Array.isArray(timeline) ? timeline.find((r) => r.stage === 'shim') : null;
    const bareMap = shimRec && shimRec.data ? shimRec.data.bare : null;
    if (bareMap) {
      const must = ['Intl', 'navigator', 'document', 'performance', 'requestAnimationFrame', 'MouseEvent'];
      const broke = must.filter((k) => bareMap[k] === 'undefined' || bareMap[k] === 'ReferenceError');
      add(
        '取证：已垫词法垫片的全局在裸路径上都可用（本宿主）',
        broke.length === 0,
        broke.length ? broke.map((k) => `${k}=${bareMap[k]}`).join(' ') : must.map((k) => `${k}=${bareMap[k]}`).join(' ')
      );
      const dead = Object.entries(bareMap).filter(([, v]) => v === 'ReferenceError');
      console.log(
        `  裸标识符清单（本宿主）：${Object.keys(bareMap).length - dead.length} 项可用` +
          (dead.length ? `，${dead.length} 项 ReferenceError：${dead.map(([k]) => k).join(', ')}` : '')
      );
    }
    add(
      '取证：像素记录尺寸自洽（px 长度 = cols×rows×6）',
      !!pxRec && typeof pxRec.px === 'string' && pxRec.px.length === pxRec.cols * pxRec.rows * 6,
      pxRec ? `${pxRec.cols}×${pxRec.rows}，${pxRec.px.length} 字符` : '没有像素记录'
    );
    add(
      '取证：时间线里不带像素（否则会被 140KB 挤爆）',
      Array.isArray(timeline) && timeline.every((r) => !r.px),
      '两块分开存：时间线一个键、像素一个键'
    );
    add(
      '取证：两个键都远低于单键 1MB 上限',
      Object.values(bs).every((t) => t.length < 256 * 1024),
      bsKeys.map((k) => `${k}=${(bs[k].length / 1024).toFixed(0)}KB`).join('  ')
    );

    // 用**共享的** PNG 编码器把探针自己的像素网格出成图。
    // 这一步的意义是让「网格 → 图」这一段在本地先跑通：
    // 到了 IDE 里如果出不来图，问题就一定在数据（没采集到），不在渲染。
    if (pxRec && typeof pxRec.px === 'string' && pxRec.px.length === pxRec.cols * pxRec.rows * 6) {
      const { pngFromHexGrid } = require('./lib/png.cjs');
      const { png, width, height } = pngFromHexGrid(pxRec.px, pxRec.cols, pxRec.rows, 3);
      const dir = path.join(OUT, 'wx-beacon');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'minigame-frame.png'), png);
      beaconFrame = `assets/preview/wx-beacon/minigame-frame.png（${width}×${height}，探针自采）`;
    }
  } else {
    console.log('  （产物没带取证探针；要看这一组判据请用 npm run build:minigame:beacon）\n');
  }

  // ── 输出 ─────────────────────────────────────────────────────────
  console.log('\n══ 小游戏产物 · 无 DOM 环境实测（宿主 = Web Worker）══\n');
  console.log(`宿主屏幕: ${JSON.stringify(report.screen)}   上屏画布: ${JSON.stringify(report.canvasSize)}`);
  console.log(`Worker 天生没有 (${naturallyGone.length}): ${naturallyGone.join(', ')}`);
  console.log(`主动抹掉 (${(report.killed || []).length}): ${(report.killed || []).join(', ')}\n`);
  // 画布台账：因为「上屏画布必须是 wx.createCanvas() 的第一块」这条约束一旦被打破，
  // 症状与「渲染正常但截图黑」完全一样，肉眼分不出来，只能靠编号和调用栈。
  const ledger = report.canvasLedger || [];
  if (ledger.length) {
    console.log('画布台账（按 wx.createCanvas 调用序）:');
    for (const c of ledger.slice(0, 8)) {
      console.log(
        `    #${String(c.idx).padStart(2)}  ${String(c.w).padStart(5)}×${String(c.h).padEnd(5)}` +
          `${c.isAppCanvas ? '  ← 渲染目标' : '            '}` +
          `  上下文: ${c.contexts.length ? c.contexts.join(', ') : '（无）'}`
      );
    }
    if (ledger.length > 8) console.log(`    … 另有 ${ledger.length - 8} 块离屏画布`);
    console.log('');
  }
  for (const s of report.canvasStacks || []) {
    console.log(`  画布 #${s.idx} 谁建的: ${s.stack}`);
  }
  if ((report.canvasStacks || []).length) console.log('');
  console.log(`WebGL: ${JSON.stringify(report.webglInfo)}`);
  console.log(
    `引擎探针: floor=${probe.floor} pos=${JSON.stringify(probe.pos)} hp=${probe.hp}/${probe.hpMax ?? '-'} ` +
      `steps=${probe.steps} renderer=${probe.rendererType} @${probe.resolution}x\n`
  );

  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed += 1;
    console.log(`${c.ok ? '  ✅' : '  ❌'} ${c.name}  —— ${c.detail}`);
  }

  console.log('\n  触摸移动记录:');
  for (const m of moves) {
    console.log(
      `    ${m.dir.padEnd(9)} ${JSON.stringify(m.from)} → ${JSON.stringify(m.to)}` +
        `  目标 ${JSON.stringify(m.target)}${m.inBounds ? '      ' : '(界外)'}  ` +
        `${m.arrived ? '✅' : '❌'} 落到 ${m.hit ? `(${m.hit.x},${m.hit.y})` : '（没送到）'}  ` +
        `${m.moved ? (m.closer ? '✅ 朝目标移动' : '❌ 方向不符') : '⏸ 未移动'}`
    );
  }

  if (workerLogs.length) {
    console.log('\n  游戏/垫片日志:');
    for (const l of workerLogs.slice(0, 20)) console.log('    ' + l);
  }

  if (beaconFrame) console.log(`\n  探针自采的首帧：${beaconFrame}`);
  // 打出 `(通过/总数)` 而不是只打失败数：条数**变少**本身是个信号
  //（某条判据被合并或吞掉），只看「有没有 ❌」是看不出来的。
  console.log(
    `\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条不通过`}` +
      `（${checks.length - failed}/${checks.length}）（截图：assets/preview/minigame-board.png）\n`
  );
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  server.close();
  process.exit(2);
});
