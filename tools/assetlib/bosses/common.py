"""
BOSS 素材的公共层：网格、共享骨架原语、断言门面。

## 为什么 BOSS 单独立一层，而且现在是一个包

① **落屏规则与杂兵不同。** `BOSS_DRAW_SCALE` 恒为 1.0（绘制网格 1:1 落屏），
   而 `MONSTERS` 表里那一列对它们统一写 1 —— **故意留着误导不了的写法**：
   写 3 会让人以为改那里能放大 BOSS。这条有断言兜底。

② **从 2026-09-24 起占位与尺寸一起变了。** 玩家要求「BOSS 更大更精致、
   而且它在棋盘上占的地方要变大、挡住去路」。于是：

   | | 改前 | 改后 |
   |---|---|---|
   | 绘制网格 | 64 | **96**（= 格子 32 × 占位 3） |
   | 落屏 | 64px（2 格） | **96px（3 格）** |
   | 棋盘占位 | 自己那 1 格 | **3×3 格，九格都不可走进** |

   96 网格是**按占位格数算出来的**，不是拍脑袋：`BOS_W = CELL × BOSS_TILES`，
   而 `BOSS_TILES` 读的是 `data/constants.json` 的 `boss.footprintTiles` ——
   玩法、渲染、素材三方共用同一个数字，构建期有断言钉住它。

③ **一个 BOSS 一个文件。** 改一只 BOSS（造型 + 配色 + 它占哪几个 id）只碰一个文件。
   这一层只放**真的被两只以上共用**的东西，放过一次性的东西会让「改一只只看一处」
   这个好处慢慢消失。

## 「画得比一格大」是刻意的

大块头本身是层级信号。96px 的精灵正好覆盖它 3×3 的占位块（精灵中心 = 格子中心、
脚踩占位块的下沿），所以「画出来的范围」与「走不进去的范围」在屏幕上是同一块 ——
这正是玩家要的那个读法。渲染层据此摆放，A5a 与 A21 两条判据盯着它。
"""

from __future__ import annotations

import json

from ..config import CELL, ROOT
from ..metrics import _detail_density, _head_asym, _inner_detail, _solid_set
from ..palette import MON_INK
from ..pixel import _put, add_outline
from ..pil import Image
from ..shapes import (
    _beam,
    _beam_sym,
    _ell,
    _gem,
    _rivets,
    _scales,
    _sym,
    _wing_draw,
    _wing_fan,
)


# ════════════════════════════════════════════════════════════════════
# 一、网格与门槛
# ════════════════════════════════════════════════════════════════════

def _footprint_tiles() -> int:
    """
    从 `data/constants.json` 读 BOSS 占位边长（格）。

    ## 为什么素材构建要去读游戏数据

    这个数字有**三个消费者**，而它们分处三套语言：
      · 素材（本包）：绘制网格 = CELL × 本值；
      · 渲染层（`board/index.ts`）：精灵落屏尺寸 = CELL × 本值；
      · 引擎（`game/state.ts`）：哪几格走不进去。

    三处各写一个 3 的后果是**它们可以各自漂移**：把占位改成 2 而忘了改绘制网格，
    画面会变成「精灵比占位块大一圈」—— 而这是那种「看着有点怪但没人说得清哪里怪」
    的缺陷。所以真值只有一份（在 data/ 里），另外两处读它。
    """
    const = json.loads((ROOT / "data" / "constants.json").read_text(encoding="utf-8"))
    try:
        return int(const["boss"]["footprintTiles"])
    except (KeyError, TypeError, ValueError) as exc:  # pragma: no cover - 数据缺失时给一条人能读懂的错
        raise SystemExit(
            "data/constants.json 里读不到 boss.footprintTiles —— BOSS 的绘制网格、"
            "落屏尺寸、棋盘占位三方都靠这个数，缺了它无法继续（也不该猜一个默认值）。"
        ) from exc


BOSS_TILES = _footprint_tiles()

# BOSS 的绘制网格：**一个源像素 = 一个落屏像素**（1:1），所以它就是落屏尺寸。
# 不做「画完再缩到非整数倍」——nearest 采样下每 4 列丢 1 列，1px 的轮廓线会时断时续
# （改前那 4 只大 BOSS 发糊就是这个原因）。
BOS_W = BOS_H = CELL * BOSS_TILES

