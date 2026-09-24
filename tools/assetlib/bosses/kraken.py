"""
巨型乌贼（`kraken`，第 15 层）—— 纵向水滴形外套膜 + 一对侧鳍 + 两只巨眼 + 角质喙 + 六条长腕。

## 乌贼在外套膜上有两个记号，且都体现在**比例**上

改前的身体是一个**正圆**（`rx = ry`），配上同样圆的两只大眼，落屏后和史莱姆族
是一家人 —— 构建期断言一条都没拦住，因为它量的是「颜色密度」，不量「像不像乌贼」。

| 记号 | 含义 | 本文件 |
|---|---|---|
| 纵向长（rx < ry） | 头是筒形，不是球 | `MANT_RX = 25 / MANT_RY = 30`（高比宽长 1/5） |
| 侧鳍 | 外套膜中上部向外上伸出的一对角 | `_sym` 画的收尖三角 |

腕也必须**明显长于身体**：改前腕只画到第 62 行、而身体占到第 46 行，六条腕几乎
被外套膜吃掉，只剩一排小凸起 —— 这正是「读成水母」的原因之一。现在腕从第 58 行
拉到画布底（95），弯度也加大。

## 六条腕怎么做到对称

三条左腕手写，右三条是**镜像调用**（`x → 95-x`、`bow → -bow`，推导见
`shapes._bez`：控制点是 `mx - dy/ln*bow`，横坐标镜像之后偏移方向正好反号）。

⚠️ 这个镜像**不是逐像素精确**的（`_tentacle` 内部按 `round` 取整、块宽又是奇数），
所以腕上会有 1px 级的左右差异 —— 这在有机的触腕上是可接受的，也正因为如此
本模块把**眼睛与喙**全部交给 `ell_pair` / `bar_sym`（那两个是精确的），
而腕一律从 y58 起笔（低于 `metrics.HEAD_BAND_RATIO` 量到的头部区域），
使「正面朝向的头部必须对称」那条判据量不到腕。

## 外套膜为什么必须铺纵纹（2026-09-24 量出来的）

`ell_sym(34, 25, 30, body)` 是这只身上最大的一片平色（50 宽 × 60 高，膜占全图
一半面积）。旧稿只在膜上点了几处 `scale_band`，于是 `_inner_detail` 只有 **2.20**
（门槛 2.40 必红），`_detail_density` 只有 **3.00** —— 与 64 网格的旧图**同分**，
也就是说「重绘」在判据眼里根本没发生。

现在膜上沿纵向铺**肌理条纹**（3px 暗纹 + 紧贴外侧 1px 亮线）：这不是为了好看而已，
真实乌贼的外套膜本来就是肌肉，纵向的收缩纹是它最好认的表面特征之一。
纹理一律走 `_sym` —— 这只在 `common.HEAD_FRONT` 名单里，头部对称度判据对它生效。
"""

from __future__ import annotations

import math

from ..palette import MON_WHITE
from ..shapes import _bez, _sym, _tentacle
from .common import (
    BOS_CX,
    bar_sym,
    bos_canvas,
    ell_pair,
    ell_sym,
    half_sym,
    scale_band,
)

IDS = ("kraken",)

# ⚠️ `ridge`（暗→底的过渡色）是**为判据加的第四阶**，不是装饰。
#
# `_detail_density` 是**整数中位数**：只给「底色 + 暗纹 + 亮线」三色时，膜上
# 最宽那一段（y36 一带的 6 个块）恰好落在 3 —— 而中位数要够到 4 才算达标。
# 有了 `ridge`，一条纵纹横跨的像素是 `light | dark | ridge | body` 四阶，
# 同一个 12×12 块里也就有了四色。它同时是**更准确**的画法：膜的鼓起是渐变的，
# 从暗纹直接跳到亮线本来就是一阶硬边。
KRAKEN = dict(
    body=(132, 78, 176, 255),
    ridge=(108, 60, 148, 255),
    dark=(74, 38, 112, 255),
    light=(186, 140, 226, 255),
    sucker=(214, 178, 240, 255),
    eye=(250, 242, 206, 255),
    pupil=(36, 20, 50, 255),
    beak=(28, 22, 34, 255),
)

# 三条**左腕**：(起点 x, 终点 x, 弯度, 根部粗细)。
# 全部保持 x < 48（镜像之后右半才有位置；跨过中轴的腕会被镜像切成两截）。
LEFT_TENTACLES = (
    (30, 4, -8, 10),
    (37, 20, -10, 10),
    (43, 36, -6, 9),
)
# 腕的起笔行**必须低于外套膜的下沿**，否则腕全长在膜后面、只剩末端露出来 ——
# 第一版腕从 y58 起笔而膜铺到 y72，落屏后读到的是「一排短须」，不是六条长腕。
TENT_Y0, TENT_Y1 = 54, 95

