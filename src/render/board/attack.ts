/**
 * 挥剑动画 —— 帧推进 + 时间轴特效。
 *
 * 从 `board.ts` 拆出来的。攻击表现由**两条独立的线**组成，它们在这里第一次
 * 被放在同一页上：
 *
 *   1. **换帧**：`attackFrameIdx()` 决定勇者此刻贴 walk 还是 attack 的哪一帧。
 *   2. **特效**：`drawAttackFx()` 在勇者层上画前冲 / 刀光 / 命中火星。
 *
 * 两条线都只依赖 `heroAttackMs` 这一个变量，且**全部是 t 的确定函数 —— 没有随机数**，
 * 所以同一时刻截图必然一致（自动化取证依赖这一点）。把这句话写在文件头上，
 * 是因为将来有人想给刀光加「随机抖动」时，应该先看到它。
 *
 * ## 关于「攻击时角色变小」这段历史（保留，因为它是这两条线存在的理由）
 *
 * 早期是**靠换帧**表达攻击的，量出来 attack[2]/[3] 的实心身体只有 17 行（走路帧 20 行），
 * 且精灵底部锚定而 attack 帧的内容最低点是**剑尖**不是脚 —— 于是脚离地 7 行 × 2 倍
 * = 14px，人看着浮起来。所以一度改成「精灵不换帧，只画特效」。
 *
 * 2026-09-23 勇者改手绘之后，重画的解剖表让四向都变成同一组数字
 * （walk[0] 与 attack[0]/[3] 都是 (4,23)，**底行恒为 23**，脚不离地），
 * 挥剑帧于是被接回来了 —— 见 `docs/assets.md` 与 A14 判据。
 * **注意：这里的关键不是「哪个更好看」，而是「底行是否恒定」这个可量条件。**
 */

import type { Container, Graphics } from 'pixi.js';
import { T } from '../theme';
import { FACING_ANGLE, FACING_VEC, type Facing } from './types';

/** 勇者挥剑动画总时长（ms） */
export const ATTACK_MS = 300;
/** 挥剑序列的帧数（图集 actors.hero.attack 每向 4 帧）—— 见 `attackFrameIdx` */
export const ATTACK_FRAMES = 4;
/** 挥剑时朝向前冲的峰值位移（px，按 32px 格子计） */
const ATTACK_LUNGE = 4;
/** 刀光半径（px，按 32px 格子计） */
const ATTACK_TRAIL_R = 15;
/** 刀光扫过的总角度 */
const ATTACK_SWEEP = (162 * Math.PI) / 180;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** 缓出：动画的通用曲线，头快尾慢 —— 挥砍的加速感就来自这里 */
const easeOut = (v: number): number => 1 - Math.pow(1 - clamp01(v), 3);

/**
 * 当前挥剑进度对应的帧号（0..ATTACK_FRAMES-1）；不在挥剑时返回 **-1**。
 *
 * 用 `-1` 而不是 0 表示「不在挥剑」，是因为 0 是合法的帧号 ——
 * 拿 0 兼作哨兵，调用方就分不清「刚起手」和「已收招」，
 * 收招那一帧会留在挥剑造型上。
 */
export function attackFrameIdx(ms: number): number {
  if (ms <= 0) return -1;
  const p = 1 - ms / ATTACK_MS; // 0 → 1
  return Math.min(ATTACK_FRAMES - 1, Math.max(0, Math.floor(p * ATTACK_FRAMES)));
}

/** 前冲位移的时间曲线（单位：设计像素，t ∈ [0,1]） */
export function attackLungeAt(t: number): number {
  if (t < 0.22) return -1.5 * (t / 0.22); // 蓄力：微微后拉
  if (t < 0.52) return -1.5 + (ATTACK_LUNGE + 1.5) * easeOut((t - 0.22) / 0.3); // 刺出
  return ATTACK_LUNGE * (1 - easeOut((t - 0.52) / 0.48)); // 收招归位
}

/** `drawAttackFx` 需要的一切。刻意列出来而不是收 Board —— 这样它就能脱离棋盘单独验 */
export interface AttackFxInput {
  /** 格子边长（32）。特效尺寸按 32px 格子给，格子大小变了跟着走 */
  cellPx: number;
  dir: Facing;
  /** 勇者当前所处格子 */
  pos: { x: number; y: number };
  /** 剩余挥剑时间（ms）；≤0 表示不在挥剑 */
  ms: number;
  /** 前冲位移层 —— 收招时要把它归零 */
  lunge: Container;
}

