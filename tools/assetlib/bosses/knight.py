"""
骑士队长（`knightCaptain`，第 40 / 42 层）—— 白银全身甲 + 金饰 + 红披风 + 金羽。

## 与骷髅队长共用「金」这套语言，所以识别必须落在别的地方

两只都是「金子 + 一个大盾 + 一把长兵器」。分开它们的是**体量**而不是颜色：

| | 骷髅队长 | 骑士队长 |
|---|---|---|
| 体量来源 | 肋骨 + 颅骨的镂空 | **披风的面积**（铺到画布左右缘） |
| 垂直线索 | 脊椎 + 两侧对生的肋骨（横向重复） | 披风褶（纵向重复） |
| 兵器 | 单手骨剑，偏细 | **双手大剑**，剑身宽一倍 |
| 盾 | 圆盾（正圆） | **鸢盾**（上宽下尖，竖长） |

## 96 网格相对 64 网格新增的东西

- 披风从「一块红布」变成 **三层**：外披 / 内衬 / 褶上的亮线，
  且褶的位置**跟着喇叭宽度算**（写死 x 会在窄处落到披风外 —— 这个 bug
  在法师袍上踩过一次）；
- 腿甲多了**膝甲与胫甲的分片线**；
- 头盔多了**面罩竖缝**与**金羽的三节**；
- 鸢盾从「一块梯形」变成 **盾面 / 上缘金带 / 中脊 / 铆钉列 / 中心宝石** 五层。
"""

from __future__ import annotations

from ..palette import MON_INK, MON_WHITE, SILVER_A
from ..pixel import _put
from ..shapes import _gem, _rivets, _sym
from .common import (
    BOS_CX,
    bar_sym,
    blade,
    bos_canvas,
    chest,
    diamond_sym,
    ell_sym,
    flare,
    half_sym,
    limb_pair,
    pauldron,
)

IDS = ("knightCaptain",)

KNIGHT = dict(
    # 白银全身甲：材质三档直接来自跨模块调色板的 SILVER_A
    **SILVER_A,
    light2=(244, 248, 252, 255),
    trim=(250, 216, 98, 255),
    trim_dk=(150, 104, 18, 255),
    cape=(148, 32, 40, 255),
    cape_dk=(96, 18, 26, 255),
    cape_lt=(206, 66, 70, 255),
    visor=(30, 34, 46, 255),
    blade=(226, 232, 244, 255),
    blade_dk=(148, 156, 174, 255),
    shield=(110, 116, 132, 255),
    shield_dk=(72, 78, 92, 255),
    grip=(104, 66, 34, 255),
)


def spec(bid: str) -> dict:
    if bid != "knightCaptain":
        raise KeyError(f"knight 模块不负责 {bid}")
    return dict(KNIGHT)


