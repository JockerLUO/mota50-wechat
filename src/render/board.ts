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

import { Container, Graphics, Rectangle, Sprite, Text, TilingSprite } from 'pixi.js';
import type { GameData } from '../data';
import { tileAt, type GameState } from '../game/state';
import { atlas, fitSize, isWallChar, terrainKeyFor, variantIndex } from './atlas';
import { drawHero, drawItemGlyph, drawMonsterBody, drawTerrain, itemCategoryOf, itemColorOf, shade } from './icons';
import { GRADE_STYLE, T, monsterPalette } from './theme';

const NPC_COLOR: Record<string, number> = {
  sage: 0x3b6fd4,
  merchant: 0xd99e0b,
  shop: 0x15a34a,
  princess: 0xdb5a9a,
  thief: 0x6b7280,
  fairy: 0x38bdf8
};

/** 怪物 idle 动画每帧时长（ms）。四帧一轮 ≈ 0.7s，慢到不抢注意力 */
const MONSTER_FRAME_MS = 170;
/** 勇者挥剑动画总时长（ms） */
const ATTACK_MS = 300;
/** 每步走路前进一帧：一步一格 = 一个完整步态循环 */
const WALK_FRAMES = 4;

/** 怪物名缩到 2 字，让同族不同阶在棋盘上可分辨（骷髅 / 骷士 / 骷队） */
function shortName(name: string): string {
  return name.length <= 2 ? name : name.slice(0, 2);
}

/** 勇者朝向名，与 MANIFEST 的 dirOrder 一致 */
type Facing = 'down' | 'left' | 'up' | 'right';

interface EntityView {
  key: string;
  node: Container | null;
  x: number;
  y: number;
  /** 有值表示这格是怪物，参与 idle 动画 */
  monsterId?: string;
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

    const bg = new Graphics();
    bg.roundRect(-6, -6, this.span + 12, this.span + 12, 14).fill(T.panel);
    bg.roundRect(-6, -6, this.span + 12, this.span + 12, 14).stroke({ width: 1, color: T.panelBorder });

