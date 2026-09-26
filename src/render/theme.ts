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
   * 自动化（tools/verify/checks/a07-panel-layout.cjs 的 A7）据此在**真的渲染树**上量出
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
  princess: { label: '主线', color: 0xdb5a9a },
  /**
   * 红魔王 —— **地图上没有他的实体**，这个条目只服务剧情台词（事件的 `say` 算子
   * 用 `speaker: 'redKing'` 取这里的颜色）。
   *
   * 为什么照样写进这张表：对话框的职能章是按 id 取色的，漏了这一条不会报错，
   * 只会静静地掉进「路人 / 灰」那一档 —— 于是首领开口说话，头上顶着一个
   * 「路人」。颜色取 `demon` 一族（见 `monsterPalette`），一眼认得出是敌方首领。
   */
  redKing: { label: '首领', color: 0xa32a3a }
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

// ── 塔的位面 ────────────────────────────────────────────────────────
//
// 「主界面」（棋盘与面板背后那层场景）要表达的是**塔的位面**：抬头是星空，
// 低头是绝地。而这两样东西必须随楼层变化 —— 否则 50 层塔从地底打到星界，
// 背景却一动不动，「位面」就只是一张壁纸。
//
// 做法：每个位面给一组锚点色 + 一个**地平线高度**（大地占画面的比例），
// 全塔连续插值。于是第 1 层大地压顶、第 50 层星空为主，中间平滑过渡。
//
// 面板的卡片底色也在这里：它随位面**微调**（暖白 → 冷白），幅度刻意压得很小。
// 短条（ACCENT）**不参与**——它是「职责色」（状态=蓝、道具=金），
// 让它随楼层变会把上一轮建立的「颜色即职责」那套识别规则毁掉。

export interface Realm {
  id: string;
  name: string;
  /** 楼层区间（闭区间），只用于给玩家一个说法；配色是连续插值的 */
  from: number;
  to: number;
  /** 天顶色 */
  sky: number;
  /** 近地平线的天色（比天顶暖一点，模拟大气散射） */
  skyLow: number;
  /** 地平线辉光 */
  haze: number;
  /** 绝地：最远一层（受天光，最亮） */
  ground: number;
  /** 绝地：中间一层 */
  groundMid: number;
  /** 绝地：最近一层（最暗，压在下缘） */
  groundNear: number;
  /** 地平线占画布高度的比例。**越小＝地平线越高＝星空占比越大** */
  horizon: number;
  /** 星点密度 0..1 */
  stars: number;
  /** 卡片底色（随位面微调，保持浅色可读） */
  card: number;
  /** 卡片描边色 */
  cardEdge: number;
}

/**
 * 五个位面锚点（1–10 / 11–20 / … / 41–50）。
 *
 * 锚点之间按**位面中心**（5.5 / 15.5 / 25.5 / 35.5 / 45.5）线性插值，
 * 所以 50 层每一层的背景都不一样，且跨档不跳变。
 */
export const REALMS: Realm[] = [
  {
    id: 'depth', name: '地底', from: 1, to: 10,
    sky: 0x090e20, skyLow: 0x24304f, haze: 0xa9704a,
    ground: 0x3b2b22, groundMid: 0x2a1e19, groundNear: 0x16100d,
    horizon: 0.62, stars: 0.30,
    card: 0xfdf9f3, cardEdge: 0xe4d6c4
  },
  {
    id: 'bastion', name: '石堡', from: 11, to: 20,
    sky: 0x0a1230, skyLow: 0x27325e, haze: 0x8b7c94,
    ground: 0x39303a, groundMid: 0x27212b, groundNear: 0x141119,
    horizon: 0.50, stars: 0.48,
    card: 0xfbf9f6, cardEdge: 0xdfd7d0
  },
  {
    id: 'spire', name: '高塔', from: 21, to: 30,
    sky: 0x0a1440, skyLow: 0x2a3a78, haze: 0x94a0e4,
    ground: 0x2f3448, groundMid: 0x1f2334, groundNear: 0x101322,
    horizon: 0.38, stars: 0.66,
    card: 0xf9f9fd, cardEdge: 0xd9dced
  },
  {
    id: 'skyhall', name: '云廊', from: 31, to: 40,
    sky: 0x0b1850, skyLow: 0x314596, haze: 0xb4c8ff,
    ground: 0x2b3663, groundMid: 0x1c2448, groundNear: 0x0e1330,
    horizon: 0.26, stars: 0.84,
    card: 0xf8faff, cardEdge: 0xd5dcf5
  },
  {
    id: 'astral', name: '星界', from: 41, to: 50,
    sky: 0x070d3c, skyLow: 0x2a3c96, haze: 0xd0dcff,
    ground: 0x1d2450, groundMid: 0x131838, groundNear: 0x070a20,
    horizon: 0.16, stars: 1.0,
    card: 0xf7f9ff, cardEdge: 0xd2daf7
  }
];

