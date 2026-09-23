/**
 * 棋盘渲染 —— 11×11 网格的地形层 + 实体层 + 勇者层。
 *
 * 分层约定：
 *   terrain  地面铺底 + 每格一张地形贴图，只在「地形被改变」时重画（开门、挖墙、地震卷轴）
 *   entities 怪物 / 道具 / NPC，换层或实体被移除时重建
 *   hero     单独一层，带插值动画与朝向
 *   overlay  悬停与选中高亮
 *
 * 每只怪物脚下有一块**可行性名牌**：底色直接来自 core/combat.mjs 的 grade()，
 * 绿=可打、黄=损失偏大、红=致命、紫=打不动。
 * 这是原版「数值门」体验的核心信息，放在地图上比藏在面板里有用得多。
 * 底色与名字合成同一个元素 —— 网格只有 32px，塞不下「精灵 + 指示灯 + 名牌」三样，
 * 详见 makeEntityView 里那段注释。
 *
 * ── 关于素材 ──────────────────────────────────────────────────────
 * 有图集就走精灵（`atlas.ready` 为 true），没有就整层退回 `icons.ts` 的程序化
 * 矢量图形。两条路径**共用同一套布局常量与同一个等级指示灯**，所以即使回退，
 * 玩法信息也不会少。
 *
 * ── 这个目录里为什么四块东西是分开的 ──────────────────────────────
 *
 * 原先这里是**一个 1135 行的 `board.ts`**。切出去的三块都有一个共同特征：
 * **它们不需要 `this`** —— 纯函数或纯类型，可以脱离棋盘单独读、单独验。
 *
 *   types.ts   Facing / EntityView / BoardHooks —— 「棋盘对外承诺了什么」
 *   bob.ts     待机呼吸（一件被反复微调过三次的规则，值得单独一页）
 *   attack.ts  挥剑的帧推进与时间轴特效（同样全是 t 的确定函数）
 *
 * 留下的这一页是**真的在画东西**的部分：塔壁、地砖、实体精灵、勇者层。
 * 判断标准同 `app/`：**搬出去之后它还需不需要 `this`**。
 */

import { Container, Graphics, Rectangle, Sprite, Texture, TilingSprite } from 'pixi.js';
import type { GameData } from '../../data';
import { tileAt, type GameState } from '../../game/state';
import { atlas, fitSize, isWallChar, terrainKeyFor, variantIndex } from '../atlas';
import {
  drawHero,
  drawItemGlyph,
  drawMonsterBody,
  drawNpcFallback,
  drawTerrain,
  itemCategoryOf,
  itemColorOf
} from '../icons';
import { STONE, T, UI, monsterPalette, npcRole } from '../theme';
import { LAYOUT } from '../hud';
import { ATTACK_MS, attackFrameIdx, drawAttackFx } from './attack';
import { MONSTER_BOB_MS, NPC_BOB_MS, bobPhase, bobPx } from './bob';
import type { BoardHooks, EntityView, Facing } from './types';

/** 每步走路前进一帧：一步一格 = 一个完整步态循环 */
const WALK_FRAMES = 4;

/**
 * NPC 落屏造型 —— 分两层，缺一不可：
 *
 * 1. **精灵本身按职能各不相同**（图集里的 npc.<id>，由 `tools/assetlib/npc.py` 的
 *    `NPC_ART` 手绘）。之前 6 个 NPC 是同一张图换色，剪影完全一样，
 *    在地图上一眼看不出「这个人是卖东西的还是给情报的」。
 * 2. **脚下名牌用职能色**（theme.ts 的 NPC_ROLE，与对话框的职能章同源）。
 *    名字只取前两个字，但颜色与职能章一致 —— 玩家在对话框里认出「金色=交易」之后，
 *    回到地图上还能靠颜色继续认人。
 */

export class Board extends Container {
  readonly cellPx: number;
  readonly span: number;

  private hooks: BoardHooks;
  private parapetLayer = new Container();
  /** 塔壁用的砖纹贴图（与地图内墙同一张，供 `__wallSources()` 断言同源） */
  private parapetTex: Texture | null = null;
  private terrainLayer = new Container();
  private entityLayer = new Container();
  private overlay = new Graphics();
  private heroLayer = new Container();

  /** 地面铺底：整块棋盘一张平铺图，让圆角门的透明角落下面有地砖而不是白面板 */
  // （直接挂在 terrainLayer 上，不另存引用）

  private terrainGfx: (Graphics | null)[] = [];
  private terrainSprites: (Sprite | null)[] = [];
  /** 每格当前「已画出的地形键」——存键而不是字符，因为带邻域信息的墙顶边也参与比较 */
  private terrainKeys: string[] = [];
  private entityViews: EntityView[] = [];

