/**
 * 开发探针 —— 三个**只读快照**，给自动化验证与控制台读。
 *
 * 从 `app.ts` 拆出来的。它们原先以 `__probe()` / `__layout()` / `__panels()`
 * 的形式占着 `Game` 类里约 200 行，而它们和游戏逻辑是**正交**的：
 * 只读、不改状态、不参与任何一帧的渲染。
 *
 * ## 为什么是「传一个视图」而不是「把 Game 传进来」
 *
 * 直接收 `Game` 最省事，但那样这个文件就会顺着 `this` 摸到任意字段 ——
 * 探针与游戏内部结构之间就有了一个看不见的契约（改个私有字段名，探针静默读 undefined，
 * 而断言只会表现成「某个值为 null」）。
 * 显式列出 `ProbeView` 之后，「探针能看到什么」是一份**可审的清单**：
 * 它看不到 `board`、看不到 `toolbar` 对象本身，只能看到它明确要读的那几个值。
 *
 * ## 探针的纪律
 *
 * 这里每一个字段都对应一条断言或一次踩坑，注释里的「为什么单列出来」不是装饰 ——
 * 删掉一个字段就等于删掉一条断言的眼睛。改动前请先读对应注释。
 */

import { RendererType, type Container } from 'pixi.js';
import type { GameState } from '../game/state';
import { atlas } from '../render/atlas';
import { LAYOUT, boardBox, textResolution } from '../render/hud';
import { UI } from '../render/theme';
import { realm } from '../render/theme';
import type { Cell } from './pathing';

/** 探针允许看到的一切。加字段前先想清楚「哪条断言会用它」。 */
export interface ProbeView {
  state: GameState;
  modal: 'merchant' | 'shop' | 'dialogue' | null;
  browseFloor: number | null;
  lastBoardClick: Cell | null;
  dialogueOpen: boolean;
  toolbarBrowseLabel: string;
  /** 只取渲染器上被探针读到的四个值，不把整个 Renderer 递进来 */
  renderer: { type: number; resolution: number; width: number; height: number };
  backdrop: { horizon: number; paintedFloor: number };
  /** 三块**回填**了卡片矩形的面板（版式断言读的是这里，不是 LAYOUT 常量） */
  rects: {
    hud: { x: number; y: number; w: number; h: number };
    detail: { x: number; y: number; w: number; h: number };
    items: { x: number; y: number; w: number; h: number };
  };
  /** 渲染树根 —— `panelsSnapshot()` 要遍历它 */
  root: Container;
}

/**
 * 供控制台与自动化验证读取的精简状态快照。
 * 渲染层不参与它 —— 拿到的是引擎的真值，所以能用来判断「画面是否只是看起来对」。
 */