/** 位面锚点的楼层中心 —— 插值就发生在相邻两个中心之间 */
const REALM_CENTERS = REALMS.map((r) => (r.from + r.to) / 2);

/** 某层的位面视图：色与比例都已插值好，直接用 */
export interface RealmView {
  /** 最近锚点在 REALMS 里的下标 */
  index: number;
  id: string;
  name: string;
  /** 全塔进度 0..1（第 1 层 = 0，第 50 层 = 1） */
  t: number;
  sky: number;
  skyLow: number;
  haze: number;
  ground: number;
  groundMid: number;
  groundNear: number;
  horizon: number;
  stars: number;
  card: number;
  cardEdge: number;
}

/** 线性插值两个 0xRRGGBB 颜色（sRGB 分量直插，够用且不会产生色偏） */
export function lerpColor(a: number, b: number, t: number): number {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * 楼层 → 位面视图。纯函数，任何一层都可以随时问一次。
 *
 * 楼层被夹到 1..50：楼层浏览面板可以点到边界，夹一下比让调用方各自防御更省事。
 */
export function realmOf(floor: number): RealmView {
  const f = Math.min(50, Math.max(1, Math.round(floor)));
  const t = (f - 1) / 49;
  // 找到把 f 夹在中间的那对锚点中心；两端直接落在首/末档上
  let i = 0;
  while (i < REALMS.length - 2 && f > REALM_CENTERS[i + 1]) i++;
  const a = REALMS[i];
  const b = REALMS[i + 1];
  const kRaw = (f - REALM_CENTERS[i]) / (REALM_CENTERS[i + 1] - REALM_CENTERS[i]);
  const k = Math.min(1, Math.max(0, kRaw));
  const mix = (x: number, y: number): number => lerpColor(x, y, k);
  const num = (x: number, y: number): number => x + (y - x) * k;
  const nearest = Math.abs(f - REALM_CENTERS[i]) <= Math.abs(f - REALM_CENTERS[i + 1]) ? a : b;
  return {
    index: REALMS.indexOf(nearest),
    id: nearest.id,
    name: nearest.name,
    t,
    sky: mix(a.sky, b.sky),
    skyLow: mix(a.skyLow, b.skyLow),
    haze: mix(a.haze, b.haze),
    ground: mix(a.ground, b.ground),
    groundMid: mix(a.groundMid, b.groundMid),
    groundNear: mix(a.groundNear, b.groundNear),
    horizon: num(a.horizon, b.horizon),
    stars: num(a.stars, b.stars),
    card: mix(a.card, b.card),
    cardEdge: mix(a.cardEdge, b.cardEdge)
  };
}

/**
 * 当前位面 —— 一个**刻意的全局单值**。
 *
 * 为什么不做成参数往下传：消费它的是 `panel()` 这个**自由函数**（所有卡片都走它画底板），
 * 它没有 `this`，而把位面一路穿到每个 `panel()` 调用点，等于把版面函数
 * 和游戏状态绑死。本作是单机单场景，任何一刻只有一个位面，"当前位面"
 * 因此是个合法全局；换层时由编排层（`Game.sync`）统一 `setRealm()` 一次。
 */
let currentRealm: RealmView = realmOf(1);

export function setRealm(floor: number): RealmView {
  currentRealm = realmOf(floor);
  return currentRealm;
}

export function realm(): RealmView {
  return currentRealm;
}

// ── 塔壁石材 ────────────────────────────────────────────────────────
//
// 棋盘外围那圈「墙」必须和地图内部是同一套石头，否则一眼就看出是两块东西：
// 地图里是暖砂石地砖 + 暖褐砖墙（`assets/atlas/terrain.png` 的 floor_1 #be9f74 /
// wall_mid #433836，暗部 #222222、砖面亮部 #775c55），而这一圈原本用的是
// 冷灰蓝 #8b98ac —— 冷暖两套色系，撞在一起就是「周边是后期贴上去的」。
//
// 下面这组值取自那张墙贴图（亮部 #775c55 往暖里推一档），
// 由 tools/verify/checks/a09-wall-source.cjs 的 A9 在**截图上**核对「外檐像素与地图墙同色族」。
export const STONE = {
  /** 墙面主体 */
  face: 0x7a5c4e,
  /** 受光面（城垛顶、砖面上沿） */
  faceLit: 0x9a7a68,
  /** 背光面（砖面下沿、石基） */
  faceDark: 0x503c34,
  /** 砖缝 */
  joint: 0x2a201c,
  /** 城垛顶面 —— 朝天，最亮 */
  top: 0xb08e78,
  /** 贴着棋盘那一圈的内阴影：让地图"嵌"进塔壁里，而不是浮在墙上 */
  inner: 0x1f1815,
  /** 塔壁外缘描边（与夜色交界） */
  edge: 0x120d0b
} as const;
