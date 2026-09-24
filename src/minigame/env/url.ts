/**
 * `URL` 构造器 —— 微信小游戏里**不存在**，和 `document` / `navigator` 是同一类东西：
 * 它属于 **BOM**，由浏览器宿主提供，而小游戏的宿主是 JavaScriptCore（iOS）/ V8（Android）
 * 加一层 `wx` API，没有 BOM 也没有 DOM。
 *
 * ## 为什么「少一个构造器」能让整个包起不来
 *
 * 拆包之后 Vite 会给每个 `await import()` 生成一个 `__vitePreload(loader, deps, importerUrl)`。
 * 第三实参是 Vite 在**构建期**拼出来的一段「这个 chunk 的绝对地址」表达式，形态是：
 *
 * ```js
 * typeof document === "undefined"
 *   ? require("url").pathToFileURL(__filename).href                        // ← Node 分支
 *   : _documentCurrentScript && _documentCurrentScript.tagName.toUpperCase() === "SCRIPT"
 *       && _documentCurrentScript.src
 *     || new URL("boot.js", document.baseURI).href                          // ← 浏览器分支
 * ```
 *
 * 三个事实叠在一起就炸了：
 *
 * 1. 它是**实参**，不是函数体 —— 实参照样求值，哪怕 `__vitePreload` 内部根本没用到它
 *    （那份产物里 `deps` 恒为 `void 0`，消费 `importerUrl` 的分支已被消除）。
 * 2. 真机上 `document` **是存在的**（我们自己在 `document.ts` 里垫的），
 *    所以走的是**右支**，也就是 `new URL(...)`。
 * 3. 真机没有 `URL` ⇒ `ReferenceError: URL is not defined`。
 *
 * 而这段代码位于 `autoDetectRenderer` → `getWebGLRenderer()` 的调用链上，
 * 是**启动必经之路**，于是表现是启动即失败。
 *
 * ## ⚠️ 为什么两个本地宿主都测不出来（这次假绿的形状）
 *
 * | 宿主 | 有没有 `URL` | 结果 |
 * |---|---|---|
 * | Web Worker（`verify:minigame`） | **有**（`WorkerGlobalScope` 自带标准 `URL`） | 绿 |
 * | 真 Chromium（`verify:dom`） | **有** | 绿 |
 * | 真机小游戏 | **没有** | 红 |
 *
 * 这正是本项目反复踩的那类假绿：**两个宿主都恰好有，于是「全绿」什么都不说明**。
 * 修法不是改断言，而是**让宿主与小游戏对齐** —— 现在 `verify:minigame` 的抹除列表里
 * 有 `URL`（与 `Intl` / `navigator` 同一份清单），这条路径本地就能跑到。
 *
 * ## 垫什么：一个能正确解析的窄实现
 *
 * 不装一个假对象了事 —— 产物里 `new URL(x, base)` 的结果是要**被用**的
 * （`document.baseURI` 拼资源地址、pixi 的跨域判定比 `hostname`/`port`/`protocol`），
 * 返回错值会变成更难查的静默问题。所以这里实现的是
 * **RFC 3986 §5.2 的相对引用解析**（`merge` + `remove_dot_segments` + `recompose`），
 * 属性从解析结果里如实读出。
 *
 * 「如实」的边界也写清楚：本实现**不**做 WHATWG 那些规范化（不补默认端口、
 * 不把 `\` 当 `/`、不替 `file:` 特殊处理）。产物用到的形态（包内相对路径 +
 * `wxgame://code-package/` base）在这套算法下与原生结果一致；
 * 一旦有代码依赖更细的 WHATWG 行为，会走到下面的 `unsupported()` 上**显式报错**，
 * 而不是拿到一个含糊的值。
 *
 * ## 与 `Intl` / `navigator` 的分工是一致的
 *
 *   宿主**有** → 让路（原生一定比垫片准，浏览器/Worker 行为零变化）
 *   宿主**没有** → 补上，并且**当场自检**（装错了就红，不静默）
 *
 * ⚠️ 本文件不声明任何名为 `URL` 的局部绑定（`state.ts` 那条约束），
 * 类名用 `MiniUrl`，只在 `safeAssign` 时作为**值**传出去。
 */
