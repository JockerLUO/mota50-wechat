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
 */

import { Container, Graphics, Rectangle, Sprite, Texture, TilingSprite } from 'pixi.js';
import type { GameData } from '../data';
import { tileAt, type GameState } from '../game/state';
import { atlas, fitSize, isWallChar, terrainKeyFor, variantIndex } from './atlas';
import {
  drawHero,
  drawItemGlyph,
  drawMonsterBody,
  drawNpcFallback,
  drawTerrain,
  itemCategoryOf,
  itemColorOf,
  shade
} from './icons';
import { GRADE_STYLE, STONE, T, UI, monsterPalette, npcRole } from './theme';
import { LAYOUT } from './hud';

/**
 * NPC 落屏造型 —— 分两层，缺一不可：
 *
 * 1. **精灵本身按职能各不相同**（图集里的 npc.<id>，由 tools/build-assets.py 的
 *    NPC_ART 手绘）。之前 6 个 NPC 是同一张图换色，剪影完全一样，
 *    在地图上一眼看不出「这个人是卖东西的还是给情报的」。
 * 2. **脚下名牌用职能色**（theme.ts 的 NPC_ROLE，与对话框的职能章同源）。
 *    名字只取前两个字，但颜色与职能章一致 —— 玩家在对话框里认出「金色=交易」之后，
 *    回到地图上还能靠颜色继续认人。
 */

/** 怪物 idle 动画每帧时长（ms）。四帧一轮 ≈ 0.7s，慢到不抢注意力 */
const MONSTER_FRAME_MS = 170;
/** 勇者挥剑动画总时长（ms） */
const ATTACK_MS = 300;
/** 每步走路前进一帧：一步一格 = 一个完整步态循环 */
const WALK_FRAMES = 4;
/** NPC 静帧呼吸每帧时长（ms）。比怪物慢一倍 —— 站着的人不该动得像喘气 */
const NPC_FRAME_MS = 340;

/** 勇者朝向名，与 MANIFEST 的 dirOrder 一致 */
type Facing = 'down' | 'left' | 'up' | 'right';

interface EntityView {
  key: string;
  node: Container | null;
  x: number;
  y: number;
  /** 有值表示这格是怪物，参与 idle 动画 */
  monsterId?: string;
  /** 有值表示这格是 NPC，参与呼吸动画 */
  npcId?: string;
  /** 有值表示这格是道具（`__sprites()` 用它报出「这一格是什么」） */
  itemId?: string;
  sprite?: Sprite;
  /** 每只怪物错开一点相位，否则满屏怪物同步呼吸，像一个人在动 */
  phase?: number;
  frameIdx?: number;
}

