#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-assets.py —— 把 assets/raw 下的原始素材，加工成游戏真正加载的图集 + 映射表。

为什么要写这个脚本
------------------
素材来自 6 个互不相干的免费包（0x72 / ArMM1998 / Kenney x4 / wareya），
它们的尺寸、朝向顺序、命名规则全都不一样。如果让渲染层直接去引用原件，
「哪只怪物用哪张图」这件事就散落在代码各处，改一次错一次。
本脚本把这件事收敛成三张表（TERRAIN / MONSTERS / ITEMS），可重跑、可核对、可 diff。

三条硬规则
----------
1. raw/ 只读。任何变换都在这里用代码表达，绝不手工修图 —— 否则重跑就冲掉了。
2. 保持 16px 基准。输出的精灵是 16×16（大家伙是 32×32），运行时按 2 倍整数
   放大到 32px 的格子。整数倍最近邻放大，像素画不会被插值糊掉。
3. 找不到源就明说。不猜、不硬塞，manifest 里如实标 generated 或 null，
   渲染层据此回退到程序化矢量图形（src/render/icons.ts）。

用法
----
    python3 tools/build-assets.py
产物
----
    assets/atlas/*.png        运行时加载的图集
    assets/MANIFEST.json      实体 → 图集坐标的唯一事实来源
    assets/preview/*.png      目视核对用的对照图（不参与运行）
"""

from __future__ import annotations

import colorsys
import json
import math
import os
import random
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    sys.exit(
        "需要 Pillow：\n"
        f"  {sys.executable} -m pip install pillow\n"
        "若用虚拟环境，请把该解释器路径传给 npm：PYTHON=<venv>/bin/python npm run assets"
    )

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "assets" / "raw"
ATLAS_DIR = ROOT / "assets" / "atlas"
PREVIEW_DIR = ROOT / "assets" / "preview"

BASE_TILE = 16          # 精灵的基准边长
CELL = 32               # 游戏棋盘的格子边长（= BASE_TILE × 2）
DRAW_SCALE = 2          # 常规绘制倍数
BIG_SCALE = 3           # 「大家伙」绘制倍数（仍是整数，像素不糊）

# ─────────────────────────────────────────────────────────────────────
# 一、工具：调色板变换
# ─────────────────────────────────────────────────────────────────────

# 像素画的颜色数很少（通常 < 64），逐色映射比逐像素便宜，而且不会引入新噪声
def _palette_map(im: Image.Image, fn) -> Image.Image:
    im = im.convert("RGBA")
    px = im.load()
    cache: dict[tuple[int, int, int], tuple[int, int, int]] = {}
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            key = (r, g, b)
            if key not in cache:
                cache[key] = fn(r, g, b)
            nr, ng, nb = cache[key]
            px[x, y] = (nr, ng, nb, a)
    return im


def hue_shift(im: Image.Image, deg: float, sat: float = 1.0, val: float = 1.0) -> Image.Image:
    """整体转色相。给「同一只史莱姆的绿/红变体」这类需求用。"""

    def fn(r, g, b):
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        h = (h + deg / 360.0) % 1.0
        s = max(0.0, min(1.0, s * sat))
        v = max(0.0, min(1.0, v * val))
        return tuple(int(round(c * 255)) for c in colorsys.hsv_to_rgb(h, s, v))

    return _palette_map(im, fn)


def ramp(im: Image.Image, dark, light) -> Image.Image:
    """
    亮度 → 双色渐变。

    给金属/骨头的「阶级变体」用（青铜 → 白银 → 黄金）。比单纯转色相可信得多：
    它保留原图的明暗结构，只把材质色换掉。骷髅兵的三级进阶全靠这个函数，
    否则三只骷髅会变成三坨纯色。
    """
    dr, dg, db = dark
    lr, lg, lb = light

    def fn(r, g, b):
        t = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
        return (
            int(dr + (lr - dr) * t),
            int(dg + (lg - dg) * t),
            int(db + (lb - db) * t),
        )

    return _palette_map(im, fn)


def ramp_norm(im: Image.Image, dark, light) -> Image.Image:
    """
    亮度 → 双色渐变，但**先把原图亮度拉伸到满量程**再映射。

    与 ramp 的唯一区别，也是必须存在的理由（实测出来的，不是理论洁癖）：
    0x72 的 floor_1 一共只有 3 个颜色，亮度全挤在 0.133~0.389。直接 ramp 的话
    输出只用到 dark→light 这段渐变的 13%~39%，等于「换了个色却几乎没提亮」，
    结构对比也一起被压扁。先归一化到 0~1，「深缝/砖面/高光」才各归其位。

    用途：地形。地形对比度是**可玩性**而不是审美 —— 地面和墙一旦分不开，
    迷宫就读不出来。verify_terrain 里的对比度断言就是防止这件事回潮。
    """
    im = im.convert("RGBA")
    px = im.load()
    lums = [
        (0.299 * px[x, y][0] + 0.587 * px[x, y][1] + 0.114 * px[x, y][2]) / 255.0
        for y in range(im.height)
        for x in range(im.width)
        if px[x, y][3] > 0
    ]
    if not lums:
        return im
    lo, hi = min(lums), max(lums)
    span = max(hi - lo, 1e-6)
    dr, dg, db = dark
    lr, lg, lb = light

    def fn(r, g, b):
        t = ((0.299 * r + 0.587 * g + 0.114 * b) / 255.0 - lo) / span
        t = max(0.0, min(1.0, t))
        return (
            int(dr + (lr - dr) * t),
            int(dg + (lg - dg) * t),
            int(db + (lb - db) * t),
        )

    return _palette_map(im, fn)


def recolor_hue(im: Image.Image, lo: float, hi: float, dark, light) -> Image.Image:
    """
    **局部**换色：只把色相落在 [lo, hi] 的像素压成 dark→light 渐变，其余原样保留。

    为什么需要「局部」这个能力 —— Kenney 的钥匙是「深色匙体 + 橙色匙柄 + 一小截
    彩色横带」，识别颜色全在那截横带上（#126 绿 / #127 红 / #128 蓝，各约 10 像素）。
    用整体 hue_shift 转色相会**把匙柄一起转掉**：绿钥匙转 +55° 后匙柄变黄绿、
    横带变青蓝，结果是一把「绿头蓝身」的钥匙 —— 既不像黄钥匙，又和蓝钥匙撞色。
    （这正是三色门当初踩过的同一个坑：整体转色相在这个素材包里基本都不可靠。）

    所以三把钥匙统一改成「同一个底图 + 只重染横带」，天然成一套，
    颜色也各自纯粹。
    """
    dr, dg, db = dark
    lr, lg, lb = light

    def fn(r, g, b):
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        # 彩度门槛不能省：近灰的像素色相是噪声，它们可能恰好落在目标区间里，
        # 一旦被重染，那些金属高光点就会变成一两颗突兀的彩点。
        if s < 0.30 or not (lo <= h * 360 <= hi):
            return (r, g, b)
        # 落在目标区间的是彩色横带：按原明暗压成渐变，保住立体感
        t = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
        return (
            int(dr + (lr - dr) * t),
            int(dg + (lg - dg) * t),
            int(db + (lb - db) * t),
        )

    return _palette_map(im, fn)


def alpha_mul(im: Image.Image, k: float) -> Image.Image:
    im = im.convert("RGBA")
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, int(round(a * k)))
    return im


def add_outline(im: Image.Image, color=(42, 32, 40, 255)) -> Image.Image:
    """
    给不透明像素外圈补 1px 深色描边。

    这套素材（0x72 / ArMM / Kenney）全部自带描边 —— 程序化补出来的缺口图标
    如果没描边，混进去会一眼看出「不是一家人」。所以生成图标收尾一律过这道。
    """
    im = im.convert("RGBA")
    w, h = im.size
    src = im.load()
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    dst = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = src[x, y]
            if a > 0:
                dst[x, y] = (r, g, b, a)
                continue
            near = False
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and src[nx, ny][3] > 120:
                        near = True
            if near:
                dst[x, y] = color
    return out


# ─────────────────────────────────────────────────────────────────────
# 二、工具：图集打包
# ─────────────────────────────────────────────────────────────────────


class Shelf:
    """
    货架式打包器：从左往右摆，排满换行。

    没有用 MaxRects 之类的最优算法 —— 素材总量只有几百个 16×16，
    即使用最笨的排法图集也就几百 KB，不值得为省几十 KB 引入算法复杂度。
    """

    def __init__(self, width: int = 512, pad: int = 1):
        self.width = width
        self.pad = pad
        self.rows: list[list[dict]] = []

    def add(self, im: Image.Image) -> None:
        w, h = im.size
        if self.rows:
            row = self.rows[-1]
            last = row[-1]
            x = last["x"] + last["w"] + self.pad
            # 只有「放得下宽度」且「不超过本排已定高度」才留在本排。
            # 不检查高度的话，一个高个精灵会把整排撑高，旁边全是大片空白。
            if x + w <= self.width and h <= max(e["h"] for e in row):
                row.append({"x": x, "y": 0, "w": w, "h": h})
                return
        self.rows.append([{"x": 0, "y": 0, "w": w, "h": h}])

    def render(self) -> tuple[Image.Image, list[dict]]:
        """给每排定 y（排高 = 本排最高项），返回 (空白图集, 同序条目)"""
        entries: list[dict] = []
        y = 0
        for row in self.rows:
            rh = max(e["h"] for e in row)
            for e in row:
                e["y"] = y
                entries.append(e)
            y += rh + self.pad
        total_h = max(1, y - self.pad)
        sheet = Image.new("RGBA", (self.width, total_h), (0, 0, 0, 0))
        return sheet, entries


# ─────────────────────────────────────────────────────────────────────
# 三、工具：切帧
# ─────────────────────────────────────────────────────────────────────


def bands(vals, thr=0):
    """把连续 > thr 的下标区间找出来，用于从投影里定位帧边界。"""
    out, s = [], None
    for i, v in enumerate(vals):
        if v > thr and s is None:
            s = i
        elif v <= thr and s is not None:
            out.append((s, i - 1))
            s = None
    if s is not None:
        out.append((s, len(vals) - 1))
    return out


def content_box(im: Image.Image, box=None):
    """在给定区域内取非透明包围盒。"""
    region = im.crop(box) if box else im
    bb = region.getbbox()
    if bb is None:
        return None
    ox, oy = (box[0], box[1]) if box else (0, 0)
    return (bb[0] + ox, bb[1] + oy, bb[2] + ox, bb[3] + oy)


def bottom_center(im: Image.Image, cw: int, ch: int) -> Image.Image:
    """
    把精灵贴到底部居中的画布上。

    棋盘是俯视图，精灵必须「脚踩在格子下沿」才站得住。所有角色类素材
    统一过这一步，渲染层就不用再为每张图单独调偏移了。
    """
    im = im.convert("RGBA")
    bb = im.getbbox()
    if bb:
        im = im.crop(bb)
    if im.width > cw:  # 超宽就等比缩到 cw（最近邻，保持硬边）
        k = cw / im.width
        im = im.resize((cw, max(1, int(round(im.height * k)))), Image.NEAREST)
    canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    x = (cw - im.width) // 2
    y = ch - im.height
    canvas.paste(im, (x, max(0, y)), im)
    return canvas


# ─────────────────────────────────────────────────────────────────────
# 四、素材源
# ─────────────────────────────────────────────────────────────────────

O72 = RAW / "0x72" / "frames"
O72_SHEET = RAW / "0x72" / "0x72_DungeonTilesetII_v1.3.png"
ARMM = RAW / "armm-zeldalike" / "gfx"
KEN_TD = RAW / "kenney" / "tiny-dungeon" / "tilemap_packed.png"
KEN_TT = RAW / "kenney" / "tiny-town" / "tilemap_packed.png"

KEN_COLS = 12  # Kenney tiny-* 图集是 12 列


def o72(name: str) -> Image.Image:
    return Image.open(O72 / f"{name}.png").convert("RGBA")


def ken(idx: int, path: Path = KEN_TD) -> Image.Image:
    im = Image.open(path).convert("RGBA")
    c, r = idx % KEN_COLS, idx // KEN_COLS
    return im.crop((c * BASE_TILE, r * BASE_TILE, (c + 1) * BASE_TILE, (r + 1) * BASE_TILE))


# ─────────────────────────────────────────────────────────────────────
# 五、地形映射
# ─────────────────────────────────────────────────────────────────────
# 键 = data/tiles.json 里的地形编码（0..11）。
# 「假墙」必须和真墙长得一模一样 —— 这就是它的全部玩法意义，所以共用同一张图。

TERRAIN = {
    # 地面必须**又暖又亮**，理由在数据里：
    # 0x72 的 floor_1 与 wall_mid 用的是**完全相同的三个颜色**
    # (72,59,58) / (119,92,85) / (34,34,34)，只是排列不同（地面＝平坦底＋缝，
    # 墙＝砖纹）。也就是说源素材本身**没打算让两者靠颜色区分**。
    # 只给地面提亮 ×1.5 的结果是实测平均亮度 0.364 vs 墙 0.232，比值 1.57 ——
    # 亮度差不够、色相还完全一样，整屏糊成一坨褐色，迷宫读不出来。
    # 而且墙的砖缝 (34,34,34) 正好等于史莱姆身体的深色，怪物会「粘」在墙上。
    # 所以这里换成 ramp_norm：先把亮度拉伸到满量程，再压成一套暖砂石渐变
    # （深缝 #926c42 → 砖面 #bd9e73 → 高光 #f4deb2），实测比值提到 2.77，
    # 且色相明确落在暖色区（35°）。对比度断言见 verify_terrain 第 ④ 条。
    0: ("floor", lambda: ramp_norm(o72("floor_1"), (146, 108, 66), (244, 222, 178)),
       "0x72/floor_1 @ 暖砂石渐变（亮度归一化后映射，与墙拉开明度差）"),
    1: ("wall",       lambda: o72("wall_mid"),                         "0x72/wall_mid"),
    2: ("prisonDoor", lambda: o72("doors_leaf_closed"),                "0x72/doors_leaf_closed（原色木门，区别于三色钥匙门）"),
    3: ("stairsDown", lambda: o72("floor_ladder"),                     "0x72/floor_ladder"),
    # 0x72 只有一张 floor_ladder，上/下楼梯本来是同一张图。必须在构建期把「上」
    # 翻转过来，否则两个楼梯在画面上完全一样 —— 玩家分不清往哪走。
    # 放在这里烘焙而不是留给渲染层，是因为「忘了翻转」不会报错、只会静默变丑。
    4: ("stairsUp",   lambda: o72("floor_ladder").transpose(Image.FLIP_TOP_BOTTOM),
       "0x72/floor_ladder @ 预翻转（与下楼梯镜像）"),

    # 三色门用「渐变」而不是「转色相」。原因看数据：门原本是暖木色（色相约 12°），
    # 想转到红（~355°）只能移 -17°，结果还是褐色，一眼认不出是红门；
    # 而 +250° 会直接跑到蓝紫（实测 250.8°）。渐变能把门压进明确而饱和的色族，
    # 代价是丢掉一点木纹层次 —— 对「颜色即玩法」的钥匙门来说，这个交换值得。
    5: ("lava",       lambda: ramp(o72("wall_goo"), (46, 8, 4), (255, 176, 36)),
       "0x72/wall_goo @ 岩浆渐变（原素材是绿色黏液）"),
    6: ("void",       lambda: ramp(o72("wall_goo_base"), (24, 16, 52), (150, 110, 220)), "0x72/wall_goo_base @ 星际渐变"),
    7: ("doorYellow", lambda: ramp(o72("doors_leaf_closed"), (54, 36, 6), (252, 214, 96)), "0x72/doors_leaf_closed @ 黄渐变"),
    8: ("doorBlue",   lambda: ramp(o72("doors_leaf_closed"), (14, 24, 58), (150, 194, 246)), "0x72/doors_leaf_closed @ 蓝渐变"),
    9: ("doorRed",    lambda: ramp(o72("doors_leaf_closed"), (58, 10, 16), (250, 138, 138)), "0x72/doors_leaf_closed @ 红渐变"),
    10: ("autoDoor",  lambda: o72("doors_leaf_open"),                  "0x72/doors_leaf_open"),
    11: ("fakeWall",  lambda: o72("wall_mid"),                         "0x72/wall_mid（与真墙同图，这是玩法本身）"),
}

# 墙的「顶边」变体：上方没有墙时用这张，地牢立刻有了立体感。
# 渲染层按邻域挑，挑不到就退回普通墙。
#
# ⚠️ 这里必须**预合成**，不能直接把 wall_top_mid 摆进去：
# wall_top_mid 只有最下面 4 行有内容（石头压顶），上面 12 行是全透明的 ——
# 它是给「贴到墙体上面那一格的下沿」这种用法画的。原样贴在本格会让整格
# 四分之三透明，露出底色（白色面板），看起来像墙缺了一块。
# 翻转过来让压顶落在本格的**上沿**，再和墙身合成为一张不透明图，本格就完整了。
def _wall_top_baked(body: Image.Image | None = None) -> Image.Image:
    body = o72("wall_mid") if body is None else body
    cap = o72("wall_top_mid").transpose(Image.FLIP_TOP_BOTTOM)
    out = body.copy()
    out.alpha_composite(cap)
    return out


TERRAIN_TOP = {
    1: ("wallTop", _wall_top_baked, "0x72/wall_mid + wall_top_mid 翻转预合成（压顶落在本格上沿）"),
}

# ─────────────────────────────────────────────────────────────────────
# 五之二、地形变体 —— 打散「同一块砖反复平铺」的视觉锁定
# ─────────────────────────────────────────────────────────────────────
# 为什么必须做：
#   11×11 的棋盘上地面要铺 121 次、墙也动辄几十块。只有一张瓦片时，地砖的倒角
#   缺口与墙的砖缝会连成一张**规则网格**，眼睛一眼读出的不是「一片地牢」而是
#   「同一张图在重复」。这是放大到真机尺寸后最刺眼的问题。
#
# 唯一的硬约束：**色调必须几乎不变**。
#   变体一旦平均色有差，棋盘就会变成深浅不一的补丁 —— 比原来的重复感更难看，
#   而且这种「补丁感」在缩略图上不明显、在真机上很明显。所以变体一律只做
#   **同一调色板内的像素重排**：用哪几个颜色、各用多少个，与底图完全相同。
#   这不是靠自觉，verify_terrain 里有直方图断言。
#
# 两种地形各有一套做法，理由不同：
#   地面：倒角（上/左暗边、下/右亮边）是地砖能连成一片的关键，**不动**；
#         只把倒角上缺口的**位置**重排，再撒几粒同色小杂质。
#   墙  ：四行一层的砌层结构（高光边 / 砖身 ×2 / 横缝）**不动**，动了会出现
#         横向条带；只重排**竖缝**的位置 —— 砖缝错开正是真实砌法的样子。
#
# 门 / 楼梯 / 岩浆 / 虚空都是一格一格出现的，没有被平铺锁定，做了只是白占体积。

VARIANT_SEED = 20260921  # 固定种子：变体必须可重跑，不能每次构建都换一批
FLOOR_VARIANTS = 6       # 含底图本身（键 `0`；其余是 `0:1` … `0:5`）
WALL_VARIANTS = 5        # 含底图本身（键 `1`；其余是 `1:1` … `1:4`）
WALL_COURSE = 4          # 墙四行一层：高光边 / 砖身 / 砖身 / 横缝


def _hist(im: Image.Image) -> dict:
    """颜色直方图。变体校验靠它 —— 平均色相同但直方图不同也算不合格。"""
    return {c: n for n, c in (im.getcolors(1 << 16) or [])}


def _lum(c: tuple) -> float:
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def _mean_rgb(im: Image.Image) -> tuple[float, float, float]:
    """逐通道平均色。比平均亮度严一格：两个变体亮度可以相同而色相不同。"""
    # 注意：RGBA 图上的 get_flattened_data() 给的是**像素元组序列**，不是扁平整数序列
    px = list(im.get_flattened_data())
    n = len(px)
    return (
        sum(p[0] for p in px) / n,
        sum(p[1] for p in px) / n,
        sum(p[2] for p in px) / n,
    )


def _floor_palette(base: Image.Image) -> tuple[tuple, tuple, tuple]:
    """从底图**推出**三档色，而不是写死常量。
    这样将来调地面配色（TERRAIN[0] 的 ramp_norm 参数）不需要同步改变体生成器。"""
    colors = list(_hist(base))
    fill = base.getpixel((base.width // 2, base.height // 2))
    rest = sorted((c for c in colors if c != fill), key=_lum)
    if len(rest) < 2:
        raise RuntimeError("地面底图不足三色，无法推出倒角配色")
    return fill, rest[0], rest[-1]


def _floor_variants(base: Image.Image) -> list[Image.Image]:
    """地面变体：倒角分工不变，只重排缺口位置 + 撒小杂质。"""
    w, h = base.size
    fill, bead_dark, bead_light = _floor_palette(base)
    corners = {(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)}

    def edge_points(edge: str) -> list[tuple[int, int]]:
        if edge == "top":
            return [(x, 0) for x in range(w)]
        if edge == "bottom":
            return [(x, h - 1) for x in range(w)]
        if edge == "left":
            return [(0, y) for y in range(h)]
        return [(w - 1, y) for y in range(h)]

    out = [base]
    for vi in range(1, FLOOR_VARIANTS):
        rng = random.Random(VARIANT_SEED * 101 + vi)
        im = base.copy()
        p = im.load()
        for edge in ("top", "bottom", "left", "right"):
            bead = bead_dark if edge in ("top", "left") else bead_light
            pts = [q for q in edge_points(edge) if q not in corners]
            n = sum(1 for q in pts if base.getpixel(q) == bead)
            for q in pts:
                p[q] = fill
            for q in rng.sample(pts, n):  # 缺口数量不变，只换位置
                p[q] = bead
        # 小杂质（石子 / 磨痕）：数量刻意很少 —— 撒多了就成麻点，比重复更难看
        for _ in range(rng.randint(2, 3)):
            p[(rng.randrange(2, w - 2), rng.randrange(2, h - 2))] = bead_dark
        if vi % 2 == 0:
            for _ in range(rng.randint(1, 2)):
                p[(rng.randrange(2, w - 2), rng.randrange(2, h - 2))] = bead_light
        out.append(im)
    return out


def _wall_palette(base: Image.Image) -> tuple[tuple, tuple, tuple]:
    """墙的三档色（亮 / 中 / 暗）同样从底图推出。"""
    colors = sorted(_hist(base), key=_lum, reverse=True)
    if len(colors) < 3:
        raise RuntimeError("墙底图不足三色，无法推出砌层配色")
    return colors[0], colors[1], colors[2]


def _wall_variants(base: Image.Image) -> list[Image.Image]:
    """墙变体：砌层结构不变，只重排竖缝位置。"""
    w, h = base.size
    hi, body, joint = _wall_palette(base)
    out = [base]
    for vi in range(1, WALL_VARIANTS):
        rng = random.Random(VARIANT_SEED * 211 + vi)
        im = base.copy()
        p = im.load()
        for c0 in range(0, h - WALL_COURSE + 1, WALL_COURSE):
            xs = sorted(rng.sample(range(w), rng.choice((2, 3))))
            for dy in range(WALL_COURSE - 1):
                y = c0 + dy
                row = hi if dy == 0 else body
                for x in range(w):
                    p[(x, y)] = row
                for x in xs:
                    p[(x, y)] = joint  # 竖缝贯穿本层的高光边与砖身
            # 横缝整行都是暗色 → 跨瓦片天然连续，砌层不会错位
            for x in range(w):
                p[(x, c0 + WALL_COURSE - 1)] = joint
            # 原图本来就有「只出现在砖身下沿的短竖缝」，保留一点这种不对称
            if rng.random() < 0.5:
                x = rng.randrange(w)
                if x not in xs:
                    p[(x, c0 + WALL_COURSE - 2)] = joint
        out.append(im)
    return out


def _variant_key(base_key: str, vi: int) -> str:
    """变体键：索引 0 就是底图本身，不另存一份，也不改名。"""
    return base_key if vi == 0 else f"{base_key}:{vi}"


def _art_rows(im: Image.Image) -> tuple[int, int]:
    """素材内容所占的行区间 [top, bottom]（含端点）。全透明返回 (h, -1)。"""
    a = im.getchannel("A")
    rows = [y for y in range(im.height) if any(a.getpixel((x, y)) for x in range(im.width))]
    return (rows[0], rows[-1]) if rows else (im.height, -1)


def verify_monster_fit(art: dict[str, dict]) -> list[str]:
    """
    怪物素材的两条布局断言。

    `art`： id -> {"h": 内容高度最坏值, "scale": 绘制倍数, "padIdle": idle 帧底留白最坏值}

    ① **非 BOSS 必须装得进一格。** 落屏内容高度 ≤ CELL。
       抓的是「精灵比格子还高」——它会让「怪物占哪一格」在画面上变得不确定，
       而魔塔是靠走进某格来打怪的。实测踩过：5 只非 BOSS 取了 ×3，
       全塔 479 只怪物里 145 只是它们。

    ② **idle 帧必须底对齐（底留白为 0）。**
       渲染层让精灵「站在脚下名牌的上沿」，站的位置就是帧底沿；idle 又是棋盘上
       唯一会用到的动画。帧底若留白，怪物就会浮在名牌上方 —— 而且不同怪浮的量不同，
       非常难查。
       注意**只断言 idle**：`run` 帧实测有 1–3px 底留白，那是源动画本身的起伏，
       而棋盘不用 run 帧（`grep "run" src/` 为空）。对所有帧一刀切会误报。
    """
    problems: list[str] = []
    for mid, info in sorted(art.items()):
        if info["padIdle"] != 0:
            problems.append(
                f"怪物 {mid} 的 idle 帧底部有 {info['padIdle']}px 透明留白 —— 渲染层让精灵"
                f"站在脚下名牌的上沿，留白会让它浮在半空。idle 帧必须底对齐"
            )
        if mid in OVERSIZE_BOSSES:
            continue
        h, scale = info["h"], info["scale"]
        if h * scale > CELL:
            problems.append(
                f"怪物 {mid} 落屏内容高 {h}×{scale}={h * scale}px，超过格子 {CELL}px —— "
                f"非加大的精灵必须装得进一格，否则「它占哪一格」在画面上不确定。"
                f"（确实要更大且是 BOSS，就加进 OVERSIZE_BOSSES）"
            )
    return problems


# 「画得比一格大」的怪物名单 —— 注意它**不等于**「玩法上的 BOSS」。
#
# 玩法 BOSS 的真值在 `data/monsters.json` 的 `boss` 字段（共 8 只：
# skeletonCaptain / vampire / archmage / knightCaptain / dragon / kraken /
# demonKing / demonKingTrue），渲染层据此画金色圈。
# 这里只挑其中 4 只**额外放大**：它们各自是一段塔层的关底，
# 尺寸本身就是「这个打不过」的第一眼信号；另外 4 只是层内强敌，
# 再放大反而会糊到邻格上，金色圈已经够表意了。
#
# 名字原来叫 BOSS_SCALE_EXEMPT，被 `tools/verify-visual.cjs` 的 A6 断言
# 逼着改掉了：那个名字会让人以为「BOSS 就这 4 只」，而实际是 8 只 ——
# 一个名字让两处真值看起来矛盾，是下一个 bug 的温床。
#
# 不变量（有断言，见 tools/verify-visual.cjs A6）：
# OVERSIZE_BOSSES ⊆ 玩法 BOSS。反方向不要求 —— 允许有 BOSS 不放大，
# 不允许有杂兵被放大。
OVERSIZE_BOSSES = {
    "dragon",
    "kraken",
    "demonKing",
    "demonKingTrue",
}


# ─────────────────────────────────────────────────────────────────────
# 六、怪物映射（34 只）
# ─────────────────────────────────────────────────────────────────────
# 格式： id -> (0x72 源名, 变换函数, 绘制倍数, 变换说明)
#
# 设计依据：这份怪物名单本身就成族（skeleton/skeletonSoldier/skeletonCaptain），
# 原版 50 层魔塔就是靠同图换色做的三级进阶，这里沿用同一套做法 ——
# 换色不是偷懒，是这个品类的既定视觉语言。
# 变换一律用 ramp（保明暗结构）而非 hue_shift（会糊成一坨纯色），
# 因为战士/骑士/骷髅这三族的阶差主要靠「材质」表达（铁→银→金）。
#
# ⚠️ 绘制倍数只有 BOSS 能取 3，其余一律 2 —— 这条有断言（见 verify_monster_fit）。
# 教训：曾经有 5 只非 BOSS（bigBat / vampireBat / bigSlime / slimeKing / stoneGolem）
# 也取了 ×3，落屏 36–39px，**越出 32px 的格子 4–7px**。全塔 479 只怪物里有 145 只
# 属于这 5 种，于是「它到底占哪一格」在画面上变得不确定 ——
# 而魔塔是靠「走进哪一格」来打怪的，格子边界不是审美问题。
# BOSS 超出格子是刻意的（大块头本身是层级信号），而且实测 BOSS 都落在 y≥3，
# 越出的是自己头顶那一格，不会捅出棋盘外框。

def _r(dark, light):
    return lambda im: ramp(im, dark, light)


def _h(deg, sat=1.0, val=1.0):
    return lambda im: hue_shift(im, deg, sat, val)


IRON, SILVER, GOLD = (46, 48, 58), (214, 222, 236), (196, 148, 42)
BONE, BLOOD, SHADOW = (78, 66, 52), (92, 16, 28), (28, 22, 40)
STONE_F, STONE_L = (72, 70, 74), (176, 172, 168)

MONSTERS = {
    # ── 骷髅三阶：骨 → 铁甲 → 金甲 ────────────────────────────────
    "skeleton":        ("skelet",        _r((72, 62, 48), (238, 232, 208)), 2, "骨色原样"),
    "skeletonSoldier": ("skelet",        _r(IRON, SILVER),                  2, "铁甲渐变"),
    "skeletonCaptain": ("skelet",        _r((92, 62, 12), (250, 214, 96)),  2, "金甲渐变"),

    # ── 亡灵族 ──────────────────────────────────────────────────
    "ghostWarrior":    ("wogol",         _h(160, 0.55, 1.1),                2, "青白，幽灵感"),
    "phantom":         ("wogol",         lambda im: alpha_mul(hue_shift(im, 250, 0.7), 0.7), 2, "紫，半透明"),
    "vampire":         ("zombie",        _h(300, 0.5, 0.9),                 2, "紫，尸族"),
    "ice_zombie":      ("ice_zombie",    None,                              2, "原样（备用图，本作暂未用）"),

    # ── 蝙蝠族：用带翼的 imp ────────────────────────────────────
    # ⚠️ 只有 OVERSIZE_BOSSES 里的那 4 只允许乘 3。其余一律乘 2 —— 见该常量的说明。
    "bat":             ("imp",           _h(20, 0.9, 0.95),                 2, "褐"),
    "bigBat":          ("imp",           _h(10, 1.15, 0.8),                 2, "深褐（原为 ×3，实测越出格子 4px）"),
    "vampireBat":      ("imp",           _h(340, 1.4, 0.95),                2, "血红（原为 ×3）"),

    # ── 史莱姆族：绿 → 红 → 大 → 王 ────────────────────────────
    "greenSlime":      ("swampy",        _h(0, 1.0, 1.0),                   2, "原色即绿"),
    "redSlime":        ("swampy",        _h(300, 1.3, 1.05),                2, "红"),
    "bigSlime":        ("muddy",         _h(0, 1.15, 1.0),                  2, "绿（原为 ×3，实测越出格子 7px）"),
    "slimeKing":       ("muddy",         lambda im: ramp(im, (96, 62, 10), (250, 216, 112)), 2, "金（原为 ×3）"),

    # ── 法师族：学徒 → 资深（蓝 → 紫） ─────────────────────────
    "juniorMage":      ("wizzard_m",     _h(150, 1.2),                      2, "蓝袍"),
    "seniorMage":      ("wizzard_m",     _h(230, 1.2),                      2, "紫袍"),
    "juniorWizard":    ("wizzard_f",     _h(150, 1.2),                      2, "蓝袍"),
    "seniorWizard":    ("wizzard_f",     _h(230, 1.2),                      2, "紫袍"),
    "archmage":        ("orc_shaman",    lambda im: ramp(im, (92, 66, 14), (246, 214, 118)), 2, "金袍"),
    "magicGuard":      ("necromancer",   _h(140, 1.25),                     2, "青，魔卫"),

    # ── 兽人族 ──────────────────────────────────────────────────
    "orc":             ("orc_warrior",   _h(0, 1.0),                        2, "原色"),
    "orcWarrior":      ("masked_orc",    _h(20, 1.25, 0.9),                 2, "深绿"),
    "goblin":          ("goblin",        None,                              2, "原样"),

    # ── 守卫族：青铜 → 白银 → 黄金 ─────────────────────────────
    "juniorGuard":     ("knight_m",      _r((86, 52, 24), (214, 148, 86)),  2, "青铜"),
    "midGuard":        ("knight_m",      _r(IRON, SILVER),                  2, "白银"),
    "seniorGuard":     ("knight_m",      _r((92, 62, 12), (250, 214, 96)),  2, "黄金"),

    # ── 剑士 / 骑士族 ──────────────────────────────────────────
    "swordsman":       ("elf_m",         _h(330, 1.35),                     2, "红"),
    "warrior":         ("knight_f",      _r((60, 58, 66), (196, 194, 202)), 2, "铁"),
    "knight":          ("knight_m",      _h(170, 1.2),                      2, "蓝甲"),
    "knightCaptain":   ("knight_f",      _r(IRON, SILVER),                  2, "白银"),
    "darkKnight":      ("knight_m",      _r((14, 12, 20), (110, 106, 128)), 2, "近黑"),
    "stoneGolem":      ("ogre",          _r(STONE_F, STONE_L),              2, "石色（原为 ×3，实测越出格子 7px）"),

    # ── BOSS：允许 ×3（48px）。层级信号靠尺寸，但**只有 BOSS 有这个特权** ──────
    "dragon":          ("chort",         _h(320, 1.4),                      3, "赤红，放大"),
    "kraken":          ("swampy",        _h(250, 1.25, 0.9),                3, "深紫，放大"),
    "demonKing":       ("big_demon",     None,                              3, "源为 32×32，归一化到 16 后放大，与巨龙同级"),
    "demonKingTrue":   ("big_demon",     _h(320, 1.45, 1.1),                3, "猩红真身"),
}

# ─────────────────────────────────────────────────────────────────────
# 七、道具映射（32 项）
# ─────────────────────────────────────────────────────────────────────

# 匙身横带的色相区间。
# 实测 Kenney #126 只有 10 个像素落在这个区间 —— 就是那截识别色横带；
# 匙柄（橙，15–45°）和匙体（深，260–345°）都在区间外，所以重染不会碰到它们。
KEY_ACCENT = (70, 165)

ITEM_SRC = {
    # 宝石：六个源包里都没有 —— 程序化生成（见 gen_icon 的 gem_red/gem_blue）。
    # 曾经从 0x72 图集 r12c1/r12c3 切，但那两格是纯色矩形，棋盘上就是两个方块。
    "redGem":   ("gen", "gem_red",  "程序化生成（0x72/Kenney 均无宝石）"),
    "blueGem":  ("gen", "gem_blue", "程序化生成（0x72/Kenney 均无宝石）"),

    "redPotion":  ("o72", "flask_red",   "0x72/flask_red"),
    "bluePotion": ("o72", "flask_blue",  "0x72/flask_blue"),
    "holyWater":  ("o72", "flask_big_blue", "0x72/flask_big_blue"),

    # 钥匙：Kenney tiny-dungeon 的钥匙是「深色匙体 + 橙色匙柄 + 一截彩色横带」，
    # 识别颜色**只在那截横带上**（绿/红/蓝各约 10 像素）。
    # 所以三色钥匙统一取同一张底图（#126），只把横带重染成金/蓝/红 ——
    # 这样它们天然是一套，颜色也各自纯粹，还顺手补上了原素材没有的黄色。
    # （试过用整体 hue_shift 把绿钥匙转成黄：匙柄会跟着转，得到一把「绿头蓝身」的
    #   钥匙，既不像黄钥匙又和蓝钥匙撞色。整体转色相在这个素材包里基本都不可靠。）
    "yellowKey": ("ken", 126, KEY_ACCENT + ((92, 62, 12), (252, 214, 96)), "Kenney #126 @ 匙身重染为金"),
    "blueKey":   ("ken", 126, KEY_ACCENT + ((14, 24, 58), (150, 194, 246)), "Kenney #126 @ 匙身重染为蓝"),
    "redKey":    ("ken", 126, KEY_ACCENT + ((58, 10, 16), (250, 138, 138)),  "Kenney #126 @ 匙身重染为红"),
    # 万能钥匙：整把压成黄金渐变，保留 #129 不同的匙柄造型 —— 与黄钥匙（橙色匙柄）区分
    "goldenKey": ("ken", 129, "gold", "Kenney #129 @ 整把黄金渐变"),

    # 剑：0x72 的 22 把武器里挑 6 把，按威力从朴素到华丽
    "ironSword":   ("o72", "weapon_rusty_sword",  "0x72/weapon_rusty_sword"),
    "silverSword": ("o72", "weapon_regular_sword", "0x72/weapon_regular_sword"),
    "knightSword": ("o72", "weapon_knight_sword", "0x72/weapon_knight_sword"),
    "holySword":   ("o72", "weapon_golden_sword", "0x72/weapon_golden_sword"),
    "sacredSword": ("o72", "weapon_lavish_sword", "0x72/weapon_lavish_sword"),
    "dragonSlayer": ("o72", "weapon_red_gem_sword", "0x72/weapon_red_gem_sword"),

    # 盾：Kenney #102，五级用渐变区分材质
    "ironShield":   ("ken", 102, "shield_iron",   "Kenney #102 @ 铁渐变"),
    "silverShield": ("ken", 102, "shield_silver", "Kenney #102 @ 银渐变"),
    "knightShield": ("ken", 102, "shield_knight", "Kenney #102 @ 蓝钢渐变"),
    "holyShield":   ("ken", 102, "shield_holy",   "Kenney #102 @ 黄金渐变"),
    "sacredShield": ("ken", 102, "shield_sacred", "Kenney #102 @ 圣红渐变"),

    # 工具
    "shovel":  ("sheet", (5 * 16, 192, 6 * 16, 208), "0x72 图集 r12c5（镐）"),
    "bomb":    ("gen", "bomb",        "程序化生成"),
    "cross":   ("gen", "cross",       "程序化生成"),
    "snowflake": ("gen", "snowflake", "程序化生成"),
    "quakeScroll": ("gen", "scroll",  "程序化生成"),
    "monsterBook": ("gen", "book_monster", "程序化生成"),
    "notebook": ("gen", "book_note",  "程序化生成"),
    "mirrorFlyer": ("gen", "mirror",  "程序化生成"),
    "upFlyer":   ("gen", "wing_up",   "程序化生成"),
    "downFlyer": ("gen", "wing_down", "程序化生成"),
    "floorTeleporter": ("gen", "portal", "程序化生成"),

    # 金币堆：用 0x72 的金币首帧放大（保持与 bigGold「大堆」的观感差）
    "bigGold": ("o72", "coin_anim_f0", "0x72/coin_anim_f0"),
}

# ─────────────────────────────────────────────────────────────────────
# 八、程序化图标（补缺口专用）
# ─────────────────────────────────────────────────────────────────────
# 只给「六个免费包里确实没有对等物件」的道具用。每一张都经过 add_outline，
# 保证和手绘素材一样带深色描边，混在一起不会露馅。

INK = (42, 32, 40, 255)


def _canvas():
    return Image.new("RGBA", (BASE_TILE, BASE_TILE), (0, 0, 0, 0))


def gen_icon(kind: str) -> Image.Image:
    im = _canvas()
    d = ImageDraw.Draw(im)

    if kind == "bomb":
        d.ellipse([3, 5, 12, 14], fill=(38, 38, 48, 255))
        d.ellipse([5, 7, 8, 10], fill=(96, 96, 112, 255))
        d.line([10, 5, 11, 2], fill=(150, 110, 60, 255))
        d.point((12, 1), fill=(250, 190, 70, 255))
        d.point((11, 1), fill=(250, 140, 50, 255))

    elif kind == "cross":
        d.rectangle([6, 2, 9, 13], fill=(226, 186, 96, 255))
        d.rectangle([3, 5, 12, 8], fill=(226, 186, 96, 255))
        d.rectangle([7, 3, 8, 12], fill=(250, 226, 150, 255))

    elif kind == "snowflake":
        c = (176, 226, 250, 255)
        d.line([8, 2, 8, 13], fill=c)
        d.line([2, 8, 13, 8], fill=c)
        d.line([4, 4, 11, 11], fill=c)
        d.line([11, 4, 4, 11], fill=c)
        for p in [(8, 2), (8, 13), (2, 8), (13, 8)]:
            d.point(p, fill=(230, 248, 255, 255))

    elif kind in ("gem_red", "gem_blue"):
        # 宝石是**六个源包里唯一真正缺失的对象**，所以只能生成：
        #   0x72 的 130 张帧里没有宝石（只有 skull / coin / flask_* / ui_heart_*）；
        #   Kenney 的 roguelike-rpg-pack / tiny-dungeon 里也找不到「红/蓝菱形」这个轮廓。
        # 轮廓必须是菱形 —— 这是宝石在图鉴里唯一不会和药水瓶、金币混淆的形状，
        # 而这也正是原来那版的问题：它从 0x72 图集 r12c1/r12c3 切了两块**纯色矩形**
        # 来当宝石（那两格其实是图集里给别的用途画的色块），
        # 结果棋盘上显示成两个纯红/纯蓝的方块，既不像宝石也认不出是什么。
        if kind == "gem_red":
            face, lit, dark = (226, 74, 60, 255), (250, 150, 130, 255), (140, 34, 40, 255)
        else:
            face, lit, dark = (78, 148, 226, 255), (152, 204, 250, 255), (34, 64, 140, 255)
        d.polygon([(8, 1), (14, 7), (8, 14), (2, 7)], fill=face)   # 主体菱形
        d.polygon([(8, 1), (11, 4), (8, 6), (5, 4)], fill=lit)     # 顶部切面高光
        d.line([2, 7, 8, 14], fill=dark)                           # 左下暗面
        d.line([8, 14, 14, 7], fill=dark)                          # 右下暗面

    elif kind == "scroll":
        d.rectangle([3, 4, 12, 12], fill=(214, 190, 146, 255))
        d.rectangle([3, 3, 12, 4], fill=(150, 108, 62, 255))
        d.rectangle([3, 11, 12, 12], fill=(150, 108, 62, 255))
        for y in (6, 8):
            d.line([5, y, 10, y], fill=(120, 86, 48, 255))

    elif kind == "book_monster":
        d.rectangle([3, 3, 12, 13], fill=(96, 44, 56, 255))
        d.rectangle([4, 4, 11, 12], fill=(198, 178, 150, 255))
        d.ellipse([6, 6, 9, 9], fill=(210, 60, 60, 255))  # 封面上的兽眼

    elif kind == "book_note":
        d.rectangle([3, 3, 12, 13], fill=(58, 74, 110, 255))
        d.rectangle([4, 4, 11, 12], fill=(226, 222, 210, 255))
        for y in (6, 8, 10):
            d.line([5, y, 10, y], fill=(140, 140, 150, 255))

    elif kind == "mirror":
        d.ellipse([3, 2, 12, 11], fill=(196, 226, 244, 255))
        d.ellipse([4, 3, 11, 10], fill=(128, 184, 226, 255))
        d.line([9, 4, 5, 9], fill=(240, 250, 255, 255))
        d.rectangle([7, 11, 8, 14], fill=(150, 108, 62, 255))

    elif kind in ("wing_up", "wing_down"):
        c = (232, 226, 240, 255)
        s = (150, 146, 178, 255)
        if kind == "wing_up":
            d.polygon([(2, 10), (7, 3), (13, 6), (8, 9)], fill=c)
            d.line([3, 9, 8, 5], fill=s)
        else:
            d.polygon([(2, 5), (7, 12), (13, 9), (8, 6)], fill=c)
            d.line([3, 6, 8, 10], fill=s)

    elif kind == "portal":
        d.ellipse([2, 2, 13, 13], fill=(72, 52, 128, 255))
        d.ellipse([4, 4, 11, 11], fill=(140, 106, 220, 255))
        d.ellipse([6, 6, 9, 9], fill=(226, 208, 255, 255))

    else:
        raise KeyError(kind)

    return add_outline(im, INK)


# ─────────────────────────────────────────────────────────────────────
# 九、角色表切分（ArMM1998 Zelda-like）
# ─────────────────────────────────────────────────────────────────────
# 这张表不是规整网格：角色比 16px 格子高，且不同行带的帧距不一样。
# 所以先按投影找出「行带」，再在每个行带里按列投影切帧，而不是硬套 16 的倍率。

HERO_DIRS = ["down", "right", "up", "left"]
# NPC 素材的行带顺序与勇者不同：NPC_test.png 四行是 下/左/上/右
NPC_DIRS = ["down", "left", "up", "right"]


def slice_armm_rows(path: Path, row_specs):
    """
    row_specs: [(y0, y1, x_positions, crop_w), ...]
    返回 [[frame, ...], ...]，每帧已裁到内容包围盒。

    crop_w 必须传「帧距」而不是一个够大的数 —— 相邻帧只差 16px，
    裁宽了就会把下一帧的头一起吃进来。
    """
    im = Image.open(path).convert("RGBA")
    out = []
    for y0, y1, xs, cw in row_specs:
        row = []
        for x0 in xs:
            cell = im.crop((x0, y0, x0 + cw, y1 + 1))
            bb = cell.getbbox()
            row.append(cell.crop(bb) if bb else cell)
        out.append(row)
    return out


def build_actor_sheet():
    """
    产出勇者（走路 4 向 × 4 帧 + 挥剑 4 向 × 4 帧）+ 6 个 NPC（各 4 向 × 4 帧）。
    这是全套素材里唯一真正的「多角度」来源，务必切准。
    """
    char = ARMM / "character.png"
    src = Image.open(char).convert("RGBA")
    px = src.load()
    W, H = src.size
    rowbands = bands([sum(1 for x in range(W) if px[x, y][3] > 8) for y in range(H)])

    # 走路：行带 0..3 = 下/左/上/右，每带第一组 4 帧，帧距 16
    walk_specs = [(rowbands[i][0], rowbands[i][1], [0, 16, 32, 48], 16) for i in range(4)]
    walk = slice_armm_rows(char, walk_specs)

    # 挥剑：行带 4..7，列位 7 / 40 / 72 / 104 —— 帧距 32，所以裁宽可以给到 32
    atk_specs = [(rowbands[i][0], rowbands[i][1], [7, 40, 72, 104], 32) for i in range(4, 8)]
    attack = slice_armm_rows(char, atk_specs)

    # NPC：规整 4×4，帧距 16
    npc_path = ARMM / "NPC_test.png"
    npc_specs = [(7, 27, [1, 17, 33, 49], 16), (39, 59, [1, 17, 33, 49], 16),
                 (70, 91, [1, 17, 33, 49], 16), (103, 123, [1, 17, 33, 49], 16)]
    npc_frames = slice_armm_rows(npc_path, npc_specs)

    return walk, attack, npc_frames


# 6 个 NPC 用同一张图做材质渐变区分。原素材只有一个人形，无法逐个重画；
# 渐变至少能做到「一眼分得清谁是谁」，且保住 4 向 4 帧的动画。
NPC_STYLE = {
    "sage":     ((88, 84, 78), (238, 234, 222)),   # 灰白老者
    "merchant": ((92, 56, 22), (226, 176, 108)),   # 暖褐
    "thief":    ((28, 26, 42), (128, 124, 156)),   # 暗紫
    "fairy":    ((72, 120, 132), (186, 240, 236)), # 青白
    "princess": ((122, 46, 96), (248, 190, 224)),  # 粉
    "shop":     ((30, 78, 48), (142, 218, 148)),   # 绿
}


# ─────────────────────────────────────────────────────────────────────
# 十、主流程
# ─────────────────────────────────────────────────────────────────────


def mean_hsv(im: Image.Image, min_sat: float = 0.18):
    """
    只统计有彩度的像素求平均色相/饱和/明度。

    为什么要排除低饱和像素：所有素材都带近黑的描边，如果把描边算进去，
    任何颜色的平均色相都会被拉向「无色」，断言就失去意义了。
    """
    px = im.load()
    hs = ss = vs = 0.0
    n = 0
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a < 128:
                continue
            h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if s > min_sat:
                hs += h * 360
                ss += s
                vs += v
                n += 1
    if n == 0:
        return None
    return hs / n, ss / n, vs / n


def mean_lum(im: Image.Image) -> float:
    """
    不透明像素的平均相对亮度（0~1）。

    和 mean_hsv 不同，这里**不**排除低饱和像素 —— 算的是「感知对比度」，
    砖缝、描边这些近黑像素恰恰是决定「两格看起来是不是一个色」的主力，
    把它们剔掉反而会得出「对比度够了」的假结论。
    """
    px = im.convert("RGBA").load()
    tot = 0.0
    n = 0
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            tot += (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
            n += 1
    return tot / n if n else 0.0


def verify_terrain(cells: dict) -> list[str]:
    """
    对地形做色彩断言。

    这些断言是有代价的教训：一开始红门用 hue_shift(+250°) 做，看着「转了色」就
    通过了肉眼检查，实际上色相落在 250°（蓝紫）—— 门是紫的。而岩浆被转到 201°
    （青色）。肉眼在缩略图上很难发现，用色相区间一键就抓出来了。
    """
    problems: list[str] = []

    EXPECT = {
        # 键: (名称, 色相下界, 色相上界, 明度下界)
        # 地面放宽到 48°：暖砂石本色就落在 30~42°，这里卡的是「必须是暖色」，
        # 不是「必须精确等于某个橙色」—— 过窄的区间只会变成维护负担。
        "0": ("地面", 0, 48, 0.55),          # ramp_norm 后应远亮于墙（墙约 0.23）
        "5": ("岩浆", 8, 48, 0.30),          # 橙红
        "7": ("黄门", 32, 62, 0.35),
        "8": ("蓝门", 190, 250, 0.35),
        "9": ("红门", 335, 360, 0.35),       # 红跨 0°，循环里单独补判 0–22°
    }

    for key, (name, lo, hi, vmin) in EXPECT.items():
        cell = cells.get(key)
        if cell is None:
            problems.append(f"地形 {key}（{name}）缺失")
            continue
        got = mean_hsv(cell)
        if got is None:
            problems.append(f"地形 {key}（{name}）没有任何彩色像素")
            continue
        h, s, v = got
        ok_h = lo <= h <= hi
        if key == "9":  # 红色跨 360°
            ok_h = (335 <= h <= 360) or (0 <= h <= 22)
        if not ok_h:
            problems.append(f"地形 {key}（{name}）色相 {h:.1f}° 不在 [{lo}, {hi}] —— 颜色不对")
        if v < vmin:
            problems.append(f"地形 {key}（{name}）明度 {v:.2f} < {vmin} —— 偏暗")

    # 假墙必须与真墙逐像素一致。这不是审美问题：假墙一旦看得出来，玩法就废了。
    w, fw = cells.get("1"), cells.get("11")
    if w is not None and fw is not None:
        if list(w.get_flattened_data()) != list(fw.get_flattened_data()):
            problems.append("假墙(11) 与真墙(1) 图像不一致 —— 玩家会一眼看穿，玩法失效")
    else:
        problems.append("真墙或假墙缺失，无法校验一致性")

    # ── 下面两条是「静默变丑」类的 bug，肉眼在缩略图上很难发现，只能靠断言 ──

    # ① 墙族必须完全不透明。
    # 踩过的坑：wall_top_mid 原样用的时候整格 75% 是透明的（它是给「贴到上面
    # 那一格下沿」用的），贴上去直接露出白色面板，像墙缺了一块。缩略图上看着
    # 「有花纹」就通过了肉眼检查，实际是破的。
    # 只对墙族断言「必须全不透明」—— 门是有意留透明的（开门后本来就该看穿，
    # 三色门四角也是圆角），对它们要求全不透明反而会把正确的东西判错。
    for key in sorted(cells):
        if key != "1" and key != "11" and not key.startswith("1:"):
            continue
        im = cells.get(key)
        if im is None:
            problems.append(f"墙族瓦片 {key} 缺失，无法校验不透明性")
            continue
        clear = sum(1 for a in im.getchannel("A").get_flattened_data() if a == 0)
        if clear:
            problems.append(
                f"墙族瓦片 {key} 有 {clear} 个透明像素 —— 墙是实心的，透出来会露出"
                f"底色（多半是忘了把 wall_top_mid 和墙身预合成，或忘了翻转）"
            )

    # ② 任何地形瓦片都不该「近乎全空」——那说明源图找错了。
    # 阈值定在 90%：自动门是 50% 透明（门洞就该是空的），留足余量。
    for key, im in sorted(cells.items()):
        frac = sum(1 for a in im.getchannel("A").get_flattened_data() if a == 0) / (im.width * im.height)
        if frac >= 0.9:
            problems.append(f"地形 {key} 有 {frac:.0%} 的像素是全透明的 —— 这张图几乎是空的，多半取错了源")

    # ③ 上楼梯与下楼梯必须可区分。
    # 踩过的坑：0x72 只有一张 floor_ladder，不翻转的话两个楼梯一模一样，
    # 玩家在塔里分不清哪边是往上走。
    up, down = cells.get("4"), cells.get("3")
    if up is not None and down is not None:
        if list(up.get_flattened_data()) == list(down.get_flattened_data()):
            problems.append(
                "上楼梯(4) 与下楼梯(3) 图像完全相同 —— 玩家分不清方向，"
                "上楼梯需要在构建期做垂直翻转"
            )
    else:
        problems.append("上/下楼梯瓦片缺失，无法校验可区分性")

    # ④ 地面与墙必须有足够的明度差。
    # 踩过的坑（这条是本次才发现的）：floor_1 与 wall_mid 在 0x72 里共用同一套
    # 三色 (72,59,58)/(119,92,85)/(34,34,34)，源素材根本没打算靠颜色区分它们。
    # 只给地面提亮 ×1.5 时，实测平均亮度 0.364 vs 墙 0.232 —— 比值 1.57，
    # 亮度差不够、色相又完全一样，整屏糊成一片褐色，迷宫的地面/墙读不出来。
    # 这种事在缩略图上非常容易「看着还行」地蒙混过关，只有数值能抓住。
    # （顺带：墙砖缝 (34,34,34) 也等于史莱姆身体的深色，怪物会「粘」在墙上。）
    # 改用 ramp_norm 重染后实测 0.643 vs 0.232，比值 2.77。
    fl, wl = cells.get("0"), cells.get("1")
    if fl is not None and wl is not None:
        lf, lw = mean_lum(fl), mean_lum(wl)
        if lw <= 0 or lf / lw < 2.0:
            problems.append(
                f"地面/墙平均亮度比只有 {lf / lw:.2f}（地面 {lf:.3f} vs 墙 {lw:.3f}）"
                f" —— 低于 2.0 迷宫会读不出来。0x72 的 floor_1 与 wall_mid 同色板，"
                f"地面必须显式重染（TERRAIN[0] 应使用 ramp_norm 而非单纯提亮）"
            )
    else:
        problems.append("地面或墙缺失，无法校验对比度")

    # ⑤ 变体必须与底图**色调一致**。
    # 变体的全部意义是「打散平铺锁定」，不是「换一种地砖」。一旦某个变体的平均色
    # 偏了一点，11×11 的棋盘就会变成深浅不一的补丁 —— 比原来的重复感更难看，
    # 而且缩略图上根本看不出来，只有真机满屏铺开后才发现。
    #
    # 判据分三层，一层比一层严，各抓一种失败：
    #   ① 调色板必须一模一样：变体只允许在底图已有的颜色里挪像素。
    #      抓的是「有人顺手给变体加了个高光/阴影色」。
    #   ② 改动像素量有上限：变体应当**基本是**像素重排，只允许少量新增内容
    #      （地面撒几粒石子、墙补一条短竖缝）。
    #      抓的是「有人把变体当成第二套地砖来画」。
    #   ③ 逐通道平均色差 ≤ 1/255。抓的是满屏铺开后的补丁感 —— 这条才是真正
    #      对应「难看」的那一条，①② 是它的两道护栏。
    # 墙顶(1:top) 的上限放宽：它是把压顶 alpha 合成到换过砖身的底上，
    # 而压顶有半透明像素，合成结果天然会比纯重排多动一些像素。
    for family, drift_cap in (("0", 8), ("1", 8), ("1:top", 24)):
        keys = [k for k in cells if k == family or k.startswith(family + ":")]
        if family == "1":  # `1:top` 自成一族，别混进来
            keys = [k for k in keys if not k.startswith("1:top")]
        keys.sort()
        if len(keys) < 2:
            problems.append(f"地形族 {family} 只有 {len(keys)} 张瓦片，变体没有生成")
            continue
        base_hist = _hist(cells[keys[0]])
        base_mean = _mean_rgb(cells[keys[0]])
        for k in keys[1:]:
            im = cells[k]
            h = _hist(im)
            extra = sorted(set(h) - set(base_hist))
            if extra:
                problems.append(
                    f"地形变体 {k} 引入了底图 {keys[0]} 没有的颜色 {extra} —— "
                    f"变体只能在底图已有的调色板里挪像素"
                )
            drift = sum(abs(h.get(c, 0) - base_hist.get(c, 0)) for c in set(h) | set(base_hist))
            if drift > drift_cap:
                problems.append(
                    f"地形变体 {k} 有 {drift} 个像素偏离底图配色（上限 {drift_cap}）—— "
                    f"变体应当基本是像素重排，而不是另画一套地砖"
                )
            m = _mean_rgb(im)
            if max(abs(a - b) for a, b in zip(m, base_mean)) > 1.0:
                problems.append(
                    f"地形变体 {k} 平均色 {tuple(round(v, 2) for v in m)} 偏离底图 {keys[0]} "
                    f"{tuple(round(v, 2) for v in base_mean)} 超过 1/255 —— "
                    f"满屏平铺后会变成深浅不一的补丁"
                )

    return problems


# 钥匙的识别色应该落在哪个色相区间。三把钥匙的横带都必须明确落在自己那一段里。
KEY_HUE_EXPECT = {
    "yellowKey": ("黄钥匙", 32, 62),
    "blueKey": ("蓝钥匙", 190, 250),
    "redKey": ("红钥匙", 335, 360),
}


def key_accent_hue(im: Image.Image, base: Image.Image) -> float | None:
    """
    量一把钥匙的「识别色」色相。

    判据是**「相对底图被改动的那些像素」**，而不是某个色相区间。

    为什么不用色相区间挑：三把钥匙的识别色是匙身横带，而金钥匙的横带（约 41°）
    和共用的橙色匙柄（约 30°）几乎挨着 —— 想用「排除匙柄色段」的办法把横带挑出来，
    区间划在哪里都会误伤一边。用「改了什么」来定义识别色，既精确又不会自相矛盾。

    用**圆周平均**：红色跨 0°，算术平均会算出青色这种荒唐结果。
    """
    a = im.convert("RGBA").load()
    b = base.convert("RGBA").load()
    sx = sy = 0.0
    n = 0
    for y in range(im.height):
        for x in range(im.width):
            ra, ga, ba_, aa = a[x, y]
            if aa < 200:
                continue
            if (ra, ga, ba_) == b[x, y][:3]:
                continue  # 没被改动 = 匙柄/匙体，不参与识别
            h, s, v = colorsys.rgb_to_hsv(ra / 255, ga / 255, ba_ / 255)
            if s < 0.15 or v < 0.12:
                continue
            rad = h * 2 * math.pi
            sx += math.cos(rad)
            sy += math.sin(rad)
            n += 1
    if n == 0:
        return None
    return (math.atan2(sy / n, sx / n) * 180 / math.pi) % 360


def dominant_hue(im: Image.Image, min_sat: float = 0.35) -> float | None:
    """
    出现次数最多的那个**有彩度**的不透明颜色的色相。

    两个设计决定，都是被断言逼出来的：

    ① 用众数而不是均值。像素画的颜色是**离散**的，拿算术平均几乎没有意义。
       宝石的描边 INK(42,32,40) 色相 312°，主体 5° 的红，一平均得到 150° 附近 ——
       一个既不是红也不是品红的中间色，于是「红宝石是不是红的」会被平均成假通过。

    ② 用彩度门槛排掉共用描边。所有**程序化生成**的图标都过 add_outline，
       统一用 INK，而 INK 的彩度 0.238 恰好比主体色（0.48~0.76）低一截，
       但又不为零 —— 于是描边像素数（菱形周长，含对角共 58 个）会**压过**宝石
       本体（57 个），众数落到描边上，色相判断直接翻车（实测就是 312°）。
       门槛取 0.35：刚好把 INK 排除，又留下所有真实颜色。
    """
    counts: dict[tuple[int, int, int], int] = {}
    px = im.convert("RGBA").load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a <= 128:
                continue
            if colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[1] < min_sat:
                continue
            counts[(r, g, b)] = counts.get((r, g, b), 0) + 1
    if not counts:
        return None
    r, g, b = max(counts.items(), key=lambda kv: kv[1])[0]
    return colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[0] * 360


def verify_items(cells: dict, key_base: Image.Image) -> list[str]:
    """
    道具断言。

    为什么重点断言钥匙：三色钥匙是「颜色即玩法」—— 拿错钥匙开不了门，玩家必须
    一眼分得清。而它恰恰是唯一一个**原素材没有、需要构建期造出来**的东西
    （Kenney 只有绿/红/蓝/紫，没有黄），所以最容易在改素材时悄悄跑偏。
    """
    problems: list[str] = []

    hues: dict[str, float] = {}
    for key, (label, lo, hi) in KEY_HUE_EXPECT.items():
        im = cells.get(key)
        if im is None:
            problems.append(f"{label}({key}) 缺失")
            continue
        h = key_accent_hue(im, key_base)
        if h is None:
            problems.append(f"{label}({key}) 相对底图没有任何改动 —— 横带没染上色")
            continue
        hues[key] = h
        ok = lo <= h <= hi or (key == "redKey" and 0 <= h <= 22)
        if not ok:
            problems.append(
                f"{label}({key}) 识别色色相 {h:.1f}° 不在 [{lo}, {hi}] —— 拿错钥匙开不了门，"
                f"玩家必须一眼分得清"
            )

    # 三把钥匙两两之间色相要拉开，否则「分得清」只是理论上的
    ks = list(hues)
    for i in range(len(ks)):
        for j in range(i + 1, len(ks)):
            d = abs(hues[ks[i]] - hues[ks[j]])
            d = min(d, 360 - d)
            if d < 40:
                problems.append(
                    f"{KEY_HUE_EXPECT[ks[i]][0]} 与 {KEY_HUE_EXPECT[ks[j]][0]} 色相只差 {d:.0f}° —— 太近，认不出"
                )

    # 黄钥匙与万能钥匙不能长得一样（一个是普通钥匙，一个是全塔通行证）
    y, g = cells.get("yellowKey"), cells.get("goldenKey")
    if y is not None and g is not None:
        if list(y.get_flattened_data()) == list(g.get_flattened_data()):
            problems.append("黄钥匙与万能钥匙图像完全相同 —— 两者价值差很多，必须能区分")

    # 宝石：菱形轮廓 + 明确色相，两条都要。
    # 失败模式是**静默**的：上一版从 0x72 图集 r12c1/r12c3 切了两块纯色矩形当宝石
    # （那两格其实是图集里给别的用途画的色块），构建不报错、渲染也不报错，
    # 只是棋盘上出现两个莫名其妙的正方形。轮廓断言就是专门抓这种事的。
    for key, (label, red) in (("redGem", ("红宝石", True)), ("blueGem", ("蓝宝石", False))):
        im = cells.get(key)
        if im is None:
            problems.append(f"{label}({key}) 缺失")
            continue
        px = im.load()
        widths = [
            sum(1 for x in range(im.width) if px[x, y][3] > 128) for y in range(im.height)
        ]
        top = sum(widths[1:5]) / 4
        mid = sum(widths[6:10]) / 4
        bottom = sum(widths[10:14]) / 4
        if not (mid > top + 2 and mid > bottom + 1):
            problems.append(
                f"{label}({key}) 不是菱形（行宽 上/中/下 = {top:.1f}/{mid:.1f}/{bottom:.1f}）"
                f" —— 多半切成了图集里的纯色块，不是宝石"
            )
        h = dominant_hue(im)
        if h is None:
            problems.append(f"{label}({key}) 没有任何不透明像素")
            continue
        ok = (h <= 30 or h >= 330) if red else (190 <= h <= 260)
        if not ok:
            problems.append(
                f"{label}({key}) 主色相 {h:.1f}° 不对（红应 ≈0°，蓝应 ≈210°）"
                f" —— 两块宝石分不出来就失去意义了"
            )

    # 所有道具都必须自带高透明度之外的不透明像素，否则在棋盘上就是个空框
    for key, im in sorted(cells.items()):
        opaque = sum(1 for a in im.getchannel("A").get_flattened_data() if a >= 200)
        if opaque < 12:
            problems.append(f"道具 {key} 只有 {opaque} 个不透明像素 —— 几乎是空图")

    return problems


def monster_frames(src_name: str, anim: str) -> tuple[list[str], str]:
    """
    取某个 0x72 生物的 4 帧文件名，不足则循环补齐。

    为什么需要兜底：并不是每只生物都画满了 idle4 + run4。`swampy` 只有
    run 的第 0 帧 —— 如果直接判「缺帧」，绿史莱姆/红史莱姆/海妖三只就全
    掉进程序化兜底，画风当场破掉。循环补齐至少保住素材本身。

    返回 (4 个文件名, 实际用到的动作名)。
    """
    for cand in (anim, "idle" if anim == "run" else "run"):
        names = [f"{src_name}_{cand}_anim_f{i}" for i in range(4)]
        have = [n for n in names if (O72 / f"{n}.png").exists()]
        if have:
            return [have[i % len(have)] for i in range(4)], cand
    return [], anim


def main() -> int:
    ATLAS_DIR.mkdir(parents=True, exist_ok=True)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)

    manifest: dict = {
        "meta": {
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "generator": "tools/build-assets.py",
            "baseTile": BASE_TILE,
            "cell": CELL,
            "drawScale": DRAW_SCALE,
            "bigScale": BIG_SCALE,
            "note": "实体 → 图集坐标的唯一事实来源。改映射请改 tools/build-assets.py 后重跑，"
                    "不要直接编辑本文件。",
        },
        "terrain": {},
        "monsters": {},
        "items": {},
        "actors": {},
        "atlases": {},
    }

    missing: list[str] = []

    # ── 1. 地形 ──────────────────────────────────────────────────
    terr_shelf = Shelf(512)
    terr_cells: list[tuple[str, Image.Image, dict]] = []

    def push_terrain(key: str, name: str, im: Image.Image, src: str):
        terr_cells.append((key, im, {"name": name, "src": src}))

    for code, (name, fn, src) in TERRAIN.items():
        push_terrain(str(code), name, fn(), src)
    for code, (name, fn, src) in TERRAIN_TOP.items():
        push_terrain(f"{code}:top", name, fn(), src)

    # 变体。墙的变体要在「去压顶的墙身」上生成，再把压顶合上去 ——
    # 反过来（在带压顶的图上重排竖缝）会把压顶那三行也当成砖身画掉。
    _base = {k: im for k, im, _ in terr_cells}
    _wall_bodies = _wall_variants(_base["1"])
    for vi, im in enumerate(_floor_variants(_base["0"])):
        if vi:
            push_terrain(_variant_key("0", vi), f"floor#{vi}", im,
                         f"由 TERRAIN[0] 派生：倒角缺口重排 + 同色小杂质（第 {vi} 号变体）")
    for vi, im in enumerate(_wall_bodies):
        if vi:
            push_terrain(_variant_key("1", vi), f"wall#{vi}", im,
                         f"由 TERRAIN[1] 派生：竖缝位置重排，砌层与配色不变（第 {vi} 号变体）")
    for vi, body in enumerate(_wall_bodies):
        if vi:
            push_terrain(f"1:top:{vi}", f"wallTop#{vi}", _wall_top_baked(body),
                         f"由 TERRAIN_TOP[1] 派生：墙身换变体后重新合成压顶（第 {vi} 号变体）")

    # 变体数量写进 MANIFEST —— 渲染层据此决定哈希取模，不写死常量
    manifest["meta"]["terrainVariants"] = {
        "0": FLOOR_VARIANTS,
        "1": WALL_VARIANTS,
        "1:top": WALL_VARIANTS,
    }

    for _, im, _ in terr_cells:
        terr_shelf.add(im)

    terr_by_key = {k: im for k, im, _ in terr_cells}
    terr_sheet, terr_entries = terr_shelf.render()
    for (key, im, info), e in zip(terr_cells, terr_entries):
        terr_sheet.paste(im, (e["x"], e["y"]), im)
        manifest["terrain"][key] = {
            "atlas": "terrain", "x": e["x"], "y": e["y"],
            "w": im.width, "h": im.height, "drawScale": DRAW_SCALE,
            "name": info["name"], "src": info["src"],
        }
    terr_sheet.save(ATLAS_DIR / "terrain.png")

    # 地形配色是「颜色即玩法」（三色钥匙门 / 假墙伪装），必须断言而不是靠眼看
    problems = verify_terrain(terr_by_key)
    for p in problems:
        missing.append("地形断言失败：" + p)

    # ── 2. 勇者 + NPC ───────────────────────────────────────────
    walk, attack, npc_frames = build_actor_sheet()
    actor_cells: list[tuple[str, Image.Image]] = []
    actor_meta: list[dict] = []

    def push_actor(key: str, im: Image.Image, meta: dict):
        actor_cells.append((key, im))
        actor_meta.append(meta)

    hero_w, hero_h = 0, 0
    for di, d in enumerate(HERO_DIRS):
        for fi, fr in enumerate(walk[di]):
            im = bottom_center(fr, 16, 26)
            hero_w, hero_h = im.size
            push_actor(f"hero.walk.{d}.{fi}", im, {"group": "hero", "anim": "walk", "dir": d, "frame": fi})
    for di, d in enumerate(HERO_DIRS):
        for fi, fr in enumerate(attack[di]):
            im = bottom_center(fr, 20, 26)
            push_actor(f"hero.attack.{d}.{fi}", im, {"group": "hero", "anim": "attack", "dir": d, "frame": fi})

    for npc_id, (dk, lt) in NPC_STYLE.items():
        for di, d in enumerate(NPC_DIRS):
            for fi, fr in enumerate(npc_frames[di]):
                im = bottom_center(ramp(fr, dk, lt), 16, 26)
                push_actor(f"npc.{npc_id}.{d}.{fi}", im, {"group": "npc", "npc": npc_id, "dir": d, "frame": fi})

    actor_shelf = Shelf(512)
    actor_place = []
    for key, im in actor_cells:
        actor_shelf.add(im)
    actor_sheet, actor_entries = actor_shelf.render()
    for (key, im), e, meta in zip(actor_cells, actor_entries, actor_meta):
        actor_sheet.paste(im, (e["x"], e["y"]), im)
        meta.update({"atlas": "actors", "x": e["x"], "y": e["y"], "w": im.width, "h": im.height,
                     "drawScale": DRAW_SCALE, "key": key})
        actor_place.append(meta)
    actor_sheet.save(ATLAS_DIR / "actors.png")

    # 组装 actors 结构。atlas / drawScale 提到角色级，帧只留 x,y,w,h。
    # 注意：角色的帧宽高不是常量（走路 16×26、挥剑 20×26），
    # 所以 w/h 必须留在帧上，不能像怪物那样提到组级。
    actors = manifest["actors"]
    for m in actor_place:
        if m["group"] == "hero":
            hero = actors.setdefault("hero", {})
            hero["atlas"], hero["drawScale"] = m["atlas"], m["drawScale"]
            hero.setdefault(m["anim"], {}).setdefault(m["dir"], []).append(
                {k: m[k] for k in ("x", "y", "w", "h")})
        elif m["group"] == "npc":
            npc = actors.setdefault("npcs", {}).setdefault(m["npc"], {})
            npc["atlas"], npc["drawScale"] = m["atlas"], m["drawScale"]
            npc.setdefault("walk", {}).setdefault(m["dir"], []).append(
                {k: m[k] for k in ("x", "y", "w", "h")})
    actors.setdefault("hero", {})["src"] = "ArMM1998 / Zelda-like tilesets and sprites — character.png"
    actors.setdefault("hero", {})["dirOrder"] = HERO_DIRS
    for npc_id in NPC_STYLE:
        if npc_id in actors.get("npcs", {}):
            actors["npcs"][npc_id]["src"] = f"ArMM1998 / Zelda-like — NPC_test.png @ {NPC_STYLE[npc_id]}"

    # ── 3. 怪物 ─────────────────────────────────────────────────
    mon_cells: list[tuple[str, Image.Image]] = []
    mon_meta: list[dict] = []
    for mid, (src_name, xf, scale, note) in MONSTERS.items():
        for anim in ("idle", "run"):
            names, actual = monster_frames(src_name, anim)
            if not names:
                missing.append(f"{mid}: 0x72 里没有 {src_name} 的任何动画帧")
                continue
            eff_note = note if actual == anim else f"{note}（{src_name} 缺完整 {anim} 帧，回退用 {actual}）"
            for fi, fname in enumerate(names):
                im = Image.open(O72 / f"{fname}.png").convert("RGBA")
                if xf:
                    im = xf(im)
                # 不变量：图集里的怪物帧一律 16×16，落屏尺寸只由 drawScale 决定。
                # 0x72 里 ogre / big_demon / big_zombie 是 32×32，混进来会让
                # 「大家伙 ×3」算成 96px（整整 3 格）—— 石巨人和魔王都踩过这个坑。
                # 它们的像素密度本来就是别家的两倍，按原尺寸画反而显小，归一化才是对的。
                if im.size != (BASE_TILE, BASE_TILE):
                    im = im.resize((BASE_TILE, BASE_TILE), Image.NEAREST)
                top, bot = _art_rows(im)
                art_bbox = (bot - top + 1, im.height - 1 - bot)
                mon_cells.append((f"{mid}.{anim}.{fi}", im))
                mon_meta.append({"monster": mid, "anim": anim, "frame": fi,
                                 "src": f"0x72/{src_name}", "note": eff_note, "drawScale": scale,
                                 "artH": art_bbox[0], "artPadBottom": art_bbox[1]})

    mon_shelf = Shelf(512)
    for key, im in mon_cells:
        mon_shelf.add(im)
    mon_sheet, mon_entries = mon_shelf.render()
    for (key, im), e, meta in zip(mon_cells, mon_entries, mon_meta):
        mon_sheet.paste(im, (e["x"], e["y"]), im)
        meta.update({"atlas": "monsters", "x": e["x"], "y": e["y"], "w": im.width, "h": im.height})
    mon_sheet.save(ATLAS_DIR / "monsters.png")

    # 布局断言：逐帧取最坏值（同一只怪的各帧内容高度可能差 1px）。
    # 注意 padIdle 只统计 idle 帧 —— run 帧的底留白是源动画自身的起伏，而棋盘不用 run 帧。
    _fit: dict[str, dict] = {}
    for m in mon_meta:
        prev = _fit.get(m["monster"], {"h": 0, "scale": m["drawScale"], "padIdle": 0})
        prev["h"] = max(prev["h"], m["artH"])
        prev["scale"] = m["drawScale"]
        if m["anim"] == "idle":
            prev["padIdle"] = max(prev["padIdle"], m["artPadBottom"])
        _fit[m["monster"]] = prev
    for p in verify_monster_fit(_fit):
        missing.append(p)

    for m in mon_meta:
        node = manifest["monsters"].setdefault(m["monster"], {
            "src": m["src"], "note": m["note"], "drawScale": m["drawScale"],
            # atlas / 帧尺寸提到组级，帧数组里只留 x,y ——
            # 36 只 × 8 帧会让「每帧重复一遍 atlas/w/h」撑出十几 KB 的冗余
            "atlas": m["atlas"],
            "frame": {"w": m["w"], "h": m["h"]},
            "idle": [], "run": [],
        })
        node[m["anim"]].append({"x": m["x"], "y": m["y"]})

    # 补齐未映射到的怪物（数据里有、映射表漏了）→ 明确标 null，让渲染层走兜底
    monsters_json = json.loads((ROOT / "data" / "monsters.json").read_text(encoding="utf-8"))["monsters"]
    for mid in monsters_json:
        if mid not in manifest["monsters"]:
            manifest["monsters"][mid] = None
            missing.append(f"怪物 {mid} 未映射 → 渲染层将回退程序化图形")

    # 尺寸层级检查：凡按「大家伙」绘制的怪，落屏后必须真的一样大。
    # 这条断言来自一个真实的翻车：0x72 的 big_demon 是 32×32，若按 1:1 绘制
    # 屏幕上只有 32px，而 16×16 放大 3 倍的巨龙有 48px —— 结果魔王比小龙还小。
    big_sizes: dict[int, list[str]] = {}
    for mid, node in manifest["monsters"].items():
        if not node or node["drawScale"] != BIG_SCALE:
            continue
        eff = node["frame"]["w"] * node["drawScale"]
        big_sizes.setdefault(eff, []).append(mid)
    if len(big_sizes) > 1:
        detail = "；".join(f"{k}px → {', '.join(sorted(v))}" for k, v in sorted(big_sizes.items()))
        missing.append(f"「大家伙」落屏尺寸不一致，体型层级会倒挂：{detail}")

    # ── 4. 道具 ─────────────────────────────────────────────────
    item_shelf = Shelf(512)
    item_cells: list[tuple[str, Image.Image]] = []
    item_meta: list[dict] = []

    sheet_img = Image.open(O72_SHEET).convert("RGBA")
    SHIELD_STYLE = {
        "shield_iron":   ((58, 56, 66), (188, 190, 200)),
        "shield_silver": ((96, 98, 112), (244, 246, 252)),
        "shield_knight": ((28, 46, 96), (150, 186, 240)),
        "shield_holy":   ((92, 62, 12), (250, 214, 96)),
        "shield_sacred": ((92, 16, 32), (248, 158, 158)),
    }

    for iid, spec in ITEM_SRC.items():
        kind = spec[0]
        if kind == "o72":
            im, src = o72(spec[1]), spec[2]
        elif kind == "sheet":
            im, src = sheet_img.crop(spec[1]), spec[2]
        elif kind == "ken":
            im, src = ken(spec[1]), spec[3]
            tag = spec[2]
            if isinstance(tag, tuple):
                # 钥匙：只重染匙身横带 (lo, hi, dark, light)
                lo, hi, kdark, klight = tag
                im = recolor_hue(im, lo, hi, kdark, klight)
            elif tag == "gold":
                im = ramp(im, (92, 62, 12), (250, 214, 96))
            elif isinstance(tag, str) and tag.startswith("shield_"):
                im = ramp(im, *SHIELD_STYLE[tag])
        elif kind == "gen":
            im, src = gen_icon(spec[1]), spec[2]
        else:
            raise KeyError(kind)
        im = im.convert("RGBA")
        item_cells.append((iid, im))
        item_meta.append({"item": iid, "src": src})

    for key, im in item_cells:
        item_shelf.add(im)
    item_sheet, item_entries = item_shelf.render()
    for (key, im), e, meta in zip(item_cells, item_entries, item_meta):
        item_sheet.paste(im, (e["x"], e["y"]), im)
        meta.update({"atlas": "items", "x": e["x"], "y": e["y"], "w": im.width, "h": im.height})
    item_sheet.save(ATLAS_DIR / "items.png")

    # 三色钥匙是「颜色即玩法」，而黄钥匙是构建期造出来的（原素材没有），
    # 最容易在换素材时悄悄跑偏 —— 断言而不是靠眼看
    for p in verify_items(dict(item_cells), ken(126)):
        missing.append("道具断言失败：" + p)

    for m in item_meta:
        manifest["items"][m["item"]] = {
            "atlas": "items", "x": m["x"], "y": m["y"], "w": m["w"], "h": m["h"],
            "drawScale": DRAW_SCALE, "src": m["src"],
        }

    items_json = json.loads((ROOT / "data" / "items.json").read_text(encoding="utf-8"))["items"]
    for iid in items_json:
        if iid not in manifest["items"]:
            manifest["items"][iid] = None
            missing.append(f"道具 {iid} 未映射 → 渲染层将回退程序化图形")

    manifest["meta"]["atlases"] = {
        "terrain":  {"file": "terrain.png",  "w": terr_sheet.width,  "h": terr_sheet.height},
        "actors":   {"file": "actors.png",   "w": actor_sheet.width, "h": actor_sheet.height},
        "monsters": {"file": "monsters.png", "w": mon_sheet.width,  "h": mon_sheet.height},
        "items":    {"file": "items.png",    "w": item_sheet.width, "h": item_sheet.height},
    }

    (ROOT / "assets" / "MANIFEST.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # ── 5. 目视核对图 ───────────────────────────────────────────
    for nm, sheet in (("terrain", terr_sheet), ("actors", actor_sheet),
                      ("monsters", mon_sheet), ("items", item_sheet)):
        bg = Image.new("RGBA", sheet.size, (250, 250, 252, 255))
        bg.alpha_composite(sheet)
        s = max(1, min(4, 1400 // max(sheet.width, 1)))
        bg.resize((bg.width * s, bg.height * s), Image.NEAREST).convert("RGB").save(
            PREVIEW_DIR / f"atlas-{nm}.png")

    # ── 6. 汇报 ─────────────────────────────────────────────────
    print("=== 图集 ===")
    for nm, meta in manifest["meta"]["atlases"].items():
        p = ATLAS_DIR / meta["file"]
        print(f"  {nm:<9} {meta['w']:>4}×{meta['h']:<4}  {p.stat().st_size/1024:>7.1f} KB")
    print(f"\n=== 覆盖 ===")
    print(f"  地形   {len(manifest['terrain'])} 项（含墙顶边变体）")
    print(f"  怪物   {sum(1 for v in manifest['monsters'].values() if v)}/{len(manifest['monsters'])} 只有素材")
    print(f"  道具   {sum(1 for v in manifest['items'].values() if v)}/{len(manifest['items'])} 项有素材")
    print(f"  勇者   {len(HERO_DIRS)} 向 × 4 帧走路 + {len(HERO_DIRS)} 向 × 4 帧挥剑")
    print(f"  NPC    {len(NPC_STYLE)} 人 × {len(HERO_DIRS)} 向 × 4 帧")
    total = sum((ATLAS_DIR / m["file"]).stat().st_size for m in manifest["meta"]["atlases"].values())
    print(f"\n  图集总大小 {total/1024:.1f} KB")
    if missing:
        print(f"\n=== 需注意（{len(missing)} 条）===")
        for m in missing[:20]:
            print("  -", m)
    return 0


if __name__ == "__main__":
    sys.exit(main())