import { safeAssign } from './assign';
import { g, type Any } from './state';

// ── RFC 3986 的数据形态 ────────────────────────────────────────────────

interface Parts {
  /** 含冒号，如 `'wxgame:'`；空串表示「这一层没有 scheme」（相对引用） */
  scheme: string;
  /** `null` = 原文里没有 `//`；`''` = 有 `//` 但后面为空。两者语义不同，不能合并 */
  authority: string | null;
  path: string;
  /** 含 `?`，或空串 */
  query: string;
  /** 含 `#`，或空串 */
  fragment: string;
}

/**
 * 两套正则：**绝对引用**（带 scheme）与**相对引用**（无 scheme）。
 *
 * ⚠️ 不能用一套「scheme 可选」的正则代替。看似等价，实际会走错：
 * `^([a-z]+:)?…` 对 `a/../b.png` 的匹配结果是 scheme 空 + path 完整，看起来对 ——
 * 但对 `wxgame:` 这种「有 scheme、无 `//`」的形态，可选组会把 `a:` 吃成 scheme，
 * 与 `foo:bar` 这类相对路径（第一段带冒号）无法区分。
 * RFC 3986 把这条歧义写在了 §4.2，分开两次匹配才是它的本意。
 */
const ABSOLUTE_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#[\s\S]*)?$/;
// 三组全可选 ⇒ 任何串都匹配得上，所以调用方不必处理「解析失败」
const RELATIVE_RE = /^(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#[\s\S]*)?$/;

function split(input: string): Parts {
  const abs = ABSOLUTE_RE.exec(input);
  if (abs) {
    return {
      scheme: abs[1],
      // `abs[2]` 含 `//`，剥掉它之后才是 authority 本体
      authority: abs[2] === undefined ? null : abs[2].slice(2),
      path: abs[3] ?? '',
      query: abs[4] ?? '',
      fragment: abs[5] ?? ''
    };
  }
  // 相对引用：`scheme` 为空串是**有意义**的（表示「这一层没有 scheme」），
  // `authority` 的 null / '' 之分同样有意义（见 interface 注释）。
  const rel = RELATIVE_RE.exec(input)!;
  return {
    scheme: '',
    authority: rel[1] === undefined ? null : rel[1].slice(2),
    path: rel[2] ?? '',
    query: rel[3] ?? '',
    fragment: rel[4] ?? ''
  };
}

/**
 * WHATWG 意义上的「特殊 scheme」—— 它们有默认端口、host 要小写、path 至少是 `/`。
 * 本项目自己的 base（`wxgame:`）**不在**其中，这正是它与众不同的地方。
 */
const SPECIAL_RE = /^(https?|wss?|ftp|file):$/i;

/**
 * 解析结果的一次规范化。目前只做一条：**special scheme 且有 authority 时 path 不能为空**
 * （`new URL('//g', 'http://a/b')` 原生给的是 `http://g/`，少这个斜杠就不一致）。
 *
 * 放在**解析出口**而不是 `href` 的拼接处：`href` / `pathname` / `toString()` 三个出口
 * 因此天然一致，不必各自补一遍（补两处就会出现「改了一处忘了另一处」的漂移）。
 */
function normalize(p: Parts): Parts {
  if (p.path === '' && p.authority !== null && SPECIAL_RE.test(p.scheme)) {
    return { scheme: p.scheme, authority: p.authority, path: '/', query: p.query, fragment: p.fragment };
  }
  return p;
}

function recompose(p: Parts): string {
  return (
    p.scheme +
    (p.authority !== null ? `//${p.authority}` : '') +
    p.path +
    p.query +
    p.fragment
  );
}

/** RFC 3986 §5.2.4 —— 去掉 `.` / `..` 段。 */
function removeDotSegments(path: string): string {
  const out: string[] = [];
  let input = path;
  while (input.length) {
    if (input.startsWith('../')) input = input.slice(3);
    else if (input.startsWith('./')) input = input.slice(2);
    else if (input.startsWith('/./')) input = `/${input.slice(3)}`;
    else if (input === '/.') input = '/';
    else if (input.startsWith('/../')) {
      input = `/${input.slice(4)}`;
      out.pop();
    } else if (input === '/..') {
      input = '/';
      out.pop();
    } else if (input === '.' || input === '..') {
      input = '';
    } else {
      // 取到下一个 `/` 之前（含前导 `/` 时不含它，交给下一轮）
      const next = input.indexOf('/', input.startsWith('/') ? 1 : 0);
      if (next === -1) {
        out.push(input);
        input = '';
      } else {
        out.push(input.slice(0, next));
        input = input.slice(next);
      }
    }
  }
  return out.join('');
}

/** RFC 3986 §5.3 —— `base` 的 path 取到最后一个 `/` 为止，再拼上 `ref`。 */
function merge(base: Parts, refPath: string): string {
  if (base.authority !== null && base.path === '') return `/${refPath}`;
  const cut = base.path.lastIndexOf('/');
  return cut === -1 ? refPath : base.path.slice(0, cut + 1) + refPath;
}

/** RFC 3986 §5.2.2 —— 把相对引用 `ref` 解到绝对 `base` 上。 */
function resolveRef(base: Parts, ref: Parts): Parts {
  const target: Parts = { scheme: '', authority: null, path: '', query: '', fragment: ref.fragment };

  if (ref.scheme !== '') {
    target.scheme = ref.scheme;
    target.authority = ref.authority;
    target.path = removeDotSegments(ref.path);
    target.query = ref.query;
    return target;
  }
  target.scheme = base.scheme;
  if (ref.authority !== null) {
    target.authority = ref.authority;
    target.path = removeDotSegments(ref.path);
    target.query = ref.query;
    return target;
  }
  target.authority = base.authority;
  if (ref.path === '') {
    target.path = base.path;
    // 空 query **继承** base 的（§5.2.2 最后一条）；有 query 就用 ref 的（含「显式空 `?`」）
    target.query = ref.query !== '' ? ref.query : base.query;
    return target;
  }
  target.path = ref.path.startsWith('/')
    ? removeDotSegments(ref.path)
    : removeDotSegments(merge(base, ref.path));
  target.query = ref.query;
  return target;
}

// ── authority 的三段拆分 ───────────────────────────────────────────────

interface Authority {
  userinfo: string;
  hostname: string;
  port: string;
}

function splitAuthority(authority: string): Authority {
  let rest = authority;
  let userinfo = '';
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    userinfo = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  // IPv6 字面量是 `[::1]:80` 这种形态，冒号在方括号里，不能当端口分隔符
  let hostname = rest;
  let port = '';
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close !== -1) {
      hostname = rest.slice(0, close + 1);
      const tail = rest.slice(close + 1);
      if (tail.startsWith(':')) port = tail.slice(1);
    }
  } else {
    const colon = rest.indexOf(':');
    if (colon !== -1) {
      hostname = rest.slice(0, colon);
      port = rest.slice(colon + 1);
    }
  }
  return { userinfo, hostname, port };
}

