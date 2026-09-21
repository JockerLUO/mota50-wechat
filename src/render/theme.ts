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

/** 怪物家族着色 —— 靠 id 关键字归类，让同类怪视觉上成组 */
export function monsterPalette(id: string): { body: number; glyph: number } {
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
