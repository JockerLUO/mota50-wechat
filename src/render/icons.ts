/**
 * 程序化图形 —— 本项目没有美术资源，所有图标都是矢量画出来的。
 *
 * 这样做在原型阶段的三个好处：
 *  1. 零资源依赖，微信小游戏不用打包图集就能跑
 *  2. 换配色只改 theme.ts，不用重导出 PNG
 *  3. 地形 → 图形的映射是显式的代码，不会有「图集里找不到某格」的运行时惊喜
 *
 * 每格用「底色 + 符号」两层：底色负责一眼分辨类别，符号负责区分具体对象。
 */

import { Graphics } from 'pixi.js';
import { T } from './theme';
import type { ItemDef } from '../data';

// ── 地形 ────────────────────────────────────────────────────────────

export function drawTerrain(g: Graphics, ch: string, x: number, y: number, s: number): void {
  const px = x * s;
  const py = y * s;
  const r = Math.max(2, s * 0.12);

  switch (ch) {
    case '.': {
      g.roundRect(px + 0.5, py + 0.5, s - 1, s - 1, r).fill((x + y) % 2 === 0 ? T.floorA : T.floorB);
      break;
    }
    case '#':
    case 'w': {
      // 假墙与真墙外观必须完全一致，否则「假墙」这个设计就失效了
      g.roundRect(px, py, s, s, r).fill(T.wall);
      g.rect(px + 1, py + 1, s - 2, s * 0.22).fill({ color: T.wallTop, alpha: 0.85 });
      g.rect(px + 1, py + s - s * 0.18 - 1, s - 2, s * 0.18).fill({ color: T.wallDark, alpha: 0.55 });
      break;
    }
    case '~': {
      g.roundRect(px, py, s, s, r).fill(T.lava);
      g.circle(px + s * 0.32, py + s * 0.68, s * 0.16).fill({ color: T.lavaHot, alpha: 0.85 });
      g.circle(px + s * 0.7, py + s * 0.36, s * 0.11).fill({ color: T.lavaHot, alpha: 0.6 });
      break;
    }
    case '*': {
      g.roundRect(px, py, s, s, r).fill(T.space);
      const stars: [number, number, number][] = [
        [0.22, 0.26, 0.055],
        [0.66, 0.2, 0.04],
        [0.44, 0.55, 0.05],
        [0.8, 0.68, 0.045],
        [0.26, 0.78, 0.04]
      ];
      for (const [fx, fy, fr] of stars) {
        g.circle(px + s * fx, py + s * fy, Math.max(1, s * fr)).fill({ color: T.spaceStar, alpha: 0.9 });
      }
      break;
    }
    case 'D':
      drawFloorBase(g, px, py, s, r);
      drawDoorPanel(g, px, py, s, T.doorPrison, true);
      break;
    case 'a':
      drawFloorBase(g, px, py, s, r);
      drawDoorPanel(g, px, py, s, T.doorAuto, false);
      break;
    case 'y':
      drawFloorBase(g, px, py, s, r);
      drawDoorPanel(g, px, py, s, T.doorYellow, false);
      break;
    case 'b':
      drawFloorBase(g, px, py, s, r);
      drawDoorPanel(g, px, py, s, T.doorBlue, false);
      break;
    case 'r':
      drawFloorBase(g, px, py, s, r);
      drawDoorPanel(g, px, py, s, T.doorRed, false);
      break;
    case '^':
      drawFloorBase(g, px, py, s, r);
      drawStairArrow(g, px, py, s, true);
      break;
    case 'v':
      drawFloorBase(g, px, py, s, r);
      drawStairArrow(g, px, py, s, false);
      break;
    default:
      g.roundRect(px + 0.5, py + 0.5, s - 1, s - 1, r).fill(T.floorA);
  }
}

function drawFloorBase(g: Graphics, px: number, py: number, s: number, r: number): void {
  g.roundRect(px + 0.5, py + 0.5, s - 1, s - 1, r).fill(T.floorB);
}