# 镜像轴：`_sym` 的搭档恒为 `W - x - w`，所以轴在 W/2 = 48.0 ——
# `_ell(cx=48)` 与 `_sym` 因此天然一致（都对称于 x=48 那条格线）。
BOS_CX = BOS_W // 2

# 落屏倍数：**恒为 1.0**（96 网格 1:1 落屏 96px）。
BOSS_DRAW_SCALE = 1.0

# ── `verify_boss_art` 的门槛：四个都是「先量、再定」的 ──────────────
#
# 每一版素材都必须重新量改前/改后的分布，把阈值定在**改前必红、改后有余量**
# 的位置，否则它只是一条永远为真的装饰性断言。
#
# 2026-09-24 的实测（96 网格这一版，改前 = 64 网格的 `_old_bosses`）：
#
#            密度(块=网格/8)      内部细节(块=网格/16, 腐蚀=网格/32)
#   id        改前   改后          改前   改后
#   skeleton   3.00   4.00          2.18   2.89
#   knight     3.00   5.00          1.97   2.74
#   vampire    3.00   4.00          1.98   2.70
#   archmage   4.00   5.00          2.24   2.81
#   kraken     3.00   4.00          1.98   2.92
#   dragon     4.00   4.00          2.28   2.51
#   demonKing  4.00   4.00          2.28   2.47
#   demonTrue  3.00   4.00          2.01   2.51
#
# BOSS_DETAIL_MIN：每个（网格/8）² 块的**中位**独立颜色数。
#   块大小按网格缩放（96 网格 → 12×12），量的是**同一块相对面积**，所以
#   64 网格时代的读数与现在的可以直接比。
#   ⚠️ **这个量是整数中位数，分辨率就是 1** —— 所以「门槛 3.5」与「门槛 4」
#   在行为上**完全等价**（3.5 只会被 ≥4 的中位数满足）。写 3.5 而不是 4.0，
#   是为了让「差一个整数档就报红」这件事在数字上成立、而不是靠读者去推。
#   区分力：改前 5/8 红（skeleton/knight/vampire/kraken/demonTrue 都停在 3.00）。
#   另外 3 只（archmage/dragon/demonKing）**在旧版就已经是 4.00**，这条判据
#   对它们没有区分力 —— 不假装它全红；那 3 只由内部细节那条守着。
# BOSS_INNER_MIN：只统计**身体内部**（离透明边缘 ≥margin）的（网格/16）² 块，
#   取均值。为什么要它：大块的密度里**轮廓线**贡献很大，「边缘花哨、内部偷懒」
#   也能过线。区分力更硬：**改前 8/8 红**（旧版 1.97~2.28，全部低于门槛），
#   改后最小 2.47（demonKing）—— 余量 0.07，按 132 个块算约 9 个块·色的余量。
# BOSS_HEAD_SYM_MAX：正面朝向的 BOSS，头部区域的不对称像素占比上限。
#   头部区域按**画布高度的比例**取（见 `metrics._head_asym`）—— 写死行数会在
#   换网格时静默量错区域。
#   上限定在 2% 是**故意的**：它刚好卡在「半像素镜像偏差」之下。旧稿用 `_ell`
#   画居中/成对的形体，每行差 1px，读数就是 dragon 2.2% / kraken 2.3%
#   （即这条判据的存在理由本身）。现在四只全部是 **0.0%** —— 成对结构走 `_sym`、
#   居中的走 `bar_sym`，误差不是「被容忍」，而是**不存在**。
# BOSS_SIL_MIN_DIFF：两只 BOSS 剪影至少差这么多像素。阈值随网格面积走
#   （64² 时代的 400 → 96² 按面积比 2.25 折是 900；实测后取 1500）。
#   区分力：**改前 28/28 对全红**（旧版最小 447，demonKing vs demonKingTrue），
#   改后最小 1732（knightCaptain vs vampire，两只人形的最近一对）。
BOSS_DETAIL_MIN = 3.5
BOSS_INNER_MIN = 2.40
BOSS_HEAD_SYM_MAX = 0.02
BOSS_SIL_MIN_DIFF = 1500

# 哪些 BOSS 是**正面朝向玩家**的（头部对称度判据只对它们生效）。
#
# 名单写死、而不是「对所有 BOSS 都量对称度」：骷髅队长手持圆盾、骑士队长
# 手持大剑、法师抱着法杖、吸血鬼**刻意**做成不对称（竖领一高一低、斗篷偏披）
# —— 这些是合法的不对称，全局判据会把它们全部误杀。
# 往名单里加一只之前，先确认它的不对称**全部**来自剧情道具或刻意的站姿。
HEAD_FRONT = ("dragon", "demonKing", "demonKingTrue", "kraken")