  private heroNode = new Container();
  /**
   * 前冲位移层 —— 夹在 `heroNode`（格子基准位）与精灵之间。
   *
   * 为什么要多一层容器，而不是直接改 `heroNode.x/y`：
   * 同一个 `heroNode.x/y` 还被两处写 —— `placeHero()`（换层/瞬移）和
   * `update()` 里的走路插值。攻击特效若也去写它，收招时就得「还原」，
   * 而还原到哪个值取决于上一帧是谁写的 —— 走路跳到一半收招的话，人会瞬移。
   * 拆成两层之后，基准位归走位管，前冲只动内层，两边互不干扰。
   */
  private heroLunge = new Container();
  private heroSprite: Sprite | null = null;
  /**
   * 挥剑动画的特效层 —— 画在勇者**之上**，且**不**跟着前冲层走
   * （刀光打在目标格上，不该跟着人一起往前挪）。
   *
   * 攻击由两层表达：`refreshHeroTexture` 换挥剑帧（起手→举剑→收招），
   * 外加这一层的时间轴特效（前冲 + 刀光 + 命中火星）。这一层永远是空的或只有几条线。
   */
  private attackFx = new Graphics();
  private heroPos = { x: 0, y: 0 };
  private heroDir: Facing = 'down';
  private heroWalkFrame = 0;
  private heroAttackMs = 0;
  /**
   * 当前贴的是哪一帧挥剑图；**-1 表示贴的是走路帧**。
   * 只在 `refreshHeroTexture` 里写，所以它同时就是「精灵现在是什么造型」的答案
   * （`__hero()` 的 `anim` 直接读它，不另算一遍 —— 两处各算一次就会有两套真相）。
   */
  private heroAttackFrame = -1;
  private heroAnim = { active: false, fx: 0, fy: 0, tx: 0, ty: 0, t: 0 };

  private clock = 0;
  private hoverCell: { x: number; y: number } | null = null;
  private floorShown = -1;
  /** 编辑视图：显示埋在墙内的隐藏道具与实体清单 */
  revealHidden = false;

  constructor(cellPx: number, hooks: BoardHooks = {}) {
    super();
    this.cellPx = cellPx;
    this.span = cellPx * 11;
    this.hooks = hooks;

    this.buildParapet();

    // 地砖的兜底底衬：服务圆角门/楼梯那类瓦片的透明角落。
    // 用石材的暗面而不是面板白 —— 塔壁围着的地面底下不该露出卡片色
    const bg = new Graphics();
    bg.roundRect(-2, -2, this.span + 4, this.span + 4, 6).fill(STONE.faceDark);

    this.addChild(this.parapetLayer, bg, this.terrainLayer, this.entityLayer, this.heroLayer, this.overlay);
    this.buildTerrain();
    this.buildHero();

    this.eventMode = 'static';
    this.hitArea = new Rectangle(0, 0, this.span, this.span);
    this.on('pointermove', (e) => {
      const p = e.getLocalPosition(this);
      const x = Math.floor(p.x / this.cellPx);
      const y = Math.floor(p.y / this.cellPx);
      if (x < 0 || y < 0 || x > 10 || y > 10) return;
      if (this.hoverCell && this.hoverCell.x === x && this.hoverCell.y === y) return;
      this.hoverCell = { x, y };
      this.hooks.onHover?.(x, y);
    });
    this.on('pointerleave', () => {
      this.hoverCell = null;
      this.overlay.clear();
      this.hooks.onHover?.(-1, -1);
    });
    this.on('pointertap', (e) => {
      const p = e.getLocalPosition(this);
      const x = Math.floor(p.x / this.cellPx);
      const y = Math.floor(p.y / this.cellPx);
      if (x < 0 || y < 0 || x > 10 || y > 10) return;
      this.hooks.onClick?.(x, y);
    });
  }