export interface BoardHooks {
  /** 悬停到某格；null 表示移出 */
  onHover?: (x: number, y: number) => void;
  onClick?: (x: number, y: number) => void;
  /** 返回该怪物当前战斗评级，用于右上角指示灯 */
  gradeFor?: (monId: string) => string | null;
}

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
  private heroSprite: Sprite | null = null;
  private heroPos = { x: 0, y: 0 };
  private heroDir: Facing = 'down';
  private heroWalkFrame = 0;
  private heroAttackMs = 0;
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
      this.heroNode.addChild(sp);
    } else {
      const g = new Graphics();
      const r = this.cellPx * 0.36;
      drawHero(g, this.cellPx / 2, this.cellPx / 2, r);
      this.heroNode.addChild(g);
    }
    this.heroLayer.addChild(this.heroNode);
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
          : null
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
    this.heroWalkFrame = 0;
    this.refreshHeroTexture();
    this.placeHero();
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
    // 相位错开，别让满屏怪物同步呼吸（NPC 同理 —— 两个智者一起点头很出戏）
    this.entityViews.forEach((v, i) => {
      if ((v.monsterId || v.npcId) && v.phase === undefined) v.phase = (i * 137) % (MONSTER_FRAME_MS * 4);
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
      view.frameIdx = -1;

      // 怪物脚下的**战斗评级指示灯**只占很小空间；精灵脚仍要踩在格内。
      // 素材下留白为 0，所以脚的位置由指示灯高度决定，避免切脚。
      const plateH = Math.max(7, S * 0.22) + 3;
      const plateY = S - plateH - 1;
      const standY = plateY + 1;
      //
      // 名字不再画在怪物下方（玩家要求底部不要有名称），完整名称与评级详情
      // 已显示在右侧详情面板。

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
        c.addChild(sp);
      } else {
        const g = new Graphics();
        // 兜底图形也上移同样的量 —— 两条路径共用同一套布局，
        // 否则「有图集」和「没图集」两种情况的怪物高度对不上
        const by = cy - (S - standY) / 2;
        // 底板让怪物在浅色地板上更集中
        g.roundRect(cx - S * 0.42, by - S * 0.42, S * 0.84, S * 0.84, S * 0.2).fill({
          color: pal.body,
          alpha: 0.14
        });
        drawMonsterBody(g, id, cx, by, r * 0.92, pal.body);
        c.addChild(g);
      }

      // BOSS 圈 —— 两条渲染路径共用，玩法信息不因换素材而丢失
      const over = new Graphics();
      if (mon.boss) {
        over.circle(cx, cy - (S - standY) / 2, S * 0.44).stroke({ width: 2, color: T.gold, alpha: 0.9 });
      }
      c.addChild(over);

      // 怪物脚下的**战斗评级指示灯**：只保留一个小色点，不写名字。
      // 名字在详情面板里已经完整显示；格子只有 32px，底部再加字会切脚或压到邻格。
      const grade = this.hooks.gradeFor?.(id);
      const style = grade ? GRADE_STYLE[grade] : null;
      const dotW = Math.max(6, Math.round(S * 0.2));
      const dotH = Math.max(4, Math.round(S * 0.12));
      const dotY = S - dotH - 2;
      const dotColor = style ? style.color : shade(pal.body, -0.62);
      const dot = new Graphics();
      // Pixi v8 用 `label` 而不是 `name`；设 `name` 会触发弃用警告。
      dot.label = 'gradeDot';
      dot.roundRect(Math.round(cx - dotW / 2), dotY, dotW, dotH, dotH / 2).fill(dotColor);
      c.addChild(dot);
    } else if (type === 'item') {
      const item = data.items[id];
      if (!item) return view;
      view.itemId = id;
      const tex = atlas.ready ? atlas.item(id) : null;
      if (tex) {
        const sp = new Sprite(tex);
        // 等比填充，留 2px 边距 —— 所有拾取物落屏大小一致，最好辨认。
        // 不能拉伸填满：剑是 10×21、药水是 16×16、金币是 8×8，拉平方会把剑压扁加宽。
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
      // NPC 有自己的静帧呼吸动画（图集里 4 帧），按下方同一套相位错开
      view.npcId = id;
      view.frameIdx = -1;
      if (npcTex) {
        const sp = new Sprite(npcTex);
        const s = atlas.actorScale;
        sp.anchor.set(0.5, 1);
        sp.x = cx;
        sp.y = S;
        sp.width = npcTex.width * s;
        sp.height = npcTex.height * s;
        view.sprite = sp;
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

  /** 攻击时播放一次挥剑动画 —— 否则图集里那 16 帧挥剑就是死素材 */
  playHeroAttack(): void {
    if (!atlas.ready) return;
    this.heroAttackMs = ATTACK_MS;
    this.refreshHeroTexture();
  }

  private refreshHeroTexture(): void {
    if (!this.heroSprite) return;
    const attacking = this.heroAttackMs > 0;
    const anim = attacking ? 'attack' : 'walk';
    const fi = attacking
      ? Math.min(3, Math.floor(((ATTACK_MS - this.heroAttackMs) / ATTACK_MS) * 4))
      : this.heroWalkFrame;
    const tex = atlas.heroFrame(anim, this.heroDir, fi);
    if (!tex) return;
    this.heroSprite.texture = tex;
    const s = atlas.actorScale;
    // 挥剑帧是 20×26、走路帧是 16×26，宽高都要跟着换，否则会拉伸
    this.heroSprite.width = tex.width * s;
    this.heroSprite.height = tex.height * s;
    this.heroSprite.x = this.cellPx / 2;
    this.heroSprite.y = this.cellPx;
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

    if (this.heroAttackMs > 0) {
      this.heroAttackMs = Math.max(0, this.heroAttackMs - dtMs);
      this.refreshHeroTexture();
    }

    if (this.heroAnim.active) {
      this.heroAnim.t = Math.min(1, this.heroAnim.t + dtMs / 130);
      const e = this.heroAnim.t;
      const ease = 1 - Math.pow(1 - e, 3);
      const cl = (a: number, b: number) => a + (b - a) * ease;
      this.heroNode.x = cl(this.heroAnim.fx, this.heroAnim.tx) * this.cellPx;
      this.heroNode.y = cl(this.heroAnim.fy, this.heroAnim.ty) * this.cellPx;
      if (e >= 1) this.heroAnim.active = false;
    }

    // 怪物 idle 与 NPC 呼吸循环：只在帧号真的变了才换贴图，
    // 避免每帧无谓的查表与赋值
    if (atlas.ready) {
      for (const v of this.entityViews) {
        if (!v.sprite) continue;
        if (v.monsterId) {
          const fi = Math.floor((this.clock + (v.phase ?? 0)) / MONSTER_FRAME_MS) % 4;
          if (fi === v.frameIdx) continue;
          const tex = atlas.monster(v.monsterId, 'idle', fi);
          if (tex) {
            v.sprite.texture = tex;
            v.frameIdx = fi;
          }
        } else if (v.npcId) {
          const fi = Math.floor((this.clock + (v.phase ?? 0)) / NPC_FRAME_MS) % 4;
          if (fi === v.frameIdx) continue;
          const tex = atlas.npcFrame(v.npcId, 'down', fi);
          if (tex) {
            v.sprite.texture = tex;
            v.frameIdx = fi;
          }
        }
      }
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

  get hovered(): { x: number; y: number } | null {
    return this.hoverCell;
  }
}
