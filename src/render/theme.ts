/**
 * 视觉令牌 —— 单一配色来源。
 *
 * 走「白昼地牢」路线：石地板是浅灰蓝，墙体是中灰板岩，UI 面板为白色卡片。
 * 好处是浅色 IDE 预览下发色稳定，且不需要美术资源也能靠明度层次区分地形。
 *
 * 数值约定（与 <regional_conventions> 一致）：本作不涉及股价涨跌，红/绿按
 * 「危险/安全」语义使用 —— 红=致命或高损失，绿=安全或可承受。
 */

export const T = {
  // 画布与面板
  canvasBg: 0xe9eef6,
  panel: 0xffffff,
  panelAlt: 0xf6f8fc,
  panelBorder: 0xd7dfeb,
  panelShadow: 0x0f172a,

  // 文字
  ink: 0x1e293b,
  inkMuted: 0x5b6a80,
  inkFaint: 0x93a1b5,
  onDark: 0xffffff,

  // 地板：棋盘格两档
  floorA: 0xf2f6fb,
  floorB: 0xe8eef7,
  floorGrid: 0xdde5f0,

  // 墙
  wall: 0x8b98ac,
  wallTop: 0xa8b4c7,
  wallDark: 0x6c7a8f,

  // 特殊地形
  lava: 0xe4562a,
  lavaHot: 0xf9a03a,
  space: 0x1d2a45,
  spaceStar: 0x9cc3ff,

  // 门（按钥匙色）
  doorYellow: 0xd99e0b,
  doorBlue: 0x3b82f6,
  doorRed: 0xdc2626,
  doorAuto: 0x0d9488,
  doorPrison: 0x7c3aed,

  // 楼梯
  stairUp: 0x0f9c8f,
  stairDown: 0x4f46e5,

  // 勇者
  hero: 0x2563eb,
  heroLight: 0x8ab4f8,
  heroSkin: 0xf7d9b8,

  // 语义色
  danger: 0xdc2626,
  warn: 0xd97706,
  ok: 0x15a34a,
  info: 0x2563eb,
  gold: 0xd99e0b,

  // 交互
  select: 0x2563eb,
  hover: 0x94a3b8,
  hidden: 0xb45309
} as const;

/**
 * 版式令牌 —— 「同一种风格」的单一来源。
 *
 * ## 为什么要有这个（而不是各处自己写数字）
 *
 * 状态栏、详情卡、道具栏、交易浮层、对话框原本各写各的圆角与内边距
 * （16 / 12 / 10 混用），结果就是「看起来像不同人做的」。
 * 这些数字本身没有对错，**不统一**才是问题。所以集中在这里，
 * 任何一块新面板都从这里取值，不写字面量。
 *
 * 风格取向：白卡片 + 1px 冷灰描边 + 极浅投影 + 左上角一道 3px 主题色短条。
 * 短条是唯一的「花哨」元素，用颜色给面板分工（状态=蓝、道具=金、对话=角色色），
 * 其余全一致 —— 这样既统一又能一眼分辨面板职责。
 */
export const UI = {
  /** 面板圆角 */
  radius: 14,
  /** 面板内部小控件（槽位、按钮、条）的圆角 */
  radiusInner: 10,
  /** 描边宽度 */
  border: 1,
  /** 面板内边距 */
  pad: 14,
  /** 标题左侧主题色短条 */
  accent: { w: 3, h: 16, x: 12, y: 14 },
  /**
   * 标题行落点 —— 横向固定在短条右缘 +8，纵向按字号各自「视觉居中于短条」。
   *
   * 这三个数是**唯一口径**：之前六块面板各写各的（`+UI.pad`(14) 与
   * `+accent.x+accent.w+8`(23) 两种横向混用），而选 14 的那块会把标题
   * 压到短条上（短条占 12..15）—— 差 1px 看不出来，但「六块面板两套版式」
   * 是能看出来的。纵向的 12 / 14 不是随手差 2px：大标题(15px)与小标题(12.5px)
   * 的行盒高度不同，各自减去行盒半高才对得齐短条中线。
   */
  titleX: 23,
  titleYTitle: 12,
  titleYHead: 14,
  /**
   * 渲染树标记。面板容器打 `panel:<id>`、它的标题 Text 打 `panelTitle` ——
   * 自动化（tools/verify-visual.cjs 的 A7）据此在**真的渲染树**上量出
   * 「每块面板的标题落在哪里」，而不是读源码里写了什么。
   * 两个字符串只有这一处定义：打标记和读标记用同一份，改名字不会只改一边。
   */
  tag: {
    /** 面板容器：`panel:<id>` */
    panel: 'panel:',
    /** 面板标题 Text */
    title: 'panelTitle',
    /**
     * 卡片矩形（`{x,y,w,h}`）—— 面板把**自己传给 `panel()` 的那一组数**回填到
     * 这个属性上，供 `Game.__panels()` 换算「标题离卡片左上角多远」。
     *
     * 为什么需要回填：这些面板的坐标是**绝对设计坐标**（容器的 children 直接
     * 用 LAYOUT 里的 x/y，容器自己在 0,0），也没有一个「卡片锚点」子节点 ——
     * 所以「相对卡片」这个量在渲染树里根本推不出来，而不比对它就抓不住
     * 「标题压到短条上」这类偏移。回填的是同一个调用里画短条的那组数，
     * 因此偏离仍然会被抓到。
     */
    rect: 'cardRect'
  },
  /**
   * 投影：用几层极浅的偏移圆角块伪装。
   *
   * Pixi 核心没有投影滤镜（DropShadowFilter 在 pixi-filters 里，本项目没装，
   * 而且小游戏端多一个滤镜就多一份 GPU 开销）。4% 上下的三层叠加在浅色底上
   * 已经足够把卡片「托起来」，代价只是几个 Graphics 指令。
   */
  shadow: [
    { dy: 1, alpha: 0.055 },
    { dy: 2, alpha: 0.035 },
    { dy: 3, alpha: 0.02 }
  ],
  /** 字号阶梯 —— 只允许用这几档，避免 12 / 12.5 / 13 这种看不出差别的存在 */
  fs: {
    /** 楼层徽章里的数字 */
    badge: 22,
    /** 面板大标题 */
    title: 15,
    /** 面板小标题 / 按钮 */
    head: 12.5,
    /** 正文 */
    body: 11.5,
    /** 副信息 */
    label: 10.5,
    /** 数值 */
    value: 14
  }
} as const;

