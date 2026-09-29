/**
 * 应用编排 —— 把数据、规则引擎与渲染层接起来。
 *
 * 职责边界：
 *   data/    原始数据
 *   core/    战斗与商店公式（Node 校验器与浏览器共用同一份实现）
 *   game/    可序列化状态 + 规则引擎
 *   render/  PixiJS 绘制
 *   app/     输入分发、自动寻路、主循环 —— 只有这一层知道「谁调谁」
 *
 * 画布按设计尺寸 420×940 布局，再整体缩放到窗口：
 * 微信小游戏的标准做法（设计稿尺寸固定，运行时按屏幕等比缩放）。
 *
 * ## 这个目录里为什么四块东西是分开的
 *
 * 原先这里是**一个 1013 行的 `app.ts`**。拆开之后留下的这层是「编排」：
 * 它同时知道引擎、棋盘、五块面板与两个浮层，而这份「什么都知道」恰恰是它的职责
 * —— 所以**没有**继续往下拆。硬把「输入」「对话」「交易」切成独立模块，
 * 就得让它们各自持有一份 `Game` 的引用，耦合只是换了个地方藏。
 *
 * 真正**正交**的三块被请了出去，因为它们不需要知道「谁调谁」：
 *   pathing.ts         BFS 寻路与方向判定（纯算法，只读 state/data）
 *   death-overlay.ts   阵亡遮罩的渲染构建（纯绘制，接收一个回调）
 *   probe.ts           三个只读快照 —— 探针与游戏逻辑无关，且**不该**顺着
 *                      `this` 乱摸字段（见该文件头）
 *
 * 判断标准就一句：**搬出去之后，它还需不需要 `this`？** 不需要的才搬。
 */

import { Application, Container } from 'pixi.js';
import { host } from '../host';
import { loadData, type GameData, type Stat } from '../data';
import { createInitialState, entitiesOn, entityAt, entityKey, pushLog, tileAt, type Dir, type GameState } from '../game/state';
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
} from '../game/engine';
import { Board } from '../render/board';
import { Backdrop } from '../render/backdrop';
import { loadAtlas } from '../render/atlas';
import {
  DetailPanel,
  FloorPanel,
  ItemBar,
  LAYOUT,
  RunStrip,
  StatusBar,
  Toolbar,
  setTextResolution,
  type BattleLike,
  type DetailTarget
} from '../render/hud';
import { DialoguePanel } from '../render/dialogue-panel';
import { MerchantPanel, ShopPanel } from '../render/trade';
import { npcRole, realm, realmOf, setRealm } from '../render/theme';
import {
  CYCLE_LIMIT,
  createAutoMemory,
  decideAutoAction,
  explainStop,
  isCleared,
  situationOf,
  type AutoAction,
  type AutoMemory
} from '../game/autoplay';
import { buildDeathOverlay } from './death-overlay';
import { dirToward, enterable, pathTo, type Cell } from './pathing';
import {
  badgesOf,
  scoreExplain,
  scoreList,
  scoreName,
  scoreRole
} from './score-overlay';
import type { FloorScore } from '../game/score';
import type { ScoreBadgeView } from '../render/board/types';
import { layoutSnapshot, panelsSnapshot, probeSnapshot, type LayoutSnapshot, type ProbeView } from './probe';
import { AUTO_GOD_LOADOUT, GOD_LOADOUT, applyGodLoadout, godLoadoutText } from './test-loadout';

/**
 * 自动通关的**出手间隔**（毫秒）。
 *
 * 为什么不是「每帧一步」：60fps 下每帧一步等于每秒 60 格，屏幕上只剩一道残影，
 * 玩家看不出它在干什么（而「看得见它在干什么」正是接界面的全部意义）。
 * 110ms/步 ≈ 每秒 9 格 —— 与点击寻路的 95ms/格同量级，观感一致。
 *
 * 也不是越慢越好：全塔上千步，300ms 一步要五分钟以上。这个数是「看得清」
 * 与「等得起」之间的取中。
 */
