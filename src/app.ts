/**
 * 应用编排 —— 把数据、规则引擎与渲染层接起来。
 *
 * 职责边界：
 *   data/    原始数据
 *   core/    战斗与商店公式（Node 校验器与浏览器共用同一份实现）
 *   game/    可序列化状态 + 规则引擎
 *   render/  PixiJS 绘制
 *   app.ts   输入分发、自动寻路、主循环 —— 只有这一层知道「谁调谁」
 *
 * 画布按设计尺寸 420×940 布局，再整体缩放到窗口：
 * 微信小游戏的标准做法（设计稿尺寸固定，运行时按屏幕等比缩放）。
 */

import { Application, Container, Graphics, Rectangle, RendererType } from 'pixi.js';
import { host } from './host';
import { loadData, type GameData, type Stat } from './data';
import { DIRS, createInitialState, entityAt, pushLog, tileAt, type Dir, type GameState } from './game/state';
import {
  arriveOnFloor,
  buyStat,
  merchantNote,
  merchantOffers,
  nearestStandable,
  previewBattle,
  shopOptions,
  step,
  tradeAccept,
  travelTo,
  useItem,
  type NpcTalk
} from './game/engine';
import { Board } from './render/board';
import { Backdrop } from './render/backdrop';
import { atlas, loadAtlas } from './render/atlas';
import {
  DetailPanel,
  FloorPanel,
  ItemBar,
  LAYOUT,
  StatusBar,
  Toolbar,
  boardBox,
  label,
  type BattleLike,
  type DetailTarget
} from './render/hud';
import { DialoguePanel } from './render/dialogue-panel';
import { MerchantPanel, ShopPanel } from './render/trade';
import { T, UI, npcRole, realm, realmOf, setRealm } from './render/theme';

interface Cell {
  x: number;
  y: number;
}

export class Game {
  private data: GameData;
  private state: GameState;
  private app: Application;
  private root = new Container();
  /**
   * 场景背景（塔的位面）—— 结构上的第一层，所有面板与棋盘都在它上面。
   * 它不是装饰层：地平线高度由当前楼层的位面决定，见 `render/backdrop.ts`。
   */
  private backdrop: Backdrop;
  private board: Board;
  private status: StatusBar;
  private detail: DetailPanel;
  private itemBar: ItemBar;
  private toolbar: Toolbar;
  private floorPanel: FloorPanel;
  private dialogue: DialoguePanel;
  private merchantPanel: MerchantPanel;
  private shopPanel: ShopPanel;
  private deathLayer = new Container();

  private walking = false;
  /**
   * 最近一次「棋盘收到点击」的格子坐标（不论后续是否真的走成）。
   *
   * 存在的理由是**区分两种完全不同的失败**：
   *   A. 触摸事件没送到游戏 → 这个值一直是 null
   *   B. 送到了、但那一格走不过去 → 值是对的，只是没动
   * 这两者的症状在自动化里长得一模一样（「点了一下，人没动」），
   * 光看游戏状态分不出来。实测中就把 B 误判成了 A，白查了一轮。
   */
  private lastBoardClick: Cell | null = null;
  private hoverTarget: DetailTarget = { kind: 'none' };
  /** 非 null 表示正处于「楼层浏览」状态：只切显示，不驱动勇者 */
  private browseFloor: number | null = null;
  /**
   * 非 null 表示有浮层开着。
   * 它和 browseFloor 是两种不同的「暂停」：浏览只是换显示，浮层则连输入都要断掉。
   *
   * `'dialogue'` 是撞到 NPC 时的对话框。它排在交易面板之前 —— 先说话，
   * 玩家按「交易」才开摊，所以交易面板不会再把台词盖住。
   */
  private modal: 'merchant' | 'shop' | 'dialogue' | null = null;

