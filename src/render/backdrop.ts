/**
 * 场景背景层 —— 「塔的位面」。
 *
 * 它铺在整块画布最底下，是所有面板与棋盘背后那层"天地"：
 *
 *   上部 **星空**（随位面越高星越多、天色越冷）
 *   下部 **绝地**（岩层剪影，越靠下越暗、越近）
 *   中间一条**地平线**，高度由当前楼层的位面决定
 *
 * ## 为什么地平线要跟着楼层动
 *
 * 这一层要表达的不是装饰，而是「塔的位面」：第 1 层在天底下的岩窟里，
 * 第 50 层已经站在星界。所以位面越低，绝地压得越满（horizon = 0.62）；
 * 位面越高，星空铺得越开（horizon = 0.16）。中间按楼层连续插值 ——
 * 走到第 26 层时，画面正好是一半天一半地。
 *
 * 一个必须注意的副作用：背景只在**面板之间那 28px 的缝**（棋盘前后 40px）
 * 与左右 20px 的边条里露出来。所以地平线的高度范围（0.16 ~ 0.62）是**刻意挑过**的 ——
 * 让它尽量落在棋盘那一屏（约 0.15 ~ 0.59）里，否则低层的岩层会整块
 * 被下方的详情卡/道具栏遮住，玩家根本看不到"绝地"。
 *
 * ## 为什么程序化画，而不是出一张背景图
 *
 * 位面是**连续变化**的（50 层每层都不同）。贴图方案要么出 50 张图，
 * 要么做两张图的混合，都比不上按位面直接算颜色。而且程序化画能保证
 * 每次重绘结果一致（星点用确定性随机，见下），截图对比与断言才立得住。
 *
 * ## 星点为什么不能用 Math.random
 *
 * 一旦用真随机，同一个楼层每次重绘星点都会跳 —— 换层回来一眼就能看出
 * "星星换了位置"，而且截图基线没法比对。这里用 `mulberry32`（种子固定
 * 由位面星密度决定）：同一楼层永远是同一片星空，换层才换天。
 */

import { Container, Graphics } from 'pixi.js';
import { LAYOUT } from './hud';
import { lerpColor, realmOf, type RealmView } from './theme';

/** 天空竖直渐变的条带数。条带够密就看不出分界（每条 ≈ 地平线高/64 ≈ 4px） */
const SKY_BANDS = 64;
/** 绝地渐变的条带数 */
const GROUND_BANDS = 30;
/** 星密度 1.0 时的星点数。背景只在 20px 的边条里露出来，稀了就等于没有 */
const STAR_MAX = 260;
/** 岩层剪影的顶点段数 */
const RIDGE_SEGMENTS = 15;

