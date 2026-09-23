/**
 * 棋盘的公共类型 —— 朝向、实体视图、外部钩子。
 *
 * 从 `board.ts` 拆出来的原因很实际：这三样是**别人也要读**的东西
 * （`app/` 传钩子进来、校验脚本读实体视图的形状），而其余部分
 * （塔壁怎么画、地砖怎么铺）纯属 Board 的私事。
 * 把这层契约单独放，是为了让「棋盘对外承诺了什么」一眼可见。
 */

import type { Container, Sprite } from 'pixi.js';
import type { Dir } from '../../game/state';

/**
 * 勇者朝向名，与 MANIFEST 的 dirOrder 一致。
 *
 * 直接等于引擎的 `Dir`（`'up' | 'down' | 'left' | 'right'`）而不是另立一套同形字面量：
 * `playHeroAttack(dir)` 要接玩家按键的方向，两套类型虽然结构相同，
 * 但分开写就多了一个「改了这边忘了那边」的位置。
 */
export type Facing = Dir;

/** 朝向 → 单位向量。四处都在用（前冲方向、刀光轴、目标格定位），只写一次 */
export const FACING_VEC: Record<Facing, [number, number]> = {
  down: [0, 1],
  right: [1, 0],
  up: [0, -1],
  left: [-1, 0]
};

/** 刀光轴方向（弧度，屏幕坐标 y 向下） */
export const FACING_ANGLE: Record<Facing, number> = {
  right: 0,
  down: Math.PI / 2,
  left: Math.PI,
  up: -Math.PI / 2
};

export interface EntityView {
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
  /**
   * 呼吸位移的基准 y（落屏像素）。精灵的实际 y = `restY - 0|1`。
   * 只在渲染层做刚体位移 —— 见 `bob.ts` 的说明。
   */
  restY?: number;
}

export interface BoardHooks {
  /** 悬停到某格；null 表示移出 */
  onHover?: (x: number, y: number) => void;
  onClick?: (x: number, y: number) => void;
  // 这里原本还有一个 `gradeFor`，只服务于怪物脚下的评级指示灯。
  // 那颗指示点 2026-09-23 被玩家要求移除（见 Board.makeEntityView 里 standY 的说明），
  // hook 随之删掉 —— 留一个没人读的回调，下次读代码的人会以为脚下还有点。
}
