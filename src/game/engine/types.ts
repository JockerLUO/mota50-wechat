/**
 * 引擎的**类型面** —— 引擎与外部世界（UI 层、探针、校验器）之间的契约。
 *
 * 从 `engine.ts` 拆出来的。这些接口里几乎每一行注释都在讲同一件事：
 * **引擎只描述「发生了什么」，不描述「该长什么样」**。
 * 把契约单独放一个文件，是为了让这条边界一眼可见 —— 这个文件里没有任何
 * 一个 `import` 来自 `render/`，也不会有。
 */

import type { NpcLine } from '../dialogue';

/**
 * `core/combat.mjs` 是纯 JS（要同时能被 Node 校验器与浏览器引用），
 * 这里手写它的返回形状，让 TS 侧有类型可用。
 */
export interface BattlePreview {
  canWin: boolean;
  reason: string | null;
  execute: boolean;
  effectiveAtk: number;
  appliedCounters?: string[];
  perHit: number | null;
  perRound: number;
  rounds: number | null;
  enemyAttacks: number | null;
  flanked?: boolean;
  flankChance?: number;
  hpLoss: number;
  hpLossMin: number;
  hpLossMax: number;
  remainingHp: number;
}

export type StepKind = 'move' | 'blocked' | 'battle' | 'pickup' | 'door' | 'stairs' | 'talk' | 'fakewall';

/**
 * 引擎请求 UI 打开的界面。
 * 引擎只**请求**，不知道界面长什么样 —— 它不持有任何渲染对象。
 */
export type UiKind = 'floorSelect' | 'monsterBook' | 'notebook' | 'merchant' | 'shop';

/** 一次搭话的完整描述（引擎产出，UI 只负责画） */
export interface NpcTalk {
  id: string;
  name: string;
  /** 当前该说的那一句 */
  text: string;
  /** 这句是从哪个来源取的（floor / greet / repeat / note / fallback） */
  from: NpcLine['from'];
  /** 本层是否摆着摊（决定对话框要不要给「交易」按钮） */
  canTrade: boolean;
  /** 交易面板的种类：商人按层配货，商店是属性三选一 */
  tradeKind: 'merchant' | 'shop' | null;
}

export interface StepResult {
  kind: StepKind;
  /** 勇者是否真的换了位置（渲染层据此播移动动画） */
  moved: boolean;
  /** 换层后的新楼层；未换层为 undefined */
  floorChanged?: number;
  message?: string;
  /** 撞上 NPC 时请求打开的界面（商人 / 商店） */
  openUi?: UiKind;
  /**
   * 撞上 NPC 时带出的搭话信息。
   *
   * 引擎只说「你撞到了谁、他现在说的是哪一句」，**不负责把它画出来**；
   * 是弹对话框、还是写进详情卡，由编排层决定。交易入口也从
   * `openUi` 挪到了这里 —— 先说话、玩家再决定要不要交易（原版就是这个顺序），
   * 而「说哪一句」也才有地方展示。
   */
  npc?: NpcTalk;
}

export interface UseResult {
  ok: boolean;
  message: string;
  /** 需要 UI 打开的界面 */
  openUi?: UiKind;
}

export interface EffectContext {
  /** 效果作用所在楼层（clearTerrain 的 scope 是 currentFloor） */
  floor: number;
  /** 用于日志与 UI 反馈的道具 / NPC 名 */
  source: string;
}
