"""
大法师（`archmage`，第 25 层）—— 高尖帽 + 金袍 + 长白须 + 大金宝珠法杖。

## 画序是这只的全部难点

法杖（身后）→ 金袍 → 上身与披肩 → 白须（压在袍上、框住脸）→ 脸 → 尖帽（压住发际）。
顺序错一处就是「胡子长在袍子后面」这种硬伤 —— 而且它**不会红**：
密度够、颜色够、剪影也对，只有肉眼能看出来。所以这段顺序在本文件里
被刻意写成线性的一段，不抽成函数。

## 脸与帽檐的三段不许互相压（这是上一轮实测出来的硬伤）

64 网格那一版里，脸中心在 y28、帽檐椭圆在 y27（`ry=5` → 覆盖 22..32）——
**帽檐正压在两只眼睛上**，落屏后是一张没有五官的脸，只剩一团白胡子。
构建期判据一条都没拦住（它对「帽檐压眼」无话可说），是肉眼看出来的。

96 网格上这三段现在是：

| 段落 | y |
|---|---|
| 帽檐 | 25..39 |
| 眼 | 45..50 |
| 下巴 → 须根 | 58..62 |

改脸的位置时请连着这三段一起挪 —— 单挪脸就会重演「帽檐压眼」。

## 96 网格相对 64 网格新增的东西

- 袍褶 **3 组 → 3 组但每组带亮线**（三阶），且深度按袍宽收敛；
- 多了一条**金腰带 + 带扣**与袍面上的**符文点阵**（都压在最大的一片纯色上）；
- 披肩多了**两层暗阶 + 一排铆钉**；
- 白须多了 **3 道须缕的暗线**（一整片白是最大的密度洼地）；
- 法杖多了**杖身环纹**与宝珠外圈的暗环 + 符文点；
- 尖帽多了**锥体侧面的暗调**与**帽带宝石**。

## 配色为什么把帽子压暗

第一版帽子 `(160,116,28)` 与袍子 `(196,148,42)` 只差一档，落屏后**帽子和袍子
连成一片金**，整只读起来是「一顶大金帐篷」而不是「戴尖帽的法师」。
现在帽子再暗一档并压了侧面暗调，尖帽的锥形才立起来。
"""

from __future__ import annotations

import math

from ..palette import MON_INK, MON_WHITE
from ..pixel import _put
from ..shapes import _ell, _rivets, _sym
from .common import (
    BOS_CX,
    bar_sym,
    bos_canvas,
    diamond_sym,
    ell_sym,
    flare,
)

IDS = ("archmage",)

MAGE = dict(
    robe=(196, 148, 42, 255),
    dark=(128, 88, 18, 255),
    light=(248, 214, 106, 255),
    skin=(238, 200, 160, 255),
    skin_dk=(198, 156, 118, 255),
    hat=(146, 100, 22, 255),
    hat_dk=(88, 58, 8, 255),
    beard=(250, 250, 246, 255),
    beard_dk=(186, 186, 180, 255),
    staff=(122, 86, 48, 255),
    staff_dk=(78, 52, 26, 255),
    orb=(252, 226, 92, 255),
    orb_hi=(255, 250, 226, 255),
    trim=(252, 234, 142, 255),
)


def spec(bid: str) -> dict:
    if bid != "archmage":
        raise KeyError(f"mage 模块不负责 {bid}")
    return dict(MAGE)