  /**
   * 棋盘外沿的塔壁：砖纹墙身 + 城垛 + 内缘阴影。
   *
   * 它只作为场景装饰存在，不参与玩法：不占 11×11 格子、不接收点击
   * （Board 的 hitArea 仍是 0,0,span,span）、放在最底层不遮挡任何东西。
   *
   * ## 为什么这一版把旧的「外檐」整个换掉了
   *
   * 旧版是**冷灰蓝**（T.wall / T.wallDark）的纯色几何体：墙身一块灰、城垛
   * 深浅交替、左右两列砖块。而地图内部是暖砂石地砖 + 暖褐砖墙（素材
   * `terrain.png` 的 floor_1 / wall_mid）—— 一边冷一边暖，看着就像围着地图
   * 后期贴了一圈框，「周边的墙」和「地图的风格」是两套东西。
   *
   * 现在改成**直接用地图那面墙的贴图平铺**（`atlas.terrain('1')`，
   * 与地图内墙同贴图、同像素倍数），再叠明暗与城垛。于是「风格一致」
   * 不再是调一个相近的颜色，而是字面意义上的同一张图。
   *
   * ## 尺寸必须来自 LAYOUT.parapet
   *
   * 壁厚与城垛高是**版面的一部分**（塔壁画在格子区之外，向上还要多占一个
   * 城垛的高度）。旧版这里写死 `o = 14 / topH = 10` 而 LAYOUT 只记了格子区，
   * 于是版面算出的「间隙 20」在屏幕上实际是 −4：城垛压在状态卡上，
   * 而看单个文件都发现不了。
   */
  private buildParapet(): void {
    const span = this.span;
    const { t: o, merlon: m } = LAYOUT.parapet;
    const boxW = span + o * 2;

    // 塔壁的圆角语言与卡片一致（UI.radiusInner）—— 一块方角的石框摆在
    // 一堆圆角卡片中间，会显得是两套东西；轻微圆角既保住石墙感，又接上版式。
    const corner = UI.radiusInner;

    // 以下三层共用同一个圆角轮廓，所以装进一个容器统一做遮罩：
    // 贴图是平铺的矩形，光靠 roundRect 画不出圆角，只能裁。
    const wall = new Container();

    // ① 墙身底色（图集缺席时的兜底；图集就位时被 ② 的贴图盖住）
    const base = new Graphics();
    base.roundRect(-o, -o, boxW, boxW, corner).fill(STONE.face);
    wall.addChild(base);

    // ② 墙身贴图：与地图内墙同一张图、同一个像素倍数（16px 贴图 → 32px）
    const wallTex = atlas.ready ? atlas.terrain('1') : null;
    if (wallTex) {
      const ts = new TilingSprite({ texture: wallTex, width: boxW, height: boxW });
      ts.x = -o;
      ts.y = -o;
      ts.tileScale.set(this.cellPx / wallTex.width);
      this.parapetTex = wallTex;
      wall.addChild(ts);
    }

    // ③ 明暗：整体罩一层暖色（把贴图从「地牢暗褐」提到「外墙」），
    //    再上亮下暗压出体积
    const shade = new Graphics();
    shade.rect(-o, -o, boxW, boxW).fill({ color: STONE.face, alpha: 0.24 });
    for (let i = 0; i < 6; i++) {
      const t = i / 6;
      shade
        .rect(-o, -o + (boxW / 6) * i, boxW, boxW / 6 + 1)
        .fill({ color: STONE.faceDark, alpha: 0.04 + t * 0.15 });
    }
    shade.rect(-o, -o, boxW, 10).fill({ color: STONE.faceLit, alpha: 0.18 });
    // 座脚：底边一条更暗的影，让塔壁"落"在地上
    shade.rect(-o, span + o - 9, boxW, 9).fill({ color: STONE.edge, alpha: 0.32 });
    wall.addChild(shade);

    // ⑤ 内缘阴影：贴着棋盘一圈由深到浅的暗环，让地图"嵌"进塔壁而不是浮在墙上
    const inner = new Graphics();
    for (let i = 0; i < 3; i++) {
      const d = i + 1;
      inner
        .rect(-d, -d, span + d * 2, span + d * 2)
        .stroke({ width: 1, color: STONE.inner, alpha: 0.34 * (1 - i / 3) });
    }
    wall.addChild(inner);

    // 遮罩：与墙身同轮廓的圆角矩形。Mask 必须自己也在显示树上
    // （Pixi 拿它做 stencil），所以挂在 parapetLayer 上而不是 wall 里面 ——
    // 放进被遮罩的容器里会形成自我引用。
    const mask = new Graphics();
    mask.roundRect(-o, -o, boxW, boxW, corner).fill(0xffffff);
    this.parapetLayer.addChild(mask);
    wall.mask = mask;
    this.parapetLayer.addChild(wall);

    // ④ 城垛：宽度均分 11 段与内部列对齐，偶数段凸起。
    //    奇数段**什么都不画** —— 凹口是要透出背景星空的，画成"矮墙"就没了这层意思。
    //
    //    ⚠️ 城垛在遮罩轮廓**之外**（它画在 -o 往上），所以不能放进 `wall`：
    //    放进去会被圆角矩形裁掉，垛口变成平的。
    const merlons = new Graphics();
    const topW = boxW / 11;
    for (let i = 0; i < 11; i++) {
      if (i % 2 === 1) continue;
      const x = -o + i * topW;
      merlons.roundRect(x, -o - m, topW, m + 2, 2).fill(STONE.face);
      merlons.rect(x + 1, -o - m, topW - 2, 2).fill(STONE.top);
      merlons.rect(x, -o - 1.5, topW, 1.5).fill({ color: STONE.edge, alpha: 0.4 });
    }
    this.parapetLayer.addChild(merlons);

    // ⑥ 外缘描边：塔壁与夜色的交界（画在遮罩之外，才能保住 2px 的完整描边）
    const edge = new Graphics();
    edge.roundRect(-o, -o, boxW, boxW, corner).stroke({ width: 2, color: STONE.edge, alpha: 0.85 });
    this.parapetLayer.addChild(edge);
  }