export function probeSnapshot(v: ProbeView): Record<string, unknown> {
  const state = v.state;
  return {
    ok: true,
    floor: state.floor,
    pos: { ...state.pos },
    hp: state.hp,
    atk: state.atk,
    def: state.def,
    gold: state.gold,
    buyTimes: state.buyTimes,
    claimed: [...state.claimed],
    modal: v.modal,
    /** 对话框是否开着 —— 自动化截图要单独摆这个状态 */
    dialogue: v.dialogueOpen,
    /** 每个 NPC 已搭话次数：台词轮换的输入，也是「对话真的在变」的证据 */
    talked: { ...state.talked },
    keys: { ...state.keys },
    bag: Object.keys(state.bag),
    passives: [...state.passives],
    visitedCount: state.visited.length,
    steps: state.stats.steps,
    kills: state.stats.kills,
    hpLost: state.stats.hpLost,
    dead: state.dead,
    lastLog: state.log.at(-1)?.text ?? null,
    // 见 lastBoardClick 的说明：用来把「事件没送到」和「送到了但走不通」分开
    lastBoardClick: v.lastBoardClick ? { ...v.lastBoardClick } : null,
    displayFloor: v.browseFloor ?? state.floor,
    /**
     * 是否正处于「楼层浏览」。
     *
     * 单列出来是因为它是**唯一会让棋盘输入整体失效**的状态（所有入口都写
     * `browseFloor !== null` 就 return）。所以它一旦残留，症状就是「点了没反应」，
     * 而不是某个显式的错误 —— 必须能被断言直接看到。
     */
    browsing: v.browseFloor !== null,
    /** 工具栏中间那颗按钮的文案，断言「返回键真的摆出来了」用它 */
    toolbarBrowseLabel: v.toolbarBrowseLabel,
    // 渲染器信息：小游戏端要确认拿到的**不是**降级后的 CanvasRenderer。
    //
    // ⚠️ 这里返回**名字**，而不是 `renderer.type` 的原始数字，是踩过之后的决定：
    // `RendererType` 是数字枚举（WEBGL=1 / WEBGPU=2 / BOTH=3 / CANVAS=4），
    // 而 `1` 看起来太像「某种布尔或序号」—— 实测中就被读成了
    // 「不是 webgl，而是 1（某个简化渲染器）」，白白怀疑了半天。
    // 换成名字后，`=== 'webgl'` 这个断言不需要任何额外解释。
    rendererType: RendererType[v.renderer.type]?.toLowerCase() ?? `unknown(${v.renderer.type})`,
    resolution: v.renderer.resolution,
    // 文字光栅化分辨率。它必须与 `resolution`（设备像素比）一致 ——
    // 写死 2 而屏幕是 3 时，每一块面板上的中文都会被拉伸过一道，画面看着就「虚」。
    textResolution: textResolution(),
    screen: { w: v.renderer.width, h: v.renderer.height },
    // 图集是不是**真的**加载成功了。
    //
    // 这一条单列出来，是因为「URL 格式对」和「图真的加载到了」是两回事：
    // 前者只能证明路径写法没错，加载失败时 `ready` 保持 false，渲染层静默换用
    // `icons.ts` 的程序化图形 —— 画面照旧出得来，只是美术不对。
    // 也就是说这一条失败时**看不出任何异常**，只能靠显式断言。
    atlasReady: atlas.ready,
    // 图集失败的原因。`ready=false` 本身是**静默回退**（画面只是变朴素），
    // 真机上光看画面分不出「加载失败」与「本来就没素材」—— 把原因带出来。
    atlasError: atlas.lastError,
    // 场景背景（塔的位面）。`paintedFloor` 是背景层**真正画出来**的那一层，
    // 与 state.floor 分开报：换层时两者短暂不一致，正是这类 bug 的现场。
    realm: {
      id: realm().id,
      name: realm().name,
      horizon: v.backdrop.horizon,
      paintedFloor: v.backdrop.paintedFloor
    }
  };
}

export interface LayoutSnapshot {
  W: number;
  H: number;
  gap: number;
  pad: number;
  modules: Array<{ id: string; x: number; y: number; w: number; h: number }>;
  /** 真正参与排版的模块 id（道具栏为空时会缺一个） */
  placed: string[];
  /** 道具栏是不是「空背包 → 整栏不占位」 */
  itemsHidden: boolean;
  gaps: Array<{ after: string; value: number }>;
  boardCell: number;
  boardSpan: number;
  boardBox: { x: number; y: number; w: number; h: number };
}

/**
 * 版面实测快照 —— 「各模块间隙相等，且棋盘没有被挤小」必须能被断言。
 *
 * 读的是**渲染树里各面板回填的卡片矩形**（`UI.tag.rect`），不是 LAYOUT 常量：
 * 常量写的是意图，卡片矩形是真正画出来的那一版。棋盘那一块用 `boardBox()` ——
 * 它是「格子区 + 塔壁 + 城垛」的整体视觉盒，而间隙必须按它算：
 * 只按格子区算出来的间隙是假的（旧版就是这么把 20px 算成了 −4）。
 */