def bos_canvas() -> Image.Image:
    return Image.new("RGBA", (BOS_W, BOS_H), (0, 0, 0, 0))


def finish(im: Image.Image) -> Image.Image:
    """收尾：描边。**所有** BOSS 都走这一个出口。

    画布尺寸也在这里复核 —— 造型函数忘了用 `bos_canvas()` 时（比如自己
    `Image.new` 成 64 网格），会在这里当场暴露，而不是等到 `verify_boss_art`
    的判据 1 去猜「是不是退回了杂兵造型」。
    """
    if (im.width, im.height) != (BOS_W, BOS_H):
        raise AssertionError(
            f"BOSS 造型画布是 {im.width}×{im.height}，应为 {BOS_W}×{BOS_H}"
            f"（= 格子 {CELL} × 占位 {BOSS_TILES} 格）—— 造型函数要用 bos_canvas()"
        )
    return add_outline(im, MON_INK)


# ════════════════════════════════════════════════════════════════════
# 二、关于镜像轴精确对称的原语
# ════════════════════════════════════════════════════════════════════
#
# ## 为什么不能直接用 `shapes` 的 `_ell` / `_half` / `_gem` 画**居中**的东西
#
# 偶数宽画布的翻转轴落在**像素之间**：像素 i 的搭档是 `W-1-i`，所以轴在
# `(W-1)/2 = 47.5`。而 `_ell` 每行画的是 `2*hw+1` 个像素（**奇数**宽），
# 奇数宽的块只能对称于某个**像素中心**（整数轴）—— 两者差半个像素。
#
# 实测后果：`ell(cx=48, rx=20)` 覆盖 28..68，翻转后是 27..67，**每行差 1px**。
# 在 `_head_asym` 上表现为 ~2%，被 12% 的阈值容忍掉了 —— 也就是说这条
# 「正面朝向的 BOSS 必须左右对称」的判据，量的是一个**天生歪 1px 的形体**。
# 容忍不等于对：阈值是为了容错，不是为了盖住一个我们自己制造的偏差。
#
# 所以成对的用 `_sym`（它本来就是精确的：i 与 W-1-i 一一对应），
# 居中的用下面这三个 —— 宽度一律取**偶数** `2*half+2`，跨度 `[47-half, 49+half)`，
# 端点之和恒为 96，天然关于轴精确对称。


def bar_sym(im, y, half, color, h=1):
    """
    关于镜像轴对称的横条：跨度 `[47-half, 49+half)`，宽 `2*half+2`（偶数）。

    `half = -1` 表示宽 0（这一行什么都不画）—— 椭圆收尖时用得上，
    省掉调用方的 if。
    """
    if half < 0:
        return
    _sym(im, BOS_CX - 1 - half, y, half + 1, h, color)


def ell_sym(im, cy, rx, ry, color):
    """关于镜像轴精确对称的实心椭圆（`_ell` 的对称版）。"""
    import math

    if rx <= 0 or ry <= 0:
        return
    for y in range(max(0, int(math.floor(cy - ry))), min(im.height, int(math.ceil(cy + ry)) + 1)):
        dy = (y + 0.5 - cy) / ry
        if abs(dy) >= 1:
            continue
        bar_sym(im, y, int(round(rx * math.sqrt(max(0.0, 1 - dy * dy)))), color)


def half_sym(im, cy, rx, ry, color, up=True):
    """椭圆的上半或下半（对称版）—— 盔顶、帽檐、下颌、外套膜底缘用。"""
    import math

    ys = (range(max(0, int(cy - ry)), int(cy)) if up
          else range(int(cy), min(im.height, int(math.ceil(cy + ry)) + 1)))
    for y in ys:
        dy = (y + 0.5 - cy) / ry
        if abs(dy) >= 1:
            continue
        bar_sym(im, y, int(round(rx * math.sqrt(max(0.0, 1 - dy * dy)))), color)


