/**
 * 图集接入层 —— 把 `assets/atlas/*.png` + `assets/MANIFEST.json` 变成可用的 Pixi 贴图。
 *
 * 三条约定：
 *
 * 1. **MANIFEST 是唯一事实来源。** 本文件不写死任何坐标，全部从 MANIFEST 读。
 *    要换素材或调颜色，改 `tools/assetlib/data.py`（映射表）/ `terrain.py`
 *    （地形）/ `config.py`（尺寸）后重跑，不要动这里。
 *
 * 2. **`scaleMode` 必须是 `nearest`。** 素材是像素画，放大时不能插值。
 *    （网格在构建期已超采样到 rasterTile，运行时按 drawScale 落屏，见 MANIFEST.meta）
 *    Pixi 默认的线性插值会把硬边糊成毛边，整套像素感当场消失。
 *
 * 3. **失败不阻塞游戏。** 图集没加载成功（路径错、小游戏环境没打进包、网络问题）
 *    时 `ready` 为 false，渲染层自动回退到 `icons.ts` 的程序化矢量图形。
 *    宁可画得朴素，也不能白屏。
 */

import { Assets, ImageSource, Rectangle, Texture } from 'pixi.js';
import manifestJson from '../../assets/MANIFEST.json';
import actorsUrl from '../../assets/atlas/actors.png';
import itemsUrl from '../../assets/atlas/items.png';
import monstersUrl from '../../assets/atlas/monsters.png';
import terrainUrl from '../../assets/atlas/terrain.png';

// ── MANIFEST 的类型 ─────────────────────────────────────────────────
// JSON 的推断类型对使用方太啰嗦，这里显式声明一份「我们真正依赖的形状」。
// 只声明用得到的字段：MANIFEST 多出的信息（name/src/note）是给人看的，代码不读。

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TerrainEntry extends FrameRect {
  atlas: string;
  drawScale: number;
  name: string;
}

interface ItemEntry extends FrameRect {
  atlas: string;
  drawScale: number;
}

interface MonsterEntry {
  atlas: string;
  drawScale: number;
  frame: { w: number; h: number };
  idle: { x: number; y: number }[];
  run: { x: number; y: number }[];
}

type DirFrames = Record<string, FrameRect[]>;

interface ActorEntry {
  atlas: string;
  drawScale: number;
  walk: DirFrames;
  attack?: DirFrames;
}

interface Manifest {
  meta: {
    cell: number;
    drawScale: number;
    /** 每个地形键有几张变体（含底图本身）。缺失即视为 1 —— 老 MANIFEST 也能跑 */
    terrainVariants?: Record<string, number>;
  };
  terrain: Record<string, TerrainEntry>;
  monsters: Record<string, MonsterEntry | null>;
  items: Record<string, ItemEntry | null>;
  actors: { hero: ActorEntry & { dirOrder: string[] }; npcs: Record<string, ActorEntry> };
}

const MANIFEST = manifestJson as unknown as Manifest;

/** 素材基准格子（32px）—— 棋盘格宽必须与之相等，否则精灵会错位 */
export const ASSET_CELL: number = MANIFEST.meta.cell;

// ── 地形字符 → MANIFEST 键 ──────────────────────────────────────────
// 游戏数据用字符描述地形（data/tiles.json），素材用编号键。
// 这层映射是两者的接缝，只有这一处，别在渲染逻辑里散落 if/else。

const CHAR_TO_KEY: Record<string, string> = {
  '.': '0', // 空地
  '#': '1', // 墙
  '~': '5', // 岩浆
  '*': '6', // 星际空间
  D: '2', // 牢门
  a: '10', // 自动门
  y: '7', // 黄门
  b: '8', // 蓝门
  r: '9', // 红门
  '^': '4', // 上楼梯（手绘：侧视梯段，自左下升到右上 + 出口亮光）
  v: '3' // 下楼梯（手绘：俯视竖井，同心方环向内变暗）
};

/** 空地：可以铺在地面之上、不需要单独贴图的那些 */
const FLOOR_KEY = '0';

