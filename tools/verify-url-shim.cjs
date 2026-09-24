/**
 * `URL` 垫片 vs 原生 `URL` 的**对拍**。
 *
 * ## 为什么需要有这一条，而且必须独立成一套
 *
 * `src/minigame/env/url.ts` 是**自己实现的解析器**（RFC 3986 的相对引用解析：
 * merge + remove_dot_segments + recompose + 属性拆解）。另外四套验的都是
 * 「**装上了、能跑**」—— 它们**证明不了算得对**：一个把 `a/../b` 解成 `a/b`
 * 的垫片照样能让游戏跑起来，只是资源路径会歪、或者 pixi 的跨域判定走错分支，
 * 然后表现为某种莫名其妙的画面问题（正是本项目最怕的「静默降级」）。
 *
 * 所以这里拿**真原生实现**逐用例对拍：在删掉全局 `URL` 之前先把原生引用留住，
 * 装上垫片之后同一个用例喂给两边，比较 9 个字段。
 *
 * ## 用例是分三类的
 *
 *   ① **产物实际会用到的形态** —— Vite 的 `__vitePreload` 实参
 *      （`new URL('boot.js', document.baseURI)`，base 是 `wxgame://code-package/`）
 *      与 pixi 的跨域判定（`new URL(url, document.baseURI)`）。
 *      这两类是**底线**，必须逐字一致。
 *   ② **RFC 3986 §5.4 的官方归一化示例**（`g` / `./g` / `../g` / `//g` / `?y` / `#s` …）——
 *      用来兜住「相对解析」这条最容易写错的路径。期望值不是猜的，是规范给的。
 *   ③ **属性拆解的边角**（IPv6 字面量、特殊 scheme 的空 path、`file:` 的不透明 origin）。
 *      后两个在第一次对拍时**真的抓到了偏差**，已修（见 url.ts 的 `normalize` 与 `origin`）。
 *
 * ## 这一套**不加载产物**
 *
 * 它是全部校验里唯一直接对**源码模块**下手的（用 esbuild 把 url.ts 打成 CJS 再 require），
 * 其余四套跑的都是 `dist-minigame/` 里的产物。这个定位是刻意的：
 * 垫片的正确性与「产物长什么样」无关，绑进宿主反而绕远。
 *
 * 用法：`npm run verify:url-shim`
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src/minigame/env/url.ts');
const OUT = path.join(os.tmpdir(), `mota-url-shim-${process.pid}.cjs`);

/** 用例：`args` 直接展开成 `new URL(...)` 的实参；`why` 说明它守的是什么。 */
const CASES = [
  // ── ① 产物实际会用到的（底线）──────────────────────────────────────
  { args: ['boot.js', 'wxgame://code-package/'], why: '__vitePreload 第三实参的真实形态' },
  { args: ['a/../b.png', 'wxgame://code-package/dir/'], why: '同上，带 `..` 的相对引用' },
  { args: ['http://127.0.0.1:4190/x.png', 'wxgame://code-package/'], why: 'pixi determineCrossOrigin（绝对 url）' },
  { args: ['http://a.com/i.png', 'wxgame://code-package/'], why: '同上，另一种绝对形态' },
  // ── ② RFC 3986 §5.4 官方示例（相对解析的归一化）────────────────────
  { args: ['g', 'http://a/b/c/d;p?q'], why: '§5.4 基本' },
  { args: ['./g', 'http://a/b/c/d;p?q'], why: '§5.4 基本' },
  { args: ['g/', 'http://a/b/c/d;p?q'], why: '§5.4 基本' },
  { args: ['/g', 'http://a/b/c/d;p?q'], why: '§5.4 基本' },
  { args: ['//g', 'http://a/b/c/d;p?q'], why: '§5.4 基本（网络路径引用）' },
  { args: ['?y', 'http://a/b/c/d;p?q'], why: '§5.4 基本（只换 query）' },
  { args: ['g?y', 'http://a/b/c/d;p?q'], why: '§5.4 基本' },
  { args: ['#s', 'http://a/b/c/d;p?q'], why: '§5.4 基本（只换 fragment）' },
  { args: ['g#s', 'http://a/b/c/d;p?q'], why: '§5.4 基本' },
  { args: ['', 'http://a/b/c/d;p?q'], why: '§5.4 基本（空引用 = 原样）' },
  { args: ['.', 'http://a/b/c/d;p?q'], why: '§5.4 点段' },
  { args: ['..', 'http://a/b/c/d;p?q'], why: '§5.4 点段' },
  { args: ['../g', 'http://a/b/c/d;p?q'], why: '§5.4 点段' },
  { args: ['../..', 'http://a/b/c/d;p?q'], why: '§5.4 点段' },
  { args: ['../../g', 'http://a/b/c/d;p?q'], why: '§5.4 点段' },
  // ── ③ 属性拆解的边角 ──────────────────────────────────────────────
  { args: ['https://[::1]:8443/p?x=1#f'], why: 'IPv6 字面量 + 端口 + query + hash' },
  { args: ['wxgame://code-package/'], why: '本项目自己的 base（非 special scheme）' },
  { args: ['wxgame://code-package'], why: '同上，path 为空（非 special 不补 `/`）' },
  { args: ['boot.js', 'wxgame://code-package'], why: '同上，相对解析要补出 `/boot.js`' },
  { args: ['file:///tmp/a/b'], why: 'special 但 origin 不透明（对拍抓到的偏差）' },
  { args: ['https://a.com'], why: 'special 且 path 为空（要补 `/`）' }
];