/**
 * 用到未实现的能力时**当场报错**。
 *
 * 理由与项目里其余判据一致：静默返回 `undefined` 会变成「下游某个地方莫名其妙不对」，
 * 而报错能直接指到这里 —— 而且报错信息本身就说明了「小游戏缺的是这一块」。
 */
function unsupported(what: string): never {
  throw new Error(
    `[minigame] URL 垫片未实现 ${what}。小游戏没有原生 URL，这个垫片只覆盖产物实际用到的子集` +
      `（new URL(x, base) 及其 scheme/host/hostname/port/pathname/search/hash/origin）。` +
      `若确有需要，请在 src/minigame/env/url.ts 里补上，不要在此处兜底。`
  );
}

/** 垫片本体。构造签名与原生一致：`new URL(input, base?)`。 */
class MiniUrl {
  #parts: Parts;
  /** 只读缓存，避免每次读属性都重组字符串。 */
  #href: string;

  constructor(input: string | Any, base?: string | Any) {
    const inputStr = String(input);
    const self = split(inputStr);

    // 有 scheme 就是绝对引用，base 被忽略（与原生一致）
    if (self.scheme !== '') {
      this.#parts = self;
    } else {
      if (base === undefined || base === null) {
        throw new TypeError(`Invalid URL: ${inputStr}（缺 base 时 input 必须是绝对 URL）`);
      }
      const baseStr = base instanceof MiniUrl ? base.href : String(base);
      const baseParts = split(baseStr);
      if (baseParts.scheme === '') {
        throw new TypeError(`Invalid base URL: ${baseStr}`);
      }
      this.#parts = resolveRef(baseParts, self);
    }
    this.#parts = normalize(this.#parts);
    this.#href = recompose(this.#parts);
  }