/**
 * 渲染别名 —— 「假墙」必须在**进入任何渲染判断之前**就并成真墙。
 *
 * ## 为什么不采取「两个键指向同一张图」的写法
 *
 * 那种写法看起来等价，实际有真实漏洞，而且是实测查出来的：
 * 顶边压顶变体原本只对键 `'1'` 生效（`key === '1'`），假墙的键是 `'11'` ——
 * 于是**上方没有墙的假墙拿不到压顶，而同样位置的真墙有**。
 * 全塔 69 面假墙里有 11 面属于这种情况（第 9/12/14/15/16/18/23/29/33 层）。
 * 假墙的玩法定义是「外观与墙相同，撞一次才现形」（`data/tiles.json` code 11，
 * `passable: true`）—— 一旦在画面上能挑出来，隐藏通路这个设计就整个失效了。
 *
 * 归一成同一个字符之后，渲染层**结构上无法**区别对待它们：顶边判定、变体选择、
 * 兜底图形全都走同一条路径，不会再出现「某个新加的判断只覆盖了真墙」这类分叉。
 * 关键在于「结构上无法」而不是「记得同时改两处」。
 *
 * 代价是 MANIFEST 里的 `11` 不再被渲染层读取。它仍然留在素材表里，服务两件事：
 * 它是 `data/tiles.json` 的 code 11 在地形表里的锚点，以及 `verify_terrain` 那条
 * 「假墙必须与真墙逐像素一致」的断言对象 —— 那条约束的是**素材**，是另一道独立的防线。
 */
const RENDER_ALIAS: Record<string, string> = { w: '#' };

/** 把字符归一到渲染真正使用的那个字符 */
export function renderChar(ch: string): string {
  return RENDER_ALIAS[ch] ?? ch;
}

/** 可以作为「墙」参与邻域判断的字符（归一后只有 `#`） */
export function isWallChar(ch: string): boolean {
  const c = renderChar(ch);
  return c === '#' || c === 'w';
}

/**
 * 求某格应该用哪个地形键。
 *
 * `wallAbove` 只说一件事：正上方那格是不是墙。是墙就用墙身，不是就用带压顶的
 * 顶边变体 —— 墙块因此有了上沿，地牢立刻立起来。
 *
 * ⚠️ 顶边判定按「字符是墙」而不是按「键等于 '1'」—— 后者正是假墙漏洞的成因，
 * 详见 `RENDER_ALIAS` 的说明。
 */
export function terrainKeyFor(ch: string, wallAbove: boolean): string | null {
  const c = renderChar(ch);
  const key = CHAR_TO_KEY[c];
  if (key === undefined) return null;
  if (isWallChar(c) && !wallAbove) return `${key}:top`;
  return key;
}

// ── 缩放：两套规则，各有各的道理 ─────────────────────────────────────

/**
 * 怪物与角色：帧是 64×64 / 64×104（构建期从 16 网格超采样 ×4），按 MANIFEST 的
 * `drawScale`（常规 0.5、大家伙 0.75）落屏 32–52px。
 *
 * 所以**素材网格比落屏网格密**：GPU 从 64px 的纹理采样到约 86 个设备像素
 * （32 设计px × root 缩放 × dpr 3），一个素材像素只占 ~1.35 个设备像素；
 * 网格翻倍之前是 ~5.4 个 —— 画面的颗粒感就是这么来的。
 * 落屏尺寸只由 `drawScale` 决定，不随格子大小浮动；这里的 floor/max 只是
 * 拿不到 MANIFEST 时的兜底。
 */
export function fitScale(w: number, h: number, box: number): number {
  if (w <= 0 || h <= 0) return 1;
  return Math.max(1, Math.floor(box / Math.max(w, h)));
}

/**
 * 道具图标：**等比填充**目标框，允许非整数倍。
 *
 * 为什么这里放宽整数倍：道具帧尺寸本来就不统一（药水 64×64、剑 40×84、金币 32×32），
 * 而目标框（棋盘格 32px、道具栏槽 40px、交易底板 30px）也不是 16 的整数倍。
 * 硬套整数倍只剩两个选择：×1（10×21 的剑在 40px 槽里小得可怜）或 ×2（撑破边框）。
 * 而道具图标只有 20 来个像素、造型以大色块为主，非整数倍在这个尺寸下看不出来，
 * 反倒是「所有拾取物落屏大小一致」更利于辨认。
 *
 * 唯一不能省的是**等比**：拉伸成方形会把剑压扁加宽，一眼就看出变形。
 * （注意 `tools/preview-board.py` 里就是拉伸填满的，那是个 bug —— 剑会变形。）
 */