  private buildTerrain(): void {
    if (atlas.ready) {
      const tex = atlas.floor;
      if (tex) {
        const ft = new TilingSprite({ texture: tex, width: this.span, height: this.span });
        // 素材 16px → 格子 32px：整数倍，像素画才不会被插值糊掉
        ft.tileScale.set(this.cellPx / tex.width);
        // 这一层现在只服务一件事：**门/楼梯那类圆角瓦片的透明角落**。
        // 地面格自己已经压了一张变体贴图（见 paintCell），不再靠它铺底。
        this.terrainLayer.addChild(ft);
      }
    }

    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 11; x++) {
        if (atlas.ready) {
          const sp = new Sprite();
          sp.x = x * this.cellPx;
          sp.y = y * this.cellPx;
          sp.width = this.cellPx;
          sp.height = this.cellPx;
          sp.visible = false;
          this.terrainLayer.addChild(sp);
          this.terrainSprites.push(sp);
          this.terrainGfx.push(null);
        } else {
          const g = new Graphics();
          this.terrainLayer.addChild(g);
          this.terrainGfx.push(g);
          this.terrainSprites.push(null);
        }
        this.terrainKeys.push('');
      }
    }
  }

  /**
   * 取本格的兜底 Graphics，按需创建。
   *
   * 不能在构造时先建好 121 个：图集路径下它们用不到，而**没挂到显示树上的
   * Graphics 画了也不会显示** —— 那样一旦某个地形键在 MANIFEST 里找不到贴图，
   * 兜底就会静默画在孤儿节点上，格子直接空掉。
   */
  private fallbackGfx(idx: number): Graphics {
    let g = this.terrainGfx[idx];
    if (!g) {
      g = new Graphics();
      this.terrainLayer.addChild(g);
      this.terrainGfx[idx] = g;
    }
    return g;
  }

  private buildHero(): void {
    this.heroNode.addChild(this.heroLunge);
    const tex = atlas.ready ? atlas.heroFrame('walk', this.heroDir, 0) : null;
    if (tex) {
      const sp = new Sprite(tex);
      const s = atlas.actorScale;
      sp.anchor.set(0.5, 1); // 底部居中：俯视游戏里精灵要「脚踩格子下沿」才站得住
      sp.x = this.cellPx / 2;
      sp.y = this.cellPx;
      sp.width = tex.width * s;
      sp.height = tex.height * s;
      this.heroSprite = sp;
      this.heroLunge.addChild(sp);
    } else {
      const g = new Graphics();
      const r = this.cellPx * 0.36;
      drawHero(g, this.cellPx / 2, this.cellPx / 2, r);
      this.heroLunge.addChild(g);
    }
    this.heroLayer.addChild(this.heroNode, this.attackFx);
  }

  /**
   * 校验用：塔壁砖纹与地图内墙是否**来自同一张素材**。
   *
   * 「周边的墙和地图的风格一致」有两种做法：调一个相近的颜色（看着像，
   * 换个人调色就散了），或者干脆用同一张图（结构上一致，不可能散）。
   * 这里走的是后者，所以断言也按后者写：比较两张 Texture 的 `source`
   * （base texture）—— source 相同，就意味着它们真的是同一张图上的像素，
   * 而不是"两个恰好接近的颜色"。
   *
   * 传回 null 表示图集没加载（程序化兜底路径），那时这条断言无从谈起。
   */
  __wallSources(): { parapet: number | null; inner: number | null } {
    const inner = atlas.ready ? atlas.terrainVariant('1', 0) : null;
    return {
      parapet: this.parapetTex ? this.parapetTex.source.uid : null,
      inner: inner ? inner.source.uid : null
    };
  }

  /**
   * 校验用：把棋子上**真正落屏**的精灵报出来（纹理来源 uid + 帧矩形）。
   *
   * 存在的理由：所有实体都是「图集就绪就用精灵，否则退回 `icons.ts` 的程序化图形」。
   * 于是「某只怪悄悄退回了程序化图形」在截图上几乎看不出来 —— 形状相近、色系也接近，
   * 肉眼比对不可靠。但 `source.uid` 是**同一性**，一比就知道。
   *
   * 这一条对本轮的 13 只手绘怪物尤其关键：它们的存在意义就是「换掉与名字不符的素材」，
   * 一旦退回程序化图形，等于这轮改动白做，而画面看起来「还好」。
   *
   * `uid` 为 null 表示该格走的是程序化兜底（没有精灵）。
   */
  __sprites(): Array<{
    key: string;
    x: number;
    y: number;
    kind: 'monster' | 'npc' | 'item';
    id: string | null;
    uid: number | null;
    frame: { x: number; y: number; w: number; h: number } | null;
    /** 精灵当前的 y（含呼吸位移） */
    spriteY: number | null;
    /** 精灵落屏高度。呼吸只许位移、不许改这个值 —— 见 verify-visual 的 A20 */
    spriteH: number | null;
  }> {
    return this.entityViews.map((v) => {
      const sp = v.sprite ?? null;
      const f = sp ? sp.texture.frame : null;
      return {
        key: v.key,
        x: v.x,
        y: v.y,
        kind: v.monsterId ? 'monster' : v.npcId ? 'npc' : 'item',
        id: v.monsterId ?? v.npcId ?? v.itemId ?? null,
        uid: sp ? sp.texture.source.uid : null,
        frame: f
          ? { x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.width), h: Math.round(f.height) }
          : null,
        spriteY: sp ? sp.y : null,
        spriteH: sp ? sp.height : null
      };
    });
  }

  /** 换层：重建地形与实体 */
  setFloor(state: GameState, data: GameData, floor: number): void {
    this.floorShown = floor;
    const chs = this.readChars(state, data, floor);
    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 11; x++) this.paintCell(x, y, chs);
    }
    this.rebuildEntities(state, data, floor);
    this.heroPos = { x: state.pos.x, y: state.pos.y };
    this.heroAnim.active = false;
    // 换层要把挥剑动画一并掐断：残留的 heroAttackMs 会在新画面上画出一刀空砍
    this.heroAttackMs = 0;
    this.heroWalkFrame = 0;
    this.refreshHeroTexture();
    this.placeHero();
    this.drawAttackFx();
  }

  /** 把 11×11 的地形字符读成一张表（已应用 terrainPatch 覆盖层） */
  private readChars(state: GameState, data: GameData, floor: number): string[] {
    const chs: string[] = new Array(121);
    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 11; x++) chs[y * 11 + x] = tileAt(state, data, floor, x, y);
    }
    return chs;
  }

  /**
   * 同层刷新：只重画变化的地形格，并同步实体增删。
   *
   * ⚠️ 这里必须用 `this.floorShown` 而不是 `state.floor`：
   * 「楼层浏览」模式下显示的层与勇者所在层不同，用 state.floor 会把画面立刻拽回去。
   */
  refresh(state: GameState, data: GameData): void {
    const floor = this.floorShown;
    if (floor < 0) {
      this.setFloor(state, data, state.floor);
      return;
    }
    const chs = this.readChars(state, data, floor);
    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 11; x++) this.paintCell(x, y, chs);
    }
    this.syncEntities(state, data, floor);
  }

  /**
   * 画一格地形。`chs` 是整张字符表 —— 墙的顶边变体要看正上方那格，
   * 所以不能只传本格字符。
   *
   * 比较的是「地形键 + 变体号」而不是字符：挖开一面墙会让**下面**那格从墙身变成
   * 带压顶的顶边，字符没变、键变了，只有比键才能重画到它。
   * 变体号也必须进签名，否则换层时同一格会留着上一层的变体不更新。
   */
  private paintCell(x: number, y: number, chs: string[]): void {
    const idx = y * 11 + x;
    const ch = chs[idx];
    // y === 0 时棋盘外面没有格子，不能去问邻格（越界查询会返回「墙」，把顶边判反）
    const wallAbove = y > 0 && isWallChar(chs[(y - 1) * 11 + x]);
    const key = terrainKeyFor(ch, wallAbove);
    const vi = key === null ? 0 : variantIndex(x, y, this.floorShown, atlas.terrainVariantCount(key));
    const sig = key === null ? `?${ch}` : `${key}#${vi}`;
    if (sig === this.terrainKeys[idx]) return;
    this.terrainKeys[idx] = sig;

    const sp = this.terrainSprites[idx];
    const drawFallback = () => {
      const g = this.fallbackGfx(idx);
      g.clear();
      drawTerrain(g, ch, x, y, this.cellPx);
    };

    if (sp && key !== null) {
      const tex = atlas.terrainVariant(key, vi);
      if (tex) {
        sp.texture = tex;
        sp.visible = true;
        return;
      }
      // MANIFEST 里有这个键但取不到贴图 —— 宁可退回程序化图形，也不能留空格
      sp.visible = false;
      drawFallback();
      return;
    }

    // 无图集（或该字符没映射）：整格交给程序化图形
    drawFallback();
  }

  private rebuildEntities(state: GameState, data: GameData, floor: number): void {
    this.entityLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.entityViews = [];
    this.syncEntities(state, data, floor);
  }

  private syncEntities(state: GameState, data: GameData, floor: number): void {
    const alive = new Set<string>();
    for (const e of data.floors.get(floor)!.entities) {
      const key = `${floor}:${e.x}:${e.y}:${e.type}:${e.id}`;
      if (state.removed.has(key)) continue;
      alive.add(key);
      if (this.entityViews.some((v) => v.key === key)) continue;
      if (e.hidden && !this.revealHidden) {
        // 隐藏实体仍占位，但不渲染 —— 标记成占位视图，开启编辑视图时再补画
        this.entityViews.push({ key, node: null, x: e.x, y: e.y });
        continue;
      }
      this.entityViews.push(this.makeEntityView(data, e.id, e.type, e.x, e.y, key));
    }
    // 清掉已不存在的
    for (const v of [...this.entityViews]) {
      if (alive.has(v.key)) continue;
      v.node?.destroy({ children: true });
      this.entityViews = this.entityViews.filter((s) => s !== v);
    }
    // 相位错开，别让满屏怪物同步呼吸（NPC 同理 —— 两个智者一起点头很出戏）。
    // 相位由 **key 散列**决定而不是数组下标 —— 理由见 bobPhase 的说明。
    this.entityViews.forEach((v) => {
      if ((v.monsterId || v.npcId) && v.phase === undefined) {
        v.phase = bobPhase(v.key, v.monsterId ? MONSTER_BOB_MS : NPC_BOB_MS);
      }
    });
  }

  private makeEntityView(
    data: GameData,
    id: string,
    type: string,
    x: number,
    y: number,
    key: string
  ): EntityView {
    const view: EntityView = { key, node: null, x, y };
    const c = new Container();
    c.x = x * this.cellPx;
    c.y = y * this.cellPx;
    const S = this.cellPx;
    const cx = S / 2;
    const cy = S / 2;
    const r = S * 0.34;

    if (type === 'monster') {
      const mon = data.monsters[id];
      if (!mon) return view;
      const pal = monsterPalette(id);
      view.monsterId = id;

      // 怪物**脚踩在格子下沿**（`standY = S`）。
      //
      // 这里原本把精灵整体抬高 10px（`standY = S - plateH - 1`，即 22），
      // 为的是在脚下腾出「战斗评级指示灯」的位置。2026-09-23 玩家要求
      // 「移除怪物脚底的点或者阴影」—— 指的正是那颗指示灯：它是 6×4 的
      // `roundRect`，颜色取 `shade(pal.body, -0.62)`（怪物主色的暗色），
      // 落在浅色地板上读起来就是「怪物脚底有块脏东西」，而不是「一个评级标记」。
      //
      // 点没了，抬高的理由也没了：精灵回到格底，格子被真正占满，
      // 待机呼吸的「抬起 1px」也才有「脚离地」的读法（原来脚下本来就悬空 10px，
      // 抬 1px 只是在一段空白里动，看不出呼吸）。
      //
      // 评级信息没有丢：它在 HUD 的战斗面板里（hud/ 用同一份 GRADE_STYLE）。
      const standY = S;

      const tex = atlas.ready ? atlas.monster(id, 'idle', 0) : null;
      if (tex) {
        const sp = new Sprite(tex);
        const s = atlas.monsterScale(id);
        sp.anchor.set(0.5, 1);
        sp.x = cx;
        sp.y = standY;
        sp.width = tex.width * s;
        sp.height = tex.height * s;
        view.sprite = sp;
        view.restY = standY;   // 呼吸位移的基准 —— 见 EntityView.restY
        c.addChild(sp);
      } else {
        const g = new Graphics();
        // 兜底图形与精灵同底（都是 standY = 格底），两条渲染路径的落点必须一致，
        // 否则「有图集」和「没图集」两种情况的怪物高度对不上
        drawMonsterBody(g, id, cx, cy, r * 0.92, pal.body);
        c.addChild(g);
      }

      // BOSS 圈 —— 两条渲染路径共用，玩法信息不因换素材而丢失。
      // `label` 是给断言用的：A5b 要靠它把「允许存在的唯一额外绘制物」和
      // 「不许再出现的脚下标记」区分开（生产构建会压缩类名，只能按 label 找）。
      const over = new Graphics();
      over.label = 'bossRing';
      if (mon.boss) {
        // BOSS 的记号是**脚下的一圈椭圆光环**，不是腰上的圆环。
        //
        // 原来是以格中心为圆心的 `circle(…, S * 0.44)`。BOSS 从 48px 长到
        // 64px（`tools/assetlib/config.py` 的 `BIG_SCALE`，经 MANIFEST 的 `drawScale`
        // 传下来）之后，格中心落在它**腰**上，
        // 落屏后读成「腰里套了个金箍」，而不是「这是个打不过的大块头」。
        // 光环属于**地面**：压住格底、横向铺开、纵向压扁（俯视透视）。
        // 宽高都按格子算，不随精灵高度漂 —— 换素材不会让它跑位。
        const rw = S * 0.9;
        const rh = Math.max(5, S * 0.24);
        over.ellipse(cx, S - rh / 2, rw / 2, rh / 2)
          .stroke({ width: 2, color: T.gold, alpha: 0.9 });
      }
      c.addChild(over);
    } else if (type === 'item') {
      const item = data.items[id];
      if (!item) return view;
      view.itemId = id;
      const tex = atlas.ready ? atlas.item(id) : null;
      if (tex) {
        const sp = new Sprite(tex);
        // 等比填充，留 2px 边距 —— 所有拾取物落屏大小一致，最好辨认。
        // 不能拉伸填满：剑是 40×84、药水是 64×64、金币是 32×32，拉平方会把剑压扁加宽。
        const box = S - 4;
        const size = fitSize(tex.width, tex.height, box);
        sp.anchor.set(0.5, 1);
        sp.x = cx;
        sp.y = S;
        sp.width = size.w;
        sp.height = size.h;
        c.addChild(sp);
      } else {
        const g = new Graphics();
        const cat = itemCategoryOf(id, item.name);
        const color = itemColorOf({ ...item, id });
        g.circle(cx, cy + S * 0.04, S * 0.4).fill({ color: 0xffffff, alpha: 0.72 });
        drawItemGlyph(g, cat, cx, cy, r, color);
        c.addChild(g);
      }
    } else {
      const role = npcRole(id);
      const npcTex = atlas.ready ? atlas.npcFrame(id, 'down', 0) : null;
      // NPC 的呼吸同样是**渲染层的刚体位移**（素材只有一帧静止图），
      // 与怪物共用下面那套相位错开的逻辑
      view.npcId = id;
      if (npcTex) {
        const sp = new Sprite(npcTex);
        const s = atlas.actorScale;
        sp.anchor.set(0.5, 1);
        sp.x = cx;
        sp.y = S;
        sp.width = npcTex.width * s;
        sp.height = npcTex.height * s;
        view.sprite = sp;
        view.restY = S;
        c.addChild(sp);
      } else {
        const g = new Graphics();
        // 兜底：程序化图形也按职能分工，不能退回「所有人一个样」
        drawNpcFallback(g, id, cx, cy, r, role.color);
        c.addChild(g);
      }
      // 脚下名牌：只用**职能色**，不写名字。
      // 名字在详情卡与对话框里都有；格子只有 32px，写名字会压到邻格，
      // 而颜色本身就能回答玩家唯一的问题 ——「这个人能干什么」。
      const plateH = Math.max(4, Math.round(S * 0.12));
      const plateW = Math.max(10, Math.round(S * 0.4));
      const plate = new Graphics();
      plate.label = 'npcPlate';
      plate
        .roundRect(Math.round(cx - plateW / 2), S - plateH - 2, plateW, plateH, plateH / 2)
        .fill(role.color);
      c.addChild(plate);
    }

    this.entityLayer.addChild(c);
    view.node = c;
    return view;
  }

  /** 编辑视图：把埋在墙内的武器显示出来 */
  setRevealHidden(state: GameState, data: GameData, on: boolean): void {
    this.revealHidden = on;
    this.rebuildEntities(state, data, state.floor);
  }

  setHeroPos(x: number, y: number, animate: boolean): void {
    const dx = x - this.heroPos.x;
    const dy = y - this.heroPos.y;
    if (dx !== 0 || dy !== 0) {
      // 每走一格前进一帧 —— 步态循环与移动距离对齐，比按时间推进更稳
      if (dx > 0) this.heroDir = 'right';
      else if (dx < 0) this.heroDir = 'left';
      else if (dy > 0) this.heroDir = 'down';
      else this.heroDir = 'up';
      this.heroWalkFrame = (this.heroWalkFrame + 1) % WALK_FRAMES;
    }

    if (!animate || (this.heroPos.x === x && this.heroPos.y === y)) {
      this.heroPos = { x, y };
      this.heroAnim.active = false;
      this.refreshHeroTexture();
      this.placeHero();
      return;
    }
    this.heroAnim = { active: true, fx: this.heroPos.x, fy: this.heroPos.y, tx: x, ty: y, t: 0 };
    this.heroPos = { x, y };
    this.refreshHeroTexture();
  }

  /**
   * 撞上怪物时播一次挥剑动画。
   *
   * `dir` 是**玩家按下的方向**，不是勇者当前朝向 —— 这两者在「撞」的时候恰好不同：
   * 撞墙/撞怪时勇者并没有移动，`setHeroPos` 里那段「按位移推朝向」根本不触发，
   * 于是不传方向的话，向右撞怪会朝着下方挥空。
   *
   * 不依赖图集：整套特效是程序化图形，图集缺席（走 `icons.ts` 兜底那条路）时
   * 同样打得出来 —— 攻击反馈属于玩法，不该是「锦上添花」。
   */
  playHeroAttack(dir?: Facing): void {
    if (dir) {
      this.heroDir = dir;
      // 转向是**换方向的走路帧**，尺寸与走路帧完全一致（都是 64×104 的帧、落屏 32×52）——
      // 这正是「攻击时形体不变」能成立的前提
      this.refreshHeroTexture();
    }
    this.heroAttackMs = ATTACK_MS;
  }

  /**
   * 勇者精灵贴图刷新 —— 走路用 `walk` 帧，挥剑期间换 `attack` 帧。
   *
   * ## 挥剑帧为什么一度被弃用，又为什么回来了
   *
   * 用户反馈过「攻击怪物时角色会变小」。当时的量法是（旧 ArMM 素材）：
   *
   * | | 实心身体行数 | 内容最低点 | 脚的位置 |
   * |---|---|---|---|
   * | 走路帧 | **20** 行（4..23） | 脚（第 23 行） | 贴格底 |
   * | attack[0] | 20 行（5..24） | 剑尖（第 25 行） | 抬高 1 行 |
   * | attack[2] / [3] | **17** 行（2..18） | **剑尖**（第 25 行） | **抬高 7 行** |
   *
   * ① 弓身突刺那一瞬的身体只有 17 行（走路的 85%），再忠实也会缩一圈；
   * ② 精灵是底部锚定的，而 attack 帧的内容最低点是**剑尖**不是脚，
   *    于是脚离地 7 行 × 2 倍 = 14px，人看着浮起来。
   *
   * 所以攻击反馈改由 `drawAttackFx()` 的时间轴特效表达，精灵不换帧。
   *
   * **2026-09-23：勇者改成手绘之后，那两条理由都不成立了**（重画时解剖表在自己手里，
   * 抬剑只改 y）。实测四向都是同一组数字：
   *
   * | | 实心行区间 | 行数 |
   * |---|---|---|
   * | walk[0] | (4, 23) | 20 |
   * | attack[0] / [3] | (4, 23) | 20 |
   * | attack[1] | (2, 23) | 22 |
   * | attack[2] | (0, 23) | 24 |
   *
   * **底行恒为 23**（脚不离地），行数的变化全部来自**向上伸的剑**。
   * 于是挥剑帧接回来了：`anim` 跟着 `attackFrameIdx()` 在两者之间切，
   * 而两套帧的画布尺寸相同（16×26），所以「不变小」这条依然由 A14 钉着。
   */
  private refreshHeroTexture(): void {
    if (!this.heroSprite) return;
    const fi = attackFrameIdx(this.heroAttackMs);
    // 记下来供 `__hero()` 报告「现在贴的是哪套帧」—— A14 靠它正面确认挥剑帧真的用上了
    this.heroAttackFrame = fi;
    const tex =
      fi >= 0
        ? atlas.heroFrame('attack', this.heroDir, fi)
        : atlas.heroFrame('walk', this.heroDir, this.heroWalkFrame);
    if (!tex) return;
    this.heroSprite.texture = tex;
    const s = atlas.actorScale;
    this.heroSprite.width = tex.width * s;
    this.heroSprite.height = tex.height * s;
    this.heroSprite.x = this.cellPx / 2;
    this.heroSprite.y = this.cellPx;
  }

  /** 挥剑特效（实现在 `attack.ts`）—— 这里只把棋盘当前的状态喂进去 */
  private drawAttackFx(): void {
    drawAttackFx(this.attackFx, {
      cellPx: this.cellPx,
      dir: this.heroDir,
      pos: this.heroPos,
      ms: this.heroAttackMs,
      lunge: this.heroLunge
    });
  }

  /** 浏览别的楼层时把勇者藏起来 —— 他并不在那里 */
  setHeroVisible(v: boolean): void {
    this.heroLayer.visible = v;
  }

  private placeHero(): void {
    this.heroNode.x = this.heroPos.x * this.cellPx;
    this.heroNode.y = this.heroPos.y * this.cellPx;
  }

  /** 由主循环驱动：勇者位置插值 + 怪物 idle 动画 + 悬停高亮 */
  update(dtMs: number, state: GameState): void {
    this.clock += dtMs;

    // 挥剑计时 + 画特效。计时归零那一帧也要走一次 drawAttackFx
    // （它负责把前冲层归位），所以不能写成 `if (heroAttackMs > 0)` 包住整段
    if (this.heroAttackMs > 0) this.heroAttackMs = Math.max(0, this.heroAttackMs - dtMs);
    // 挥剑帧推进。只在**帧号真的变了**时才换贴图 —— 每个 rAF 都重新赋一次
    // `sprite.texture`（哪怕指向同一个 Texture）纯属浪费。
    // 收招那一帧也必须走到这里：计时归零后 `attackFrameIdx()` 变 -1，
    // 贴图换回走路帧，否则勇者会定格在举剑造型上。
    if (attackFrameIdx(this.heroAttackMs) !== this.heroAttackFrame) this.refreshHeroTexture();
    this.drawAttackFx();

    if (this.heroAnim.active) {
      this.heroAnim.t = Math.min(1, this.heroAnim.t + dtMs / 130);
      const e = this.heroAnim.t;
      const ease = 1 - Math.pow(1 - e, 3);
      const cl = (a: number, b: number) => a + (b - a) * ease;
      this.heroNode.x = cl(this.heroAnim.fx, this.heroAnim.tx) * this.cellPx;
      this.heroNode.y = cl(this.heroAnim.fy, this.heroAnim.ty) * this.cellPx;
      if (e >= 1) this.heroAnim.active = false;
    }

    // 怪物 / NPC 的待机呼吸：**整只精灵的刚体位移**，不改任何贴图。
    //
    // 这里以前是「按相位换 4 帧贴图」，那 4 帧是素材层做出来的「上半身上移 1 行
    // + 腰上补一行」，换帧时读出来就是压缩感。现在素材只有 1 帧，
    // 呼吸 = 在基准 y 与「上抬 1px」之间往复 —— 像素形状全程恒定。
    // 完整理由与三次调参的演进见 `bob.ts`。
    for (const v of this.entityViews) {
      const sp = v.sprite;
      if (!sp || v.restY === undefined) continue;
      const up = bobPx(this.clock, v);
      const y = v.restY - up;
      if (sp.y !== y) sp.y = y;
    }

    this.overlay.clear();
    const s = this.cellPx;
    // 勇者脚下的定位框（浏览别的楼层时勇者不在这里，不画）
    if (this.heroLayer.visible) {
      this.overlay
        .roundRect(state.pos.x * s + 1, state.pos.y * s + 1, s - 2, s - 2, s * 0.16)
        .stroke({ width: 2, color: T.hero, alpha: 0.55 });
    }
    if (this.hoverCell) {
      const { x, y } = this.hoverCell;
      this.overlay
        .roundRect(x * s + 1, y * s + 1, s - 2, s - 2, s * 0.16)
        .stroke({ width: 2, color: T.select, alpha: 0.9 });
    }
  }

  /** 悬停格的中心点（世界坐标），用于浮层定位 */
  cellCenter(x: number, y: number): { x: number; y: number } {
    return { x: (x + 0.5) * this.cellPx, y: (y + 0.5) * this.cellPx };
  }

  /**
   * 校验用：勇者此刻的落屏状态。
   *
   * 「攻击时角色会变小」是**观感**问题，但它有可以量的代理量：
   * 精灵的贴图矩形与落屏宽高。只要这两样在攻击全程保持不变，
   * 「变小」在物理上就不可能发生 —— 所以断言量它们，不去争论好不好看。
   *
   * `fxBounds` 是特效层的实测包围盒：空图形是 0×0，画了东西就不是。
   * 用**渲染树算出来的**包围盒而不是「我记得我画了」的自报字段 ——
   * 自报只能证明代码跑到了那一行，证明不了真的有东西落在屏上。
   */
  __hero(): {
    dir: Facing;
    attacking: boolean;
    /** 当前贴的是哪套帧 —— 挥剑期间应为 'attack'（A14 正面确认挥剑帧真的用上了） */
    anim: 'walk' | 'attack';
    frame: { w: number; h: number } | null;
    size: { w: number; h: number } | null;
    lunge: { x: number; y: number };
    fxBounds: { x: number; y: number; w: number; h: number };
  } {
    const f = this.heroSprite?.texture.frame ?? null;
    const fx = this.attackFx.getBounds();
    return {
      dir: this.heroDir,
      attacking: this.heroAttackMs > 0,
      anim: this.heroAttackFrame >= 0 ? 'attack' : 'walk',
      frame: f ? { w: Math.round(f.width), h: Math.round(f.height) } : null,
      size: this.heroSprite
        ? { w: Math.round(this.heroSprite.width), h: Math.round(this.heroSprite.height) }
        : null,
      lunge: { x: this.heroLunge.x, y: this.heroLunge.y },
      fxBounds: {
        x: Math.round(fx.x),
        y: Math.round(fx.y),
        w: Math.round(fx.width),
        h: Math.round(fx.height)
      }
    };
  }

  get hovered(): { x: number; y: number } | null {
    return this.hoverCell;
  }
}