function drawDoorPanel(g: Graphics, px: number, py: number, s: number, color: number, barred: boolean): void {
  const inset = s * 0.08;
  g.roundRect(px + inset, py + inset, s - inset * 2, s - inset * 2, s * 0.1).fill({ color, alpha: 0.92 });
  g.roundRect(px + inset, py + inset, s - inset * 2, (s - inset * 2) * 0.34, s * 0.1).fill({
    color: 0xffffff,
    alpha: 0.22
  });
  if (barred) {
    // 牢门：竖栅栏
    for (let i = 1; i <= 3; i++) {
      const lx = px + inset + ((s - inset * 2) * i) / 4;
      g.rect(lx - s * 0.025, py + inset * 1.5, s * 0.05, s - inset * 3).fill({ color: 0xffffff, alpha: 0.6 });
    }
  } else {
    g.circle(px + s * 0.5, py + s * 0.56, s * 0.075).fill({ color: 0xffffff, alpha: 0.9 });
    g.rect(px + s * 0.5 - s * 0.03, py + s * 0.56, s * 0.06, s * 0.16).fill({ color: 0xffffff, alpha: 0.9 });
  }
}

function drawStairArrow(g: Graphics, px: number, py: number, s: number, up: boolean): void {
  const color = up ? T.stairUp : T.stairDown;
  for (let i = 0; i < 3; i++) {
    const t = i * 0.22;
    const w = s * (0.72 - t * 1.4);
    const cy = up ? py + s * (0.72 - t) : py + s * (0.28 + t);
    g.rect(px + (s - w) / 2, cy - s * 0.07, w, s * 0.14).fill({
      color,
      alpha: 0.45 + i * 0.25
    });
  }
}

// ── 怪物 ────────────────────────────────────────────────────────────

export type MonsterShape = 'blob' | 'bat' | 'skull' | 'gem' | 'hex' | 'shield' | 'cube' | 'tentacle';

export function monsterShapeOf(id: string): MonsterShape {
  const s = id.toLowerCase();
  if (s.includes('slime')) return 'blob';
  if (s.includes('bat')) return 'bat';
  if (s.includes('skeleton') || s.includes('ghost') || s.includes('phantom')) return 'skull';
  if (s.includes('mage') || s.includes('wizard')) return 'gem';
  if (s.includes('guard')) return 'hex';
  if (s.includes('knight') || s.includes('swordsman') || s.includes('warrior') || s.includes('orc')) return 'shield';
  if (s.includes('golem')) return 'cube';
  if (s.includes('kraken') || s.includes('demon')) return 'tentacle';
  if (s.includes('dragon')) return 'hex';
  return 'blob';
}