export function layoutSnapshot(v: ProbeView): LayoutSnapshot {
  const bb = boardBox();
  const modules = [
    { id: 'hud', ...v.rects.hud },
    { id: 'board', ...bb },
    {
      id: 'toolbar',
      x: LAYOUT.toolbar.x,
      y: LAYOUT.toolbar.y,
      w: LAYOUT.toolbar.w,
      h: LAYOUT.toolbar.h
    },
    { id: 'detail', ...v.rects.detail },
    { id: 'items', ...v.rects.items }
  ];
  // 道具栏 h = 0 表示「空背包，整栏不占位」。这时它必须整块从版面里**摘出去**，
  // 而不是留一条 0 高的缝 —— 否则 `detail → items` 与 `items → 底` 两条
  // 会变成 28 与 142 这样的假间隙，A8 立刻报错，而画面其实是对的。
  const placed = modules.filter((m) => m.h > 0);
  const gaps: Array<{ after: string; value: number }> = [{ after: 'top', value: placed[0].y }];
  for (let i = 0; i < placed.length - 1; i++) {
    gaps.push({ after: placed[i].id, value: placed[i + 1].y - (placed[i].y + placed[i].h) });
  }
  const last = placed[placed.length - 1];
  gaps.push({ after: last.id, value: LAYOUT.H - (last.y + last.h) });
  return {
    W: LAYOUT.W,
    H: LAYOUT.H,
    gap: LAYOUT.gap,
    pad: LAYOUT.pad,
    modules,
    /** 参与排版的模块（h=0 的已摘除）。断言用这个 */
    placed: placed.map((m) => m.id),
    itemsHidden: v.rects.items.h === 0,
    gaps,
    boardCell: LAYOUT.board.cell,
    boardSpan: LAYOUT.board.cell * 11,
    boardBox: bb
  };
}

/**
 * 面板版式快照 —— 「所有面板共用一套版式」这件事必须能被断言。
 *
 * ## 为什么从渲染树读，而不是让每个面板自报数字
 *
 * 自报的是「我以为我设了多少」，读树拿到的是「真的设进去多少」。
 * 这一轮就抓到过两者的差别：交易浮层的标题横向用了 `+UI.pad`(14)，
 * 而短条占 12..15 —— 标题压在自己的短条上，源码里却看不出任何异常。
 *
 * ## 偏移是逐级累加出来的，不是 `getGlobalPosition()`
 *
 * 全局坐标会被 `root.scale`（按屏幕/dpr 算出来的那个系数）乘一遍，
 * 同一个偏移在不同设备像素比下量出来是 23 / 46 / 69。累加**本地** x/y
 * 得到的是设计坐标，与 dpr 无关 —— 断言才能写成一个确定的数。
 */
export function panelsSnapshot(v: ProbeView): Array<{ panel: string; title: string; dx: number; dy: number; fontSize: number | null }> {
  type Rect = { x: number; y: number; w: number; h: number };
  type Node = {
    label?: string;
    x: number;
    y: number;
    text?: string;
    style?: { fontSize?: number };
    cardRect?: Rect;
    children?: unknown[];
  };
  const out: Array<{ panel: string; title: string; dx: number; dy: number; fontSize: number | null }> = [];
  const walk = (n: Node, owner: string, dx: number, dy: number, rect: Rect | null): void => {
    const lb = typeof n.label === 'string' ? n.label : undefined;
    const isPanel = !!lb && lb.startsWith(UI.tag.panel);
    const name = isPanel ? lb.slice(UI.tag.panel.length) : owner;
    // 进到一块面板里，累加器归零：之后量到的都是「相对这块面板左上角」
    const ax = isPanel ? 0 : dx + n.x;
    const ay = isPanel ? 0 : dy + n.y;
    // 卡片矩形沿路径继承：交易浮层把矩形记在 ModalShell 上、标题是它的子节点，
    // 所以标题要找的是「路径上最近的那一个」，不是自己身上那一个。
    // 宽高为 0 的是「还没 layout 过」的占位矩形（浮层只在 open() 时才定高），
    // 不能拿它当基准 —— 否则会量出「面板在 (0,0)」这种假坐标。
    const card = n.cardRect && n.cardRect.w > 0 ? n.cardRect : rect;
    if (lb === UI.tag.title && card) {
      out.push({
        panel: name,
        title: n.text ?? '',
        dx: Math.round(ax - card.x),
        dy: Math.round(ay - card.y),
        fontSize: n.style?.fontSize ?? null
      });
    }
    for (const c of n.children ?? []) walk(c as Node, name, ax, ay, card);
  };
  walk(v.root as unknown as Node, 'root', 0, 0, null);
  return out;
}