export function fitSize(w: number, h: number, box: number): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: box, h: box };
  const s = box / Math.max(w, h);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// ── 变体选择 ────────────────────────────────────────────────────────

/**
 * 决定 (x, y, floor) 这一格用第几号变体。
 *
 * 三条要求，缺一条都会出问题：
 *
 * 1. **确定性。** 同一格必须每次都算出同一个数。否则每帧、每次重画都会换一张贴图，
 *    满屏地面会像噪点一样闪。所以只用坐标与楼层，绝不用时间或随机数。
 * 2. **位置无关联。** 相邻格的结果不能相关，否则变体会连成条纹 —— 那比重复更难看。
 *    所以哈希之后还要再混两轮（`>>>` 与乘法交错），把位扩散开。
 * 3. **与预览脚本一致。** `tools/preview-tiling.py` 用同样的算法出对照图，
 *    两边不一致就会「预览好看、游戏里不是那样」。
 *    为此这里刻意只用 `Math.imul` 与 `>>>`——它们在 JS 与 Python 里的语义都是
 *    「32 位整数回绕」，而普通的 `*` 在 JS 里超过 2^53 会丢精度，两边就对不上了。
 */
export function variantIndex(x: number, y: number, floor: number, count: number): number {
  if (count <= 1) return 0;
  let h =
    0x9e3779b9 ^
    Math.imul(x + 1, 0x85ebca6b) ^
    Math.imul(y + 1, 0xc2b2ae35) ^
    Math.imul(floor + 1, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h = (h ^ (h >>> 13)) >>> 0;
  return h % count;
}

// ── 图集对象 ────────────────────────────────────────────────────────

const ATLAS_URLS: Record<string, string> = {
  terrain: terrainUrl,
  actors: actorsUrl,
  monsters: monstersUrl,
  items: itemsUrl
};

/** 小游戏 `wx.createImage()` 的返回值 —— 只声明我们用到的那几个字段。 */
interface WxImage {
  src: string;
  onload: ((ev?: unknown) => void) | null;
  onerror: ((err?: unknown) => void) | null;
  width: number;
  height: number;
}

/**
 * 拿 `wx.createImage`（不在小游戏环境里则返回 null）。
 *
 * 用 `globalThis.wx` 而不是 import 小游戏环境模块：本文件是**网页端与小游戏共用**的，
 * 一旦 import `src/minigame/*`，网页端构建也会被拖进那套垫片。
 */
function wxCreateImage(): (() => WxImage) | null {
  const host = globalThis as { wx?: { createImage?: () => WxImage } };
  const fn = host.wx?.createImage;
  return typeof fn === 'function' ? fn.bind(host.wx) : null;
}

/**
 * 用 `wx.createImage()` 加载一张图集。
 *
 * ⚠️ **必须有超时**。`wx.createImage()` 的 `onerror` 在某些失败形态下不触发
 * （路径写错、包内文件缺失、真机上解码失败各有不同表现），而没有 `onerror`
 * 就意味着这个 Promise 永远 pending —— `atlas.load()` 会一直等下去，
 * 而它是 `await` 在 `Game.create()` 里的，表现成**卡在启动、既无画面也无报错**。
 * 宁可让图集失败（回退程序化图形），也不能让「锦上添花」把启动拖死。
 */
function loadImageViaWx(url: string, create: () => WxImage, timeoutMs = 8000): Promise<WxImage> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };
    let img: WxImage;
    try {
      img = create();
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => finish(() => reject(new Error(`wx.createImage 超时（${timeoutMs}ms）：${url}`))), timeoutMs);
    img.onload = () => finish(() => { clearTimeout(timer); resolve(img); });
    img.onerror = (err) =>
      finish(() => {
        clearTimeout(timer);
        reject(new Error(`wx.createImage 失败：${url} ${err === undefined ? '' : String(err)}`));
      });
    img.src = url;
  });
}