const AUTO_STEP_MS = 110;

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
  /** 底部那条「自动跑了多少步」—— 见 `hud/run-strip.ts` */
  private runStrip: RunStrip;
  private deathLayer = new Container();

  private walking = false;
  /**
   * 自动通关的**短期记忆**；`null` 表示没在跑。
   *
   * 它是 `decideAutoAction` 的第三个参数（决策器本身是纯函数，记忆由调用方持有）。
   * 用 `null`/非 `null` 兼作「是否运行中」这一个状态，不另设布尔 ——
   * 两份状态迟早会不一致，而症状是「按钮亮着但不走了」。
   */
  private auto: AutoMemory | null = null;
  /** 自动通关的出手计时器（累加 ticker 的 deltaMS） */
  private autoAccum = 0;
  /**
   * 自动通关**已经出手多少步** —— 这是界面上那条「自动 128 步」读的数。
   *
   * 为什么不直接用 `state.stats.steps`：那个数里混着玩家自己走的步，
   * 而这条读数要回答的是「AI 走到第几步时做错了」—— 混进玩家的步数就对不上了。
   * 每一次 `performAutoAction()` 记 1（暂停的拍子不计，见 `tickAuto`）。
   */
  private autoTicks = 0;
  /**
   * 这一局有没有跑过自动通关。
   *
   * 与 `auto !== null` 分开：**停下之后读数不能消失**。自动通关判定
   * 「走投无路」自己停下时，玩家正要读这个数 —— 那一刻把它清掉等于擦掉证据。
   */
  private autoRan = false;
  /**
   * 这一局有没有套用过**神装测试起手**（`src/app/test-loadout.ts`）。
   *
   * 与属性本身分开记：属性会被战斗与购买改掉，而「这一局是从神装起手的」这件事
   * 是**历史事实**，不该被后来的掉血抹掉 —— 探针报的就是它
   * （见 `ProbeView.autoLoadout`）。
   */
  private autoLoadoutApplied = false;
  /**
   * 局势循环探针：同一个「局势」出现过几次（签名见 `situationOf`）。
   *
   * 只属于**这一次自动通关**：`startAuto` 里清空（`restart` 会先停自动）。
   */
  private cycleSeen = new Map<string, number>();
  /** 计分视图的分数清单（徽标与点击明细共用这一份，见 `syncScores`） */
  private scoreEntries: FloorScore[] = [];
  private scoreBadges: ScoreBadgeView[] = [];
  /**
   * 上一份分数清单是按什么局面算的。
   *
   * `sync()` 每走一步都会被调到，而分数的输入是「整层的怪 + 属性 + 位置 + 钥匙」——
   * 没有这个签名的话，每一步都要跑一遍 121 格的 Dijkstra 与几十次战斗预览。
   * 签名里少列一项的症状是「吃了宝石，AI 的分变了、界面上的分没变」——
   * 所以宁可多列：`removed` / `terrainPatch` / `monsterSwap` 都进签名。
   */
  private scoreSig: string | null = null;
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
      onClick: (x, y) => void this.onBoardClick(x, y)
    });
    this.board.x = LAYOUT.board.x;
    this.board.y = LAYOUT.board.y;

    this.status = new StatusBar();
    this.detail = new DetailPanel();
    this.itemBar = new ItemBar((id) => this.onUseItem(id));
    this.toolbar = new Toolbar({
      onToggleScore: () => this.toggleScore(),
      // 同一颗按钮两种语义：平时开楼层面板，浏览态下就是「返回」
      onBrowse: () => (this.browseFloor !== null ? this.returnFromBrowse() : this.openFloorPanel('browse')),
      onAuto: () => this.toggleAuto(),
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
    this.runStrip = new RunStrip();

    // 顺序即层序：背景在最底，两个交易浮层与对话框必须排在棋盘与 HUD 之后，
    // 遮罩才挡得住下层点击
    this.root.addChild(
      this.backdrop,
      this.status,
      this.board,
      this.toolbar,
      this.detail,
      this.itemBar,
      // 底部读数条排在道具栏之后（它贴在屏幕底边）、但在浮层之前 ——
      // 浮层弹出时要把整屏盖住，读数条不该浮在遮罩之上
      this.runStrip,
      this.floorPanel,
      this.dialogue,
      this.merchantPanel,
      this.shopPanel,
      this.deathLayer
    );
    this.app.stage.addChild(this.root);

    this.board.setFloor(this.state, this.data, this.state.floor);
    this.sync();
    this.app.ticker.add((tk) => {
      this.board.update(tk.deltaMS, this.state);
      this.tickAuto(tk.deltaMS);
    });
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

    // 文字按**屏幕**的分辨率光栅化。写死 2 时，dpr=3 的手机上所有中文都被拉伸过
    // 一道 —— 这一行就是「面板文字发虚」的全部来源。必须在建任何 Text 之前设。
    setTextResolution(app.renderer.resolution);

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
   * 把探针要读的字段**显式列成一份清单**（见 `probe.ts` 的文件头）。
   *
   * 这个方法是「Game 的内部结构」与「探针」之间唯一的接触面：
   * 想让探针多读一个字段，就得在这里加一行 —— 于是「探针能看到什么」
   * 永远是可审的，而不是靠 `this` 随便摸。
   */
  private probeView(): ProbeView {
    return {
      state: this.state,
      modal: this.modal,
      browseFloor: this.browseFloor,
      lastBoardClick: this.lastBoardClick,
      dialogueOpen: this.dialogue.isOpen,
      dialogueLines: this.dialogue.lines,
      toolbarBrowseLabel: this.toolbar.browseLabel,
      toolbarAutoLabel: this.toolbar.autoLabel,
      toolbarScoreLabel: this.toolbar.scoreLabel,
      toolbarButtons: this.toolbar.buttonRects(),
      autoRunning: this.auto !== null,
      autoSteps: this.autoTicks,
      // 只在**这一局真的套过**测试起手时非 null —— 这个标记是「这一局开了挂」的
      // 唯一凭据，判据与玩家都读它（见 `ProbeView.autoLoadout` 的注释）
      autoLoadout: this.autoLoadoutApplied
        ? { hp: GOD_LOADOUT.hp, atk: GOD_LOADOUT.atk, def: GOD_LOADOUT.def, keys: { ...GOD_LOADOUT.keys } }
        : null,
      scoreView: this.board.scoreView,
      scoreBadges: this.scoreBadges,
      runStrip: this.runStrip.visible
        ? { text: this.runStrip.labelText, visible: true }
        : { text: '', visible: false },
      renderer: this.app.renderer,
      backdrop: this.backdrop,
      rects: { hud: this.status.cardRect, detail: this.detail.cardRect, items: this.itemBar.cardRect },
      root: this.root
    };
  }

  /** 供控制台与自动化验证读取的精简状态快照（实现在 `probe.ts`） */
  __probe(): Record<string, unknown> {
    return probeSnapshot(this.probeView());
  }

  /** 版面实测快照（实现在 `probe.ts`） */
  __layout(): LayoutSnapshot {
    return layoutSnapshot(this.probeView());
  }

  /** 面板版式快照（实现在 `probe.ts`） */
  __panels(): Array<{ panel: string; title: string; dx: number; dy: number; fontSize: number | null }> {
    return panelsSnapshot(this.probeView());
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
   *
   * ⚠️ 落点用 `{ avoidEntities: true }`：**调试传送只搬人，不动背包**。
   * 不用这个口径的话，`arriveOnFloor()` 的「落地即拾取」会让 `__goto(37)`
   * 落在放着炸弹的 (4,4) 上、顺手把炸弹收走 —— 而 `a01-terrain` 是逐层 `__goto`，
   * 于是「看一眼全塔」就把背包弄脏，A11「空背包不占位」跟着变红。
   * 那条链子跨了三个判据文件，靠人眼是追不回来的：A1b 现在正面钉住它。
   */
  __goto(floor: number, x?: number, y?: number): string {
    if (!this.data.floors.has(floor)) return `第 ${floor} 层不存在`;
    const spot =
      x !== undefined && y !== undefined
        ? { x, y }
        : nearestStandable(this.state, this.data, floor, 5, 5, { avoidEntities: true });
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
   * 开发用：开始 / 停止自动通关，等价于点工具栏那颗按钮。
   *
   * 有它才谈得上**可断言的界面验收**：判据里既要能「开始」，也要能「停下」，
   * 而靠 `tap()` 点按钮时，一旦几何变了（按钮数、宽度）就会点到缝里 ——
   * 于是「功能坏了」和「测试点歪了」长得一模一样。所以两条路都要有：
   * 判据用 `__auto` 做**行为**断言，另有一条用 `tap()` 做**按钮可达**断言。
   *
   * 不传参 = 切换；传 `true` / `false` = 明确开始 / 停止。
   */
  __auto(on?: boolean): string {
    const want = on ?? this.auto === null;
    if (want && !this.auto) this.startAuto();
    else if (!want && this.auto) this.stopAuto('外部调用');
    return this.auto ? 'running' : 'stopped';
  }

  /**
   * 开发用：开 / 关计分视图，等价于点工具栏第一颗「计分」。
   *
   * 与 `__auto` 同一个理由：判据里既要能「开始」也要能「停下」，
   * 而靠 `tap()` 点按钮时，一旦几何变了就会点到缝里 ——
   * 于是「功能坏了」和「测试点歪了」长得一模一样。
   * 所以「按钮够得着」由 A24 用真实点击验一次，「视图行为」由这条验。
   */
  __scoreView(on?: boolean): string {
    const want = on ?? !this.board.scoreView;
    if (want !== this.board.scoreView) this.toggleScore();
    return this.board.scoreView ? 'on' : 'off';
  }

  /**
   * 开发用：点棋盘某一格（与玩家点下去**同一条路**）。
   *
   * 返回点完之后 `modal` 是什么 —— 判据据此断言「计分视图下点目标会弹出算式」，
   * 而不用去猜对话框是不是真的开了。
   */
  async __click(x: number, y: number): Promise<string> {
    await this.onBoardClick(x, y);
    return this.modal ?? 'none';
  }

  /**
   * 开发用：当前显示层的**三类分数原始清单**（徽标与点击明细共用的那一份）。
   *
   * 判据拿它与 `board.__scoreBadges()`（画出来的）对撞：数字对不上、
   * 或者某一枚漏画了，都会在这里露出来。返回的是**明细**而不是只有总分 ——
   * 算式的每一段也要能被断言（用户点名要的就是「看得见怎么算的」）。
   */
  __scores(): Array<{
    key: string;
    type: string;
    id: string;
    x: number;
    y: number;
    total: number;
    parts: Array<{ label: string; value: number }>;
  }> {
    return this.scoreEntries.map((e) => ({
      key: e.key,
      type: e.type,
      id: e.id,
      x: e.x,
      y: e.y,
      total: e.score.total,
      parts: e.score.parts.map((p) => ({ ...p }))
    }));
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
    // ⚠️ 要滤掉**已经离场**的实体：`lifecycle: 'once'` 的 NPC 搭过话就从地图上
    // 消失了（`step.ts`）。不滤的话这里会挑中那个已经不在的人 —— 勇者「撞」过去
    // 只是走到那一格上，对话框根本没开，而返回值照旧写着「搭话 xxx（第 2 次）」，
    // 于是读 `dialogue.body` 的判据量到的是**上一个 NPC 的残留行**（A15 就踩这个）。
    // 滤掉之后同一层的两个同类 NPC（第 2 层两个智者）也能各自被量到。
    const es = entitiesOn(this.state, this.data, this.state.floor).filter(
      (e) =>
        e.type === 'npc' &&
        e.id === npcId &&
        !this.state.removed.has(entityKey(this.state.floor, e.x, e.y, 'npc', e.id))
    );
    if (es.length === 0) return `${npcId} 不在这层（或已离场）`;
    const e = es[0];
    const key = entityKey(this.state.floor, e.x, e.y, 'npc', e.id);
    const before = this.state.talked[key] ?? 0;
    //
    // 先站到它旁边。相邻四格可能被墙 / 门 / 假墙 / 别的实体占着，能站哪格就站哪格。
    //
    // ⚠️ 这里要**三档**，缺一档就会有 NPC **永远采不到**（2026-09-27 实测 5 个：
    // 第 2 层小偷、第 12 层塔角的商人+智者、第 26 层公主、第 38 层智者）。
    // 而「采不到」的后果不是报错，是**判据静默少采一位** —— A15 只管「采到的那些
    // 折不折行」，少采一个人它照样绿。
    //
    //   ① 玩家**当下**真能站：`enterable(..., false)`（非假墙、非楼梯、没人占）；
    //   ② 玩家破开假墙 / 绕开门之后能站：`enterable(..., true)`，即**目标格口径**
    //      （只查地形可通行）。第 12 层那两位卡在塔角：左 / 上出界、下是墙、
    //      右是**假墙**（`w` 在 tiles.json 里 `passable: true`，撞一下即破）——
    //      ① 档四邻全空，② 档正好给出「破墙之后站的那一格」这个终态；
    //   ③ 四周连地形都不通，只能**直接放过去**。第 26 层的公主被一圈岩浆封着
    //      （(4,5)(6,5)(5,4)(5,6) 四格全是 `~`），她是有解的 —— 第 35 层的
    //      **雪花**（`clearTerrain terrain:5 scope:currentFloor`）清掉那圈岩浆后，
    //      这一格就是玩家站的位置。③ 档复现的正是那个终态，不是「走进岩浆」。
    //
    // 三档都空才算真站不下（那说明这个实体压根没有相邻格，比如落点在棋盘外）。
    const nbrs = [
      { x: e.x - 1, y: e.y },
      { x: e.x + 1, y: e.y },
      { x: e.x, y: e.y - 1 },
      { x: e.x, y: e.y + 1 }
    ];
    const pick = (isTarget: boolean) =>
      nbrs.find((s) => enterable(this.state, this.data, s.x, s.y, isTarget));
    const r1 = pick(false);
    const r2 = r1 ? null : pick(true);
    const spot =
      r1 ??
      r2 ??
      nbrs.find((s) => s.x >= 0 && s.y >= 0 && s.x <= 10 && s.y <= 10) ??
      null;
    if (!spot) return `${e.id} 四周都站不下人`;
    // 降档要在返回值里看得见 —— 否则「采到了」分不清是站在地上采的还是越位采的
    const off = !r1 ? (r2 ? `（越位站位：${spot.x},${spot.y} 需先破墙/开门）` : `（越位站位：${spot.x},${spot.y} 需先清地形）`) : '';
    this.state.pos = { ...spot };
    this.board.setHeroPos(this.state.pos.x, this.state.pos.y, false);
    const d = dirToward(this.state.pos, { x: e.x, y: e.y });
    if (!d) return '站不到身侧';
    this.doStep(d);
    return `搭话 ${npcId}（第 ${before + 1} 次）${off}`;
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
      // 玩家按方向键 = 接手。先停自动通关再走，免得两边抢同一个勇者
      if (this.auto) this.stopAuto('玩家接管');
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
    if (this.auto) this.stopAuto('玩家接管');
    if (this.walking || this.state.dead || this.browseFloor !== null || this.modal !== null) return;

    //
    // 计分视图下，点到**有东西的格子**就是「看它的分」—— 不驱动勇者。
    //
    // 这条改的是点击的语义，值得写清楚为什么可以这么改：计分视图本身是
    // **审核模式**（看算法给的价，而不是玩），此时「点一下把勇者挪过去」既不是
    // 玩家想要的，还会顺手改变局面、把刚才读到的那一批分全部作废。
    // 点空格仍然照常寻路 —— 想挪人就去点空地。
    //
    if (this.board.scoreView) {
      const entry = this.scoreAtCell(x, y);
      if (entry) {
        this.openScoreDialog(entry);
        return;
      }
    }

    const path = pathTo(this.state, this.data, x, y);
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
        const dir = dirToward(this.state.pos, cell);
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

  // ── 动作 ──────────────────────────────────────────────────────────

  /**
   * 走一步。
   *
   * `suppressUi` 是给自动通关用的：AI 的目标是「走到商人**旁边**再成交」
   * （见 `autoplay.ts` 的 `neighborSpot`），它**不由**撞 NPC 来触发交易，
   * 所以撞到 NPC / 商店时不该弹面板 —— 一弹出来 `modal` 非空，自动通关那一支
   * 就整块停住，表现是「走到商人面前不动了」。
   */
  private doStep(dir: Dir, suppressUi = false): string {
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
    if (suppressUi) return res.kind;
    if (res.npc) this.openDialogue(res.npc);
    else if (res.openUi === 'merchant') this.openMerchant();
    else if (res.openUi === 'shop') this.openShop();
    return res.kind;
  }

  // ── 自动通关 ──────────────────────────────────────────────────────
  //
  // 决策在 `src/game/autoplay.ts`（纯函数，不认 Pixi），这里**只是执行器** ——
  // 和 `tools/autoplay/sim.ts` 的 switch 一一对应。两处保持同构是有意的：
  // headless 判据能通关，界面上才谈得上「看一眼效果」。

  private toggleAuto(): void {
    if (this.auto) this.stopAuto('手动停止');
    else this.startAuto();
  }

  private startAuto(): void {
    if (this.state.dead) {
      pushLog(this.state, '勇者已阵亡，先重开再自动通关。', 'warn');
      this.sync();
      return;
    }
    //
    // ★ 神装测试起手（`src/app/test-loadout.ts`）。
    //
    // 点「自动通关」的这一刻把三围与钥匙拉满，于是**界面上的自动通关能一路打到
    // 第 50 层**（headless 那条路早就证明了它行：`verify:autoplay` 的 D 段，
    // 7906 步击败真魔王）。此前界面上只能跑到 F16 左右就「走投无路」停下 ——
    // 那不是执行器坏了，是**决策器的正常水平**；两者混在一起看，会让人以为
    // 界面接错了。所以把「塔通不通」这一层单独放到按钮上，看得见。
    //
    // ⚠️ 只在这里套用（**起手那一刻**），不是每步都套 ——
    // 否则打怪掉的血、买来的属性会立刻被抹平，那就不是「起手」而是「无敌」了，
    // 而两者要回答的问题完全不同。
    //
    // ⚠️ 必须留日志。悄悄把属性拉满，玩家（与下一个读代码的人）就分不清
    // 「它真的打过了」和「它开了挂」—— 这条日志就是那个分界。
    if (AUTO_GOD_LOADOUT) {
      applyGodLoadout(this.state);
      this.autoLoadoutApplied = true;
      pushLog(this.state, `⚠️ 测试起手（神装）：${godLoadoutText()} —— 点「重开」回到真实起手。`, 'warn');
    }
    this.auto = createAutoMemory();
    this.cycleSeen.clear();
    this.autoAccum = 0;
    // 底部读数从 0 起算（「已自动运行多少步」是**这一次**的），
    // 但 `autoRan` 一旦为真就再也不回到 false —— 停下的那一刻读数要留着
    this.autoTicks = 0;
    this.autoRan = true;
    this.toolbar.setAuto(true);
    pushLog(this.state, '自动通关开始（再点一次「停止自动」可随时接手）。', 'info');
    this.sync();
  }

  /** `reason` 为 null 表示静默停止（重开时用，免得日志里留一句无意义的「已停止」） */
  private stopAuto(reason: string | null): void {
    if (!this.auto) return;
    this.auto = null;
    this.autoAccum = 0;
    this.toolbar.setAuto(false);
    if (reason) pushLog(this.state, `自动通关停止：${reason}`, 'info');
    this.sync();
  }

  /**
   * 按 `AUTO_STEP_MS` 的节奏出手一步。
   *
   * 暂停条件（`modal` / 浏览态）只是**跳过**而不是停止：那是玩家自己打开的浮层，
   * 关掉之后自动通关应当接着跑 —— 玩家的预期是「它还在跑，只是我先看一眼」。
   */
  private tickAuto(deltaMS: number): void {
    if (!this.auto) return;
    if (this.state.dead) {
      this.stopAuto('勇者阵亡');
      return;
    }
    if (isCleared(this.state, this.data)) {
      this.stopAuto('通关：真魔王已被击败');
      return;
    }
    if (this.modal !== null || this.walking || this.browseFloor !== null) return;
    this.autoAccum += deltaMS;
    if (this.autoAccum < AUTO_STEP_MS) return;
    this.autoAccum = 0;
    //
    // ★ 局势循环护栏 —— 与 headless 那份**同一个签名、同一个上限**（`situationOf`）。
    //
    // 少了它，界面上「走投无路」永远不会发生：那种死法里每一步都**合法**
    // （上楼 ↔ 下楼、或传送器在两层间来回跳），`decideAutoAction` 每次都给出
    // 一个动作、从不返回 `stop` ⇒ 按钮会**一直转下去**，而屏幕上看起来
    // 像是「AI 有点慢」。实测默认起手那局同一局势重复 **31 次**
    // （`verify:autoplay` 那条常态红就是它），在 headless 里会被拦下并报出
    // 现场签名，而界面此前没有这道护栏。
    //
    // 停下时把 `explainStop` 的诊断一起写进日志 —— 与 `case 'stop'` 同规：
    // 「走投无路」有四五种成因，只报一句结论没法定位。
    const sit = situationOf(this.state);
    const times = (this.cycleSeen.get(sit) ?? 0) + 1;
    this.cycleSeen.set(sit, times);
    if (times > CYCLE_LIMIT) {
      pushLog(this.state, `走投无路：局势循环（${sit}，重复 ${times} 次）`, 'warn');
      for (const line of explainStop(this.state, this.data).slice(0, 4)) {
        pushLog(this.state, `  ${line}`, 'warn');
      }
      this.stopAuto(`走投无路：局势循环（重复 ${times} 次）`);
      return;
    }
    this.performAutoAction();
  }

  private performAutoAction(): void {
    const mem = this.auto;
    if (!mem) return;
    // 先记数再出手：这样底部读数里的 N 就是**正在执行的这一步**的序号，
    // 「第 N 步做错了」可以直接对着它复现（headless 报告也是这个口径）。
    // 只在 `tickAuto` 真正出手时累加 —— 被浮层/浏览态挡下的拍子不计（那里提前 return 了）。
    this.autoTicks += 1;
    const action: AutoAction = decideAutoAction(this.state, this.data, mem);

    switch (action.kind) {
      case 'step':
        this.doStep(action.dir, true);
        break;
      case 'buy': {
        const res = buyStat(this.state, action.stat);
        if (!res.ok) pushLog(this.state, res.message, 'warn');
        this.sync();
        break;
      }
      case 'useItem': {
        const res = useItem(this.state, this.data, action.id);
        if (!res.ok) pushLog(this.state, res.message, 'warn');
        this.sync();
        break;
      }
      case 'trade': {
        const res = tradeAccept(this.state, this.data, this.state.floor, action.index);
        if (!res.ok) pushLog(this.state, res.message, 'warn');
        this.sync();
        break;
      }
      case 'travel': {
        const res = travelTo(this.state, this.data, action.floor);
        if (res.ok) {
          this.board.setFloor(this.state, this.data, this.state.floor);
          this.board.setHeroVisible(true);
          this.board.setHeroPos(this.state.pos.x, this.state.pos.y, false);
        } else {
          pushLog(this.state, res.message, 'warn');
        }
        this.sync();
        break;
      }
      case 'stop': {
        // 卡住时把 `explainStop` 的诊断也写进日志 —— 「走投无路」有四种成因，
        // 只报一句结论没法定位（与 sim.ts 的 STOP 分支同规）
        pushLog(this.state, `自动通关停下：${action.reason}`, 'warn');
        for (const line of explainStop(this.state, this.data).slice(0, 4)) {
          pushLog(this.state, `  ${line}`, 'warn');
        }
        this.stopAuto(action.reason);
        break;
      }
    }
  }

  // ── NPC 对话 ─────────────────────────────────────────────────────
  //
  // 「说哪一句」是引擎（`src/game/dialogue.ts`）算好的，这里只负责**编排**：
  // 补上「本层有没有摊子」这条功能引导、按职能给颜色、决定按钮给不给。

  private openDialogue(talk: NpcTalk): void {
    this.modal = 'dialogue';
    const role = npcRole(talk.id);
    // 剧情台词（事件的 `say` 算子）是**整段**：给什么画什么，不补功能脚注 ——
    // 「本层货品：…」这种话挂在一段伏击旁白下面只会让人出戏。
    const lines = talk.lines ?? [talk.text];

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
      hint:
        talk.from === 'story'
          ? '剧情'
          : talk.from === 'floor'
            ? '本层专说'
            : talk.from === 'greet'
              ? '初次见面'
              : '又见面了',
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

  // ── 计分视图 ──────────────────────────────────────────────────────
  //
  // 「每只怪 / NPC / 道具值多少分」在 headless 侧早就有眼睛（`--scores` 诊断），
  // 但那要求你先在脑子里把坐标对上。这一块把它搬到棋盘上：格子脚下直接写数，
  // 点一下给出算式。数据全部来自 `app/score-overlay.ts`（它又只用 `score.ts`）——
  // 界面上**不允许**出现第二套估价。

  private toggleScore(): void {
    const on = !this.board.scoreView;
    // 顺序要紧：先让棋盘把隐藏实体补出来（重建实体视图），再算分 ——
    // 否则第 14 层那颗埋在墙里的红钥匙拿不到徽标，而它恰恰是「该不该专程来拿」
    // 这件事的现场。
    this.board.setScoreView(this.state, this.data, on);
    this.toolbar.setScore(on);
    // 强制重算：签名没变不代表「这一批分已经在手上」
    this.scoreSig = null;
    pushLog(
      this.state,
      on
        ? '计分视图开启：每只怪 / NPC / 道具脚下显示自动通关算法的分数，点一下看算式。'
        : '计分视图关闭',
      'info'
    );
    this.sync();
    // 开的时候顺手把「本层最值得打的那个」摊开一次：光有一片数字，
    // 读的人不知道它们是按什么算的，而算式正是这个视图存在的意义。
    if (on) this.openScoreDialog(this.introTarget());
  }

  /**
   * 开视图时先看哪一个：**本层优先级最高的怪**。
   *
   * 挑怪而不是挑道具，是因为怪物分的算式分行最多（金币 / 守护 / 拦路 / 掉血），
   * 一次就能把「三种刻度、可正可负」这件事讲清楚；本层没有怪时退而取第一个。
   */
  private introTarget(): FloorScore | null {
    return this.scoreEntries.find((e) => e.type === 'monster') ?? this.scoreEntries[0] ?? null;
  }

  /** 点到的格子上有什么（用**已经算好的那一份**清单，保证与徽标上的数逐字一致） */
  private scoreAtCell(x: number, y: number): FloorScore | null {
    return this.scoreEntries.find((e) => e.x === x && e.y === y) ?? null;
  }

  private openScoreDialog(entry: FloorScore | null): void {
    this.modal = 'dialogue';
    if (!entry) {
      // 本层没有可计分的东西（楼梯口、空房间）—— 给一段说明而不是弹一块空白
      this.dialogue.open({
        name: '计分视图',
        role: { label: '说明', color: 0x64748b },
        lines: [
          '本层没有怪物 / NPC / 道具可分。',
          '棋盘上每一格脚下的小牌子，就是这个格子里的东西按自动通关算法值多少分。',
          '金色 = 道具分（血当量）、红色 = 怪物分（优先级）、绿色 = NPC 分（金币余量）。',
          '三种刻度不通用，只在同类内比大小；点任意一个目标看它的算式。'
        ],
        hint: '点目标看算式'
      });
      return;
    }
    this.dialogue.open({
      name: scoreName(this.data, entry),
      role: scoreRole(entry),
      lines: scoreExplain(entry),
      hint: '点目标看算式'
    });
  }

  /**
   * 分数随局面重算 —— 由 `sync()` 每步调用。
   *
   * 两个输入：`board.scoreView`（开着吗）与 `scoreSig`（局面变了吗）。
   * 只在两者都成立时才算，且算完的**同一份**清单同时喂给徽标与点击明细。
   */
  private syncScores(): void {
    if (!this.board.scoreView) {
      if (this.scoreEntries.length) {
        this.scoreEntries = [];
        this.scoreBadges = [];
        this.board.setScoreBadges([]);
      }
      return;
    }
    const sig = this.scoreSignature();
    if (sig === this.scoreSig) return;
    this.scoreSig = sig;
    this.scoreEntries = scoreList(this.state, this.data, this.displayFloor);
    this.scoreBadges = badgesOf(this.scoreEntries);
    this.board.setScoreBadges(this.scoreBadges);
  }

  /**
   * 「这一批分是按什么局面算的」。
   *
   * ⚠️ 少列一项的症状是**静默的**：徽标不刷新，而界面看起来一切正常
   * （数字还在那儿，只是已经过期）。所以宁可多列：三围、金币、钥匙、
   * 被动、已清理实体数、地形覆盖、换怪表、事件生成的楼梯、显示层与勇者坐标
   * —— 后面几样看着与估价无关，但它们决定**哪些东西还在、路通不通**，
   * 而 `blockingMonsters` / `reachCosts` 正是读这些的。
   */
  private scoreSignature(): string {
    const s = this.state;
    return [
      this.displayFloor,
      s.pos.x,
      s.pos.y,
      s.hp,
      s.atk,
      s.def,
      s.gold,
      s.buyTimes,
      s.keys.yellowKey,
      s.keys.blueKey,
      s.keys.redKey,
      s.passives.join(','),
      s.removed.size,
      Object.keys(s.terrainPatch[this.displayFloor] ?? {}).length,
      Object.keys(s.monsterSwap).length,
      s.extraStairs.length
    ].join('|');
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
    // 静默停（`null`）：重开是新的一局，日志里不该留一句上一局的「自动通关已停止」
    this.stopAuto(null);
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
    // 计分视图与底部读数都属于**这一局**：重开必须一起归零，
    // 否则新的一局一上来就顶着一堆上一局的数字 —— 而那比没有数字更坏
    // （它会**看起来是对的**）。
    this.board.setScoreView(this.state, this.data, false);
    this.toolbar.setScore(false);
    this.scoreEntries = [];
    this.scoreBadges = [];
    this.scoreSig = null;
    this.autoTicks = 0;
    this.autoRan = false;
    // 同一族的「属于这一局」的状态：重开后这一局没套过测试起手
    this.autoLoadoutApplied = false;
    this.cycleSeen.clear();
    this.toolbar.setBrowsing(false, this.state.floor);
    this.toolbar.setAuto(false);
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
    // 计分徽标要**跟着实体走**：`refresh()` 会把被打死的怪、被拿走的道具
    // 从实体视图里摘掉，所以这一步必须排在它后面（`syncScores` 里的
    // `setScoreBadges` 会按新的实体视图重摆一遍）。
    this.syncScores();
    this.status.update(this.state, this.data, this.displayFloor, this.browseFloor !== null);
    this.refreshDetail();
    this.itemBar.update(this.state, this.data);
    this.syncRunStrip();
    if (this.state.dead && this.deathLayer.children.length === 0) this.showDeath();
  }

  /**
   * 底部读数条 —— 「自动跑过没有」决定显不显示，不是「正在跑」。
   *
   * 理由见 `autoRan` 的注释：自动通关自己判定走投无路停下时，
   * 玩家正要读这个数。
   */
  private syncRunStrip(): void {
    const show = this.auto !== null || this.autoRan;
    this.runStrip.update(
      show
        ? {
            steps: this.autoTicks,
            floor: this.state.floor,
            x: this.state.pos.x,
            y: this.state.pos.y,
            hp: this.state.hp,
            atk: this.state.atk,
            def: this.state.def,
            running: this.auto !== null
          }
        : null
    );
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

  /** 阵亡遮罩（实现在 `death-overlay.ts`）—— 只在这里决定「重开要做什么」 */
  private showDeath(): void {
    buildDeathOverlay(
      this.deathLayer,
      { floor: this.state.floor, steps: this.state.stats.steps, kills: this.state.stats.kills },
      () => this.restart()
    );
  }
}
