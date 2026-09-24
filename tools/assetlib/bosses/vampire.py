"""
吸血鬼伯爵（`vampire`）—— 高竖领 + 铺开的斗篷 + 苍白面孔 + 红瞳 + 獠牙。

## 它是**刻意不对称**的，而且这一点不许被「顺手修好」

竖领左高右低、斗篷偏一侧披、站姿微微侧身 —— 读起来才是「一个人」，
而不是「一块对称的形状」。它与魔王要一眼分得开，而魔王走的是**严格对称**那条路，
两只的差异因此不只来自配色。

正因如此：
  · 它**不在** `common.HEAD_FRONT` 名单里，头部对称度判据对它不生效；
  · 斗篷的填充与褶**故意不用 `bar_sym`**，用 `_put` 手写偏移量。
    谁想「顺手统一成对称原语」，先回去看这一段的理由 —— 那会把它改成魔王。
  · 但**居中**的形体（内衬、胸针、中缝）仍然必须走 `bar_sym` / `diamond_sym`：
    「这只整体不对称」不等于「它身上每个零件都可以歪一列」。

## 仍然是三阶的

不对称 ≠ 可以省细节。斗篷有 **外披 / 内衬 / 褶上亮线** 三阶（`cape` /
`cape_in` / `light`），且褶的位置**跟着斗篷的宽度算**（旧稿写死过竖线，
在窄处落到披风外 —— 那是本项目踩过两次的坑）。

## 「褶只铺下摆」是本文件最大的一个洞（2026-09-24 量出来的）

旧稿的褶只铺 y54..83，而斗篷从 y26 起 —— 肩到腰那 28 行是**一整片纯色**；
袍面（x31..65 × y46..86，约 9 个内部块）更是只剩一层暗色。
`_inner_detail` 只统计离透明边缘 ≥3px 的内部块，于是这只卡在 **2.09**，
是八只里最低的（门槛 2.40 必红）。现在褶铺满整件斗篷、袍面也有绗缝。

## 两个「同色叠同色」的哑笔

旧稿的 `_put(im, 1, 92, 94, 4, cape_in)` 与紧随其后的
`_sym(im, 6, 93, 12, 3, cape_in)` **同色**，后者画上去等于没画
——「摆底两侧的皱边」这句注释描述的东西在成品里根本不存在。
现在皱边走 `cape_mid`（亮一档），它才是可见的。
"""

from __future__ import annotations

import math

from ..palette import MON_INK, MON_WHITE
from ..pixel import _put
from ..shapes import _beam, _sym
from .common import (
    BOS_CX,
    bar_sym,
    bos_canvas,
    diamond_sym,
    ell_pair,
    ell_sym,
    half_sym,
)

IDS = ("vampire",)

VAMPIRE = dict(
    skin=(240, 228, 226, 255),
    skin_dk=(196, 174, 178, 255),
    cape=(58, 32, 72, 255),
    cape_mid=(84, 48, 102, 255),
    cape_in=(30, 18, 40, 255),
    light=(120, 74, 140, 255),
    eye=(226, 40, 54, 255),
    eye_glow=(255, 130, 124, 255),
    hair=(24, 18, 30, 255),
    fang=(252, 252, 252, 255),
    brooch=(210, 176, 62, 255),
)

# ── 斗篷 / 内衬 / 袍的几何：**填充与纹理必须共用同一份递推式** ─────────
#
# 旧稿里填充（①）与褶（③）各写了一份 `hw / shift`，两份在第 26..29 行上不一致
# （填充 `shift = -5`、褶 `shift = -2`），那 4 行的褶落在斗篷中心偏右 3 列。
# 现在只有 `_cape_row()` 一个生产者，宽度与偏移成对进出。
CAPE_TOP, CAPE_ROWS = 26, 62                # 斗篷主体铺 y26..87（喇叭形的范围不变）
HEM_TOP, HEM_ROWS = 84, 12                  # 下摆那 12 行是一整块矩形，单独铺
COLLAR_TOP, COLLAR_ROWS = 32, 30            # 内衬铺 y32..61
FOLD_OFFSETS = (10, 19, 28, 37, 46)         # 褶离斗篷中心的距离（窄行自动跳过靠外的）

ROBE_CY, ROBE_RX, ROBE_RY = 66, 18, 20      # 袍（躯干）的椭圆参数 —— 绗缝要按它裁


def spec(bid: str) -> dict:
    if bid != "vampire":
        raise KeyError(f"vampire 模块不负责 {bid}")
    return dict(VAMPIRE)


def _cape_row(k: int) -> tuple[int, int]:
    """斗篷第 k 行（y = CAPE_TOP + k）的 (半宽, 横向偏移)。旋钮只有这一处。"""
    return 18 + int(round(k * 0.52)), (-5 if k < 30 else -2 if k < 46 else 0)