/** 画怪物本体（不含文字）。cx/cy 为格中心，r 为半径 */
export function drawMonsterBody(g: Graphics, id: string, cx: number, cy: number, r: number, color: number): void {
  const shape = monsterShapeOf(id);
  const dark = shade(color, -0.35);

  switch (shape) {
    case 'blob': {
      g.ellipse(cx, cy + r * 0.15, r, r * 0.85).fill(color);
      g.circle(cx - r * 0.32, cy - r * 0.05, r * 0.18).fill({ color: 0xffffff, alpha: 0.9 });
      g.circle(cx + r * 0.32, cy - r * 0.05, r * 0.18).fill({ color: 0xffffff, alpha: 0.9 });
      g.ellipse(cx, cy + r * 0.62, r * 0.9, r * 0.22).fill({ color: dark, alpha: 0.5 });
      break;
    }
    case 'bat': {
      g.poly([cx - r * 1.15, cy - r * 0.1, cx - r * 0.25, cy - r * 0.5, cx - r * 0.25, cy + r * 0.5]).fill(color);
      g.poly([cx + r * 1.15, cy - r * 0.1, cx + r * 0.25, cy - r * 0.5, cx + r * 0.25, cy + r * 0.5]).fill(color);
      g.circle(cx, cy, r * 0.45).fill(dark);
      g.circle(cx - r * 0.16, cy - r * 0.08, r * 0.1).fill({ color: 0xffffff, alpha: 0.95 });
      g.circle(cx + r * 0.16, cy - r * 0.08, r * 0.1).fill({ color: 0xffffff, alpha: 0.95 });
      break;
    }
    case 'skull': {
      g.roundRect(cx - r * 0.8, cy - r * 0.85, r * 1.6, r * 1.6, r * 0.45).fill(color);
      g.roundRect(cx - r * 0.38, cy + r * 0.6, r * 0.76, r * 0.35, r * 0.12).fill(color);
      g.circle(cx - r * 0.34, cy - r * 0.15, r * 0.24).fill(dark);
      g.circle(cx + r * 0.34, cy - r * 0.15, r * 0.24).fill(dark);
      g.rect(cx - r * 0.08, cy + r * 0.2, r * 0.16, r * 0.3).fill(dark);
      break;
    }
    case 'gem': {
      g.poly([cx, cy - r, cx + r * 0.95, cy, cx, cy + r, cx - r * 0.95, cy]).fill(color);
      g.poly([cx, cy - r, cx + r * 0.42, cy - r * 0.1, cx, cy + r * 0.3, cx - r * 0.42, cy - r * 0.1]).fill({
        color: 0xffffff,
        alpha: 0.25
      });
      break;
    }
    case 'hex': {
      const pts: number[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.98);
      }
      g.poly(pts).fill(color);
      g.circle(cx, cy, r * 0.3).fill({ color: dark, alpha: 0.65 });
      break;
    }
    case 'shield': {
      g.poly([cx - r * 0.85, cy - r * 0.8, cx + r * 0.85, cy - r * 0.8, cx + r * 0.72, cy + r * 0.3, cx, cy + r, cx - r * 0.72, cy + r * 0.3]).fill(color);
      g.rect(cx - r * 0.5, cy - r * 0.42, r * 1.0, r * 0.16).fill({ color: 0xffffff, alpha: 0.4 });
      g.rect(cx - r * 0.08, cy - r * 0.6, r * 0.16, r * 1.1).fill({ color: 0xffffff, alpha: 0.4 });
      break;
    }
    case 'cube': {
      g.roundRect(cx - r * 0.82, cy - r * 0.82, r * 1.64, r * 1.64, r * 0.18).fill(color);
      g.roundRect(cx - r * 0.56, cy - r * 0.56, r * 1.12, r * 0.34, r * 0.1).fill({ color: 0xffffff, alpha: 0.22 });
      g.circle(cx - r * 0.3, cy + r * 0.18, r * 0.14).fill({ color: 0xffffff, alpha: 0.85 });
      g.circle(cx + r * 0.3, cy + r * 0.18, r * 0.14).fill({ color: 0xffffff, alpha: 0.85 });
      break;
    }
    case 'tentacle': {
      g.circle(cx, cy - r * 0.25, r * 0.72).fill(color);
      g.poly([cx - r * 0.7, cy + r * 0.1, cx - r * 0.3, cy + r * 0.2, cx - r * 0.5, cy + r * 0.95]).fill(color);
      g.poly([cx + r * 0.7, cy + r * 0.1, cx + r * 0.3, cy + r * 0.2, cx + r * 0.5, cy + r * 0.95]).fill(color);
      g.poly([cx - r * 0.1, cy + r * 0.2, cx + r * 0.1, cy + r * 0.2, cx, cy + r * 0.85]).fill(color);
      g.circle(cx - r * 0.26, cy - r * 0.35, r * 0.15).fill({ color: 0xffffff, alpha: 0.95 });
      g.circle(cx + r * 0.26, cy - r * 0.35, r * 0.15).fill({ color: 0xffffff, alpha: 0.95 });
      break;
    }
  }
}

// ── 道具 ────────────────────────────────────────────────────────────

export type ItemCategory =
  | 'gem'
  | 'potion'
  | 'key'
  | 'sword'
  | 'shield'
  | 'gold'
  | 'book'
  | 'flyer'
  | 'bomb'
  | 'cross'
  | 'snowflake'
  | 'shovel'
  | 'scroll'
  | 'portal'
  | 'misc';