def draw(s: dict, bid: str):
    im = bos_canvas()
    robe, dark, light = s["robe"], s["dark"], s["light"]
    skin, skin_dk = s["skin"], s["skin_dk"]
    hat, hat_dk = s["hat"], s["hat_dk"]
    beard, beard_dk = s["beard"], s["beard_dk"]
    staff, staff_dk = s["staff"], s["staff_dk"]
    orb, orb_hi, trim = s["orb"], s["orb_hi"], s["trim"]

    # ── ① 法杖（最里层，画在身后） + 大金宝珠 ────────────────────────
    _put(im, 72, 28, 10, 68, staff)
    _put(im, 72, 28, 2, 68, light)                     # 杖身受光
    _put(im, 80, 28, 2, 68, staff_dk)
    for k in range(9):                                 # 杖身环纹
        _put(im, 72, 32 + k * 7, 10, 2, staff_dk)
    _ell(im, 77, 20, 19, 19, dark)                     # 宝珠外圈暗环
    _ell(im, 77, 20, 16, 16, orb)
    _ell(im, 70, 13, 6, 6, orb_hi)                     # 高光
    for k in range(8):                                 # 宝珠外圈的符文点（角度均分）
        a = 2 * math.pi * k / 8
        _put(im, 77 + int(round(14 * math.cos(a))), 20 + int(round(14 * math.sin(a))), 2, 2, trim)

    # ── ② 金袍：从腰到地的喇叭 + 袍褶（深度跟着袍宽收敛） ────────────
    flare(im, top=52, rows=38, half0=17, slope=0.72, base=robe,
          dark=dark, light=light, step=13, fold_w=4)
    bar_sym(im, 88, 44, robe, h=6)                     # 摆底加宽
    bar_sym(im, 93, 44, dark, h=2)
    # 袍面上的符文点阵：只落在**白须之外**的两侧。
    # 第一版放在 |dx| ≤ 16，全被白须盖住了 —— 画了但看不见，而判据不会红。
    # 坐标是照着上面 `flare` 的宽度手算的（y64→hw26 / y72→hw31 / y82→hw37），
    # 改袍子的 slope 时这几个 dx 也要跟着改。
    for y, dxs in ((64, (22, 26)), (72, (22, 29)), (82, (23, 33))):
        for dx in dxs:
            _sym(im, BOS_CX - dx, y, 2, 3, light)
            _sym(im, BOS_CX + dx, y, 2, 3, light)

    # ── ③ 上身 + 金腰带 + 金披肩（两层暗阶）+ 铆钉 ──────────────────
    ell_sym(im, 48, 17, 12, robe)
    bar_sym(im, 58, 16, trim, h=4)                     # 腰带
    bar_sym(im, 58, 16, dark, h=1)
    diamond_sym(im, 59, 4, orb, hi=MON_WHITE)          # 带扣
    _sym(im, 30, 44, 5, 16, light)                     # 袍袖（左右各一）
    _sym(im, 29, 56, 7, 4, dark)                       # 袖口
    ell_sym(im, 43, 20, 9, dark)                       # 披肩的暗阶
    bar_sym(im, 40, 20, trim, h=4)                     # 披肩的金边
    bar_sym(im, 43, 20, trim, h=1)
    _rivets(im, 32, 41, 7, 5, dark, mirror=True)       # 披肩铆钉

    # ── ④ 白须：框住脸，从下巴（y58）铺到摆底 ───────────────────────
    #
    # 须缕做成**宽度按行微微起伏**的一条条 —— 等宽的竖线在 96 网格上是「条纹衬衫」，
    # 第一版就是那样（3 道等宽暗线，视觉上像围兜）。这里用 `(k // 4) % 2` 让
    # 每道的起止行错开，读起来才像须。
    for k in range(34):
        hw = 18 - int(round(k * 0.15))
        bar_sym(im, 58 + k, hw, beard)
    bar_sym(im, 90, 14, beard, h=5)                    # 须尾
    for i, d in enumerate((6, 12)):
        for k in range(6 + i, 30, 7):                  # 错开的须缕暗线（三阶）
            _sym(im, BOS_CX - d, 60 + k, 2, 4, beard_dk)
    _sym(im, 27, 62, 4, 22, beard_dk)                  # 须两侧压暗，让脸浮出来

    # ── ⑤ 脸 + 鼻 + 眼（帽檐 25..39 / 眼 45..50 / 下巴 58..62 三段互不重叠） ─
    ell_sym(im, 49, 14, 14, skin)
    _sym(im, 40, 41, 3, 12, skin_dk)                    # 两颊的暗面（把脸收窄）
    bar_sym(im, 49, 3, skin_dk, h=6)                   # 鼻
    _sym(im, 37, 45, 8, 6, MON_INK)                     # 眼窝（深色，比眼白更像老法师）
    _sym(im, 39, 46, 4, 3, MON_WHITE)                  # 眼里的一点光
    _sym(im, 36, 41, 8, 2, beard)                      # 白眉

    # ── ⑥ 尖帽：锥体（侧面压暗）+ 帽檐 + 帽带 + 带扣宝石 + 穗 ────────
    for k in range(30):
        hw = 4 + int(round(k * 0.62))
        bar_sym(im, 2 + k, hw, hat)
    for k in range(15):                                # 锥体左侧的暗调（右侧由 `_sym` 出）
        _sym(im, BOS_CX - 5 - int(round(k * 0.62)), 3 + k * 2, 3, 2, hat_dk)
    ell_sym(im, 32, 24, 7, hat)                        # 帽檐（y25..39，压在额际而不是眼睛上）
    bar_sym(im, 25, 24, hat_dk, h=1)
    bar_sym(im, 27, 21, trim, h=4)                     # 帽带
    diamond_sym(im, 29, 5, orb, hi=MON_WHITE)          # 带扣宝石
    bar_sym(im, 0, 2, trim, h=5)                       # 穗
    bar_sym(im, 5, 4, trim, h=3)

    return im