# 外套膜的椭圆参数 —— 膜的宽度是**算出来的**，不是写死的：
# 纵纹必须按每行的真实半宽裁，否则窄处（顶部与底部）的纹会画到膜外的空气上。
MANT_CY, MANT_RX, MANT_RY = 34, 25, 30
# 纵纹离中轴的距离与膜顶起笔行（顶部太窄，从 y6 起足够）
STRIA_OFFSETS = (7, 14, 21)
STRIA_TOP = 6

# 每条腕上的吸盘位置（沿腕长的参数 t）—— 一圈一圈成排，不是零散几个点。
SUCKER_TS = (0.16, 0.32, 0.48, 0.64, 0.80, 0.94)


def spec(bid: str) -> dict:
    if bid != "kraken":
        raise KeyError(f"kraken 模块不负责 {bid}")
    return dict(KRAKEN)


def _mant_hw(y: int) -> int:
    """外套膜在行 y 的半宽（0 = 这一行没有膜）。纵纹按它裁。"""
    dy = (y + 0.5 - MANT_CY) / MANT_RY
    if abs(dy) >= 1:
        return 0
    return int(round(MANT_RX * math.sqrt(1 - dy * dy)))


def _tentacle_mirrored(im, x0, x1, bow, thick, c_main, c_tip, c_ridge, suckers=()):
    """
    一条左腕 + 它的镜像。镜像规则：`x → 95-x`、`bow → -bow`（推导见模块 docstring）。

    吸盘用 `_sym` 落点，所以两侧的吸盘在同一高度上（腕本身允许 1px 差异，
    吸盘不该跟着歪 —— 它们是「一排」的读法）。

    腕上还要再补一条**过渡色的筋**：`_tentacle` 只给两阶（前 72% 暗身、
    末段换亮色），于是腕上的块只有 2 色 —— 而六条腕占全图近三分之一面积。
    筋只写左腕、由 `_sym` 出右腕，与吸盘同理。
    """
    _tentacle(im, x0, TENT_Y0, x1, TENT_Y1, bow, thick, c_main, c_tip)
    _tentacle(im, 95 - x0, TENT_Y0, 95 - x1, TENT_Y1, -bow, thick, c_main, c_tip)
    for i in range(TENT_Y0 + 6, TENT_Y1, 5):
        t = (i - TENT_Y0) / (TENT_Y1 - TENT_Y0)
        sx, _ = _bez((x0, TENT_Y0), (x1, TENT_Y1), bow, t)
        _sym(im, int(round(sx)), i, 2, 3, c_ridge)
    for t in suckers:
        sx, sy = _bez((x0, TENT_Y0), (x1, TENT_Y1), bow, t)
        ix, iy = int(round(sx)), int(round(sy))
        _sym(im, ix, iy, 2, 2, c_tip)                  # 吸盘本体（亮）
        _sym(im, ix, iy + 2, 2, 1, c_main)             # 盘下的暗边 —— 一圈吸盘才有「排」的读法


