/**
 * 渲染层回归测试 —— 在**真实浏览器 + 真实 WebGL** 里跑，不是读代码。
 *
 * ## 为什么要这个测试
 *
 * 前面几轮踩的坑有个共同点：**代码读起来是对的，画面上是错的。**
 *   · 假墙漏洞：`terrainKeyFor` 里 `key === '1'` 这个写法，只有拿真墙去对照才发现
 *     假墙拿不到压顶 —— 光看渲染代码看不出来。
 *   · 地面重复：变体函数写对了，但 `paintCell` 根本没调用它，代码也「看起来很对」。
 *   · 怪物浮空：素材帧底留白是 0（构建期断言），但渲染层把精灵摆在哪，只有量出来才知道。
 *
 * 所以这里的每条断言都拿**两个独立来源**对撞：
 *   · 期望值：Node 侧从 `data/floors/*.json` + `assets/manifest.json` **重新实现**一遍
 *     规则算出来（不是 import 渲染层的函数）。
 *   · 实测值：浏览器里跑起来之后，从渲染树读回真正落屏的东西。
 * 两边都是从源码派生的，但派生路径不同，所以能抓到「改了 A 忘了改 B」。
 *
 * ## 覆盖（每条对应 `tools/verify/checks/` 下的一个文件）
 *   A1 地形键：全塔每一格，渲染树里的键必须与独立推导一致
 *   A1b 调试传送不改背包：逐层 `__goto` 绕塔一圈，背包必须始终不变
 *       （`__goto` 的落点走 `nearestStandable` 的 `avoidEntities` 口径。少了它，
 *        `arriveOnFloor` 的「落地即拾取」会让 `__goto(37)` 把炸弹收进背包 ——
 *        而背十来个判据之后 A11 才变红，跨文件追不回来。这条把它钉在事故最近处）
 *   A2 假墙不泄漏：`w` 格必须与「同位置真墙」走同一条规则（隐藏通路设计的命门）
 *   A3 无空键：不许出现 `?字符` 这种「没映射」的兜底态
 *   A4 变体是活的：地面/墙身键在棋盘上确实用到了多个变体（防止变体路径被绕过）
 *   A5 怪物布局：非 BOSS 精灵装得进一格；BOSS 精灵与它**宣称占的那几格**逐边重合
 *      （占位块从 `constants.json` 的 `boss.footprintTiles` 推），且脚下**干净**
 *      （精灵之外只留 BOSS 圈；曾经画在脚下的评级色点在 2026-09-23 被要求移除）
 *   A6 BOSS 与倍数：画得比一格大的必须是玩法上的 BOSS（不许有「巨大的杂兵」）
 *   A7 面板版式：每块面板的标题落在同一套坐标上（见「统一版式」）
 *   A8 版面：模块间隙相等，棋盘没被挤小，棋盘盒与面板同栏
 *   A9 塔壁与地图内墙同源（比 source.uid，不比颜色）
 *   A10 位面：地平线随楼层单调上移、同一层可复现、背景跟随显示层
 *   A11 道具栏：空背包整块不占位，有道具时高度按件数算
 *   A12 手绘怪物：落屏用的是 monsters 图集且帧与 MANIFEST 一致（不退回程序化图形）
 *   A13 楼层浏览：选完某一层后「返回」始终可达，返回后勇者回来且输入复活
 *   A14 攻击动画：挥剑期间确实换成挥剑帧（anim 出现过 attack），而形体与尺寸**不变**，
 *       刀光/前冲由 `attackFx` 的时间轴演（帧画了却没接上会被这条抓住）
 *   A15 对话折行：台词折行不超卡片内宽、不以收尾标点开头（中文行首禁则）
 *   A16 上下楼梯：两张瓦片既不逐像素相同、也不互为上下翻转，且形体走向各就各位
 *   A17 像素密度：图集帧升到出图网格（原始素材 ×supersample）、drawScale 同比缩小，落屏尺寸不变
 *             （非 BOSS 一格 32 / 旧的「大家伙」48；BOSS 帧 = 格子 × 占位格数、1:1 落屏）
 *   A18 文字光栅化分辨率跟随设备像素比（dsf=3 时必须是 3，写死 2 会挂）
 *   A19 墙是手绘错缝砌法（调色板 ≥5 色、相邻砌层竖缝错开半块），不是第三方位图的超采样
 *   A20 待机呼吸是渲染层的刚体位移：贴图/帧高全程不变，只在原位上抬 1px
 *       （素材层再做「上半身位移 + 接缝补偿」会立刻被这条抓住）
 *   A21 BOSS 占位块：九格都走不进、撞上去即开战且一步不走、击败后整块恢复通行、
 *       领域伤害贴的是占位块而不是坐标（A5a 量画面，这条量规则）
 *   A22 BOSS 图集来自**当前**这批源图：`assets/MANIFEST.json` 记的源图 sha256
 *       与 `assets/raw/boss/*.png` 现算的逐只相等（改源图没重跑 assets 会红）
 *       —— A5a/A17/A21 管「帧摆在哪、多大、占几格」，这条管「帧是**哪来的**」
 *   A23 自动通关**接进界面**之后的三件事：按钮点得着（四颗等宽不重叠、不出界）、
 *       真的会走（步数在涨，不是只亮了个灯）、说停就停（停下后再等 1s 步数不动）
 *       —— `verify:autoplay` 只管决策器，这条管**执行器**接没接上
 *
 * 用法：node tools/verify-visual.cjs [--verbose]（先 npm run build）
 *
 * ---
 * 本文件是**入口，不是实现**。实现分三处：
 *   `tools/verify/harness.cjs`   静态服务 + 浏览器会话 + 结果收集（唯一碰浏览器的地方）
 *   `tools/verify/expect.cjs`    Node 侧独立重实现的期望值（与 atlas.ts 手工同步）
 *   `tools/verify/checks/*.cjs`  断言，一条一个文件（文件名就是断言编号）
 */