def ell_pair(im, cx, cy, rx, ry, color):
    """
    一对**左右精确镜像**的椭圆，左心在 `cx`、右心在 `96-cx`。

    ## 为什么不能写两次 `_ell`

    `_ell` 落的是 `[round(cx-rx), round(cx+rx)]` —— 它按**连续中心**取整，
    所以在偶数宽画布上，`_ell(cx=16, rx=14)` 给 `[2,31)`，而它该有的镜像
    `[65,94)` 会被 `_ell(cx=80)` 算成 `[66,95)`，**差 1px**。

    这一像素在落屏之后就是「两边肩膀不一样宽」「两只眼睛一高一低」——
    而剪影判据量的是总差异像素，抓不到这种错位（本项目已经在这上面栽过：
    旧稿的腿、脚、手臂、角各有几处手写成对坐标，差 1~7 列）。

    本函数逐行取左侧区间再走 `_sym`，而 `_sym` 的镜像恒为 `[W-x-w, W-x)`，
    两块中心之和恰好是 `W = 96` —— **精确**。

    要求 `cx + rx <= BOS_CX`（只画左半）；居中的形体请用 `ell_sym`。
    """
    import math

    if rx <= 0 or ry <= 0:
        return
    for y in range(max(0, int(math.floor(cy - ry))), min(im.height, int(math.ceil(cy + ry)) + 1)):
        dy = (y + 0.5 - cy) / ry
        if abs(dy) >= 1:
            continue
        hw = int(round(rx * math.sqrt(max(0.0, 1 - dy * dy))))
        _sym(im, int(round(cx - hw)), y, 2 * hw + 1, 1, color)


def diamond_sym(im, cy, r, color, hi=None):
    """
    关于镜像轴对称的菱形宝石（`_gem` 的对称版）。

    为什么是菱形而不是圆：缩到几像素时圆读成一个脏点，而菱形的四个尖角还留着，
    是**唯一能在小方块里同时给出「亮色 + 底色 + 高光」三色**的形状。
    """
    for k in range(-r, r + 1):
        bar_sym(im, cy + k, r - abs(k), color)
    if hi:
        _put(im, BOS_CX - 1, cy - r + 1, 2, 1, hi)


# ════════════════════════════════════════════════════════════════════
# 三、被两只以上 BOSS 共用的骨架原语
# ════════════════════════════════════════════════════════════════════

def flare(im, *, top, rows, half0, slope, base, dark, light, step=9, fold_w=3):
    """
    喇叭形下摆 —— 披风 / 斗篷 / 长袍共用的一套「随宽度走」的褶皱。

    ## 为什么必须返回每行的半宽

    褶线若写成**固定 x 的竖线**，在窄处会落到下摆外面、在宽处会堆在中间。
    这个 bug 在本项目出现过**两次**（法师袍褶、吸血鬼斗篷褶），两次都是
    「一眼看着像脏点」而查不出原因。所以这里把每行的半宽返回出去，
    褶子由本函数按宽度现场算，调用方不需要、也不该自己猜 x。

    ## 三阶化不是修饰

    只压一层暗褶的话，每个块里永远只有「底色 + 暗色」两种颜色，细节密度卡在
    2.0 上不去；`dark` 旁边紧贴一条 `light` 亮线之后，同一块里才出现第三色。
    BOSS_INNER_MIN 那条判据量的就是这件事。

    ## 没有 `cx` 参数，是刻意的

    下摆一定**跨镜像轴**（每一行都从左边缘拉到右边缘），所以它只有一种画法：
    `bar_sym`，宽度取偶数 `2*half+2`、跨度 `[47-half, 49+half)` —— 端点之和恒为 96。
    留一个 `cx` 参数只会让人以为「可以画一个偏心的下摆」，而偏心下摆在偶数宽
    画布上必然歪 1px（`_put(cx-hw, …, 2*hw+1, …)` 的中心是 `cx+0.5`，不是 `cx`）。
    """
    halves = []
    for k in range(rows):
        hw = half0 + int(round(k * slope))
        bar_sym(im, top + k, hw, base)
        halves.append(hw)
        if step <= 0:
            continue
        # 褶：在**左半**按宽度取位置，右半由 `_sym` 出来（所以左右严格镜像）。
        # 亮线画在折的**外侧**（`x-1`），否则镜像之后两边的亮线会一里一外。
        # 起止都留 3px 边距，否则褶会盖掉下摆自身的轮廓。
        for x in range(BOS_CX - hw + 3, BOS_CX - 6, step):
            _sym(im, x, top + k, fold_w, 1, dark)
            _sym(im, x - 1, top + k, 1, 1, light)
    return halves