/** 面板主题色（左上角短条 + 标题色）—— 同一套版式，用颜色区分职责 */
export const ACCENT = {
  status: T.hero,
  detail: 0x64748b,
  items: T.gold,
  dialogue: T.hero
} as const;

/** 卡片矩形（设计坐标）。面板回填给 `UI.tag.rect`，供 `Game.__panels()` 换算标题偏移 */
export type PanelRect = { x: number; y: number; w: number; h: number };

export function hex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

/** 战斗预判配色：与 core/combat.mjs 的 grade() 返回值一一对应 */
export const GRADE_STYLE: Record<string, { label: string; color: number }> = {
  execute: { label: '一击必杀', color: T.ok },
  easy: { label: '轻松', color: T.ok },
  ok: { label: '可接受', color: 0x2f9e6f },
  high: { label: '损失偏大', color: T.warn },
  danger: { label: '危险', color: 0xe0592a },
  fatal: { label: '必死', color: T.danger },
  blocked: { label: '打不动', color: 0x7c3aed }
};

/**
 * NPC 职能标识 —— 颜色与职能名的**单一来源**。
 *
 * 三处消费它：棋盘上 NPC 脚下的名牌底、棋盘上的职能徽章、对话框头部的职能章。
 * 之前 board.ts 自己藏了一份 `NPC_COLOR`（只有颜色、没有职能名），
 * 于是「对话框说是交易、地图上看不出是交易」。合成一份之后改一处两边都变。
 *
 * 颜色选得不只是好看：**同一职能在整座塔里颜色恒定**，
 * 玩家因此能靠颜色一眼分辨「这个人是卖东西的」还是「这个人是给情报的」。
 */
export const NPC_ROLE: Record<string, { label: string; color: number }> = {
  sage: { label: '指引', color: 0x3b6fd4 },
  merchant: { label: '交易', color: 0xd99e0b },
  shop: { label: '属性', color: 0x15a34a },
  thief: { label: '情报', color: 0x6b7280 },
  fairy: { label: '祝福', color: 0x38bdf8 },
  princess: { label: '主线', color: 0xdb5a9a }
};

export function npcRole(id: string): { label: string; color: number } {
  return NPC_ROLE[id] ?? { label: '路人', color: 0x64748b };
}

/** 怪物家族着色 —— 靠 id 关键字归类，让同类怪视觉上成组 */export function monsterPalette(id: string): { body: number; glyph: number } {
  const s = id.toLowerCase();
  const fam: [string[], number][] = [
    [['slime'], 0x4a9d5f],
    [['bat'], 0x7c5cc4],
    [['skeleton', 'ghost', 'phantom'], 0x8a8578],
    [['mage', 'wizard', 'archmage'], 0x3f6fd4],
    [['guard'], 0x5b6b86],
    [['knight', 'swordsman', 'warrior', 'orc'], 0xb0553f],
    [['golem'], 0x8a6a45],
    [['kraken'], 0x2f7d8f],
    [['demon'], 0xa32a3a],
    [['dragon'], 0x8e3ba8]
  ];
  for (const [keys, color] of fam) {
    if (keys.some((k) => s.includes(k))) return { body: color, glyph: T.onDark };
  }
  return { body: 0x64748b, glyph: T.onDark };
}