/**
 * 加载一张图集 —— **小游戏端刻意不走 `Assets.load`**。
 *
 * ## 为什么不能交给 Pixi 自己选
 *
 * `loadTextures` 的实现是「宿主有什么就用什么」：
 *
 *     if (globalThis.createImageBitmap && config.preferCreateImageBitmap) {
 *         src = await WorkerManager.loadImageBitmap(url, asset);   // 在 blob worker 里 fetch
 *         // 或 loadImageBitmap(url) → DOMAdapter.get().fetch(url) → createImageBitmap(blob)
 *     } else {
 *         src = DOMAdapter.get().createImage();  src.src = url;    // ← 这条才对
 *     }
 *
 * 坏在第一条分支的两个前提在小游戏里都站不住：
 *   - `WorkerManager` 那支在 **blob worker** 里 `fetch('assets/xxx.png')`，而 blob worker 的
 *     base URL 是 `blob:null/...` —— **相对路径解析不了**，直接 404；
 *   - `loadImageBitmap` 那支要 `DOMAdapter.fetch` + `response.blob()` + `createImageBitmap`，
 *     我们确实给了 `fetch`（走 `wx.request`），但 `wx.request` 是网络请求、
 *     读不了**包内文件**，而且小游戏里没有 `Blob`。
 *
 * 于是「能不能加载出图集」取决于宿主**碰巧**有没有 `createImageBitmap`：
 * 有（PC 端微信、桌面浏览器内核）→ 走进坏支路 → 静默回退程序化图形（玩家看到的就是「界面简陋」）；
 * 没有（部分真机）→ 走进对支路 → 正常。这种「同一份产物在不同宿主表现不同」的差异
 * 不该由宿主能力抽签决定，所以这里显式指定唯一一条路径：
 * **`wx.createImage()` + `ImageSource`**，它读的是包内相对路径，真机与 IDE 都通。
 *
 * 网页端（没有 `wx`）保持 `Assets.load` —— 那条路在浏览器里本来就是对的。
 */
async function loadAtlasTexture(url: string): Promise<Texture> {
  const create = wxCreateImage();
  if (!create) return Assets.load<Texture>(url);
  const img = await loadImageViaWx(url, create);
  // `alphaMode` 与 Pixi `loadTextures` 的取值保持一致，避免同图两条路径产出不同的源状态。
  const source = new ImageSource({ resource: img as never, alphaMode: 'premultiply-alpha-on-upload' });
  return new Texture({ source });
}

class Atlas {
  private sources: Record<string, Texture> = {};
  private cache = new Map<string, Texture>();
  private ok = false;
  /**
   * 最近一次加载失败的原因 —— 供探针上报。
   *
   * 存在的理由：`ready=false` 是**静默回退**，画面上只是「变朴素了」，
   * 在真机上根本看不出是加载失败还是本来就没素材。把原因带出来，
   * 才能区分「路径不对 / 宿主不给加载 / 超时」这几种完全不同的故障。
   */
  lastError: string | null = null;

  get ready(): boolean {
    return this.ok;
  }

  /**
   * 载入四张图集。
   *
   * 不抛异常：任何一张失败都只让 `ready` 保持 false，游戏照旧用程序化图形跑。
   * 图集是「锦上添花」，不该成为能不能启动的前提。
   */
  async load(): Promise<void> {
    try {
      const names = Object.keys(ATLAS_URLS);
      // 走 `loadAtlasTexture` 而不是 `Assets.load`：小游戏端必须避开 Pixi 那条
      // 「有 createImageBitmap 就 fetch」的分支（理由见该函数的注释）。
      const loaded = await Promise.all(names.map((n) => loadAtlasTexture(ATLAS_URLS[n])));
      names.forEach((n, i) => {
        const tex = loaded[i];
        // ★ 关键：关掉线性插值。少了这一行，放大后全是毛边。
        tex.source.scaleMode = 'nearest';
        tex.source.addressMode = 'clamp-to-edge';
        this.sources[n] = tex;
      });
      this.ok = true;
      this.lastError = null;
    } catch (err) {
      this.ok = false;
      this.sources = {};
      this.cache.clear();
      this.lastError = err instanceof Error ? err.message : String(err);
      // 只警告不抛：调用方会看到 ready=false 并走兜底分支
      console.warn('[atlas] 图集加载失败，回退到程序化图形：', err);
    }
  }