def pauldron(im, *, cy, x_off, rx, ry, plate, dark, light, studs=3):
    """
    肩甲：**受光面 + 叠甲缝 + 边缘铆钉**三层。左右严格镜像。

    为什么不是「一块整板」：整板在 96 网格上是一整块纯色，而密度判据量的正是
    「同一个块里有几种颜色」。加一道缝 + 一块受光面，同一个 12×12 块里立刻
    有板色 / 缝色 / 高光三色 —— 这是「更精致」在像素层面最省成本的一条。

    `x_off` 是肩心离镜像轴的距离，**由调用方给**而不是由 `rx` 推 ——
    推出来的写法会让「肩甲变宽」顺带把肩位往外挪，两个本该独立的量绑在一起。

    ⚠️ 右肩是**镜像出来的**，不是「在右边再用 `_ell` 画一遍」。旧写法
    （`_ell(cx=BOS_CX+x_off, …)`）在偶数宽画布上左右差 1px：左肩 `[2,31)` 的
    镜像应是 `[65,94)`，而 `_ell(cx=80)` 给的是 `[66,95)` —— 落屏后读作
    「两边肩膀不一样宽」。
    """
    cx = BOS_CX - x_off                       # 左肩中心
    ell_pair(im, cx, cy, rx, ry, plate)
    # 受光面（偏上）：读起来是「肩膀朝上的那一面」
    ell_pair(im, cx, cy - ry * 0.34, rx * 0.66, ry * 0.62, light)
    # 叠甲缝：一道横线把甲片分成上下两层
    _sym(im, cx - rx + 2, cy + int(ry * 0.34), 2 * rx - 3, 1, dark)
    # 下缘暗边：让甲片「落」在手臂上，而不是浮着
    _sym(im, cx - rx + 1, cy + ry - 1, 2 * rx - 1, 1, dark)
    # 边缘铆钉：均分，不手写坐标（手写必然左右差 1 列）
    span = max(1, 2 * rx - 6)
    for k in range(studs):
        _sym(im, cx - rx + 3 + (k * span) // max(1, studs - 1),
             cy + int(ry * 0.34) - 4, 1, 1, light)


def wing_pair(im, *, shoulder, fan, rib, mem, edge=4, spots=()):
    """
    一对膜翼（魔龙 / 魔王共用）。

    `fan` 直接透传给 `shapes._wing_fan`（那套剖面法本身就是网格无关的）：
    前缘线性上收、后缘线性上收 + 指骨齿。`edge` 是前缘厚度，
    `spots` 是膜上的暗斑（膜不能是一整块纯色 —— 那正是密度判据抓的东西）。

    ⚠️ 齿深必须 ≥ 5（96 网格）。`add_outline` 是 1px 八邻域膨胀，
    1~2 行的锯齿会被描边**直接填平**，等于没画。
    """
    cols = _wing_fan(*fan)
    _wing_draw(im, shoulder, cols, rib, mem, edge=edge, mirror=True)
    for (x, y, w, h) in spots:
        _sym(im, x, y, w, h, rib)


def horn_pair(im, *, segs, color, thick, rings=()):
    """
    分段巨角（魔龙 / 魔王共用）：只写左半，右半由 `_sym` 出来。

    `segs` 是 `(x0, y0, x1, y1, thick)` 的序列，从**角根**到**角尖**。
    分段而不是一条曲线：像素画里「角有几节」是它最好认的特征，
    而单段长角在缩到一半大小之后就是一根平滑的棍子。
    `rings` 是环纹的 y（在角身上压一道暗线，读作「年轮」）。
    """
    for (x0, y0, x1, y1, th) in segs:
        _beam_sym(im, x0, y0, x1, y1, th, color)
    for (x, y, w, th) in rings:
        _sym(im, x, y, w, th, (max(0, color[0] - 46), max(0, color[1] - 46),
                               max(0, color[2] - 46), color[3]))


def scale_band(im, *, x0, y, cols, rows, step, base, dark, light=None, mirror=False):
    """
    错行铺的**鳞甲/铆钉带** —— 「更精致」的主力，也是密度判据最直接的输入。

    细节密度最大的杀手是**一整块纯色**（每块只有 1 色）。错行铺一层鳞片立刻
    把同一块变成 2~3 色。错行（而不是方格阵）是因为方格阵落屏后读成「网格纸」。
    `dark` 压在鳞片下缘、`light` 压在左上角，一条带里就有三阶。
    """
    for r in range(rows):
        off = step // 2 if r % 2 else 0
        for c in range(cols):
            x, yy = x0 + c * step + off, y + r * step
            if mirror:
                _sym(im, x, yy, 2, 2, base)
                _sym(im, x, yy + 1, 2, 1, dark)
                if light:
                    _sym(im, x, yy, 1, 1, light)
            else:
                _put(im, x, yy, 2, 2, base)
                _put(im, x, yy + 1, 2, 1, dark)
                if light:
                    _put(im, x, yy, 1, 1, light)


