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
 * 画布按设计尺寸 420×780 布局，再整体缩放到窗口：
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
  useItem
} from './game/engine';
import { Board } from './render/board';
import { loadAtlas } from './render/atlas';
import {
  DetailPanel,
  FloorPanel,
  ItemBar,
  LAYOUT,
  LogStrip,
  StatusBar,
  Toolbar,
  label,
  type BattleLike,
  type DetailTarget
} from './render/hud';
import { MerchantPanel, ShopPanel } from './render/trade';
import { T } from './render/theme';

interface Cell {
  x: number;
  y: number;
}

export class Game {
  private data: GameData;
  private state: GameState;
  private app: Application;
  private root = new Container();
  private board: Board;
  private status: StatusBar;
  private detail: DetailPanel;
  private itemBar: ItemBar;
  private log: LogStrip;
  private toolbar: Toolbar;
  private floorPanel: FloorPanel;
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
   * 非 null 表示有交易浮层开着。
   * 它和 browseFloor 是两种不同的「暂停」：浏览只是换显示，浮层则连输入都要断掉。
   */
  private modal: 'merchant' | 'shop' | null = null;

  private constructor(app: Application, data: GameData) {
    this.app = app;
    this.data = data;
    this.state = createInitialState(data);
    pushLog(this.state, '踏上魔塔第 1 层。方向键 / WASD 移动，撞向怪物即攻击。', 'floor');

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
    this.log = new LogStrip();
    this.toolbar = new Toolbar({
      onToggleReveal: () => this.toggleReveal(),
      onBrowse: () => this.openFloorPanel('browse'),
      onRestart: () => this.restart()
    });
    this.floorPanel = new FloorPanel(this.data, (f) => this.onFloorPicked(f), () => this.closeFloorPanel());
    this.merchantPanel = new MerchantPanel(
      this.data,
      (i) => this.onTrade(i),
      () => this.closeModal()
    );
    this.shopPanel = new ShopPanel(
      (s) => this.onShopBuy(s),
      () => this.closeModal()
    );

    // 顺序即层序：两个交易浮层必须排在棋盘与 HUD 之后，遮罩才挡得住下层点击
    this.root.addChild(
      this.status,
      this.board,
      this.toolbar,
      this.detail,
      this.itemBar,
      this.log,
      this.floorPanel,
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
      background: T.canvasBg,
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

  /** 把 420×780 的设计稿等比缩放居中 */
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
      // 渲染器信息：小游戏端要确认拿到的**不是**降级后的 CanvasRenderer。
      //
      // ⚠️ 这里返回**名字**，而不是 `renderer.type` 的原始数字，是踩过之后的决定：
      // `RendererType` 是数字枚举（WEBGL=1 / WEBGPU=2 / BOTH=3 / CANVAS=4），
      // 而 `1` 看起来太像「某种布尔或序号」—— 实测中就被读成了
      // 「不是 webgl，而是 1（某个简化渲染器）」，白白怀疑了半天。
      // 换成名字后，`=== 'webgl'` 这个断言不需要任何额外解释。
      rendererType: RendererType[this.app.renderer.type]?.toLowerCase() ?? `unknown(${this.app.renderer.type})`,
      resolution: this.app.renderer.resolution,
      screen: { w: this.app.renderer.width, h: this.app.renderer.height }
    };
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
    } else {
      this.board.setHeroPos(this.state.pos.x, this.state.pos.y, res.moved);
    }
    // 撞上怪物就挥一剑 —— 图集里的挥剑帧否则就是死素材
    if (res.kind === 'battle') this.board.playHeroAttack();
    this.sync();
    // 引擎只「请求」打开界面，具体开哪块面板由编排层决定
    if (res.openUi === 'merchant') this.openMerchant();
    else if (res.openUi === 'shop') this.openShop();
    return res.kind;
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
    this.modal = null;
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
    this.floorPanel.open(this.state, mode);
  }

  private closeFloorPanel(): void {
    const wasBrowsing = this.browseFloor !== null;
    this.floorPanel.close();
    if (wasBrowsing) {
      this.browseFloor = null;
      this.board.setFloor(this.state, this.data, this.state.floor);
      this.board.setHeroVisible(true);
      this.board.setHeroPos(this.state.pos.x, this.state.pos.y, false);
      this.hoverTarget = { kind: 'none' };
    }
    this.sync();
  }

  private onFloorPicked(f: number): void {
    const mode = this.floorPanel.mode;
    this.floorPanel.close();

    if (mode === 'teleport' && f !== this.state.floor && this.state.visited.includes(f)) {
      const res = travelTo(this.state, this.data, f);
      if (res.ok) {
        this.browseFloor = null;
        this.board.setFloor(this.state, this.data, this.state.floor);
        this.board.setHeroVisible(true);
        this.sync();
        return;
      }
      pushLog(this.state, res.message, 'warn');
    }

    // 浏览模式：只切显示，勇者留在原地
    this.browseFloor = f;
    this.board.setHeroVisible(false);
    this.board.setFloor(this.state, this.data, f);
    pushLog(this.state, `浏览第 ${f} 层（勇者仍在第 ${this.state.floor} 层，按 Esc 返回）`, 'info');
    this.sync();
  }

  private restart(): void {
    this.state = createInitialState(this.data);
    this.browseFloor = null;
    this.walking = false;
    this.modal = null;
    this.merchantPanel.close();
    this.shopPanel.close();
    this.hoverTarget = { kind: 'none' };
    this.deathLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.toolbar.revealPill.setActive(false);
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
    this.board.refresh(this.state, this.data);
    this.board.update(0, this.state);
    this.status.update(this.state, this.data, this.displayFloor, this.browseFloor !== null);
    this.refreshDetail();
    this.itemBar.update(this.state, this.data);
    this.log.update(this.state);
    if (this.state.dead && this.deathLayer.children.length === 0) this.showDeath();
  }

  private showDeath(): void {
    const g = new Graphics();
    g.rect(0, 0, LAYOUT.W, LAYOUT.H).fill({ color: 0x0f172a, alpha: 0.55 });
    g.eventMode = 'static';
    g.hitArea = new Rectangle(0, 0, LAYOUT.W, LAYOUT.H);
    this.deathLayer.addChild(g);

    const px = 60;
    const py = 296;
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