const { runAll, server } = require('./verify/harness.cjs');

/**
 * 断例清单 —— **顺序即依赖**。
 *
 * A1..A23 的编号顺序就是它们历史上的执行顺序：A13 开头那句 `press('r')`
 * 假定 A1..A12 已经把全塔跑过一遍（那会留下「巫师领域」之类的状态），
 * 而 A21 开头也按一次 `r`（它要「攻击 10 < 骷髅队长防御 15」这个干净局面）。
 * 新增断言请追加在末尾；要插在中间的话，先确认后面那些断例的隐含前置条件。
 */
const CHECKS = [
  require('./verify/checks/a01-terrain.cjs'),
  require('./verify/checks/a05-monster-layout.cjs'),
  require('./verify/checks/a07-panel-layout.cjs'),
  require('./verify/checks/a08-board-layout.cjs'),
  require('./verify/checks/a09-wall-source.cjs'),
  require('./verify/checks/a10-realm.cjs'),
  require('./verify/checks/a11-item-bar.cjs'),
  require('./verify/checks/a12-monster-art.cjs'),
  require('./verify/checks/a13-floor-browse.cjs'),
  require('./verify/checks/a14-attack-anim.cjs'),
  require('./verify/checks/a15-dialogue-wrap.cjs'),
  require('./verify/checks/a16-stairs.cjs'),
  require('./verify/checks/a17-pixel-density.cjs'),
  require('./verify/checks/a18-text-resolution.cjs'),
  require('./verify/checks/a19-wall-masonry.cjs'),
  require('./verify/checks/a20-idle-bob.cjs'),
  require('./verify/checks/a21-boss-footprint.cjs'),
  require('./verify/checks/a22-boss-source.cjs'),
  require('./verify/checks/a23-autoplay-ui.cjs')
];

runAll(CHECKS).catch((err) => {
  console.error(err);
  try {
    server.close();
  } catch {
    /* 已关 */
  }
  process.exit(1);
});