def stud_ring(im, *, cx, cy, rx, ry, n, color):
    """沿椭圆一周打一圈铆钉（圆盾 / 胸甲的边缘用）。角度均分，不手写坐标。"""
    import math

    for k in range(n):
        a = 2 * math.pi * k / n
        _put(im, int(round(cx + rx * math.cos(a))), int(round(cy + ry * math.sin(a))), 1, 1, color)


def limb_pair(im, *, x0, y0, w, h, base, dark=None, light=None, edge=None, joint=None):
    """
    一对**逐像素镜像**的柱体 —— 腿 / 手臂 / 护胫 / 角柱。

    ## 为什么不能只写一条腿、再让调用方镜像

    因为 shading 也必须镜像，而且**外侧受光**这件事只有镜像才能表达对：
    左腿的受光面在它的左边、右腿的受光面在它的右边。若先画完左腿再整块 `_put`
    到右边，右腿的受光面会跑到**内侧** —— 两条腿一明一暗，看起来是「一条腿
    在阴影里」，而不是「两条腿同向受光」。所以这里每一笔画都过 `_sym`。

    ## `_sym` 为什么在这里是精确的

    `_sym` 把 `[x, x+w)` 复制到 `[W-x-w, W-x)`，两块中心之和恒为 `W = 96` ——
    偶数宽画布的镜像轴在 `x=48.0`，与 `_sym` 的 `W-x-w` 一致（见 §二的推导）。
    """
    e = edge if edge is not None else max(1, w // 5)
    _sym(im, x0, y0, w, h, base)
    if light:
        _sym(im, x0 + 1, y0, e, h, light)               # 外侧受光
    if dark:
        _sym(im, x0 + w - e, y0, e, h, dark)            # 内侧暗边
    if joint:
        step = max(5, h // 4)
        for yy in range(y0 + step // 2, y0 + h - 2, step):   # 一节一节的分段（甲片 / 骨节）
            _sym(im, x0, yy, w, 1, dark or joint)
        _sym(im, x0, y0 + h - 2, w, 2, joint)


def chest(im, *, cy, rx, ry, base, dark, light, seams=(), studs=0, stud_y=None):
    """
    对称的躯干 / 胸甲：椭圆 + 两侧压暗 + 顶部受光带 + 甲缝 + 铆钉。

    居中的形体只走 `ell_sym` / `bar_sym`；侧向的两条压暗带走 `_sym`
    （它在偶数画布上是精确的）。`seams` 是若干**相对中心的 y 偏移**，
    每条画一行暗线 —— 竖直方向没有起伏的躯干在俯视图里读成一枚棋子。

    `studs > 0` 时沿上缘均分一排 1px 铆钉，**不手写坐标**（手写必然左右差 1 列）。
    """
    ell_sym(im, cy, rx, ry, base)
    inner = rx - max(2, rx // 4)
    _sym(im, BOS_CX - rx, cy - ry // 3, max(2, rx - inner), 2 * ry // 3, dark)
    _sym(im, BOS_CX + inner, cy - ry // 3, max(2, rx - inner), 2 * ry // 3, dark)
    bar_sym(im, cy - ry + 1, max(1, rx // 3), light, h=max(2, ry // 5))
    for dy in seams:
        bar_sym(im, cy + int(dy), rx - 3, dark)
    if studs:
        y = cy - ry + 2 if stud_y is None else stud_y
        span = 2 * (rx - 4)
        for k in range(studs):
            _sym(im, BOS_CX - rx + 4 + (k * span) // max(1, studs - 1), y, 1, 1, light)


def blade(im, *, x0, y0, x1, y1, core, light, dark, thick=7, fuller=2):
    """
    一把**带血槽与刃口高光**的剑身（斜握）。

    三阶怎么来的：`core` 是剑体、`light` 压在**朝光的一侧刃口**、`dark` 压在
    另一侧 —— 只画一条均匀的斜带时，剑在 96 网格上是一根纯色棍子，
    细节密度判据会把它连同周围一起判低。`fuller` 是居中那道血槽的宽。
    """
    _beam(im, x0, y0, x1, y1, thick, core)
    _beam(im, x0, y0, x1, y1, max(1, thick // 5), light)
    _beam(im, x0 + thick - max(1, thick // 5), y0, x1 + thick - max(1, thick // 5), y1,
          max(1, thick // 5), dark)
    if fuller:
        _beam(im, x0 + (thick - fuller) // 2, y0 + 3, x1 + (thick - fuller) // 2, y1 - 3, fuller, dark)


# ════════════════════════════════════════════════════════════════════
# 四、注册表 —— 每只 BOSS 一个模块
# ════════════════════════════════════════════════════════════════════
#
# 每个模块导出三样（这就是「一只 BOSS 一个文件」的接口）：
#   IDS   该模块负责的 id 元组（`demon` 负责两个形态 —— 它们共用一套骨架）
#   spec(bid) -> dict   该 BOSS 的配色（只含它自己用到的键）
#   draw(s, bid) -> Image   造型
#
# 本模块按这张表把它们拼成 id → 造型 / 配色，`main.py` 只认这层门面。

from . import demon, dragon, knight, kraken, mage, skeleton, vampire  # noqa: E402

MODULES = (skeleton, knight, vampire, mage, kraken, dragon, demon)

_MODULE_OF: dict[str, object] = {}
for _m in MODULES:
    for _bid in _m.IDS:
        if _bid in _MODULE_OF:
            raise AssertionError(f"BOSS id {_bid} 被两个模块同时声明")
        _MODULE_OF[_bid] = _m


def boss_ids() -> tuple[str, ...]:
    return tuple(_MODULE_OF)


def boss_art_base(bid: str) -> Image.Image:
    """一只 BOSS 的静止帧（96 网格，1:1 落屏 96px）。描边语言与杂兵完全一致。"""
    mod = _MODULE_OF[bid]
    return finish(mod.draw(mod.spec(bid), bid))


def boss_art_frames(bid: str) -> list[Image.Image]:
    """BOSS 的 idle 帧 —— 与杂兵同理，**只有 1 帧**（呼吸在渲染层的刚体位移）。"""
    return [boss_art_base(bid)]


# ════════════════════════════════════════════════════════════════════
# 五、断言
# ════════════════════════════════════════════════════════════════════

# 判据的块参数与腐蚀半径**按网格缩放**（约定见 `metrics._detail_density`）。
# 写在这里而不是各判据里，是为了让「换网格要同步改哪些数」一眼可见：
# BOS_DETAIL_BLOCK / BOS_INNER_BLOCK / BOS_INNER_MARGIN 三处，
# 以及 `metrics.HEAD_BAND_RATIO`（那个按比例算，不必改）。
BOS_DETAIL_BLOCK = BOS_W // 8    # 96 → 12
BOS_INNER_BLOCK = BOS_W // 16    # 96 → 6
BOS_INNER_MARGIN = BOS_W // 32   # 96 → 3

def verify_boss_art(frames: dict[str, list[Image.Image]]) -> list:
    """
    BOSS 造型断言。**与 `verify_mon_art` 分开**，因为网格不同（96 vs 32）——
    那边所有判据都建立在 `MON_H` 上，对着 96 网格的帧会**静默量错一格量级**
    （「最后一行」量的是第 31 行，而 BOSS 的内容到第 95 行），比报错难查得多。

    ## 九条判据

      0. **绘制网格 == 格子 × 占位格数**。这条是 2026-09-24 新增的，它守的是
         「素材画多大」与「棋盘占几格」**是同一个数**：三方（素材 / 渲染 / 引擎）
         里只有素材这一侧能算出「画布对不对」，另外两侧拿到的是一个已经画好的
         帧。少了这条，把占位改成 2 而忘了改画布，画面就变成
         「精灵比占位块大一圈」—— 看着有点怪，但没有任何东西会报警。
      1. **画布必须是本网格** —— 抓「BOSS 悄悄退回 32 网格的杂兵造型」。
      2. **底行必须有像素** —— 与杂兵同理，底部锚定下帧底留白就是浮在半空。
         这里还多一层：精灵是**踩着占位块下沿**摆的，底行留白 = 整只浮起来。
      3. **每只只出 1 帧 idle** —— 呼吸是渲染层的刚体位移。
      4. **八只 BOSS 的剪影互不相同** —— 抓「画了八只结果都是同一个轮廓换色」。
         比较的是**差异像素数 ≥ 阈值**，不是「不相等」（差 1 个像素也叫不相等）。
      5. **细节密度达标**（`_detail_density`，块大小随网格缩放）。
      6. **`BOSS_IDS` 与 `data/monsters.json` 的 boss 字段一致**。
      7. **内部细节达标**（`_inner_detail`）—— 抓「边缘花哨 + 内部一整片纯色」。
      8. **正面朝向的 BOSS，头部必须左右对称**（`_head_asym`，名单见 `HEAD_FRONT`）。
    """
    problems: list[str] = []

    # 判据 0 —— 网格与占位必须来自同一个数
    if BOS_W != CELL * BOSS_TILES:
        problems.append(
            f"BOSS 绘制网格 {BOS_W} ≠ 格子 {CELL} × 占位格数 {BOSS_TILES} —— "
            f"素材画多大与棋盘占几格必须是同一个数（真值在 data/constants.json 的 "
            f"boss.footprintTiles），否则画面会出现「精灵比占位块大/小一圈」"
        )

    if set(frames) != set(boss_ids()):
        problems.append(
            f"产出的 BOSS 是 {sorted(frames)}，与注册表 {sorted(boss_ids())} 对不上"
        )
        return problems

    for bid, fs in frames.items():
        if len(fs) != 1:
            problems.append(
                f"BOSS {bid} 出了 {len(fs)} 帧 idle —— 素材里只允许静止帧。"
                f"呼吸是渲染层的刚体位移"
            )
            continue
        im = fs[0]
        if (im.width, im.height) != (BOS_W, BOS_H):
            problems.append(
                f"BOSS {bid} 的画布是 {im.width}×{im.height}，应为 {BOS_W}×{BOS_H} —— "
                f"它八成退回了旧网格的造型（造型函数忘了走 bos_canvas()？）"
            )
            continue
        if not im.crop((0, BOS_H - 1, BOS_W, BOS_H)).getchannel("A").getbbox():
            problems.append(
                f"BOSS {bid} 最后一行为空 —— 精灵是踩着占位块下沿摆的，底行留白会让它浮在半空"
            )
        d = _detail_density(im, BOS_DETAIL_BLOCK)
        if d < BOSS_DETAIL_MIN:
            problems.append(
                f"BOSS {bid} 的细节密度只有 {d:.2f}（每 {BOS_DETAIL_BLOCK}×{BOS_DETAIL_BLOCK} 块的"
                f"中位独立颜色数），低于阈值 {BOSS_DETAIL_MIN} —— 这个尺寸上「一色」是读不出结构的，"
                f"要么是把小网格的图放大过来（放大不创造颜色，只把同一批像素摊开），"
                f"要么是大面积纯色没有压明暗三阶"
            )
        inner = _inner_detail(im, BOS_INNER_BLOCK, BOS_INNER_MARGIN)
        if inner < BOSS_INNER_MIN:
            problems.append(
                f"BOSS {bid} 的内部细节只有 {inner:.2f}（排除轮廓后每 "
                f"{BOS_INNER_BLOCK}×{BOS_INNER_BLOCK} 块的平均独立颜色数），"
                f"低于阈值 {BOSS_INNER_MIN} —— 边缘再花哨也不算细节：身体内部必须有"
                f"阴影 / 高光 / 刻线 / 鳞片（只压一层暗纹不够，要连高光一起给）"
            )
        if bid in HEAD_FRONT:
            asym = _head_asym(im)
            if asym > BOSS_HEAD_SYM_MAX:
                problems.append(
                    f"BOSS {bid} 是正面朝向的，但头部区域的左右不对称像素占 "
                    f"{asym:.1%}（上限 {BOSS_HEAD_SYM_MAX:.0%}）—— 它多半是侧视/"
                    f"半侧视，或者成对结构（角 / 手臂 / 眼 / 牙）有一侧没走 `_sym`。"
                    f"正面朝向的对称结构一律用 `_sym` / `_beam_sym` 写"
                )

    ids = sorted(frames)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            sa = _solid_set(frames[a][0])
            sb = _solid_set(frames[b][0])
            diff = len(sa ^ sb)
            if diff < BOSS_SIL_MIN_DIFF:
                problems.append(
                    f"BOSS {a} 与 {b} 的剪影只差 {diff} 个像素（门槛 {BOSS_SIL_MIN_DIFF}）"
                    f"—— 八只 BOSS 的轮廓必须一眼分得开，否则「谁是谁」全靠颜色"
                )
    return problems