  private constructor(app: Application, data: GameData) {
    this.app = app;
    this.data = data;
    this.state = createInitialState(data);
    pushLog(this.state, '踏上魔塔第 1 层。方向键 / WASD 移动，撞向怪物即攻击。', 'floor');

    this.backdrop = new Backdrop();
    this.board = new Board(LAYOUT.board.cell, {
      onHover: (x, y) => this.onHover(x, y),
      onClick: (x, y) => void this.onBoardClick(x, y),
      gradeFor: (monId) => previewBattle(this.state, this.data, monId)?.grade ?? null
    });
    this.board.x = LAYOUT.board.x;
    this.board.y = LAYOUT.board.y;

    this.status = new StatusBar();
    this.detail = new DetailPanel();
    this.itemBar = new ItemBar((id) => this.onUseItem(id));
    this.toolbar = new Toolbar({
      onToggleReveal: () => this.toggleReveal(),
      // 同一颗按钮两种语义：平时开楼层面板，浏览态下就是「返回」
      onBrowse: () => (this.browseFloor !== null ? this.returnFromBrowse() : this.openFloorPanel('browse')),
      onRestart: () => this.restart()
    });
    // 对话框自己会在关闭时回调 —— 编排层据此清掉 modal 状态，
    // 否则关掉框之后输入仍然被判定为「有浮层」而整块失效
    this.dialogue = new DialoguePanel(() => {
      if (this.modal === 'dialogue') this.modal = null;
    });
    this.floorPanel = new FloorPanel(this.data, (f) => this.onFloorPicked(f), () => this.closeFloorPanel());
    this.merchantPanel = new MerchantPanel(
      this.data,
      (i) => this.onTrade(i),
      () => this.closeModal()
    );
    this.shopPanel = new ShopPanel(
      this.data,
      (s) => this.onShopBuy(s),
      () => this.closeModal()
    );

    // 顺序即层序：背景在最底，两个交易浮层与对话框必须排在棋盘与 HUD 之后，
    // 遮罩才挡得住下层点击
    this.root.addChild(
      this.backdrop,
      this.status,
      this.board,
      this.toolbar,
      this.detail,
      this.itemBar,
      this.floorPanel,
      this.dialogue,
      this.merchantPanel,
      this.shopPanel,
      this.deathLayer
    );
    this.app.stage.addChild(this.root);

    this.board.setFloor(this.state, this.data, this.state.floor);
    this.sync();
    this.app.ticker.add((tk) => this.board.update(tk.deltaMS, this.state));
    this.fit();
  }

  static async create(): Promise<Game> {
    const data = loadData();
    // 图集必须在建 Board 之前就绪 —— Board 构造时按 atlas.ready 决定这一局走
    // 精灵还是程序化图形。加载失败不抛异常，只是 ready=false，游戏照常能玩。
    await loadAtlas();

    const sh = host();
    const { w, h } = sh.size();
    const app = new Application();
    await app.init({
      // 兜底色：真正的背景由 Backdrop 铺满，这里管的是「画布之外」那圈黑边
      background: realmOf(1).sky,
      antialias: true,
      resolution: sh.dpr,
      autoDensity: true,
      width: w,
      height: h,
      // 画布由宿主提供：小游戏里必须是 `wx.createCanvas()` 的**第一次**调用结果
      // （那才是上屏画布），不能让 Pixi 自己去 createCanvas。
      canvas: sh.canvas() as unknown as HTMLCanvasElement,
      // 小游戏里 WebGPU 面要么不存在要么不完整，直接锁 webgl 免得多绕一圈
      preference: 'webgl'
    });
    sh.attach(app.canvas);

    const game = new Game(app, data);
    sh.onKey((key) => game.onKey(key));
    sh.onResize(() => game.resize());
    return game;
  }

  /** 宿主尺寸变了：重设渲染器尺寸，再重算缩放。 */
  private resize(): void {
    const { w, h } = host().size();
    this.app.renderer.resize(w, h);
    this.fit();
  }

  /** 把设计稿（LAYOUT.W × LAYOUT.H）等比缩放居中 */
  private fit(): void {
    // ⚠️ PixiJS v8 的 renderer.width 已经是**逻辑像素**（内部已除以 resolution），
    // 再除一次 resolution 会把整体缩放算成 1/dpr，画面只剩左上角一小块。
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;
    const s = Math.min(w / LAYOUT.W, h / LAYOUT.H);
    this.root.scale.set(s);
    this.root.x = Math.round((w - LAYOUT.W * s) / 2);
    this.root.y = Math.round((h - LAYOUT.H * s) / 2);
  }