/** 确定性 PRNG（mulberry32）—— 同一个种子永远给出同一串数 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Backdrop extends Container {
  private g = new Graphics();
  /** 当前画出来的楼层；-1 表示还没画过 */
  private floorShown = -1;
  /** 当前画出来的地平线（0..1）—— 断言用它验证「越往上星空越大」 */
  private horizonNow = 0;

  constructor() {
    super();
    // 背景不参与命中测试：它在最底层，任何点击都该落到棋盘或面板上
    this.eventMode = 'none';
    this.addChild(this.g);
  }

  /** 换层时调用。同一层重复调用不会重绘（绘制成本不低，别挂在每帧上）。 */
  setFloor(floor: number): void {
    if (floor === this.floorShown) return;
    this.floorShown = floor;
    this.paint(realmOf(floor));
  }

  /** 画的是哪一层（-1 = 未画） */
  get paintedFloor(): number {
    return this.floorShown;
  }

  /** 当前地平线占画布高度的比例（越小＝星空越大） */
  get horizon(): number {
    return this.horizonNow;
  }

  private paint(r: RealmView): void {
    const W = LAYOUT.W;
    const H = LAYOUT.H;
    const g = this.g;
    g.clear();

    // 地平线：整数化，避免渐变条带在半像素上出现摩尔纹
    const hy = Math.max(24, Math.round(H * r.horizon));
    this.horizonNow = hy / H;

    this.paintSky(g, r, W, hy);
    this.paintStars(g, r, W, hy);
    this.paintHaze(g, r, W, hy);
    this.paintGround(g, r, W, H, hy);
  }

  /** 上部：天顶色 → 近地平线天色 */
  private paintSky(g: Graphics, r: RealmView, W: number, hy: number): void {
    for (let i = 0; i < SKY_BANDS; i++) {
      const t0 = i / SKY_BANDS;
      const y0 = Math.round(hy * t0);
      const y1 = Math.round(hy * ((i + 1) / SKY_BANDS));
      g.rect(0, y0, W, Math.max(1, y1 - y0)).fill(lerpColor(r.sky, r.skyLow, t0));
    }
  }

  /**
   * 星点 + 银河。
   *
   * 两个细节让它不像"撒了白点"：
   *  - **大气消光**：越靠地平线越稀、越暗（`skip` 概率随深度上升）；
   *  - **银河**：沿一条斜线加密一片暗星，星空因此有结构，而不是均匀噪声。
   */
  private paintStars(g: Graphics, r: RealmView, W: number, hy: number): void {
    if (r.stars <= 0.02) return;
    const rnd = mulberry32(0x9e37_79b9 ^ Math.round(r.stars * 4096));

    const count = Math.round(STAR_MAX * r.stars);
    for (let i = 0; i < count; i++) {
      const x = rnd() * W;
      const y = rnd() * hy;
      const depth = y / Math.max(1, hy); // 0 天顶 → 1 地平线
      // 消光：靠地平线的那一半星点大概率丢掉
      if (rnd() < depth * 0.7) continue;
      const big = rnd() < 0.12;
      const rad = big ? 1.8 : 1.0;
      const alpha = Math.min(1, 0.42 + (1 - depth) * 0.58);
      g.circle(x, y, rad).fill({ color: 0xffffff, alpha });
      // 亮星加一小段十字光晕：只有大星有，否则满天都是十字会变噪
      if (big) {
        g.rect(x - 3.2, y - 0.35, 6.4, 0.7).fill({ color: 0xffffff, alpha: alpha * 0.45 });
        g.rect(x - 0.35, y - 3.2, 0.7, 6.4).fill({ color: 0xffffff, alpha: alpha * 0.45 });
      }
    }

    // 星云：一串又大又淡的柔光斑沿对角线叠着 —— 单看每斑几乎不可见，
    // 叠起来就是一条斜向的银河。比"画一条带"省事，也不会有硬边。
    const blobs = 14;
    for (let i = 0; i < blobs; i++) {
      const u = i / (blobs - 1);
      const x = u * W * 1.1 - W * 0.05;
      const y = hy * (0.08 + u * 0.62);
      g.circle(x, y, 34 + rnd() * 24).fill({ color: 0x8fb0ff, alpha: 0.02 + r.stars * 0.012 });
    }

    // 银河：沿对角线散一撮更暗的小星
    const galaxy = Math.round(90 * r.stars);
    for (let i = 0; i < galaxy; i++) {
      const u = rnd();
      const bx = u * W;
      const by = hy * (0.1 + u * 0.64);
      const x = bx + (rnd() - 0.5) * 52;
      const y = by + (rnd() - 0.5) * 20;
      if (x < 0 || x > W || y < 0 || y > hy) continue;
      g.circle(x, y, rnd() < 0.16 ? 1.3 : 0.8).fill({
        color: 0xdfe8ff,
        alpha: 0.16 + rnd() * 0.26
      });
    }
  }

  /** 地平线辉光：以地平线为中心、向两侧衰减的一条亮带 */
  private paintHaze(g: Graphics, r: RealmView, W: number, hy: number): void {
    const bands = 10;
    const h = 84;
    for (let i = 0; i < bands; i++) {
      const t = (i + 0.5) / bands; // 0..1
      const a = Math.sin(t * Math.PI) * 0.17;
      g.rect(0, hy - h / 2 + (h / bands) * i, W, h / bands + 1).fill({ color: r.haze, alpha: a });
    }
  }

  /** 下部：绝地 —— 地面底色渐变 + 三层岩层剪影 */
  private paintGround(g: Graphics, r: RealmView, W: number, H: number, hy: number): void {
    const gh = H - hy;

    for (let i = 0; i < GROUND_BANDS; i++) {
      const t0 = i / GROUND_BANDS;
      const y0 = hy + Math.round(gh * t0);
      const y1 = hy + Math.round(gh * ((i + 1) / GROUND_BANDS));
      g.rect(0, y0, W, Math.max(1, y1 - y0)).fill(lerpColor(r.ground, r.groundNear, t0));
    }

    // 三层山脊：越近越暗、起伏越大（大气透视）
    const layers = [
      { color: r.groundMid, base: hy + gh * 0.14, amp: 16, seed: 0x51ed_01, lit: 0.16 },
      { color: lerpColor(r.groundMid, r.groundNear, 0.55), base: hy + gh * 0.42, amp: 26, seed: 0x51ed_02, lit: 0.11 },
      { color: r.groundNear, base: hy + gh * 0.76, amp: 34, seed: 0x51ed_03, lit: 0.07 }
    ];

    for (const L of layers) {
      const rnd = mulberry32(L.seed);
      const ys: number[] = [];
      const xs: number[] = [];
      for (let i = 0; i <= RIDGE_SEGMENTS; i++) {
        const x = (W / RIDGE_SEGMENTS) * i;
        // 正弦给"山形"，随机给"碎岩"—— 纯随机会变成锯齿噪声，不像山
        const wave = 0.5 + 0.5 * Math.sin(i * 1.7 + L.seed);
        xs.push(x);
        ys.push(L.base - L.amp * (wave * 0.75 + rnd() * 0.35));
      }
      const pts: number[] = [];
      for (let i = 0; i <= RIDGE_SEGMENTS; i++) pts.push(xs[i], ys[i]);
      g.poly([...pts, W, H, 0, H]).fill(L.color);

      // 山脊受光的一条亮线：只描脊，不描多边形边（否则底边也有一条亮线）
      const lit = lerpColor(L.color, r.haze, L.lit);
      for (let i = 0; i < RIDGE_SEGMENTS; i++) {
        g.moveTo(xs[i], ys[i]).lineTo(xs[i + 1], ys[i + 1]).stroke({ width: 1.2, color: lit, alpha: 0.55 });
      }
    }
  }
}