    this.addChild(bg, this.terrainLayer, this.entityLayer, this.heroLayer, this.overlay);
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
    // 相位错开，别让满屏怪物同步呼吸
    this.entityViews.forEach((v, i) => {
      if (v.monsterId && v.phase === undefined) v.phase = (i * 137) % (MONSTER_FRAME_MS * 4);
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

      // 脚下的可行性名牌先定尺寸，精灵才好站在它上面。
      //
      // 为什么必须让精灵站上去，而不是压着精灵画：实测所有怪物素材的**下留白都是 0**
      // （帧是底对齐归一化的，脚正好贴格子底沿），所以任何贴在格子底部的名牌
      // 都会切掉怪物的脚 —— 蝙蝠会变成「只剩耳朵和翅膀」。而**上留白有 0–6px**，
      // 上移是有余量的。
      const fs = Math.max(7, S * 0.22);
      const plateH = fs + 3;
      const plateY = S - plateH - 1;
      const standY = plateY + 1; // 精灵的脚落在名牌上沿
      //
      // ⚠️ 已知代价：精灵因此**向上溢出格子**。格子 32px、普通怪物精灵正好 32px
      // （16×16 素材 × drawScale 2），再叠一块 ~10px 的名牌，并集就有 42px。
      // 实测（`tools/verify-visual.cjs` A5a）每一只怪都向上溢出 10px。
      //
      // 为什么不让精灵缩到能连名牌一起塞进 32px：那需要精灵 ≤22px，而 16px 素材
      // 只能整数倍放大，22px 意味着 1.375 倍 —— 像素画会被插值糊掉。宁可溢出。
      //
      // 只有**第 0 行**会露出这个代价：棋盘上沿（LAYOUT.board.y = 100）到 HUD 下沿
      // （LAYOUT.hud.h = 96）只有 4px 余量，面板再往上顶就会被 HUD 盖住。
      // 实测（同一次 A5a）第 0 行怪物精灵的不透明像素从 y≈94.3 开始，
      // 而面板上沿在 y=94 —— 也就是**刚好贴着上边框，并没有真的画到框外**。
      // 结论：这是被量过的、有界的观感问题，不是缺陷；动手前请先看 A5a 的数字。

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

      // 名牌：**等级色底片 + 白字名字**，一个元素同时承担「能不能打」和「是什么」。
      //
      // 为什么不是「右上角一个指示灯 + 底下一个名牌」两个元素：
      // 网格只有 32px，而普通怪物精灵（16×16 × drawScale 2）落屏正好 32×32 ——
      // 一格塞不下三样东西。原来的做法是在精灵之外**再叠**一个浮在头顶的圆点，
      // 结果是圆点压在精灵头上，还紧贴邻格的名牌，看上去弄不清属于谁；
      // 名牌又盖住精灵的脚。三个元素互相打架。
      //
      // 合成一个之后占位反而更小（原来「名牌 22 + 圆点 10」的并集宽 24.5，
      // 现在就是一块 22 宽的牌子），归属不再有歧义，精灵头顶也空了出来。
      //
      // 用等级色而不是家族色当底，是因为两者的信息价值不对等：
      // 家族一眼就能从精灵身上看出来（同族靠换色做阶差），
      // 而「这一击下去要掉多少血」是数值门玩法里真正要一眼看到的，
      // 且它在棋盘上没有别的表达途径。家族色因此挪到兜底分支里（取不到评级时用）。
      const grade = this.hooks.gradeFor?.(id);
      const style = grade ? GRADE_STYLE[grade] : null;
      const label = new Text({
        text: shortName(mon.name),
        style: {
          fontFamily: '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
          fontSize: fs,
          fontWeight: '700',
          fill: T.onDark
        }
      });
      label.anchor.set(0.5);
      const plateW = Math.min(S - 1, label.width + 8);
      const plateX = cx - plateW / 2;
      const plateColor = style ? style.color : shade(pal.body, -0.62);
      const chip = new Graphics();
      chip
        .roundRect(plateX, plateY, plateW, plateH, plateH * 0.32)
        .fill({ color: shade(plateColor, -0.16), alpha: 0.9 });
      // 描一圈更暗的边。等级色饱和度不低，压在同色系地砖上会「洇」进背景；
      // 描边把名牌和地砖分开，在浅色地面与深色墙面上都能立住。
      chip
        .roundRect(plateX, plateY, plateW, plateH, plateH * 0.32)
        .stroke({ width: 1, color: shade(plateColor, -0.55), alpha: 0.95 });
      label.x = cx;
      label.y = plateY + plateH / 2;
      c.addChild(chip, label);
    } else if (type === 'item') {
      const item = data.items[id];
      if (!item) return view;
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
      const npc = data.npcs[id];
      const npcTex = atlas.ready ? atlas.npcFrame(id, 'down', 0) : null;
      if (npcTex) {
        const sp = new Sprite(npcTex);
        const s = atlas.actorScale;
        sp.anchor.set(0.5, 1);
        sp.x = cx;
        sp.y = S;
        sp.width = npcTex.width * s;
        sp.height = npcTex.height * s;
        c.addChild(sp);
      } else {
        const g = new Graphics();
        const color = NPC_COLOR[id] ?? 0x64748b;
        g.circle(cx, cy + S * 0.04, S * 0.4).fill({ color: 0xffffff, alpha: 0.75 });
        // 长袍人形
        g.poly([cx - r * 0.8, cy + r * 0.95, cx, cy - r * 0.1, cx + r * 0.8, cy + r * 0.95]).fill(color);
        g.circle(cx, cy - r * 0.42, r * 0.38).fill(shade(color, 0.25));
        g.circle(cx - r * 0.13, cy - r * 0.45, r * 0.06).fill(0x1e293b);
        g.circle(cx + r * 0.13, cy - r * 0.45, r * 0.06).fill(0x1e293b);
        c.addChild(g);
      }
      const label = new Text({
        text: shortName(npc?.name ?? id),
        style: {
          fontFamily: '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
          fontSize: Math.max(8, S * 0.28),
          fontWeight: '700',
          fill: T.inkMuted
        }
      });
      label.anchor.set(0.5);
      label.x = cx;
      label.y = cy + r * 1.24;
      c.addChild(label);
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

    // 怪物 idle 循环：只在帧号真的变了才换贴图，避免每帧无谓的查表与赋值
    if (atlas.ready) {
      for (const v of this.entityViews) {
        if (!v.monsterId || !v.sprite) continue;
        const fi = Math.floor((this.clock + (v.phase ?? 0)) / MONSTER_FRAME_MS) % 4;
        if (fi === v.frameIdx) continue;
        const tex = atlas.monster(v.monsterId, 'idle', fi);
        if (tex) {
          v.sprite.texture = tex;
          v.frameIdx = fi;
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