export function itemCategoryOf(id: string, name = ''): ItemCategory {
  const s = id + name;
  if (/gem|宝石/.test(s)) return 'gem';
  if (/potion|圣水|药水/.test(s)) return 'potion';
  if (/goldenKey|Key$|钥匙/.test(s)) return 'key';
  if (/sword|剑/.test(s)) return 'sword';
  if (/shield|盾/.test(s)) return 'shield';
  if (/gold|金币/.test(s)) return 'gold';
  if (/book|book$|书/.test(s)) return 'book';
  if (/flyer|飞行器/.test(s)) return 'flyer';
  if (/bomb|炸药/.test(s)) return 'bomb';
  if (/cross|十字架/.test(s)) return 'cross';
  if (/snowflake|雪花/.test(s)) return 'snowflake';
  if (/shovel|铁锹/.test(s)) return 'shovel';
  if (/scroll|卷轴/.test(s)) return 'scroll';
  if (/Teleporter|传送器/.test(s)) return 'portal';
  return 'misc';
}

/** 道具主色：钥匙按钥匙色，其余按类别 */
export function itemColorOf(item: ItemDef & { id?: string }): number {
  const cat = itemCategoryOf(item.id ?? '', item.name);
  switch (cat) {
    case 'key':
      if (/yellow|金/.test(item.id ?? '')) return T.doorYellow;
      if (/blue/.test(item.id ?? '')) return T.doorBlue;
      if (/red/.test(item.id ?? '')) return T.doorRed;
      return T.gold;
    case 'gem':
      return /blue/.test(item.id ?? '') ? 0x3b82f6 : 0xdc2626;
    case 'potion':
      return /blue|圣水/.test(item.id ?? '') ? 0x3b82f6 : 0xe05a7a;
    case 'sword':
      return 0x8a93a6;
    case 'shield':
      return 0x64748b;
    case 'gold':
      return T.gold;
    case 'book':
      return 0x8b6f47;
    case 'flyer':
      return 0x7c5cc4;
    case 'bomb':
      return 0x475569;
    case 'cross':
      return T.gold;
    case 'snowflake':
      return 0x38bdf8;
    case 'shovel':
      return 0x92734c;
    case 'scroll':
      return 0xc7a86b;
    case 'portal':
      return 0x6d5bd0;
    default:
      return 0x64748b;
  }
}