def _collar_hw(y: int) -> int:
    """内衬在行 y 的半宽（0 = 这一行没有内衬）。"""
    if not (COLLAR_TOP <= y < COLLAR_TOP + COLLAR_ROWS):
        return 0
    return max(0, 13 - int(round((y - COLLAR_TOP) * 0.30)))


def _robe_hw(y: int) -> int:
    """袍在行 y 的半宽 —— 绗缝必须按它裁，否则会画到袍子外面的空气上。"""
    dy = (y + 0.5 - ROBE_CY) / ROBE_RY
    if abs(dy) >= 1:
        return 0
    return int(round(ROBE_RX * math.sqrt(1 - dy * dy)))


def draw(s: dict, bid: str):
    im = bos_canvas()
    skin, skin_dk = s["skin"], s["skin_dk"]
    cape, cape_mid, cape_in = s["cape"], s["cape_mid"], s["cape_in"]
    light, eye, eye_glow = s["light"], s["eye"], s["eye_glow"]
    hair, fang, brooch = s["hair"], s["fang"], s["brooch"]

    # ── ① 斗篷主体：喇叭形，**上半段整体向左偏 5 列**（不对称的来源，刻意保留） ─
    #
    # 为什么用 `_put` 而不是 `flare`：`flare` 现在只画对称的下摆（见其 docstring）。
    # 这一件的整个卖点就是偏心，所以这里显式手写 `shift`，
    # 这一段是**唯一**允许出现裸 `_put` 大块填充的地方。
    for k in range(CAPE_ROWS):
        hw, shift = _cape_row(k)
        _put(im, BOS_CX - hw + shift, CAPE_TOP + k, 2 * hw + 1, 1, cape)

    # 下摆**必须铺到画布最后一行**（y95）。第一版只到 y93，触发了
    # `verify_boss_art` 的「最后一行必须有像素」—— 而那不是装饰性判据：
    # 精灵是**踩着占位块下沿**摆的，底行留白 = 整只在棋盘上浮起来。
    _put(im, 1, HEM_TOP, 94, HEM_ROWS, cape)

    # ── ② 褶：**铺满整件斗篷**（不只是下摆），位置跟着每行的宽度算 ──────
    #
    # 这一改是量出来的，不是审美选择 —— 见模块 docstring 的「最大的一个洞」。
    # 每笔都是「3px 暗褶 + 紧贴外侧 1px 亮线」：只压暗褶的话同一块里永远只有
    # 底色 + 暗色两种，细节密度上不去（`flare` 的 docstring 里记过同一条）。
    for k in range(CAPE_ROWS):
        hw, shift = _cape_row(k)
        y = CAPE_TOP + k
        for d in FOLD_OFFSETS:
            if d > hw - 4:                  # 窄处不画，否则褶落到斗篷外的空气上
                continue
            _put(im, BOS_CX + shift - d, y, 3, 1, cape_in)
            _put(im, BOS_CX + shift + d - 3, y, 3, 1, cape_in)
            _put(im, BOS_CX + shift - d - 1, y, 1, 1, light)     # 褶上亮线（三阶）
            _put(im, BOS_CX + shift + d, y, 1, 1, light)

    # 下摆（矩形那 12 行）原本是一条 94 宽的平色 —— 它同样需要褶，
    # 否则「斗篷下摆」在密度判据眼里和一块色板没有区别。下摆不偏心（居中），
    # 所以这里 offsets 对称地落在 BOS_CX 两侧。
    for y in range(HEM_TOP, HEM_TOP + HEM_ROWS - 3):
        for d in FOLD_OFFSETS:
            _put(im, BOS_CX - d, y, 3, 1, cape_in)
            _put(im, BOS_CX + d - 3, y, 3, 1, cape_in)
            _put(im, BOS_CX - d - 1, y, 1, 1, light)
            _put(im, BOS_CX + d, y, 1, 1, light)
    _put(im, 1, HEM_TOP + 9, 94, 3, cape_in)                 # 摆底的暗边（把斗篷压在地上）
    for d in FOLD_OFFSETS:                                   # 暗边上只留亮线（暗褶与它同色，看不见）
        _put(im, BOS_CX - d - 1, HEM_TOP + 9, 1, 3, light)
        _put(im, BOS_CX + d, HEM_TOP + 9, 1, 3, light)
    _sym(im, 6, HEM_TOP + 9, 14, 3, cape_mid)                # 摆底两侧的皱边（亮一档才看得见）

    # ── ③ 内衬（暗）：胸口往上收成 V，把脸「框」出来 ─────────────────
    #
    # 画在褶**之后**：内衬把中轴那几条褶盖掉，于是「褶只在两侧、中轴是内衬」
    # 这个读法由绘制顺序自动成立，不需要在褶那边写「跳过内衬」的例外。
    #
    # ⚠️ 走 `bar_sym` 而不是 `_put(cx - hw, …, 2*hw + 1, …)`：后者的跨度
    # `[48-hw, 48+hw]` 与它该有的镜像 `[47-hw, 47+hw]` **差 1 列**（见 common §二）。
    # 内衬是**居中**的形体，偏 1 列就是「胸口那条缝不在正中」。
    for y in range(COLLAR_TOP, COLLAR_TOP + COLLAR_ROWS):
        bar_sym(im, y, _collar_hw(y), cape_in)

    # ── ③′ 内衬上的绗缝格（斜向的短划线，逐行错开） ─────────────────
    #
    # 这一段是**量出来的**，不是审美选择：`_inner_detail` 只统计「离透明边缘 ≥3px」
    # 的内部块，而斗篷内衬是这只身上最大的一片纯色 —— 只画外轮廓的话，
    # 内部细节卡在 2.0 出头，判据（门槛 2.40）必红。
    for y in range(COLLAR_TOP + 2, COLLAR_TOP + COLLAR_ROWS):
        hw = _collar_hw(y)
        if hw < 4:
            continue
        for x in range(BOS_CX - hw + 3 + (y % 3) * 3, BOS_CX + hw - 3, 9):
            _put(im, x, y, 4, 1, cape_mid)

    # ── ④ 高竖领：两片向上外撇的尖，**左高右低**（不对称，刻意） ───────
    _beam(im, 32, 46, 10, 6, 11, cape)                 # 左领（高）
    _beam(im, 64, 46, 88, 22, 11, cape)                # 右领（低）
    _beam(im, 30, 44, 8, 6, 5, cape_mid)               # 领内衬：亮一档
    _beam(im, 66, 44, 90, 22, 5, cape_mid)
    _beam(im, 12, 10, 20, 6, 4, cape_mid)              # 左领的翻折尖
    _beam(im, 86, 22, 80, 12, 4, cape_mid)

    # ── ⑤ 身（暗袍）+ 交叠的手臂 + 袖口 + 指爪 + 胸针 ────────────────
    ell_sym(im, ROBE_CY, ROBE_RX, ROBE_RY, cape_in)

    # 袍面是这只身上**第二大片纯色，而且是全图最暗的一片**（约 9 个内部块）。
    # 绗缝按 `_robe_hw` 裁 —— 写死 x 范围会画到袍子之外的空气上（本项目的老坑）。
    # 隔行铺，读起来是「料子的暗纹」；逐行铺会密到变成另一种平色。
    for y in range(ROBE_CY - ROBE_RY + 2, ROBE_CY + ROBE_RY - 1, 2):
        hw = _robe_hw(y)
        if hw < 7:
            continue
        for x in range(BOS_CX - hw + 3 + (y % 3) * 3, BOS_CX + hw - 3, 9):
            _put(im, x, y, 4, 1, cape_mid)
    _put(im, BOS_CX - 1, ROBE_CY - ROBE_RY + 1, 2, 2 * ROBE_RY - 2, cape_mid)   # 中缝

    _put(im, 28, 62, 40, 7, light)                     # 交叠的手臂
    _put(im, 28, 62, 40, 2, cape_mid)
    _sym(im, 27, 60, 3, 12, cape)                      # 袖
    _sym(im, 26, 70, 5, 3, skin)                       # 露出的一截手（左右各一）
    diamond_sym(im, 57, 5, brooch, hi=MON_WHITE)       # 胸针

    # ── ⑥ 头：苍白面孔 + 尖下颌 + 高颧骨 + 鼻影 ─────────────────────
    ell_sym(im, 36, 14, 15, skin)
    half_sym(im, 50, 9, 8, skin, up=False)             # 尖下颌
    _sym(im, 33, 32, 4, 4, skin_dk)                    # 颧骨下的暗面
    _sym(im, 43, 30, 3, 9, skin_dk)                    # 面部一侧的暗面（不对称，刻意）
    bar_sym(im, 42, 2, skin_dk, h=2)                   # 鼻影

    # ── ⑦ 黑发 + 美人尖（发是唯一「压住脸」的东西，所以要画在脸之后） ──
    half_sym(im, 36, 17, 18, hair, up=True)
    bar_sym(im, 30, 3, hair, h=10)                     # 美人尖（跨轴，天然对称）
    _sym(im, 31, 22, 4, 12, hair)                      # 鬓角
    bar_sym(im, 14, 17, hair, h=5)
    _sym(im, 34, 20, 7, 2, cape_mid)                   # 发上的一道反光（三阶）

    # ── ⑧ 红瞳 + 眉 + 獠牙（成对结构一律 `_sym` / `ell_pair`） ────────
    ell_pair(im, 38, 36, 6, 5, MON_WHITE)
    ell_pair(im, 38, 36, 3, 5, eye)
    _sym(im, 40, 34, 2, 2, eye_glow)                   # 瞳内高光
    _sym(im, 32, 29, 13, 3, hair)                      # 眉
    bar_sym(im, 45, 6, MON_INK, h=2)                   # 口缝
    _sym(im, 41, 46, 3, 6, fang)                       # 上獠牙（左右各一）
    _sym(im, 44, 47, 1, 4, fang)

    return im