  /** 从某张图集里切一个子贴图（带缓存，同一帧只建一次 Texture） */
  private cut(atlasName: string, x: number, y: number, w: number, h: number): Texture | null {
    const src = this.sources[atlasName];
    if (!src) return null;
    const key = `${atlasName}:${x},${y},${w},${h}`;
    let tex = this.cache.get(key);
    if (!tex) {
      tex = new Texture({ source: src.source, frame: new Rectangle(x, y, w, h) });
      this.cache.set(key, tex);
    }
    return tex;
  }

  // ── 地形 ──────────────────────────────────────────────────────────

  /** 取一张地形贴图。键来自 `terrainKeyFor()` */
  terrain(key: string): Texture | null {
    const n = MANIFEST.terrain[key];
    if (!n) return null;
    return this.cut(n.atlas, n.x, n.y, n.w, n.h);
  }

  /** 该地形键有几张变体（含底图本身）。数量来自 MANIFEST，渲染层不写死。 */
  terrainVariantCount(key: string): number {
    const n = MANIFEST.meta.terrainVariants?.[key] ?? 1;
    return n > 1 ? n : 1;
  }

  /**
   * 取第 `i` 号变体贴图。`i <= 0` 就是底图本身。
   *
   * 取不到就退回底图 —— 变体是「锦上添花」，缺一张不该让格子空掉。
   * 这也是新增变体数量时的安全网：MANIFEST 里多写了一个数而图集里没有对应瓦片时，
   * 画面退化到「有点重复」，而不是「有的格子是空的」。
   */
  terrainVariant(key: string, i: number): Texture | null {
    if (i <= 0) return this.terrain(key);
    return this.terrain(`${key}:${i}`) ?? this.terrain(key);
  }

  /** 铺底用的地面贴图 */
  get floor(): Texture | null {
    return this.terrain(FLOOR_KEY);
  }

  // ── 道具 ──────────────────────────────────────────────────────────

  item(id: string): Texture | null {
    const n = MANIFEST.items[id];
    if (!n) return null;
    return this.cut(n.atlas, n.x, n.y, n.w, n.h);
  }

  // ── 怪物 ──────────────────────────────────────────────────────────

  monster(id: string, anim: 'idle' | 'run', frame: number): Texture | null {
    const n = MANIFEST.monsters[id];
    if (!n) return null;
    const list = n[anim] ?? n.idle;
    if (!list || list.length === 0) return null;
    const f = list[((frame % list.length) + list.length) % list.length];
    return this.cut(n.atlas, f.x, f.y, n.frame.w, n.frame.h);
  }

  /**
   * 怪物落屏尺寸**只由 MANIFEST 的 drawScale 决定** —— 这里不做任何按体型的分支。
   *
   * 杂兵的帧在 `rasterTile`（64）网格上、drawScale 0.5 → 落屏一格的 32px；
   * BOSS 的帧在 96 网格上、drawScale 1.0 → 落屏 96px（正好是它占的 3×3 格，
   * 见 `game/footprint.ts`）。「谁允许画得比一格大」由 `data/monsters.json`
   * 的 `boss` 字段与 A6 那道断言把关，不在这里判。
   */
  monsterScale(id: string): number {
    return MANIFEST.monsters[id]?.drawScale ?? MANIFEST.meta.drawScale;
  }

  // ── 角色（勇者 / NPC） ────────────────────────────────────────────

  heroFrame(anim: 'walk' | 'attack', dir: string, frame: number): Texture | null {
    return this.actorFrame(MANIFEST.actors.hero, anim, dir, frame);
  }

  npcFrame(id: string, dir: string, frame: number): Texture | null {
    const npc = MANIFEST.actors.npcs[id];
    if (!npc) return null;
    return this.actorFrame(npc, 'walk', dir, frame);
  }

  get actorScale(): number {
    return MANIFEST.actors.hero.drawScale;
  }

  private actorFrame(node: ActorEntry, anim: 'walk' | 'attack', dir: string, frame: number): Texture | null {
    const list = node[anim]?.[dir];
    if (!list || list.length === 0) return null;
    const f = list[((frame % list.length) + list.length) % list.length];
    return this.cut(node.atlas, f.x, f.y, f.w, f.h);
  }
}

/** 全局唯一实例：渲染层各处读同一份贴图缓存 */
export const atlas = new Atlas();

/** 在 `Game.create()` 里 await 一次即可。失败返回 false，不抛。 */
export async function loadAtlas(): Promise<boolean> {
  await atlas.load();
  return atlas.ready;
}