/** 画道具图标（不含文字）。cx/cy 为格中心，r 为半径 */
export function drawItemGlyph(g: Graphics, cat: ItemCategory, cx: number, cy: number, r: number, color: number): void {
  const light = shade(color, 0.42);
  switch (cat) {
    case 'key': {
      g.circle(cx, cy - r * 0.42, r * 0.36).stroke({ width: Math.max(1.5, r * 0.24), color });
      g.rect(cx - r * 0.11, cy - r * 0.2, r * 0.22, r * 1.05).fill(color);
      g.rect(cx + r * 0.1, cy + r * 0.5, r * 0.36, r * 0.2).fill(color);
      g.rect(cx + r * 0.1, cy + r * 0.78, r * 0.28, r * 0.2).fill(color);
      break;
    }
    case 'gem': {
      g.poly([cx, cy - r, cx + r * 0.92, cy - r * 0.1, cx, cy + r, cx - r * 0.92, cy - r * 0.1]).fill(color);
      g.poly([cx, cy - r, cx + r * 0.38, cy - r * 0.16, cx, cy + r * 0.34, cx - r * 0.38, cy - r * 0.16]).fill({
        color: 0xffffff,
        alpha: 0.35
      });
      break;
    }
    case 'potion': {
      g.rect(cx - r * 0.2, cy - r * 0.85, r * 0.4, r * 0.42).fill({ color: light, alpha: 0.95 });
      g.roundRect(cx - r * 0.2, cy - r * 0.85, r * 0.4, r * 0.2, r * 0.06).fill(0x5b6a80);
      g.circle(cx, cy + r * 0.28, r * 0.68).fill(color);
      g.circle(cx - r * 0.22, cy + r * 0.08, r * 0.18).fill({ color: 0xffffff, alpha: 0.5 });
      break;
    }
    case 'sword': {
      g.poly([cx, cy - r, cx + r * 0.18, cy - r * 0.7, cx + r * 0.18, cy + r * 0.34, cx - r * 0.18, cy + r * 0.34, cx - r * 0.18, cy - r * 0.7]).fill(color);
      g.rect(cx - r * 0.6, cy + r * 0.3, r * 1.2, r * 0.18).fill(0x8a6a45);
      g.rect(cx - r * 0.1, cy + r * 0.44, r * 0.2, r * 0.44).fill(0x8a6a45);
      break;
    }
    case 'shield': {
      g.poly([cx, cy - r * 0.95, cx + r * 0.82, cy - r * 0.55, cx + r * 0.68, cy + r * 0.34, cx, cy + r, cx - r * 0.68, cy + r * 0.34, cx - r * 0.82, cy - r * 0.55]).fill(color);
      g.poly([cx, cy - r * 0.62, cx + r * 0.5, cy - r * 0.34, cx + r * 0.42, cy + r * 0.18, cx, cy + r * 0.64, cx - r * 0.42, cy + r * 0.18, cx - r * 0.5, cy - r * 0.34]).fill({ color: 0xffffff, alpha: 0.28 });
      break;
    }
    case 'gold': {
      g.ellipse(cx, cy + r * 0.34, r * 0.82, r * 0.36).fill(shade(color, -0.2));
      g.ellipse(cx, cy + r * 0.06, r * 0.82, r * 0.36).fill(color);
      g.ellipse(cx, cy - r * 0.22, r * 0.82, r * 0.36).fill(color);
      g.ellipse(cx, cy - r * 0.22, r * 0.55, r * 0.22).fill({ color: 0xffffff, alpha: 0.4 });
      break;
    }
    case 'book': {
      g.roundRect(cx - r * 0.78, cy - r * 0.9, r * 1.56, r * 1.8, r * 0.14).fill(color);
      g.rect(cx - r * 0.78, cy - r * 0.9, r * 0.24, r * 1.8).fill(shade(color, -0.3));
      g.rect(cx - r * 0.36, cy - r * 0.5, r * 1.0, r * 0.12).fill({ color: 0xffffff, alpha: 0.6 });
      g.rect(cx - r * 0.36, cy - r * 0.14, r * 0.8, r * 0.1).fill({ color: 0xffffff, alpha: 0.45 });
      break;
    }
    case 'flyer': {
      g.poly([cx, cy - r * 0.25, cx - r * 1.0, cy - r * 0.7, cx - r * 0.55, cy + r * 0.5]).fill(color);
      g.poly([cx, cy - r * 0.25, cx + r * 1.0, cy - r * 0.7, cx + r * 0.55, cy + r * 0.5]).fill(color);
      g.poly([cx, cy + r * 0.9, cx - r * 0.3, cy + r * 0.2, cx + r * 0.3, cy + r * 0.2]).fill(shade(color, -0.3));
      break;
    }
    case 'bomb': {
      g.circle(cx, cy + r * 0.2, r * 0.72).fill(color);
      g.circle(cx - r * 0.24, cy - r * 0.02, r * 0.18).fill({ color: 0xffffff, alpha: 0.45 });
      g.rect(cx - r * 0.1, cy - r * 0.8, r * 0.2, r * 0.3).fill(0x8a6a45);
      g.moveTo(cx + r * 0.05, cy - r * 0.76).lineTo(cx + r * 0.55, cy - r * 1.05).stroke({ width: Math.max(1.5, r * 0.14), color: 0xf59e0b });
      break;
    }
    case 'cross': {
      g.rect(cx - r * 0.2, cy - r * 0.95, r * 0.4, r * 1.9).fill(color);
      g.rect(cx - r * 0.72, cy - r * 0.36, r * 1.44, r * 0.4).fill(color);
      break;
    }
    case 'snowflake': {
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        g.moveTo(cx, cy).lineTo(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95).stroke({ width: Math.max(1.4, r * 0.16), color });
      }
      g.circle(cx, cy, r * 0.22).fill(color);
      break;
    }
    case 'shovel': {
      g.rect(cx - r * 0.1, cy - r * 0.95, r * 0.2, r * 1.2).fill(0x8a6a45);
      g.rect(cx - r * 0.36, cy - r * 1.0, r * 0.72, r * 0.18).fill(0x8a6a45);
      g.poly([cx - r * 0.42, cy + r * 0.2, cx + r * 0.42, cy + r * 0.2, cx + r * 0.3, cy + r * 0.95, cx - r * 0.3, cy + r * 0.95]).fill(color);
      break;
    }
    case 'scroll': {
      g.roundRect(cx - r * 0.7, cy - r * 0.6, r * 1.4, r * 1.2, r * 0.12).fill(color);
      g.roundRect(cx - r * 0.88, cy - r * 0.82, r * 0.36, r * 1.64, r * 0.16).fill(shade(color, -0.25));
      g.roundRect(cx + r * 0.52, cy - r * 0.82, r * 0.36, r * 1.64, r * 0.16).fill(shade(color, -0.25));
      break;
    }
    case 'portal': {
      g.circle(cx, cy, r * 0.88).stroke({ width: Math.max(1.6, r * 0.18), color });
      g.circle(cx, cy, r * 0.5).stroke({ width: Math.max(1.4, r * 0.14), color: light });
      g.circle(cx, cy, r * 0.18).fill(color);
      break;
    }
    default:
      g.circle(cx, cy, r * 0.7).fill(color);
  }
}