  /**
   * 供控制台与自动化验证读取的精简状态快照。
   * 渲染层不参与它 —— 拿到的是引擎的真值，所以能用来判断「画面是否只是看起来对」。
   */
  __probe(): Record<string, unknown> {
    return {
      ok: true,
      floor: this.state.floor,
      pos: { ...this.state.pos },
      hp: this.state.hp,
      atk: this.state.atk,
      def: this.state.def,
      gold: this.state.gold,
      buyTimes: this.state.buyTimes,
      claimed: [...this.state.claimed],
      modal: this.modal,
      /** 对话框是否开着 —— 自动化截图要单独摆这个状态 */
      dialogue: this.dialogue.isOpen,
      /** 每个 NPC 已搭话次数：台词轮换的输入，也是「对话真的在变」的证据 */
      talked: { ...this.state.talked },
      keys: { ...this.state.keys },
      bag: Object.keys(this.state.bag),
      passives: [...this.state.passives],
      visitedCount: this.state.visited.length,
      steps: this.state.stats.steps,
      kills: this.state.stats.kills,
      hpLost: this.state.stats.hpLost,
      dead: this.state.dead,
      lastLog: this.state.log.at(-1)?.text ?? null,
      // 见 lastBoardClick 的说明：用来把「事件没送到」和「送到了但走不通」分开
      lastBoardClick: this.lastBoardClick ? { ...this.lastBoardClick } : null,
      displayFloor: this.browseFloor ?? this.state.floor,
      /**
       * 是否正处于「楼层浏览」。
       *
       * 单列出来是因为它是**唯一会让棋盘输入整体失效**的状态（所有入口都写
       * `browseFloor !== null` 就 return）。所以它一旦残留，症状就是「点了没反应」，
       * 而不是某个显式的错误 —— 必须能被断言直接看到。
       */
      browsing: this.browseFloor !== null,
      /** 工具栏中间那颗按钮的文案，断言「返回键真的摆出来了」用它 */
      toolbarBrowseLabel: this.toolbar.browseLabel,
      // 渲染器信息：小游戏端要确认拿到的**不是**降级后的 CanvasRenderer。
      //
      // ⚠️ 这里返回**名字**，而不是 `renderer.type` 的原始数字，是踩过之后的决定：
      // `RendererType` 是数字枚举（WEBGL=1 / WEBGPU=2 / BOTH=3 / CANVAS=4），
      // 而 `1` 看起来太像「某种布尔或序号」—— 实测中就被读成了
      // 「不是 webgl，而是 1（某个简化渲染器）」，白白怀疑了半天。
      // 换成名字后，`=== 'webgl'` 这个断言不需要任何额外解释。
      rendererType: RendererType[this.app.renderer.type]?.toLowerCase() ?? `unknown(${this.app.renderer.type})`,
      resolution: this.app.renderer.resolution,
      screen: { w: this.app.renderer.width, h: this.app.renderer.height },
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
        horizon: this.backdrop.horizon,
        paintedFloor: this.backdrop.paintedFloor
      }
    };
  }

  /**
   * 版面实测快照 —— 「各模块间隙相等，且棋盘没有被挤小」必须能被断言。
   *
   * 读的是**渲染树里各面板回填的卡片矩形**（`UI.tag.rect`），不是 LAYOUT 常量：
   * 常量写的是意图，卡片矩形是真正画出来的那一版。棋盘那一块用 `boardBox()` ——
   * 它是「格子区 + 塔壁 + 城垛」的整体视觉盒，而间隙必须按它算：
   * 只按格子区算出来的间隙是假的（旧版就是这么把 20px 算成了 −4）。
   */
  __layout(): {
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
  } {
    const bb = boardBox();
    const modules = [
      { id: 'hud', ...this.status.cardRect },
      { id: 'board', ...bb },
      {
        id: 'toolbar',
        x: LAYOUT.toolbar.x,
        y: LAYOUT.toolbar.y,
        w: LAYOUT.toolbar.w,
        h: LAYOUT.toolbar.h
      },
      { id: 'detail', ...this.detail.cardRect },
      { id: 'items', ...this.itemBar.cardRect }
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
      itemsHidden: this.itemBar.cardRect.h === 0,
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
  __panels(): Array<{ panel: string; title: string; dx: number; dy: number; fontSize: number | null }> {
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
    walk(this.root as unknown as Node, 'root', 0, 0, null);
    return out;
  }

  /**
   * 开发用：直接把道具塞进勇者手里。
   * 51 层塔里要验证某个 UI 状态，靠走位过去是不现实的（很多道具在钥匙经济上
   * 本来就够不着）。这个方法只服务开发期，不进入正常流程。
   */
  __grant(id: string): string {
    const item = this.data.items[id];
    if (!item) return `未知道具 ${id}`;
    const persistent = (item.effects ?? []).some(
      (e) => e.op === 'traitCounter' || e.op === 'immune' || e.op === 'mulGoldGain'
    );
    if (item.kind === 'usable') this.state.bag[id] = (this.state.bag[id] ?? 0) + 1;
    else if (item.kind === 'passive' || persistent) {
      if (!this.state.passives.includes(id)) this.state.passives.push(id);
    }
    // 拾取即生效的道具（宝石 / 剑盾）顺带把效果也应用上，否则状态会对不上
    if (item.kind === 'pickup') {
      for (const e of item.effects ?? []) {
        if (e.op === 'addStat') this.state[e.stat as 'hp' | 'atk' | 'def'] += e.value as number;
        if (e.op === 'addKey') this.state.keys[e.key as 'yellowKey' | 'blueKey' | 'redKey'] += e.value as number;
      }
    }
    pushLog(this.state, `[开发] 发放 ${item.name}`, 'loot');
    this.sync();
    return `已发放 ${item.name}`;
  }

  /**
   * 开发用：把勇者直接放到某层（跳过钥匙经济与楼梯）。
   * 全塔 12 个商人分散在 2/6/7/12/15/28/29/31/38/39/45/47 层，
   * 靠走位逐层验证交易界面是不现实的 —— 光是钥匙就够不着。
   */
  __goto(floor: number, x?: number, y?: number): string {
    if (!this.data.floors.has(floor)) return `第 ${floor} 层不存在`;
    const spot =
      x !== undefined && y !== undefined ? { x, y } : nearestStandable(this.state, this.data, floor, 5, 5);
    arriveOnFloor(this.state, this.data, floor, spot.x, spot.y);
    this.browseFloor = null;
    this.board.setFloor(this.state, this.data, this.state.floor);
    this.board.setHeroVisible(true);
    this.board.setHeroPos(spot.x, spot.y, false);
    this.sync();
    return `已到第 ${floor} 层 (${spot.x}, ${spot.y})`;
  }

  /** 开发用：以代码方式走一步，等价于按方向键（含开面板等副作用） */
  __step(dir: Dir): string {
    return this.doStep(dir);
  }

  /**
   * 开发用：直接给金币。
   * 45 层商人要 1000、47 层地震卷轴要 3000 —— 靠打怪攒够这些钱要通掉大半座塔，
   * 而这几层恰恰是交易界面最需要验证的地方。
   */
  __gold(n: number): string {
    this.state.gold += n;
    pushLog(this.state, `[开发] 金币 +${n}`, 'loot');
    this.sync();
    return `金币 ${this.state.gold}`;
  }

  /** 当前楼层的商人报价 —— 与面板看到的完全同源 */
  __offers(): unknown[] {
    return merchantOffers(this.state, this.data, this.state.floor);
  }

  /** 当前楼层的商店报价 */
  __shop(): unknown {
    return shopOptions(this.state, this.data);
  }

  /**
   * 开发用：直接和某个 NPC 说上话（跳过走位）。
   *
   * 全塔 12 个商人、4 个商店分散在各层，要验证对话框的三种来源
   * （本层特供 / 首次见面 / 再次搭话）靠走位过去是不现实的。
   * 它走的是**和撞上去完全同一条路径**（同一个引擎分支、同一个 `openDialogue`），
   * 所以截图里看到的就是玩家会看到的那一帧。
   */
  __talk(npcId: string): string {
    const es = (this.data.floors.get(this.state.floor)?.entities ?? []).filter(
      (e) => e.type === 'npc' && e.id === npcId
    );
    if (es.length === 0) return `${npcId} 不在这层`;
    const e = es[0];
    const before = this.state.talked[npcId] ?? 0;
    // 先站到它旁边。相邻四格可能被墙/门占着，能站哪格就站哪格
    const spots = [
      { x: e.x - 1, y: e.y },
      { x: e.x + 1, y: e.y },
      { x: e.x, y: e.y - 1 },
      { x: e.x, y: e.y + 1 }
    ].filter((s) => this.enterable(s.x, s.y, false));
    if (spots.length === 0) return `${e.id} 四周都站不下人`;
    this.state.pos = { ...spots[0] };
    this.board.setHeroPos(this.state.pos.x, this.state.pos.y, false);
    const d = this.dirToward(this.state.pos, { x: e.x, y: e.y });
    if (!d) return '站不到身侧';
    this.doStep(d);
    return `搭话 ${npcId}（第 ${before + 1} 次）`;
  }

  // ── 输入 ──────────────────────────────────────────────────────────

  /**
   * 只吃「按了哪个键」，不吃 KeyboardEvent —— 平台差异（preventDefault、事件对象形状）
   * 已由 `host.onKey` 吸收，小游戏端干脆不实现键盘。
   */
  private onKey(key: string): void {
    const map: Record<string, Dir> = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      w: 'up',
      a: 'left',
      s: 'down',
      d: 'right',
      W: 'up',
      A: 'left',
      S: 'down',
      D: 'right'
    };
    const dir = map[key];
    if (dir) {
      if (this.walking || this.state.dead || this.browseFloor !== null || this.modal !== null) return;
      this.doStep(dir);
      return;
    }
    if (key === 'Escape') {
      // 浮层优先关：否则玩家连按 Esc 会先关掉下层看不见的楼层面板，像失灵了
      if (this.modal !== null) this.closeModal();
      else this.closeFloorPanel();
      return;
    }
    if (key === 'r' || key === 'R') this.restart();
    if (key === 'Tab') {
      if (this.modal !== null) return;
      if (this.floorPanel.visible) this.closeFloorPanel();
      else this.openFloorPanel('browse');
    }
  }

  private onHover(x: number, y: number): void {
    if (x < 0 || y < 0) {
      this.hoverTarget = { kind: 'none' };
      this.refreshDetail();
      return;
    }
    const floor = this.browseFloor ?? this.state.floor;
    const ent = entityAt(this.state, this.data, floor, x, y);
    if (ent) {
      if (ent.type === 'monster') this.hoverTarget = { kind: 'monster', id: ent.id, x, y };
      else if (ent.type === 'item') this.hoverTarget = { kind: 'item', id: ent.id, x, y };
      else this.hoverTarget = { kind: 'npc', id: ent.id, x, y };
    } else {
      this.hoverTarget = { kind: 'terrain', char: tileAt(this.state, this.data, floor, x, y), x, y };
    }
    this.refreshDetail();
  }

  private async onBoardClick(x: number, y: number): Promise<void> {
    // ⚠️ 记录必须放在所有提前 return **之前**：我们要的是「点击送到哪一格」，
    //    而不是「哪一格成功走了」。被守卫挡下的点击同样是有价值的证据。
    this.lastBoardClick = { x, y };
    if (this.walking || this.state.dead || this.browseFloor !== null || this.modal !== null) return;

    const path = this.pathTo(x, y);
    if (!path || path.length === 0) {
      pushLog(this.state, '走不过去。', 'warn');
      this.sync();
      return;
    }
    this.walking = true;
    try {
      for (let i = 0; i < path.length; i++) {
        const cell = path[i];
        const isLast = i === path.length - 1;
        // 中途遇到怪物 / 门 / NPC 就停下，把决定权交回玩家
        if (!isLast) {
          const ent = entityAt(this.state, this.data, this.state.floor, cell.x, cell.y);
          const ch = tileAt(this.state, this.data, this.state.floor, cell.x, cell.y);
          const info = this.data.byChar[ch];
          if (ent || !info?.passable || info.stairs || ch === 'w') break;
        }
        const dir = this.dirToward(this.state.pos, cell);
        if (!dir) break;
        const kind = this.doStep(dir);
        if (kind === 'blocked' || kind === 'talk' || kind === 'stairs' || kind === 'battle') break;
        await new Promise((r) => setTimeout(r, 95));
      }
    } finally {
      this.walking = false;
      this.sync();
    }
  }

  private dirToward(from: Cell, to: Cell): Dir | null {
    if (to.y === from.y && to.x === from.x + 1) return 'right';
    if (to.y === from.y && to.x === from.x - 1) return 'left';
    if (to.x === from.x && to.y === from.y + 1) return 'down';
    if (to.x === from.x && to.y === from.y - 1) return 'up';
    return null;
  }

  /** 能否走进某格（供寻路使用）。isTarget 时放宽，因为目标格可以是怪物 / 门 / 假墙 */
  private enterable(x: number, y: number, isTarget: boolean): boolean {
    if (x < 0 || y < 0 || x > 10 || y > 10) return false;
    const ch = tileAt(this.state, this.data, this.state.floor, x, y);
    const info = this.data.byChar[ch];
    if (!info?.passable) return false;
    if (isTarget) return true;
    if (entityAt(this.state, this.data, this.state.floor, x, y)) return false;
    if (info.stairs) return false; // 别把楼梯当中转点，会意外换层
    if (ch === 'w') return false;
    return true;
  }

  /** BFS 寻路。目标不可直入时（门 / 墙 / 岩浆）退化成「走到它旁边再撞一下」 */
  private pathTo(tx: number, ty: number): Cell[] | null {
    const startK = `${this.state.pos.x},${this.state.pos.y}`;
    const targetK = `${tx},${ty}`;
    const prev = new Map<string, string>();
    const dist = new Map<string, number>([[startK, 0]]);
    const q: Cell[] = [{ x: this.state.pos.x, y: this.state.pos.y }];

    const reconstruct = (k: string): Cell[] => {
      const out: Cell[] = [];
      let cur: string | undefined = k;
      while (cur && cur !== startK) {
        const [x, y] = cur.split(',').map(Number);
        out.unshift({ x, y });
        cur = prev.get(cur);
      }
      return out;
    };

    while (q.length) {
      const cur = q.shift()!;
      const cd = dist.get(`${cur.x},${cur.y}`) ?? 0;
      for (const d of Object.values(DIRS)) {
        const nx = cur.x + d.dx;
        const ny = cur.y + d.dy;
        const k = `${nx},${ny}`;
        if (dist.has(k)) continue;
        if (!this.enterable(nx, ny, nx === tx && ny === ty)) continue;
        dist.set(k, cd + 1);
        prev.set(k, `${cur.x},${cur.y}`);
        q.push({ x: nx, y: ny });
      }
    }

    if (dist.has(targetK)) return reconstruct(targetK);

    let best: { k: string; d: number } | null = null;
    for (const [k, d] of dist) {
      const [x, y] = k.split(',').map(Number);
      if (Math.abs(x - tx) + Math.abs(y - ty) !== 1) continue;
      if (!best || d < best.d) best = { k, d };
    }
    if (!best) return null;
    return [...reconstruct(best.k), { x: tx, y: ty }];
  }

  // ── 动作 ──────────────────────────────────────────────────────────

  private doStep(dir: Dir): string {
    const before = this.state.floor;
    const res = step(this.state, this.data, dir);
    if (this.state.floor !== before || res.floorChanged !== undefined) {
      this.board.setFloor(this.state, this.data, this.state.floor);
      this.board.setHeroVisible(true);
      // 换层意味着「勇者不在这里」这件事不再成立，浏览态必须一并清掉，
      // 否则工具栏那颗会一直停在「返回第 N 层」上
      this.browseFloor = null;
      this.toolbar.setBrowsing(false, this.state.floor);
    } else {
      this.board.setHeroPos(this.state.pos.x, this.state.pos.y, res.moved);
    }
    // 撞上怪物就挥一剑。
    // 方向要用**玩家按下的那个方向**而不是勇者当前朝向 —— 撞怪时勇者没移动，
    // 朝向不会被更新，传当前朝向会出现「向右撞怪却朝下挥空」
    if (res.kind === 'battle') this.board.playHeroAttack(dir);
    this.sync();
    // 引擎只「请求」打开界面，具体开哪块面板由编排层决定
    if (res.npc) this.openDialogue(res.npc);
    else if (res.openUi === 'merchant') this.openMerchant();
    else if (res.openUi === 'shop') this.openShop();
    return res.kind;
  }

  // ── NPC 对话 ─────────────────────────────────────────────────────
  //
  // 「说哪一句」是引擎（`src/game/dialogue.ts`）算好的，这里只负责**编排**：
  // 补上「本层有没有摊子」这条功能引导、按职能给颜色、决定按钮给不给。

  private openDialogue(talk: NpcTalk): void {
    this.modal = 'dialogue';
    const role = npcRole(talk.id);
    const lines = [talk.text];

    // 功能引导：NPC 的价值在于「告诉你现在能做什么」，所以第二段说明摊位状态。
    // 文案取自引擎算好的报价，不在渲染层重算价格。
    if (talk.tradeKind === 'merchant') {
      const offers = merchantOffers(this.state, this.data, this.state.floor);
      const goods = offers.map((o) => `${o.title}${o.price > 0 ? `（${o.price} 金币）` : ''}`).join('、');
      lines.push(goods ? `本层货品：${goods}` : '');
    } else if (talk.tradeKind === 'shop') {
      const shop = shopOptions(this.state, this.data);
      lines.push(`本层买卖：第 ${shop.n} 次成交起价 ${shop.cost} 金币，越买越贵（${shop.tierNote}）。`);
    } else if (talk.id === 'princess') {
      lines.push('主线：护送公主离开这座塔。');
    }

    this.dialogue.open({
      name: talk.name,
      role,
      lines: lines.filter(Boolean),
      hint: talk.from === 'floor' ? '本层专说' : talk.from === 'greet' ? '初次见面' : '又见面了',
      tradeLabel: talk.tradeKind ? '交易' : undefined,
      onTrade: () => {
        this.modal = null;
        if (talk.tradeKind === 'shop') this.openShop();
        else if (talk.tradeKind === 'merchant') this.openMerchant();
      }
    });
  }

  private onUseItem(id: string): void {
    if (this.state.dead) return;
    const res = useItem(this.state, this.data, id);
    if (res.openUi === 'floorSelect') this.openFloorPanel('teleport');
    else if (!res.ok) pushLog(this.state, res.message, 'warn');
    this.sync();
  }

  // ── 交易（商人 / 商店） ───────────────────────────────────────────

  private openMerchant(): void {
    const offers = merchantOffers(this.state, this.data, this.state.floor);
    if (offers.length === 0) return;
    this.modal = 'merchant';
    this.merchantPanel.open(offers, merchantNote(this.data, this.state.floor), this.state.gold);
  }

  private openShop(): void {
    this.modal = 'shop';
    this.shopPanel.open(shopOptions(this.state, this.data));
  }

  /** 成交后必须整块重画：金币、持有量、以及每条的 blocked 都变了 */
  private onTrade(index: number): void {
    const res = tradeAccept(this.state, this.data, this.state.floor, index);
    if (!res.ok) pushLog(this.state, res.message, 'warn');
    this.sync();
    if (this.modal !== 'merchant') return;
    const offers = merchantOffers(this.state, this.data, this.state.floor);
    if (offers.length === 0) this.closeModal();
    else this.merchantPanel.open(offers, merchantNote(this.data, this.state.floor), this.state.gold);
  }

  private onShopBuy(stat: Stat): void {
    const res = buyStat(this.state, stat);
    if (!res.ok) pushLog(this.state, res.message, 'warn');
    this.sync();
    if (this.modal === 'shop') this.shopPanel.open(shopOptions(this.state, this.data));
  }

  private closeModal(): void {
    if (this.modal === null) return;
    const was = this.modal;
    this.modal = null;
    // 对话框的 close() 会回调回来清 modal —— 此时 modal 已经是 null，
    // 回调里的守卫（`modal === 'dialogue'`）不成立，所以不会自我递归
    if (was === 'dialogue') this.dialogue.close();
    this.merchantPanel.close();
    this.shopPanel.close();
    this.sync();
  }

  private toggleReveal(): void {
    const on = !this.board.revealHidden;
    this.board.revealHidden = on;
    this.board.setRevealHidden(this.state, this.data, on);
    this.toolbar.revealPill.setActive(on);
    pushLog(this.state, on ? '编辑视图开启：显示埋在墙内的隐藏道具' : '编辑视图关闭', 'info');
    this.sync();
  }

  private openFloorPanel(mode: 'teleport' | 'browse'): void {
    this.floorPanel.open(this.state, mode, this.displayFloor);
  }

  /**
   * 退出楼层浏览，回到勇者所在层。
   *
   * ## 为什么单独抽一个方法
   *
   * 走这条路的有三处：工具栏那颗「返回第 N 层」、面板右上角的「关闭」、以及 Esc。
   * 之前只有后两条，而且**返回键只在面板可见时才存在** —— 而浏览态下选一层之后
   * 面板会自己关上（见 `onFloorPicked`），于是玩家被卡在一个没有出口的状态里：
   * 勇者被隐藏、棋盘对点击没反应（所有输入都被 `browseFloor !== null` 挡下），
   * 唯一出路是键盘 Esc，而触摸设备上没有键盘。
   *
   * 实测证据（tools/probe-round.cjs）：
   *   选完楼层后 → panelVisible=false、heroLayerVisible=false、browseFloor=7，
   *   点棋盘 → 步数 0 → 0（点了没反应）。
   */
  private returnFromBrowse(): void {
    if (this.browseFloor === null) return;
    this.browseFloor = null;
    this.floorPanel.close();
    this.board.setFloor(this.state, this.data, this.state.floor);
    this.board.setHeroVisible(true);
    this.board.setHeroPos(this.state.pos.x, this.state.pos.y, false);
    this.hoverTarget = { kind: 'none' };
    this.toolbar.setBrowsing(false, this.state.floor);
    this.sync();
  }

  private closeFloorPanel(): void {
    // 面板的「关闭」在浏览态下就是「返回」；非浏览态只是收起面板
    if (this.browseFloor !== null) {
      this.returnFromBrowse();
      return;
    }
    this.floorPanel.close();
    this.sync();
  }

  private onFloorPicked(f: number): void {
    const mode = this.floorPanel.mode;

    if (mode === 'teleport' && f !== this.state.floor && this.state.visited.includes(f)) {
      const res = travelTo(this.state, this.data, f);
      if (res.ok) {
        this.floorPanel.close();
        this.browseFloor = null;
        this.toolbar.setBrowsing(false, this.state.floor);
        this.board.setFloor(this.state, this.data, this.state.floor);
        this.board.setHeroVisible(true);
        this.sync();
        return;
      }
      pushLog(this.state, res.message, 'warn');
    }

    // ── 浏览模式：只切显示，勇者留在原地 ────────────────────────────
    //
    // 选完这一层要**把面板收起来**，两个理由，缺一个都会让这套浏览等于白做：
    //
    //  1. 面板卡片是 y=240..700 —— 它正好盖住棋盘（y=178..544）。留着面板，
    //     玩家根本看不清自己点开的那一层，"浏览"就成了只看一眼角落。
    //  2. 面板的遮罩是**全屏**的，连工具栏一起盖住。于是工具栏那颗「返回第 N 层」
    //     虽然已经把文案换好了，却按不着 —— 实测 `page.mouse` 点上去毫无反应，
    //     用 Pixi 的 `hitTest` 一看命中的是面板自己的遮罩。
    //
    // 旧版之所以"不能关面板"，是因为那时候**返回键只在面板上**：一关就再没有出口。
    // 现在出口在工具栏上（`toolbar.setBrowsing(true, …)` 把它变成「返回第 N 层」
    // 并高亮），关掉面板反而让这个出口**看得见、也按得着**。面板收起后
    // 「勇者被隐藏 + 棋盘不吃点击」这个状态依然存在，但它是**有出口的**，不再是死路。
    this.browseFloor = f;
    this.board.setHeroVisible(false);
    this.board.setFloor(this.state, this.data, f);
    this.toolbar.setBrowsing(true, this.state.floor);
    this.floorPanel.close();
    pushLog(
      this.state,
      `浏览第 ${f} 层（勇者仍在第 ${this.state.floor} 层，点工具栏的「返回」回来）`,
      'info'
    );
    this.sync();
  }

  private restart(): void {
    this.state = createInitialState(this.data);
    this.browseFloor = null;
    this.walking = false;
    this.modal = null;
    this.merchantPanel.close();
    this.shopPanel.close();
    this.dialogue.close();
    this.floorPanel.close();
    this.hoverTarget = { kind: 'none' };
    this.deathLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.toolbar.revealPill.setActive(false);
    this.toolbar.setBrowsing(false, this.state.floor);
    this.board.revealHidden = false;
    pushLog(this.state, '回到第 1 层，重新开始。', 'floor');
    this.board.setFloor(this.state, this.data, this.state.floor);
    this.board.setHeroVisible(true);
    this.board.setHeroPos(this.state.pos.x, this.state.pos.y, false);
    this.sync();
  }

  // ── 刷新 ──────────────────────────────────────────────────────────

  private currentBattle(): BattleLike | null {
    if (this.hoverTarget.kind !== 'monster') return null;
    return previewBattle(this.state, this.data, this.hoverTarget.id) as BattleLike | null;
  }

  /** 棋盘当前显示的是哪一层 —— 浏览模式下与勇者所在层不同 */
  private get displayFloor(): number {
    return this.browseFloor ?? this.state.floor;
  }

  private refreshDetail(): void {
    this.detail.render(this.state, this.data, this.hoverTarget, this.currentBattle(), {
      browsing: this.browseFloor !== null,
      shownFloor: this.displayFloor
    });
  }

  private sync(): void {
    // 位面必须先切：背景层与面板底板都读它，晚一步就会画出上一层的色
    this.syncRealm(this.displayFloor);
    this.board.refresh(this.state, this.data);
    this.board.update(0, this.state);
    this.status.update(this.state, this.data, this.displayFloor, this.browseFloor !== null);
    this.refreshDetail();
    this.itemBar.update(this.state, this.data);
    if (this.state.dead && this.deathLayer.children.length === 0) this.showDeath();
  }

  /**
   * 把「当前位面」推给背景层与面板。
   *
   * 只在**跨过位面锚点**时重画卡片底板：相邻两层的底色差得极小（第 20 层到
   * 第 21 层要跨过石堡→高塔），没必要每层都重画一遍三块面板的底板 ——
   * 那是每步都可能触发的路径。
   */
  private syncRealm(floor: number): void {
    const before = realm().id;
    setRealm(floor);
    if (realm().id !== before) {
      this.status.repaintCard();
      this.detail.repaintCard();
      this.itemBar.repaintCard();
    }
    // 屏幕上超出设计稿的那部分（黑边）也染成天顶色，画面因此是"满"的
    this.app.renderer.background.color = realm().sky;
    this.backdrop.setFloor(floor);
  }

  private showDeath(): void {
    const g = new Graphics();
    g.rect(0, 0, LAYOUT.W, LAYOUT.H).fill({ color: 0x0f172a, alpha: 0.55 });
    g.eventMode = 'static';
    g.hitArea = new Rectangle(0, 0, LAYOUT.W, LAYOUT.H);
    this.deathLayer.addChild(g);

    const px = 60;
    const py = Math.round((LAYOUT.H - 186) / 2);
    const pw = LAYOUT.W - 120;
    const ph = 186;
    const panel = new Graphics();
    panel.roundRect(px, py, pw, ph, 16).fill(T.panel);
    panel.roundRect(px, py, pw, ph, 16).stroke({ width: 1, color: T.panelBorder });
    this.deathLayer.addChild(panel);

    const title = label('勇者阵亡', 22, T.danger, '800');
    title.anchor.set(0.5, 0);
    title.x = LAYOUT.W / 2;
    title.y = py + 26;
    this.deathLayer.addChild(title);

    const sub = label(
      `在第 ${this.state.floor} 层倒下　步数 ${this.state.stats.steps}　击杀 ${this.state.stats.kills}`,
      12,
      T.inkMuted
    );
    sub.anchor.set(0.5, 0);
    sub.x = LAYOUT.W / 2;
    sub.y = py + 64;
    this.deathLayer.addChild(sub);

    const tip = label('巫师领域是唯一致死途径，战斗前会先被拦下。', 11, T.inkFaint);
    tip.anchor.set(0.5, 0);
    tip.x = LAYOUT.W / 2;
    tip.y = py + 88;
    this.deathLayer.addChild(tip);

    const btn = new Container();
    btn.x = LAYOUT.W / 2 - 60;
    btn.y = py + 122;
    const bg = new Graphics();
    bg.roundRect(0, 0, 120, 38, 19).fill(T.hero);
    const bt = label('重新开始', 14, T.onDark, '700');
    bt.anchor.set(0.5);
    bt.x = 60;
    bt.y = 19;
    btn.addChild(bg, bt);
    btn.eventMode = 'static';
    btn.cursor = 'pointer';
    btn.hitArea = new Rectangle(0, 0, 120, 38);
    btn.on('pointertap', () => this.restart());
    this.deathLayer.addChild(btn);
  }
}