/**
 * 挥剑特效 —— 精灵不动，攻击感由勇者层上的这三样表达：
 *
 *   · **前冲**：整个人沿朝向平移（峰值 `ATTACK_LUNGE` px），收招回位。
 *     平移而不是缩放 —— 缩放就是「变小」，那正是要修掉的东西。
 *   · **刀光**：以朝向为轴、扫过 `ATTACK_SWEEP` 的弧，三层同心描边做拖影；
 *     弧心落在**目标格**（朝向前方那一格）而不是勇者自己身上。
 *   · **命中火星**：挥到位那一刻（t≈0.5）在目标格炸开四道短线，快速淡出。
 *
 * 时间轴由 `heroAttackMs` 单变量驱动，全部是 t 的确定函数 —— 没有随机数，
 * 所以同一时刻截图必然一致（自动化取证依赖这一点）。
 */
export function drawAttackFx(g: Graphics, o: AttackFxInput): void {
  g.clear();

  if (o.ms <= 0) {
    // 不在攻击中：把前冲层归零。基准位归走位逻辑管，这里不碰
    o.lunge.x = 0;
    o.lunge.y = 0;
    return;
  }

  const k = o.cellPx / 32;
  const t = 1 - o.ms / ATTACK_MS;
  const [vx, vy] = FACING_VEC[o.dir];
  const axis = FACING_ANGLE[o.dir];

  // ① 前冲：0 → −1.5（蓄力后拉）→ +4（刺出）→ 0（收招）
  const lunge = attackLungeAt(t) * k;
  o.lunge.x = vx * lunge;
  o.lunge.y = vy * lunge;

  // 目标格中心（勇者朝向前方那一格）；比格子中心再上抬 4px —— 怪物是底部锚定的，
  // 身体长在格子的中上部，弧心落在格中心会显得「打在脚上」。
  // 抬得太多（试过 6）弧底会溢出到下一格，压到那格的地形上，看着像画错了地方。
  const tx = o.pos.x * o.cellPx + o.cellPx / 2 + vx * o.cellPx;
  const ty = o.pos.y * o.cellPx + o.cellPx / 2 - 4 * k + vy * o.cellPx;

  // ② 刀光：0.18 → 0.52 扫开，0.52 → 0.82 淡出
  const sweepP = clamp01((t - 0.18) / 0.34);
  if (sweepP > 0) {
    const fade = clamp01(1 - (t - 0.52) / 0.3);
    const half = (ATTACK_SWEEP * easeOut(sweepP)) / 2;
    const R = ATTACK_TRAIL_R * k;
    const a0 = axis - half;
    const a1 = axis + half;
    // 实心扇形环（外弧 + 内弧反向围成），不是描边线 ——
    // 描边画出来是一条细「U」，在暖砂石地砖上既细又和地面同色系；
    // 实心扇形有面积，才压得住底。
    g.arc(tx, ty, R, a0, a1);
    g.arc(tx, ty, R - 5 * k, a1, a0, true);
    g.closePath();
    g.fill({ color: T.gold, alpha: 0.55 * fade });
    // 刃口：扇形外缘再补一条近白的细线，攻击的「锋」落在这一条上
    g.arc(tx, ty, R - 1.5 * k, a0, a1);
    g.stroke({ width: 1.6 * k, color: 0xfffbe8, alpha: 0.95 * fade });
    // 刃尖：扫到哪就亮到哪。没有这个点，弧光只像一圈「U」，看不出挥的方向
    g.circle(tx + Math.cos(a1) * R, ty + Math.sin(a1) * R, 2.6 * k).fill({
      color: 0xffffff,
      alpha: 0.9 * fade
    });
  }

  // ③ 命中火星：0.48 → 0.86，四道短线按挥砍平面铺开，长度先涨后收
  const sparkP = (t - 0.48) / 0.38;
  if (sparkP > 0 && sparkP < 1) {
    const grow = Math.sin(Math.PI * sparkP); // 0 → 1 → 0
    const fade = 1 - sparkP;
    const rays = [
      { a: -0.7, len: 9 },
      { a: 0.7, len: 9 },
      { a: -2.44, len: 5.5 },
      { a: 2.44, len: 5.5 }
    ];
    for (const r of rays) {
      const ang = axis + r.a;
      const len = r.len * k * grow;
      g.moveTo(tx + Math.cos(ang) * 2 * k, ty + Math.sin(ang) * 2 * k);
      g.lineTo(tx + Math.cos(ang) * (2 * k + len), ty + Math.sin(ang) * (2 * k + len));
      g.stroke({ width: 1.6 * k, color: 0xffe9a8, alpha: fade });
    }
    g.circle(tx, ty, 2.2 * k * grow).fill({ color: 0xffffff, alpha: 0.85 * fade });
  }
}