// ── 勇者 ────────────────────────────────────────────────────────────

export function drawHero(g: Graphics, cx: number, cy: number, r: number): void {
  g.ellipse(cx, cy + r * 0.92, r * 0.85, r * 0.24).fill({ color: 0x1e293b, alpha: 0.18 });
  // 披风
  g.poly([cx - r * 0.85, cy + r * 0.9, cx, cy - r * 0.05, cx + r * 0.85, cy + r * 0.9]).fill(shade(T.hero, -0.25));
  // 身体
  g.roundRect(cx - r * 0.5, cy - r * 0.1, r * 1.0, r * 1.0, r * 0.28).fill(T.hero);
  g.roundRect(cx - r * 0.5, cy - r * 0.1, r * 1.0, r * 0.34, r * 0.2).fill({ color: T.heroLight, alpha: 0.75 });
  // 头
  g.circle(cx, cy - r * 0.58, r * 0.44).fill(T.heroSkin);
  // 头盔
  g.arc(cx, cy - r * 0.58, r * 0.46, Math.PI, Math.PI * 2).stroke({ width: Math.max(1.6, r * 0.22), color: T.hero });
  g.rect(cx - r * 0.46, cy - r * 0.62, r * 0.92, r * 0.14).fill({ color: T.heroLight, alpha: 0.9 });
  // 眼睛
  g.circle(cx - r * 0.15, cy - r * 0.5, r * 0.07).fill(0x1e293b);
  g.circle(cx + r * 0.15, cy - r * 0.5, r * 0.07).fill(0x1e293b);
}

// ── NPC（图集缺失时的程序化兜底） ───────────────────────────────────
//
// ⚠️ 这一份是**兜底**，只在图集加载失败时用到（`atlas.ready === false`）。
// 但它同样必须按职能分工：上一版是「所有人同一个长袍人形 + 换个颜色」，
// 结果图集一失败，整座塔的人长得一模一样 —— 而兜底路径恰恰是最不容易被
// 发现的那条（画面只是变朴素，不会报错）。