const FIELDS = ['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'];

function add(name, ok, detail) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  —— ${detail}` : ''}`);
  return ok;
}

function main() {
  console.log('\n══ URL 垫片 vs 原生 URL 对拍（源码模块，不加载产物）══\n');

  // 把 url.ts 打成 CJS。esbuild 是 vite 的传递依赖（`verify:minigame` 的语法地板判据
  // 也在用它），所以这里没有新增任何依赖。
  try {
    execFileSync(
      path.join(ROOT, 'node_modules/.bin/esbuild'),
      [SRC, '--bundle', '--format=cjs', '--platform=node', `--outfile=${OUT}`, '--log-level=warning'],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
  } catch (err) {
    console.log(`  ❌ 无法用 esbuild 打包 src/minigame/env/url.ts  —— ${err.message}`);
    console.log('\n❌ 1 条不通过（共 1 条判据）\n');
    process.exit(1);
  }

  // ⚠️ **先把模块加载完**再动全局。
  //
  // `require` 内部会读文件，而**本机沙箱的 `fs` 垫片自己也用裸 `URL`**
  // （WorkBuddy CLI 的 `node-brokered-fs-shim.cjs`，`toAbsPath` 里 `new URL(...)`）。
  // 所以「删掉 `URL`」这一步必须放在 `require` **之后** —— 踩过一次，现象是：
  //
  //   ❌ 垫片装上了（宿主没有 URL 时 installUrl 生效）—— 装的时候抛了：URL is not defined
  //
  // 而栈**全在 `node-brokered-fs-shim.cjs` 里**，看起来像 `url.ts` 有 bug，
  // 其实是**验证工具自己的时序问题**（`delete globalThis.URL` 把宿主 fs 垫片一起废了）。
  // 这条记在这里，因为「判据红了先怀疑期望值 / 先怀疑工具」在本项目是省时间的一条纪律。
  const mod = require(OUT);

  // ⚠️ 顺序不能反：**先把原生引用留住**，再删全局。
  //    删全局是为了模拟小游戏（`installUrl` 只在宿主没有 URL 时才装垫片），
  //    而留住引用才能在同一个进程里做对拍 —— 否则连基准都没了。
  const NativeURL = globalThis.URL;
  let ShimURL;
  let installErr = '';
  delete globalThis.URL;
  try {
    mod.installUrl();
    ShimURL = globalThis.URL;
  } catch (err) {
    installErr = err && err.message ? err.message : String(err);
  } finally {
    // ★ **立刻把全局还回去**，把「没有 `URL`」的窗口压到最小。
    //   上面的 fs 垫片教训说明：只要这个窗口跨过一次文件读取，就会炸在**别人**的代码里。
    //   所以策略不是「记得别在窗口里读文件」（那要靠人记），而是**把窗口关小**：
    //   只有 `installUrl()` 这一小段。后面所有比较都改用「窗口里抓下来的 `ShimURL`」，
    //   不再依赖全局状态 —— 顺带让对拍本身也不受全局被谁改过的影响。
    globalThis.URL = NativeURL;
  }

  const results = [];
  results.push(
    add(
      '垫片装上了（宿主没有 URL 时 installUrl 生效）',
      !installErr && typeof ShimURL === 'function',
      installErr ? `装的时候抛了：${installErr}` : `ShimURL = ${ShimURL && ShimURL.name}（窗口内抓到，全局已还原）`
    )
  );

  const diffs = [];
  for (const c of CASES) {
    const label = `new URL(${c.args.map((a) => JSON.stringify(a)).join(', ')})`;
    let n;
    let s;
    try {
      n = new NativeURL(...c.args);
    } catch (err) {
      n = { __err: `${err.name}: ${err.message}` };
    }
    try {
      s = new ShimURL(...c.args);
    } catch (err) {
      s = { __err: `${err.name}: ${err.message}` };
    }
    const row = [];
    for (const f of FIELDS) {
      if (n.__err || s.__err) continue;
      if (n[f] !== s[f]) row.push(`${f}: 原生 ${JSON.stringify(n[f])} ≠ 垫片 ${JSON.stringify(s[f])}`);
    }
    if ((n.__err || s.__err) && n.__err !== s.__err) row.push(`抛错行为不同：原生=${n.__err} 垫片=${s.__err}`);
    if (row.length) diffs.push({ label, why: c.why, row });
  }

  results.push(
    add(
      `与原生逐字段一致（${CASES.length} 个用例 × ${FIELDS.length} 个字段）`,
      diffs.length === 0,
      diffs.length === 0
        ? `${CASES.length} 个用例全部一致（含 RFC 3986 §5.4 的归一化示例）`
        : `${diffs.length} 个用例有差异，见下`
    )
  );
  for (const d of diffs) {
    console.log(`\n     ✗ ${d.label}   （${d.why}）`);
    for (const r of d.row) console.log(`         ${r}`);
  }

  try {
    fs.unlinkSync(OUT);
  } catch {
    /* 临时文件删不掉无所谓 */
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 条不通过`}（共 ${results.length} 条判据）\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