  get href(): string {
    return this.#href;
  }
  get protocol(): string {
    return this.#parts.scheme;
  }
  get username(): string {
    return splitAuthority(this.#parts.authority ?? '').userinfo.split(':')[0] ?? '';
  }
  get password(): string {
    const ui = splitAuthority(this.#parts.authority ?? '').userinfo;
    const colon = ui.indexOf(':');
    return colon === -1 ? '' : ui.slice(colon + 1);
  }
  get host(): string {
    const { hostname, port } = splitAuthority(this.#parts.authority ?? '');
    return port ? `${hostname}:${port}` : hostname;
  }
  get hostname(): string {
    return splitAuthority(this.#parts.authority ?? '').hostname;
  }
  get port(): string {
    return splitAuthority(this.#parts.authority ?? '').port;
  }
  get pathname(): string {
    // `normalize()` 已在解析出口补齐了 special scheme 的那个 `/`，这里如实返回即可。
    return this.#parts.path;
  }
  get search(): string {
    return this.#parts.query;
  }
  get hash(): string {
    return this.#parts.fragment;
  }
  get origin(): string {
    // ⚠️ `file:` 虽然是 special scheme，origin 却是**不透明**的，序列化成 `"null"` ——
    //    只判「是不是 special」会把它答成 `file://`（对拍时抓到的第二处偏差）。
    if (/^file:$/i.test(this.#parts.scheme)) return 'null';
    // 非 special scheme（我们的 base 就是 `wxgame:`）在规范里 origin 也是 `"null"`（字符串）
    if (!SPECIAL_RE.test(this.#parts.scheme) || this.#parts.authority === null) return 'null';
    return `${this.#parts.scheme}//${this.#parts.authority}`;
  }
  get searchParams(): never {
    return unsupported('searchParams');
  }

  toString(): string {
    return this.#href;
  }
  toJSON(): string {
    return this.#href;
  }

  /** 小游戏里没有 Blob / createObjectURL 这条链，静默返回假串比报错更坏。 */
  static createObjectURL(): never {
    return unsupported('createObjectURL');
  }
  static revokeObjectURL(): never {
    return unsupported('revokeObjectURL');
  }
}

// ── 装配 ───────────────────────────────────────────────────────────────

/** 自检用的基准：既是绝对 URL，又带一层目录（能同时验到 merge 与相对拼接）。 */
const PROBE_BASE = 'wxgame://code-package/dir/';
const PROBE_INPUT = 'a/../b.png';
const PROBE_EXPECT = 'wxgame://code-package/dir/b.png';

export function installUrl(): void {
  // 宿主有原生 → 让路。**不拿 probe 结果决定是否覆盖** —— 原生 URL 对非 special scheme
  // 的处理细节与垫片未必逐字相同，而「原生比垫片准」这条判断不需要自检来支撑。
  if (typeof g.URL === 'function') return;

  const ok = safeAssign('URL', MiniUrl);
  if (!ok) {
    console.warn('[minigame] 无法安装 URL 垫片：产物里的 `new URL(x, document.baseURI)` 会抛 ReferenceError');
    return;
  }
  // 装上了就当场验一遍。自检失败必须**炸**而不是警告 —— 一个算错的 URL 垫片
  // 会把 `document.baseURI` 拼错，表现是资源路径诡异（或跨域判定走错分支），
  // 那类问题比「启动失败」难查一个量级。所以宁可在这里红。
  let got = '';
  try {
    got = new MiniUrl(PROBE_INPUT, PROBE_BASE).href;
  } catch (err) {
    throw new Error(`[minigame] URL 垫片自检抛错：${err instanceof Error ? err.message : String(err)}`);
  }
  if (got !== PROBE_EXPECT) {
    throw new Error(`[minigame] URL 垫片自检失败：new URL('${PROBE_INPUT}', '${PROBE_BASE}') = '${got}'，应为 '${PROBE_EXPECT}'`);
  }
}