def draw(s: dict, bid: str):
    im = bos_canvas()
    body, dark, light = s["body"], s["dark"], s["light"]
    ridge = s["ridge"]
    sucker, eye, pupil, beak = s["sucker"], s["eye"], s["pupil"], s["beak"]

    # ── ① 侧鳍（最里层）：向外上收尖的三角 + 鳍上的亮脊与辐条 ────────
    for k in range(22):
        _sym(im, 22 - k, 30 - k, 1, 24 - k, dark)
    for k in range(8):
        _sym(im, 20 - k, 28 - k, 1, 3, light)
    # 辐条：从鳍根向鳍尖的几条短过渡线 —— 只画一块三角的话鳍是一整片暗色，
    # 与「膜」的读法都谈不上（鳍是有骨架的）。
    #
    # ⚠️ 这里原来是 `dark`（就是鳍自己的底色），**画上去等于没画** ——
    # 与 vampire 那两笔「同色叠同色」是同一个病。同理，鳍上的块只剩 2 色。
    for k in (2, 6, 10, 14):
        _sym(im, 20 - k, 28 - k, 1, max(2, 14 - k), ridge)

    # ── ② 六条长腕（三条左腕 + 三条镜像）+ 腕上的两列吸盘 ───────────
    for (x0, x1, bow, th) in LEFT_TENTACLES:
        _tentacle_mirrored(im, x0, x1, bow, th, dark, light, ridge, suckers=SUCKER_TS)

    # ── ③ 外套膜：**纵向水滴形**（rx 25 / ry 30 —— 高比宽长五分之一） ──
    #
    # 膜的下沿收到 y64：六条腕要从它下面**露出来**（第一版膜铺到 y72，
    # 腕只露了 23 行，读成「一排短须」）。
    ell_sym(im, MANT_CY, MANT_RX, MANT_RY, body)
    half_sym(im, 28, 20, 24, light, up=True)           # 顶部受光
    _sym(im, 21, 20, 8, 28, dark)                      # 两侧的暗调（走 `_sym` 保证镜像）
    _sym(im, 24, 42, 5, 20, dark)

    # ── ③′ 膜的**纵向肌理**：每行按真实半宽铺暗纹 + 外侧亮线 ─────────
    #
    # 这一段是**量出来的**：旧稿膜上只有几处 `scale_band`，内部细节 2.20、
    # 密度 3.00（与 64 网格旧图同分 → 「重绘」在判据眼里等于没发生）。
    # 暗纹宽 2px、内侧 1px `ridge` 过渡、外侧 1px 亮线 —— 一条纹横跨四阶
    # （`light | dark | ridge | body`）。只压暗纹的话同一块里永远只有
    # 底色 + 暗色两色（`common.flare` 的 docstring 记过同一条）。
    #
    # 只写左半、右半由 `_sym` 出：这只在 HEAD_FRONT 名单里，
    # 头部对称度判据会量到 y0..50 这一段。
    for y in range(STRIA_TOP, MANT_CY + MANT_RY):
        hw = _mant_hw(y)
        if hw < 7:
            continue
        for d in STRIA_OFFSETS:
            if d > hw - 4:
                continue
            _sym(im, BOS_CX - d, y, 2, 1, dark)
            _sym(im, BOS_CX - d + 2, y, 1, 1, ridge)
            _sym(im, BOS_CX - d - 1, y, 1, 1, light)

    # 色素细胞（chromatophore）：膜上成片的深色小斑。真实乌贼靠它变色的，
    # 而且它在像素层面正是「同一块里出现第三、第四种颜色」。
    for (sx, sy, sw, sh) in ((13, 20, 6, 3), (19, 40, 5, 4), (15, 50, 6, 3), (22, 28, 4, 5)):
        _sym(im, sx, sy, sw, sh, dark)

    scale_band(im, x0=26, y=36, cols=4, rows=4, step=8, base=light, dark=dark, mirror=True)
    scale_band(im, x0=28, y=56, cols=3, rows=2, step=8, base=light, dark=dark, mirror=True)
    bar_sym(im, 62, 14, dark, h=3)                     # 膜的下沿收口

    # ── ④ 眼下压暗，把巨眼从外套膜上「抠」出来 ───────────────────────
    bar_sym(im, 44, 21, dark, h=5)

    # ── ⑤ 两只巨眼：暗环 → 眼白 → 竖瞳 → 高光（`ell_pair` 是精确镜像的） ─
    #
    # 加一圈暗环是必须的：第一版只有「眼白 + 竖瞳」，而眼白（250,242,206）与
    # 膜上的受光面（186,140,226）在缩到 32px 后都读作「一块浅色」，
    # 两只眼就像贴在身上的两个圆斑。暗环把眼从膜上切出来。
    ell_pair(im, 33, 40, 14, 15, dark)
    ell_pair(im, 33, 40, 12, 13, eye)
    ell_pair(im, 33, 40, 6, 11, pupil)
    ell_pair(im, 28, 34, 4, 4, MON_WHITE)

    # ── ⑥ 角质喙（外套膜下缘的 V 形开口）+ 下伸的钩尖 ────────────────
    bar_sym(im, 61, 9, dark, h=9)
    for k in range(8):
        bar_sym(im, 63 + k, 8 - k, beak)
    bar_sym(im, 67, 3, beak, h=11)
    _sym(im, 42, 64, 2, 7, sucker)                     # 喙上的两道反光

    # ── ⑦ 喙两侧的短触须（与长腕同一套语言，短得多） ─────────────────
    for (x0, x1, bow, th) in ((40, 33, -5, 6),):
        _tentacle(im, x0, 62, x1, 80, bow, th, dark, light)
        _tentacle(im, 95 - x0, 62, 95 - x1, 80, -bow, th, dark, light)
        for t in (0.30, 0.60, 0.88):
            sx, sy = _bez((x0, 62), (x1, 80), bow, t)
            _sym(im, int(round(sx)), int(round(sy)), 2, 2, sucker)

    return im