export function drawNpcFallback(g: Graphics, id: string, cx: number, cy: number, r: number, color: number): void {
  const dark = shade(color, -0.35);
  const light = shade(color, 0.3);
  const skin = 0xf7d9b8;

  // 底色盘：让角色从地板里浮出来（兜底路径没有像素描边，只能靠底衬）
  g.circle(cx, cy + r * 0.04, r * 0.86).fill({ color: 0xffffff, alpha: 0.7 });

  // 长袍：所有职能共用的身体，剪影差异靠下面的「帽子 / 手持物」制造
  g.poly([cx - r * 0.78, cy + r * 0.95, cx, cy - r * 0.15, cx + r * 0.78, cy + r * 0.95]).fill(color);
  g.poly([cx - r * 0.78, cy + r * 0.95, cx, cy - r * 0.15, cx, cy + r * 0.95]).fill({ color: light, alpha: 0.35 });
  // 头
  g.circle(cx, cy - r * 0.48, r * 0.36).fill(skin);
  g.circle(cx - r * 0.12, cy - r * 0.5, r * 0.06).fill(0x1e293b);
  g.circle(cx + r * 0.12, cy - r * 0.5, r * 0.06).fill(0x1e293b);

  switch (id) {
    case 'sage':
      // 尖顶帽 + 白须 + 法杖
      g.poly([cx - r * 0.42, cy - r * 0.7, cx, cy - r * 1.35, cx + r * 0.42, cy - r * 0.7]).fill(dark);
      g.poly([cx - r * 0.3, cy - r * 0.28, cx, cy + r * 0.5, cx + r * 0.3, cy - r * 0.28]).fill(0xf4f2ec);
      g.rect(cx + r * 0.72, cy - r * 0.95, Math.max(1.4, r * 0.14), r * 1.7).fill(0x7a5630);
      g.circle(cx + r * 0.79, cy - r * 1.05, r * 0.2).fill(0x4a8cf6);
      break;
    case 'merchant':
      // 宽檐帽 + 钱袋
      g.ellipse(cx, cy - r * 0.72, r * 0.95, r * 0.2).fill(dark);
      g.roundRect(cx - r * 0.34, cy - r * 1.12, r * 0.68, r * 0.42, r * 0.12).fill(dark);
      g.circle(cx + r * 0.62, cy + r * 0.5, r * 0.26).fill(0xe2b048);
      break;
    case 'shop':
      // 围裙 + 一摞金币
      g.roundRect(cx - r * 0.4, cy - r * 0.1, r * 0.8, r * 0.9, r * 0.14).fill(0xe2d0a8);
      for (let i = 0; i < 3; i++) g.ellipse(cx + r * 0.66, cy + r * (0.2 + i * 0.26), r * 0.24, r * 0.1).fill(0xf0ca54);
      break;
    case 'thief':
      // 兜帽 + 蒙面（只留眼缝）
      g.poly([cx - r * 0.5, cy - r * 0.18, cx, cy - r * 1.1, cx + r * 0.5, cy - r * 0.18]).fill(dark);
      g.rect(cx - r * 0.34, cy - r * 0.42, r * 0.68, r * 0.26).fill(0x262a3a);
      break;
    case 'fairy':
      // 翅膀 + 星杖
      g.ellipse(cx - r * 0.72, cy - r * 0.2, r * 0.34, r * 0.6).fill({ color: 0xb2e8fa, alpha: 0.85 });
      g.ellipse(cx + r * 0.72, cy - r * 0.2, r * 0.34, r * 0.6).fill({ color: 0xb2e8fa, alpha: 0.85 });
      g.rect(cx + r * 0.68, cy - r * 0.7, Math.max(1.2, r * 0.1), r * 1.3).fill(0xf0f6ff);
      g.circle(cx + r * 0.74, cy - r * 0.85, r * 0.16).fill(0x56d6fa);
      break;
    case 'princess':
      // 金冠 + 长发
      g.poly([
        cx - r * 0.34, cy - r * 0.66,
        cx - r * 0.34, cy - r * 1.02,
        cx - r * 0.16, cy - r * 0.8,
        cx, cy - r * 1.08,
        cx + r * 0.16, cy - r * 0.8,
        cx + r * 0.34, cy - r * 1.02,
        cx + r * 0.34, cy - r * 0.66
      ]).fill(0xf6ca46);
      g.rect(cx - r * 0.42, cy - r * 0.6, r * 0.16, r * 1.0).fill(0x7e4a28);
      g.rect(cx + r * 0.26, cy - r * 0.6, r * 0.16, r * 1.0).fill(0x7e4a28);
      break;
    default:
      break;
  }
}

// ── 工具 ────────────────────────────────────────────────────────────

/** 按比例提亮(正)/压暗(负)一个颜色 */
export function shade(color: number, amount: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount))));
  return (f(r) << 16) | (f(g) << 8) | f(b);
}