def draw(s: dict, bid: str):
    im = bos_canvas()
    armor, dark, light = s["armor"], s["dark"], s["light"]
    light2 = s["light2"]
    trim, trim_dk = s["trim"], s["trim_dk"]
    cape, cape_dk, cape_lt = s["cape"], s["cape_dk"], s["cape_lt"]
    visor, blade_c, blade_dk = s["visor"], s["blade"], s["blade_dk"]
    shield, shield_dk, grip = s["shield"], s["shield_dk"], s["grip"]

    # ── ① 披风（最里层）：外披 → 内衬 → 下摆 ────────────────────────
    #
    # `half0=20 / slope=0.42` → 下摆半宽 20→47，最宽处直接顶到画布左右缘。
    # 第一版是 `half0=17 / slope=0.54` 且从 y26 起笔，结果披风**只从肩下露出
    # 一条窄边**：整块红布被躯干（rx=21）与腿甲盖掉，落屏后读不出「有披风」——
    # 而这只 BOSS 的等级感恰恰全押在披风的面积上。
    flare(im, top=22, rows=66, half0=20, slope=0.42, base=cape,
          dark=cape_dk, light=cape_lt, step=11, fold_w=3)
    flare(im, top=30, rows=58, half0=14, slope=0.34, base=cape_dk,
          dark=cape_dk, light=cape, step=15, fold_w=2)
    bar_sym(im, 85, 47, cape, h=4)                     # 下摆的加宽边
    bar_sym(im, 89, 47, cape_dk, h=2)

    # ── ② 腿甲 + 膝甲分片 + 靴 ──────────────────────────────────────
    limb_pair(im, x0=36, y0=52, w=12, h=32, base=dark, dark=s["dark"],
              light=light, edge=3)
    _sym(im, 34, 66, 16, 2, armor)                     # 膝甲上缘
    _sym(im, 36, 68, 12, 7, armor)                     # 膝甲
    _sym(im, 38, 69, 8, 2, light)                      # 膝甲受光面
    _sym(im, 33, 84, 18, 6, armor)                     # 靴
    _sym(im, 33, 87, 18, 1, dark)
    _sym(im, 31, 88, 20, 8, armor)                     # 脚掌（底行必须有像素）
    _sym(im, 31, 93, 20, 2, dark)                      # 鞋底暗边

    # ── ③ 躯干 + 胸甲 + 金十字 + 中心宝石 + 上缘铆钉 ─────────────────
    chest(im, cy=46, rx=20, ry=15, base=armor, dark=dark, light=light,
          seams=(-8, 6, 13), studs=6)
    bar_sym(im, 34, 3, trim, h=20)                     # 十字的竖笔
    bar_sym(im, 44, 13, trim, h=5)                     # 十字的横笔
    bar_sym(im, 44, 13, trim_dk, h=1)
    diamond_sym(im, 46, 6, trim, hi=MON_WHITE)         # 胸甲中心宝石
    _sym(im, 26, 40, 5, 3, light2)                     # 胸甲两侧的高光阶
    bar_sym(im, 36, 17, dark, h=3)                     # 护颈（gorget）
    bar_sym(im, 36, 17, light2, h=1)
    bar_sym(im, 62, 15, trim, h=4)                     # 腰带
    bar_sym(im, 62, 15, trim_dk, h=1)
    diamond_sym(im, 63, 4, trim, hi=MON_WHITE)         # 带扣

    # ── ④ 肩甲 ─────────────────────────────────────────────────────
    pauldron(im, cy=38, x_off=30, rx=15, ry=12, plate=armor, dark=dark,
             light=light2, studs=4)
    _sym(im, 1, 34, 6, 3, dark)                        # 肩甲外侧的封边

    # ── ⑤ 头盔：盔顶 + 帽檐 + 面罩 + 竖缝 + 金羽 ─────────────────────
    half_sym(im, 30, 19, 21, armor, up=True)           # 盔顶（拱形，y 9..30）
    bar_sym(im, 30, 16, armor, h=9)                    # 面罩区（y 30..39）
    bar_sym(im, 28, 19, armor, h=4)                    # 帽檐（y 28..32，比盔体宽一档）
    bar_sym(im, 28, 19, light2, h=1)                   # 檐口受光
    bar_sym(im, 39, 16, dark, h=1)                     # 面罩下缘
    bar_sym(im, 32, 13, visor, h=5)                    # 横向观察缝
    for dx in (-8, -4, 0):                             # 竖缝：左半写、右半由 `_sym` 出
        _sym(im, BOS_CX + dx, 32, 1, 5, dark)
    bar_sym(im, 26, 4, trim, h=4)                      # 羽座
    bar_sym(im, 26, 4, trim_dk, h=1)
    _sym(im, 40, 24, 4, 3, trim)                       # 羽座的横向延伸（左右各一）
    bar_sym(im, 16, 3, trim, h=10)                     # 金羽：三节，下宽上窄
    bar_sym(im, 8, 3, trim_dk, h=1)
    bar_sym(im, 4, 2, trim, h=5)
    bar_sym(im, 0, 2, trim_dk, h=1)
    _sym(im, 44, 2, 1, 12, trim_dk)                    # 羽上的分节刻线

    # ── ⑥ 鸢盾（左手）：上宽下尖 + 上缘金带 + 中脊 + 铆钉列 + 宝石 ───
    _put(im, 2, 34, 26, 20, shield)                    # 盾面
    for k in range(12):                                # 向下的尖
        _put(im, 3 + k, 54 + k, 24 - 2 * k, 1, shield)
    _put(im, 2, 34, 26, 3, trim)                       # 上缘金带
    _put(im, 2, 34, 26, 1, trim_dk)
    _put(im, 2, 52, 24, 2, shield_dk)                  # 下缘暗带
    _put(im, 14, 36, 3, 22, trim)                      # 中脊
    _rivets(im, 5, 39, 5, 4, s["light2"])              # 铆钉列
    _rivets(im, 5, 46, 5, 4, s["light2"])
    _gem(im, 15, 44, 4, trim, MON_WHITE)

    # ── ⑦ 双手大剑（右手，竖握）：剑身宽一倍 + 剑格 + 握柄 ───────────
    #
    # 宽度 10（不是第一版的 12）：96px 的格子里，剑身再宽一点就会把右侧的披风
    # 与肩甲一起糊住 —— 判据不量「挡没挡住」，只有肉眼看得出来。
    blade(im, x0=82, y0=6, x1=80, y1=72, core=blade_c, light=MON_WHITE,
          dark=blade_dk, thick=10, fuller=3)
    _put(im, 68, 70, 26, 4, trim)                      # 剑格
    _put(im, 68, 70, 26, 1, trim_dk)
    _gem(im, 78, 72, 5, trim, MON_WHITE)
    _put(im, 75, 74, 7, 16, grip)                      # 握柄
    _put(im, 76, 76, 1, 12, armor)
    _put(im, 79, 76, 1, 12, armor)
    _put(im, 71, 90, 15, 4, trim)                      # 柄尾

    return im
