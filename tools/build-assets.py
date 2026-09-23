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
2. 保持 16px **绘制**网格。手绘与程序化坐标都写在这套网格上；出图时统一
   Scale2x 升到 32px 网格（超采样 SS=2），运行时 1:1 画进 32px 的格子 ——
   落屏的设计像素数不变，但一个素材像素占的设备像素从 ~5.4 降到 ~2.7。
   整数倍最近邻放大，像素画不会被插值糊掉。
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
    from PIL import Image, ImageDraw, ImageFilter
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

BASE_TILE = 16          # 精灵的**绘制网格**边长（所有手绘 / 程序化坐标都在这套网格上）
CELL = 32               # 游戏棋盘的格子边长（设计像素，不随素材网格变化）

# ── 超采样：让「落屏像素点」更密 ─────────────────────────────────
# 素材画在 16 网格上、运行时放大到 32px 的格子；在 dpr=3 的手机上，
# 一个素材像素要占好几个设备像素 —— 画面的颗粒感来源就是这个，不是渲染器。
# 所以「更精细」要做的是**在高网格上出图**：帧尺寸 ×SS、drawScale ÷ SS，
# 落屏的设计像素数一点不变（verify-visual 的 A17 断言这件事）。
#
# 放大算法是 Scale2x 而不是双线性：它按 4 邻域决定 2×2 块里的对角填充，
# 消掉阶梯锯齿的同时**保留硬边**，像素画不会变糊。
#
# ⚠️ SS=4 是 Scale2x 连做两遍。第二遍会把第一遍的 1px 直角磨圆 —— 对第三方
# 位图（信息上限 16×16）这是可接受的代价（轮廓更平滑），但**程序化手绘的地形
# （地板、墙、楼梯）不这么走**：它们直接画在 RASTER_TILE 网格上（见「四、素材源」），
# 超采样对它们是空操作。手绘在高网格上 = 真·细节翻倍；超采样 = 只把已有信息摊细。
SS = 4
SS_PASSES = SS.bit_length() - 1     # 4 → 2 次 Scale2x
RASTER_TILE = BASE_TILE * SS        # 64：图集里瓦片的边长
DRAW_SCALE = CELL / RASTER_TILE     # 0.5：帧是落屏网格的 2 倍密，绘制时缩小一半
BIG_SCALE = 3                       # 「大家伙」落屏仍是 16 网格 ×3 = 48px（表里的
                                    # 倍数是对**绘制网格**而言的）；出图时同样超采样
                                    # 到 64 网格、倍数 ÷SS = 0.75，否则它是全屏最粗的东西。

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


def scale2x(im: Image.Image) -> Image.Image:
    """
    像素画专用放大 ×2（AdvMAME Scale2x）。

    每个源像素展开成 2×2，块内四个格子的取值由 4 邻域决定：

        A B C
        D E F        E0 = D 当 D==B      否则 E
        G H I        E1 = F 当 B==F      否则 E
                     E2 = D 当 D==H      否则 E
                     E3 = F 当 H==F      否则 E

    于是斜向的阶梯会被「抹平」成真正的斜边，而直边（B==H 或 D==F）保持不动 ——
    这正是像素画要的：**去锯齿但不插值**。双线性会把整张图糊成一团，
    NEAREST 则什么都不做，只有 Scale2x 两者都不占。
    """
    im = im.convert("RGBA")
    w, h = im.size
    src = im.load()
    out = Image.new("RGBA", (w * 2, h * 2))
    dst = out.load()

    def at(x: int, y: int):
        # 越界一律当作「和中心同色」：不这样写，边缘像素会凭空长出一条边框
        return src[x, y] if 0 <= x < w and 0 <= y < h else None

    for y in range(h):
        for x in range(w):
            E = src[x, y]
            B, D, F, H = at(x, y - 1), at(x - 1, y), at(x + 1, y), at(x, y + 1)
            B = E if B is None else B
            D = E if D is None else D
            F = E if F is None else F
            H = E if H is None else H
            x0, y0 = x * 2, y * 2
            if B != H and D != F:
                dst[x0, y0] = D if D == B else E
                dst[x0 + 1, y0] = F if B == F else E
                dst[x0, y0 + 1] = D if D == H else E
                dst[x0 + 1, y0 + 1] = F if H == F else E
            else:
                dst[x0, y0] = dst[x0 + 1, y0] = dst[x0, y0 + 1] = dst[x0 + 1, y0 + 1] = E
    return out


def supersample(im: Image.Image) -> Image.Image:
    """
    把帧放大 **SS 倍**（源网格 ×SS）。用于角色 / 怪物 / 道具。

    它们的落屏尺寸各不相同（勇者 32×52、剑 20×42、金币 16×16），所以必须按
    「各自的源 ×SS」走 —— 统一放大到 RASTER_TILE 会把小道具整整放大一倍
    （金币 8×8 会被拉到 64，落屏从 16px 变 32px）。
    已经是出图网格的手绘帧原样返回。
    """
    if im.width >= RASTER_TILE and im.height >= RASTER_TILE:
        return im
    out = im
    for _ in range(SS_PASSES):
        out = scale2x(out)
    return out


def terrain_raster(im: Image.Image) -> Image.Image:
    """
    地形专用：放大到**出图网格**（RASTER_TILE）为止，而不是「源 ×SS」。

    差别就在门：它的源本来就是 32×32（不是 16 网格那一套），按 ×SS 会到
    128×128，落屏 64px —— 一扇门顶两格宽。而地形一律占一格、落屏 = cell，
    所以目标应当是「边长 = RASTER_TILE」。
    """
    out = im
    while out.width < RASTER_TILE or out.height < RASTER_TILE:
        out = scale2x(out)
    return out


def _mon_out(im: Image.Image, scale: int) -> Image.Image:
    """
    怪物的出图帧：统一放大到出图网格 RASTER_TILE（64）。

    手绘怪物现在直接画在 32 网格上（MON_W），所以这里只 Scale2x 一遍到 64；
    取自 0x72 的 16 网格怪物则放两遍到 64 —— 与旧版超采样到 64 等价。
    落屏尺寸仍只由 drawScale 决定（见 _out_scale），不变。
    """
    out = im
    while out.width < RASTER_TILE or out.height < RASTER_TILE:
        out = scale2x(out)
    return out


def _out_scale(scale: int) -> float:
    """
    MONSTERS 表里写的倍数是对**绘制网格**（16）而言的；出图网格翻了 SS 倍，
    倍数要同步除掉，落屏的设计像素数才不变（16×2 = 32 = 64×0.5）。
    「大家伙」3 ÷ 4 = 0.75，落屏仍是 48px。
    """
    return scale / SS


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
# 四之三、上/下楼梯 —— 两张都手绘，谁也不翻转谁
# ─────────────────────────────────────────────────────────────────────
# 0x72 只有一张 floor_ladder，所以上一版是「下楼梯原样用 + 上楼梯垂直翻转」。
# 但 floor_ladder 本身近乎上下对称，翻转之后**肉眼根本分不出来** —— 玩家站在
# 塔里分不清哪一格是往上走（用户报的第 ④ 条就是这个）。
#
# 关键决定：这一版让两张图的**结构**不同，而不是「同一张图的明暗翻转」。
#   下楼梯 = 俯视竖井：同心方环一层层往里变暗，每环上沿留一条亮线当台阶棱，
#            越往里越深 —— 视觉上是"视线掉下去"。
#   上楼梯 = 侧视阶梯：四级台阶自左下升到右上，踏面／立面成对出现、逐级变亮，
#            右上角是一片出口亮光 —— 视觉上是"视线升上去"。
#
# 为什么必须是"结构不同"而不是"明暗相反"：明暗相反在缩小到 32px 之后等价于
# 翻转，玩家学到的只是"亮的是上"这种脆弱的相对线索，换个背景就不成立；
# 而"井"和"阶梯"是两个不同的形体，任何时候都认得出。
# verify_terrain 第 ③ 条据此断言：既不逐像素相同、也不互为上下翻转，
# 且各自的亮度剖面要落在"井 = 上下左右都近对称" / "阶梯 = 自下而上单调变亮"
# 这两条结构特征上 —— 只改了明暗而没改结构的话，第一条就会挂。
#
# 说明：下面的 `_put` 定义在本文件更靠后的位置（NPC 造型那一节）。Python 的
# 函数体在**调用时**才查全局名，而 TERRAIN 里是 lambda、真正调用发生在构建
# 阶段（见 build()），所以这里的先后顺序不影响运行。

# ── 地板：手绘在**出图网格**上 ───────────────────────────────────
# 旧的地板是第三方 16×16 位图重染色再超采样。第三方位图只有 256 个像素的
# 信息，超采样只是把既有信息摊细 —— **不会多出任何细节**，只把轮廓磨圆。
# 地板是占屏面积最大的地形，所以它是最值得真手绘的一张。
FLOOR_BASE = (198, 168, 126)    # 石板面
FLOOR_HI = (216, 190, 147)      # 上 / 左受光倒角
FLOOR_SHADE = (166, 138, 100)   # 下 / 右背光倒角
FLOOR_JOINT = (132, 102, 66)    # 石板缝
FLOOR_BEAD = (146, 108, 66)     # 碎石
FLOOR_SEED = 20260922

# 上楼梯：梯段的踏面／立面，逐级变亮；最后一块是梯顶的出口亮光
STAIR_TREAD = [(178, 154, 118), (198, 174, 136), (218, 194, 158), (238, 214, 176)]
STAIR_RISER = [(122, 102, 72), (136, 114, 82), (152, 128, 92), (168, 144, 104)]
STAIR_SHAFT = (52, 42, 30)      # 梯段背后的井道暗部
STAIR_EXIT = (252, 242, 214)    # 梯顶的出口亮光
STAIR_EXIT_RIM = (232, 212, 168)
STAIR_BASE = (44, 35, 24)       # 最下面那级的落地线
# 下楼梯：越往下越暗，最后一档近乎全黑 —— 那是「看不见底的深处」，
# 也是玩家一眼区分上下的主要依据（上＝往亮处走，下＝往暗处沉）
STAIR_WELL = [(122, 102, 72), (92, 76, 54), (62, 51, 36), (34, 28, 20)]


# ── 墙：手绘在**出图网格**上 ───────────────────────────────────────
# 和地板同一个道理：0x72 的 wall_mid 只有 16×16、三个颜色，超采样只是把这三个
# 色摊细 —— 「每个 16 网格单元内的独立颜色数」实测 1.15 → 1.18，几乎没有多出
# 细节。墙是第二种满屏平铺的地形（地板之外就数它占屏最多），所以同样改成手绘。
#
# 砌法用**错缝**（running bond）：相邻两层的竖缝错开半块砖。这既是真的砌法，
# 也正好用来打散「同一张图在重复」—— 每隔一层，缝的位置就换一次。
WALL_BASE = (78, 63, 60)        # 砖身（仍在 0x72 的墙色族里，与其它地形的明暗关系不变）
WALL_HI = (118, 96, 86)         # 上 / 左受光倒角
WALL_SHADE = (56, 46, 45)       # 下 / 右背光倒角
# 灰缝。比 0x72 的 (34,34,34) 略偏暖 —— 那个值正好等于史莱姆身体的深色，
# 怪物会「粘」在墙上（这条是当年给地板重染色时才量出来的）。
WALL_JOINT = (38, 32, 31)
WALL_STAIN = (92, 70, 54)       # 锈斑 / 苔痕：比砖身暖一点，不是单纯的暗
WALL_SEED = 20260923

WALL_COURSE = 4 * SS            # 一层砌层 16 行 = 砖身 14 + 横缝 2
WALL_BOND = 8 * SS              # 竖缝间距 32（半块砖 16）→ 砖身恒为 30 宽
WALL_JW = max(2, SS) // 2 + SS // 2   # 缝宽 2px
# 残缺的**数量**（不是位置）写死 —— 变体只换位置，配色多重集才守恒。
# 破损（缺角 / 裂纹）一律用缝色：崩掉一块露出来的本来就是灰缝，不新增颜色。
WALL_CHIPS = 6                  # 缺角：2×2
WALL_CRACKS = 3                 # 裂纹：斜向 5px
WALL_CRACK_LEN = 5
WALL_STAINS = 3                 # 锈斑：3×2
WALL_BEADS = 24                 # 麻点：单像素（用受光色，是亮点不是脏点）

# 墙顶压顶：顶面 2 行 / 立面 11 行 / 下沿 1 行 / 投影 4 行。
# 前三项之和 = 14 = 砖身上沿（含第一道横缝的上半），投影那 4 行正好吃掉第一层
# 与第二层之间的整道横缝 —— 否则压顶底下会留下 2px 孤零零的缝，看着像画歪了。
WALL_CAP_ROWS = (2, 11, 1, 4)
WALL_CAP_HI = (206, 186, 164)   # 顶面（受光）
WALL_CAP_FACE = (166, 138, 120) # 立面
WALL_CAP_EDGE = (126, 104, 88)  # 下沿
WALL_CAP_SHADOW = (44, 36, 33)  # 投影（压顶压在墙身上的那道影）


def _floor(seed: int = FLOOR_SEED) -> Image.Image:
    """
    地板：错缝石板，直接画在 RASTER_TILE 网格上。

    结构：上下两行石板，第一行从中间断一次、第二行断两次 —— **错缝砌法**，
    平铺时才不会连成十字网格。缝宽 2px；每块石板贴着缝的那 1px 压倒角
    （上 / 左受光、下 / 右背光），内部再撒极稀疏的碎石。

    ⚠️ `seed` 只影响最后一步的杂质：缝与倒角必须用**固定的** FLOOR_SEED 生成。
    变体就是靠「同一个配方、换个杂质种子」派生的 —— 缝一旦跟着变，平铺就会
    连不上，而颜色多重集也不再守恒，配色断言（verify_terrain ⑤）会立刻红。

    石子用**离散几档色**而不是连续噪声，同样是为了多重集守恒：
    变体只挪位置、不引入新颜色。
    """
    n = RASTER_TILE
    im = Image.new("RGBA", (n, n), FLOOR_BASE + (255,))
    p = im.load()
    rng = random.Random(FLOOR_SEED)      # 缝 / 倒角：固定种子
    jw = max(2, SS) // 2 + SS // 2        # 缝宽：64 网格上 2px

    def vjoint(cx: int, y0: int, y1: int):
        for y in range(y0, y1):
            for dx in range(-jw // 2, jw - jw // 2):
                x = cx + dx
                if 0 <= x < n:
                    p[(x, y)] = FLOOR_JOINT + (255,)

    for ri in range(2):
        y0, y1 = ri * (n // 2), (ri + 1) * (n // 2)
        for cx in ([n // 2] if ri == 0 else [n // 4, 3 * n // 4]):
            vjoint(cx, y0, y1)
    # 横缝：只在两行之间（上下边缘不画，否则平铺时会连成加粗的十字）
    for y in range(n // 2 - jw // 2, n // 2 + jw - jw // 2):
        if 0 <= y < n:
            for x in range(n):
                p[(x, y)] = FLOOR_JOINT + (255,)

    # 倒角：贴着缝的那一圈。上/左提亮、下/右压暗 —— 石板因此读得出厚度。
    base = FLOOR_BASE + (255,)
    joint = FLOOR_JOINT + (255,)
    for y in range(n):
        for x in range(n):
            if p[(x, y)] != base:
                continue
            up = p[(x, y - 1)] == joint if y > 0 else False
            lf = p[(x - 1, y)] == joint if x > 0 else False
            dn = p[(x, y + 1)] == joint if y < n - 1 else False
            rt = p[(x + 1, y)] == joint if x < n - 1 else False
            if up or lf:
                p[(x, y)] = FLOOR_HI + (255,)
            elif dn or rt:
                p[(x, y)] = FLOOR_SHADE + (255,)

    # 杂质：碎石（暗）与磨痕（亮）。密度刻意很低 —— 撒多了就是麻点，
    # 比重复更难看；而且变体是「整批挪位置」，数量越多越容易顶穿 drift 上限。
    rng = random.Random(seed)             # ← 只有这一步随变体变化
    inner = [(x, y) for y in range(1, n - 1) for x in range(1, n - 1) if p[(x, y)] == base]
    for _ in range(int(n * n * 0.008)):
        if not inner:
            break
        x, y = inner[rng.randrange(len(inner))]
        p[(x, y)] = FLOOR_BEAD + (255,)
    for _ in range(int(n * n * 0.004)):
        if not inner:
            break
        x, y = inner[rng.randrange(len(inner))]
        p[(x, y)] = FLOOR_HI + (255,)
    return im


def _wall(seed: int = WALL_SEED) -> Image.Image:
    """
    墙：错缝砌法（running bond），直接画在 RASTER_TILE 网格上。

    为什么手绘：见上面「墙」那一节的注释 —— 第三方位图超采样不产生新细节。

    结构：一层砌层 16 行（砖身 14 + 横缝 2）；竖缝间距 32，相邻层错开半块（16）。
    于是砖身恒为 30×14 —— 平铺时跨格也接得上：横缝在格子上下沿各出 1px、
    竖缝在左右沿各出 1px，拼起来仍是 2px，不会在格子接缝处细一条。
    ⚠️ 缝宽与缝距都必须**整除** RASTER_TILE，否则接缝会在每格边界露出来
    （整片墙每隔 32px 多一条细线，缩略图上根本看不出，真机上一眼可见）。

    ⚠️ `seed` 只影响最后一步的残缺：缝与倒角必须用**固定**的 WALL_SEED。
    变体就是「同一配方、换一批残缺位置」派生出来的 —— 缝一变，平铺就连不上。
    残缺全是**离散色 + 固定数量**，所以变体的配色多重集与底图完全相同。
    """
    n = RASTER_TILE
    im = Image.new("RGBA", (n, n), WALL_BASE + (255,))
    p = im.load()
    base = WALL_BASE + (255,)
    joint = WALL_JOINT + (255,)
    jw = WALL_JW

    def vjoint(cx: int, y0: int, y1: int):
        """一道竖缝，占 [cx-1, cx]（与地板同一套约定：缝偏在 cx 的左上侧）。"""
        for y in range(y0, y1):
            for dx in range(-jw // 2, jw - jw // 2):
                x = cx + dx
                if 0 <= x < n:
                    p[(x, y)] = joint

    # 横缝：每层的上沿，宽 jw（与竖缝同宽）。第 0 层的 y=0 与最后一层的 y=n-1
    # 各只画到半道 —— 另一半由相邻那张瓦片补上，拼起来正好是完整的一道缝。
    # ⚠️ 缝宽必须与竖缝一致：只差一点的话，横竖缝会在满屏铺开时粗细不一。
    for ci in range(n // WALL_COURSE + 1):
        cy = ci * WALL_COURSE
        for dy in range(-jw // 2, jw - jw // 2):
            y = cy + dy
            if 0 <= y < n:
                for x in range(n):
                    p[(x, y)] = joint

    # 竖缝：错缝 —— 相邻层错开半块砖
    for ci in range(n // WALL_COURSE):
        y0, y1 = ci * WALL_COURSE, (ci + 1) * WALL_COURSE
        phase = (ci % 2) * (WALL_BOND // 2)
        for k in range(n // WALL_BOND + 1):
            vjoint(phase + k * WALL_BOND, y0, y1)

    # 倒角：贴着缝的那一圈。上/左提亮、下/右压暗 —— 砖因此读得出厚度
    for y in range(n):
        for x in range(n):
            if p[(x, y)] != base:
                continue
            up = y > 0 and p[(x, y - 1)] == joint
            lf = x > 0 and p[(x - 1, y)] == joint
            dn = y < n - 1 and p[(x, y + 1)] == joint
            rt = x < n - 1 and p[(x + 1, y)] == joint
            if up or lf:
                p[(x, y)] = WALL_HI + (255,)
            elif dn or rt:
                p[(x, y)] = WALL_SHADE + (255,)

    # 残缺：缺角 / 裂纹 / 锈斑 / 麻点。数量写死，只换位置。
    rng = random.Random(seed)
    free = {(x, y) for y in range(n) for x in range(n) if p[(x, y)] == base}
    order = sorted(free)
    rng.shuffle(order)

    def stamp(cells_of, color: tuple, what: str) -> None:
        """从打乱后的候选点里找一个整块都空着的位置落笔。"""
        while order:
            x, y = order.pop()
            if (x, y) not in free:
                continue
            cells = cells_of(x, y)
            if cells is None or any(c not in free for c in cells):
                continue
            for c in cells:
                free.discard(c)
                p[c] = color
            return
        raise RuntimeError(f"墙的{what}放不下 —— 砖身像素不够，或网格参数冲突")

    def rect(w: int, h: int):
        return lambda x, y: [(x + dx, y + dy) for dy in range(h) for dx in range(w)]

    def crack(x: int, y: int):
        return [(x + i, y + i) for i in range(WALL_CRACK_LEN)]

    for _ in range(WALL_CHIPS):
        stamp(rect(2, 2), joint, "缺角")
    for _ in range(WALL_CRACKS):
        stamp(crack, joint, "裂纹")
    for _ in range(WALL_STAINS):
        stamp(rect(3, 2), WALL_STAIN + (255,), "锈斑")
    for _ in range(WALL_BEADS):
        stamp(rect(1, 1), WALL_HI + (255,), "麻点")
    return im


def _wall_cap(body: Image.Image) -> Image.Image:
    """
    墙顶：在本格上沿压一道**石质压顶**（手绘，不再是 0x72 的 wall_top_mid）。

    为什么不再超采样第三方压顶：wall_top_mid 在 16 网格上只有最下面 4 行有内容，
    放大到 64 网格后是一条糊掉的色带 —— 压在一张**手绘**的墙身上会明显比墙身
    粗，正是这一轮要消灭的那种不一致。所以在出图网格上直接画：
    顶面受光 → 立面 → 下沿 → 投影，让压顶「浮」在墙身上。

    ⚠️ 投影那几行必须吃掉第一层砌层的横缝，否则压顶底下会留下 1px 孤零零的缝。
    """
    n = body.width
    out = body.copy()
    p = out.load()
    joint = WALL_JOINT + (255,)
    hi_r, face_r, edge_r, shadow_r = WALL_CAP_ROWS
    face_end = hi_r + face_r
    edge_end = face_end + edge_r
    shadow_end = edge_end + shadow_r
    for y in range(shadow_end):
        if y < hi_r:
            c = WALL_CAP_HI
        elif y < face_end:
            c = WALL_CAP_FACE
        elif y < edge_end:
            c = WALL_CAP_EDGE
        else:
            c = WALL_CAP_SHADOW
        for x in range(n):
            p[(x, y)] = c + (255,)
    # 压顶的竖缝：与偶数层同相位（0 / 32）—— 横向平铺时块宽与墙身一致（都是 30）。
    # 投影那几行是阴影不是石头，所以不断开。
    for y in range(edge_end):
        for k in range(n // WALL_BOND + 1):
            for dx in range(-WALL_JW // 2, WALL_JW - WALL_JW // 2):
                x = k * WALL_BOND + dx
                if 0 <= x < n:
                    p[(x, y)] = joint
    return out


def _stairs_down() -> Image.Image:
    """
    下楼梯：**侧视下沉阶梯**（与上楼梯同一族画法，方向相反）。

    上一版是「俯视竖井」—— 8 个同心方环向内变暗。用户反馈那圈方形读不出
    楼梯，反而像个坑／漏斗，而且和侧视的上楼梯**不像一套**。所以这里改成
    同一个画法的反向版本：四级台阶，踏面自左上向右下一级级沉下去，越深越暗，
    最后一档近乎全黑（看不见底的深处）。

    与上楼梯的区分点因此是**两个方向同时相反**：
      上 —— 从左下升到右上，越往上越亮，顶端有出口亮光；
      下 —— 从左上沉到右下，越往下越暗，底端是深渊。
    只改其中一个（比如把一张图调暗）不够，两个一起才是「读得出方向」。
    """
    n = RASTER_TILE
    steps = 4
    sw = n // steps                 # 16
    tread = SS                      # 踏面厚度：16 网格 1px × SS
    im = Image.new("RGBA", (n, n), STAIR_SHAFT + (255,))
    for i in range(steps):
        x = i * sw
        ty = 2 * SS + i * 3 * SS    # 8 / 20 / 32 / 44：逐级下沉
        # 越往下越暗 —— 踏面用 TREAD 的倒序，井壁用 WELL 的正序
        _put(im, x, ty, sw, tread, STAIR_TREAD[steps - 1 - i] + (255,))
        _put(im, x, ty + tread, sw, n - (ty + tread), STAIR_WELL[i] + (255,))
    # 井底：最深处再压一层近黑，让「深不见底」有一个落点
    _put(im, n - sw, n - 2 * SS, sw, 2 * SS, STAIR_WELL[-1] + (255,))
    return im


def _stairs_up() -> Image.Image:
    """
    上楼梯：侧视阶梯。

    四级台阶，每级是一根**实心立柱**（1px 踏面 + 直到地面的立面），
    高度自左向右递增 —— 合起来就是一条上升的梯段剖面。背后的井道填暗色，
    梯顶右上角留一小块出口亮光。因为高度是单调递增的，"往上是哪边"这件事
    在轮廓上就能读出来，不依赖颜色。

    坐标全部写在 RASTER_TILE 网格上（16 网格的 ×SS）：手绘素材不走超采样，
    高网格上直接画 = 真多出来的细节；超采样只会把既有信息摊细。
    """
    n = RASTER_TILE
    steps = 4
    sw = n // steps
    tread = SS
    im = Image.new("RGBA", (n, n), STAIR_SHAFT + (255,))
    _put(im, 0, n - SS, n, SS, STAIR_BASE + (255,))   # 落地线，把梯段"放"在地上
    for i in range(steps):
        x = i * sw
        ty = n - 3 * SS - i * 3 * SS            # 52 / 40 / 28 / 16：逐级升高
        # 踏面整条即高光，不再单独给左端压一格更亮的像素 —— 那样会在横剖面上
        # 造成 1px 的局部回退，把「自左向右单调变亮」这条结构特征弄脏。
        _put(im, x, ty, sw, tread, STAIR_TREAD[i] + (255,))
        _put(im, x, ty + tread, sw, n - (ty + tread) - SS, STAIR_RISER[i] + (255,))
    # 梯顶：最高一级踏面（y=16）正上方就是出口。先铺一层"边框色"再压亮光，
    # 让出口是"一段亮着的梯口"而不是"一块贴在墙上的白斑"。
    _put(im, 3 * sw, 0, sw, 4 * SS, STAIR_EXIT_RIM + (255,))
    _put(im, 3 * sw, 0, sw, 2 * SS, STAIR_EXIT + (255,))
    return im


# ─────────────────────────────────────────────────────────────────────
# 五、地形映射
# ─────────────────────────────────────────────────────────────────────
# 键 = data/tiles.json 里的地形编码（0..11）。
# 「假墙」必须和真墙长得一模一样 —— 这就是它的全部玩法意义，所以共用同一张图。

TERRAIN = {
    # 地面必须**又暖又亮**。这条约束的来历看数据：
    # 0x72 的 floor_1 与 wall_mid 用的是**完全相同的三个颜色**
    # (72,59,58) / (119,92,85) / (34,34,34)，只是排列不同（地面＝平坦底＋缝，
    # 墙＝砖纹）。也就是说源素材本身**没打算让两者靠颜色区分**。
    # 只给地面提亮 ×1.5 的结果是实测平均亮度 0.364 vs 墙 0.232，比值 1.57 ——
    # 亮度差不够、色相还完全一样，整屏糊成一坨褐色，迷宫读不出来。
    # 而且墙的砖缝 (34,34,34) 正好等于史莱姆身体的深色，怪物会「粘」在墙上。
    #
    # 曾经的解法是 ramp_norm 重染第三方位图（比值提到 2.77）。现在改成**手绘**：
    # 地板占屏面积最大，而第三方位图只有 16×16 的信息，超采样摊细它并不会
    # 多出细节（只会把轮廓磨圆）。要真的更精细，只能在高网格上重画 ——
    # 见 `_floor()`。配色仍压在暖砂石族里，明度比断言见 verify_terrain 第 ④ 条。
    0: ("floor", _floor, "手绘 · 错缝石板（直接画在出图网格上，非第三方位图重染）"),
    # 墙：**手绘**错缝砌法。改动理由与地板完全相同（第三方位图超采样不产生新细节），
    # 唯一差别是墙还多挂一条约束 —— 假墙必须和它逐像素一致，所以两者共用同一个
    # 函数而不是「同一张源图」。
    1: ("wall",       _wall,                                          "手绘 · 错缝砌法（直接画在出图网格上）"),
    2: ("prisonDoor", lambda: o72("doors_leaf_closed"),                "0x72/doors_leaf_closed（原色木门，区别于三色钥匙门）"),
    # 上/下楼梯：**同一族画法的两个方向**（侧视梯段），不是同一张图翻转。
    # 理由见上面「四之三」那一节：floor_ladder 近乎上下对称，翻转后肉眼分不出
    # 等于没有区分；而同族反向 + 明暗反向，玩家一眼就能读出「往哪边走」。
    3: ("stairsDown", _stairs_down, "手绘 · 侧视下沉阶梯（越往下越暗，底端近黑）"),
    4: ("stairsUp",   _stairs_up,   "手绘 · 侧视上升阶梯（越往上越亮，顶端出口光）"),

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
    11: ("fakeWall",  _wall,                                          "手绘 · 错缝砌法（与真墙同图，这是玩法本身）"),
}

# 墙的「顶边」变体：上方没有墙时用这张，地牢立刻有了立体感。
# 渲染层按邻域挑，挑不到就退回普通墙。
#
# ⚠️ 这里必须**预合成**，不能直接把 wall_top_mid 摆进去：
# wall_top_mid 只有最下面 4 行有内容（石头压顶），上面 12 行是全透明的 ——
# 它是给「贴到墙体上面那一格的下沿」这种用法画的。原样贴在本格会让整格
# 四分之三透明，露出底色（白色面板），看起来像墙缺了一块。
# 翻转过来让压顶落在本格的**上沿**，再和墙身合成为一张不透明图，本格就完整了。
# 压顶同样改成手绘（见 `_wall_cap`）：第三方 wall_top_mid 只有 4 行内容，
# 超采样后压在手绘墙身上会明显比墙身粗 —— 那是「只换了一半素材」的典型症状。
def _wall_top_baked(body: Image.Image | None = None) -> Image.Image:
    body = _wall() if body is None else body
    return _wall_cap(body)


TERRAIN_TOP = {
    1: ("wallTop", _wall_top_baked, "手绘 · 墙身 + 石质压顶预合成（压顶落在本格上沿）"),
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
# 两种地形同一套做法，理由也相同：
#   地面：缝与倒角是石板能连成一片的关键，**不动**；只换碎石 / 磨痕的位置。
#   墙  ：砌层与错缝是砌法，**不动**（缝一变，平铺就连不上）；只换残缺的位置。
#
# 曾经给墙用过另一套做法 —— 在超采样后的成品图上把竖缝**整段平移**。那条路
# 是「第三方位图没有配方、只能挪像素」逼出来的；墙改成手绘之后就有了配方，
# 于是和地面一样退回「同一配方、换个种子」，配色多重集**天然守恒**。
#
# 门 / 楼梯 / 岩浆 / 虚空都是一格一格出现的，没有被平铺锁定，做了只是白占体积。

VARIANT_SEED = 20260921  # 固定种子：变体必须可重跑，不能每次构建都换一批
FLOOR_VARIANTS = 6       # 含底图本身（键 `0`；其余是 `0:1` … `0:5`）
WALL_VARIANTS = 5        # 含底图本身（键 `1`；其余是 `1:1` … `1:4`）

SPECKLE = SS * SS        # 面积变 4 倍，杂质数量同步 ×4 才维持同样的疏密
# （砌层厚度 WALL_COURSE / 缝距 WALL_BOND 定义在「墙」那一节 —— 它们是**画法**
#   的参数，不是变体的参数，跟着手绘的墙走。）


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


def _floor_variants() -> list[Image.Image]:
    """
    地板变体：缝与倒角逐像素一致，只有碎石 / 磨痕换一批位置。

    底图是**手绘**的（不再是第三方位图），所以变体不必「从成品图上挪像素」——
    直接同一配方换个种子重画更干净：**颜色多重集天然守恒**，drift 断言因此量的
    是「杂质挪了多少」，而不是「两种画法差多少」。
    缝一旦跟着变，平铺就会连不上 —— 所以 `_floor()` 内部只有杂质那一步吃 seed。
    """
    return [_floor(FLOOR_SEED + vi * 977) for vi in range(FLOOR_VARIANTS)]


def _wall_variants() -> list[Image.Image]:
    """
    墙变体：砌层与错缝逐像素一致，只有残缺（缺角 / 裂纹 / 锈斑 / 麻点）换一批位置。

    和地面同一个做法：`_wall()` 内部只有残缺那一步吃 seed。缝一旦跟着变，
    平铺就会连不上（相邻两张瓦片的缝对不齐，整片墙会出现错位的长砖）。
    """
    return [_wall(WALL_SEED + vi * 977) for vi in range(WALL_VARIANTS)]


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


# 8 只玩法 BOSS 的 id。真值在 `data/monsters.json` 的 `boss` 字段，
# 构建期由 `verify_boss_art` 的判据 6 与数据表核对（少一只 = 这只 BOSS 会退回
# 32 网格的杂兵造型，而它头上还顶着渲染层画的金色圈）。
#
# 定义在这里而不是 BOSS 绘制段旁边：`OVERSIZE_BOSSES` 要引用它，
# 而模块级语句是自上而下求值的 —— 放到后面会在 import 时直接 NameError。
BOSS_IDS = (
    "skeletonCaptain", "kraken", "archmage", "dragon",
    "knightCaptain", "demonKing", "demonKingTrue", "vampire",
)

# 「画得比一格大」的怪物名单 —— 注意它**不等于**「玩法上的 BOSS」。
#
# 玩法 BOSS 的真值在 `data/monsters.json` 的 `boss` 字段（8 只，见 `BOSS_IDS`），
# 渲染层据此画金色圈。
#
# ## 2026-09-23：从 4 只扩到全部 8 只
#
# 改前只挑 4 只放大（dragon / kraken / demonKing / demonKingTrue），
# 另外 4 只（骷髅队长 / 骑士队长 / 吸血鬼 / 大法师）与杂兵同为 32px 落屏。
# 玩家这一轮的要求是「让 boss 模型更精致更大更逼真」——
# 「一半的 BOSS 和杂兵一样大」正是「不够大」的一半来源，而且是**前中期**那一半：
# 玩家在第 10 层遇到骷髅队长时，它看起来就是一只杂兵。
#
# 现在 8 只全部走 64 网格（`PROC_BOSSES`）、1:1 落屏 64px。
# 于是这里和 `BOSS_IDS` **恰好相等** —— 但两者刻意都留着：
# 一个管「素材画多大」，一个管「玩法上是不是 BOSS」，
# 相等是此时此刻的事实，不是可以合并的理由（A6 就是靠这两者的**差集**工作的）。
#
# 名字原来叫 BOSS_SCALE_EXEMPT，被 `tools/verify-visual.cjs` 的 A6 断言
# 逼着改掉了：那个名字会让人以为「BOSS 就这 4 只」，而实际是 8 只 ——
# 一个名字让两处真值看起来矛盾，是下一个 bug 的温床。
#
# 不变量（有断言，见 tools/verify-visual.cjs A6）：
# OVERSIZE_BOSSES ⊆ 玩法 BOSS。反方向**以前**不要求（允许有 BOSS 不放大），
# 现在有 `verify_boss_art` 的判据 6 反过来钉死「8 只一个不落」。
OVERSIZE_BOSSES = set(BOSS_IDS)


# ─────────────────────────────────────────────────────────────────────
# 六、怪物映射（36 只，其中 35 只手绘）
# ─────────────────────────────────────────────────────────────────────
# 格式： id -> (0x72 源名, 变换函数, 绘制倍数, 变换说明)
#
# **源名写 `"gen"` 表示这只不取 0x72，改由本仓库按名称手绘** ——
# 形状与配色见 `PROC_MONSTERS`。手绘的原因有两代：
#   第一代：0x72 包里**没有**蝙蝠/龙/乌贼/石头人/史莱姆，只能自己画；
#   第二代（本轮）：0x72 仅有的人形底图也**读不出职业与等级** ——
#     `knight_m/f` 源图是像素机器人（浅蓝方壳 + 独眼），守卫/骑士 8 只全顶着它；
#     同族等级只靠换色（ramp 铁→银→金），16px 下阶差几乎不可读。
#   于是人形怪也搬进 32 网格手绘（守卫/骑士/法师/兽人/骷髅/幽魂六形），
#   设计语言是「职业 = 装备剪影 × 等级 = 材质与覆盖度」，见 PROC_MONSTERS。
# 两边必须严格一一对应，有断言拦（见 verify_mon_art）。
# 现在唯一还取自 0x72 的是 ice_zombie（备用图，本作暂未用，名字与形象相符）。
#
# ⚠️ **第三列（绘制倍数）对 8 只 BOSS 已不再生效**：它们全部搬到 64 网格的
# 独立体系（见 PROC_BOSSES / boss_art_frames），落屏规则只有一条 —— 64 网格
# 1:1，即 drawScale 恒为 1.0（BOSS_DRAW_SCALE）。这一列对它们统一写 1，
# 是**故意留着误导不了的写法**：写 3 会让人以为改这里能放大 BOSS。
# 这条也有断言兜底（verify_monster_fit 会核对 BOSS 的 drawScale 必须是 1.0）。
#
# ⚠️ 对**非 BOSS**，倍数一律 2 —— 这条有断言（见 verify_monster_fit）。
# 教训：曾经有 5 只非 BOSS（bigBat / vampireBat / bigSlime / slimeKing / stoneGolem）
# 也取了 ×3，落屏 36–39px，**越出 32px 的格子 4–7px**。全塔 479 只怪物里有 145 只
# 属于这 5 种，于是「它到底占哪一格」在画面上变得不确定 ——
# 而魔塔是靠「走进哪一格」来打怪的，格子边界不是审美问题。
# BOSS 超出格子是刻意的（大块头本身是层级信号），而且实测 BOSS 都落在 y≥3，
# 越出的是自己头顶那一格，不会捅出棋盘外框。

MONSTERS = {
    # ── 骷髅三阶：骨 → 铁甲 → 金甲（等级 = 护甲覆盖度，剪影骨架不变）──
    "skeleton":        ("gen",           None,                              2, "手绘·骷髅：裸骨 + 锈剑"),
    "skeletonSoldier": ("gen",           None,                              2, "手绘·骷髅兵：铁盔铁甲 + 铁剑"),
    "skeletonCaptain": ("gen",           None,                              1, "手绘·骷髅队长（64 网格 BOSS）：金盔金甲 + 圆盾 + 骨剑"),

    # ── 亡灵族 ──────────────────────────────────────────────────
    "ghostWarrior":    ("gen",           None,                              2, "手绘·幽魂武士：兜帽飘尾 + 幽光剑，青白"),
    "phantom":         ("gen",           None,                              2, "手绘·幻影：同幽魂换紫 + 半透明"),
    "vampire":         ("gen",           None,                              1, "手绘·吸血鬼伯爵（64 网格 BOSS）：高领斗篷 + 尖牙 + 红眼"),
    "ice_zombie":      ("ice_zombie",    None,                              2, "原样（备用图，本作暂未用）"),

    # ── 蝙蝠族：手绘（0x72 没有蝙蝠，旧版用 imp 小恶魔顶替）──────
    # ⚠️ 只有 OVERSIZE_BOSSES 里的那 4 只允许乘 3。其余一律乘 2 —— 见该常量的说明。
    "bat":             ("gen",           None,                              2, "手绘：德拉基式圆球身 + 呆毛，棕"),
    "bigBat":          ("gen",           None,                              2, "手绘：长翅，深褐"),
    "vampireBat":      ("gen",           None,                              2, "手绘：长翅 + 獠牙，血红"),

    # ── 史莱姆族：手绘（0x72 没有史莱姆，旧版用 swampy 绿衣人顶替）─
    "greenSlime":      ("gen",           None,                              2, "手绘：绿圆顶果冻"),
    "redSlime":        ("gen",           None,                              2, "手绘：红圆顶果冻"),
    "bigSlime":        ("gen",           None,                              2, "手绘：更高的圆顶（用体量而不是换色表达「大」）"),
    "slimeKing":       ("gen",           None,                              2, "手绘：金 + 三尖冠"),

    # ── 法师族：学徒 → 资深 → 大法师（袍色蓝→紫→金 + 帽高 + 宝珠）──
    "juniorMage":      ("gen",           None,                              2, "手绘·法师学徒：蓝袍短帽 + 木杖，白须"),
    "seniorMage":      ("gen",           None,                              2, "手绘·法师：紫袍高帽 + 紫宝珠，白须"),
    "juniorWizard":    ("gen",           None,                              2, "手绘·女法师学徒：蓝袍短帽 + 长发"),
    "seniorWizard":    ("gen",           None,                              2, "手绘·女法师：紫袍高帽 + 长发"),
    "archmage":        ("gen",           None,                              1, "手绘·大法师（64 网格 BOSS）：金袍高帽 + 金宝珠 + 长白须"),
    "magicGuard":      ("gen",           None,                              2, "手绘·魔卫：青袍兜帽（无檐）+ 绿宝珠杖"),

    # ── 兽人族：木棒 → 铁肩甲战斧 → 矮身短匕 ────────────────────
    "orc":             ("gen",           None,                              2, "手绘·兽人：绿皮獠牙 + 木棒"),
    "orcWarrior":      ("gen",           None,                              2, "手绘·兽人武士：深绿 + 铁肩甲 + 战斧"),
    "goblin":          ("gen",           None,                              2, "手绘·哥布林：矮身大耳 + 短匕"),

    # ── 守卫族：青铜 → 白银 → 黄金（甲色三阶 + 盔羽无→短→高）─────
    "juniorGuard":     ("gen",           None,                              2, "手绘·守卫：青铜甲 + 长枪圆盾（无盔羽）"),
    "midGuard":        ("gen",           None,                              2, "手绘·守卫：白银甲 + 短盔羽"),
    "seniorGuard":     ("gen",           None,                              2, "手绘·守卫：黄金甲 + 高盔羽 + 金饰金盾钉"),

    # ── 剑士 / 骑士族：露脸轻装 → 铁甲 → 蓝钢红羽 → 白银金饰披风 → 暗黑 ─
    "swordsman":       ("gen",           None,                              2, "手绘·剑士：露脸红发带 + 细剑（轻装）"),
    "warrior":         ("gen",           None,                              2, "手绘·战士：铁全盔 + 鸢盾"),
    "knight":          ("gen",           None,                              2, "手绘·骑士：蓝钢甲 + 红盔羽 + 鸢盾"),
    "knightCaptain":   ("gen",           None,                              1, "手绘·骑士长（64 网格 BOSS）：白银甲金饰 + 红披风金羽"),
    "darkKnight":      ("gen",           None,                              2, "手绘·暗黑骑士：黑甲红目缝 + 黑披风"),
    "stoneGolem":      ("gen",           None,                              2, "手绘：方块躯干 + 砖缝 + 发光眼（旧为 ogre 食人魔）"),

    # ── BOSS：允许 ×3（48px）。层级信号靠尺寸，但**只有 BOSS 有这个特权** ──────
    "dragon":          ("gen",           None,                              1, "手绘·魔龙（64 网格 BOSS）：巨角 + 长吻 + 展翼 + 卷尾"),
    "kraken":          ("gen",           None,                              1, "手绘·巨型乌贼（64 网格 BOSS）：圆头 + 侧鳍 + 六条腕"),
    "demonKing":       ("gen",           None,                              1, "手绘·魔王（64 网格 BOSS）：巨角 + 膜翼 + 发光眼"),
    "demonKingTrue":   ("gen",           None,                              1, "手绘·魔王真身（64 网格 BOSS）：高举巨翼 + 三段长角 + 金冠"),
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

# 行带顺序：character.png 的四行是 下/右/上/左。
# ⚠️ 顺序错了不会报错，只会让左右走时朝向反 —— 实测踩过（左右互换，
#    因为想当然写成下左上右）。改这里必须对着图确认，不能凭直觉。
HERO_DIRS = ["down", "right", "up", "left"]
# NPC 素材的行带顺序与勇者不同：NPC_test.png 四行是 下/左/上/右
NPC_DIRS = ["down", "left", "up", "right"]


# ─────────────────────────────────────────────────────────────────────
# 九之一·B、勇者造型（程序化手绘：铠甲 / 剑 / 盾）
# ─────────────────────────────────────────────────────────────────────
#
# ## 为什么不再切 ArMM 的 character.png
#
# 它是全套素材里**最后一个**还在用的第三方位图角色（6 个 NPC 与 35 只怪都已手绘）。
# 问题不在精细度，而在**读不出装备**：
#   · 走路 4 帧之间只差「整张图上下 1 行」，看不出在迈步；
#   · 右手没有剑、左手没有盾、身上是一件红布衫 —— 玩家的原话是
#     「优化玩家角色的模型，增加剑、盾、铠甲」；
#   · 它自带软边描边，与手绘的 NPC / 怪物并排时不像一家人。
#
# ## 画法：与 NPC / 怪物同一套语言
#
# `_put()` 填硬边像素块 + `add_outline()` 收 1px 深色描边。装备与身体一起画，
# 但**分区**：剑在画面左（右手）、盾在画面右（左手）、铠甲占躯干与双肩。
# 三件装备各用一套专属色（钢 / 靛蓝 + 金 / 银蓝），漏画一件或挪了位置都会被断言抓住。
#
# ## 三条硬约束（断言在盯，改之前先读）
#
#   ① **实心内容恰好 4..23**（20 行）。`verify_npc_scale` 拿勇者朝下第 0 帧的
#      行区间当**基准**去卡六个 NPC —— 改这里等于改 NPC 的身高。
#      做法：绘制 5..22，描边上下各外扩 1 行 → 4..23。
#   ② **最宽 ≥ 12 列**（NPC 最宽处 12；勇者比它窄，NPC 站旁边就会显得更大）。
#      现在剑到 x=1、盾到 x=14，描边后 0..15 —— 16 列画布正好用满。
#   ③ **帧画布尺寸不许变**：走路 16×26、挥剑 20×26。
#      `verify-visual` 的 A17 钉着「落屏勇者 32×52」。
#
# ## 侧面只画一次
#
# `left` 由 `right` **镜像**得到（`transpose(FLIP_LEFT_RIGHT)`）。旧素材的四行带顺序
# 踩过坑（见 HERO_DIRS 上的注释：「想当然写成下左上右」），镜像能让
# 「左右走时朝向反了」这类错在原理上不可能发生。
#
# ## 走路「迈步」的做法（不是整体上下挪）
#
# 走路 4 帧**不动绘制区间**，只改腿部相位：抬起的腿少一行、靴子跟着抬一行。
#
# ⚠️ 这里踩过一次：最初照旧素材的做法「1/3 帧整体下移 1 行」，结果帧 1 的脚
#    描边落到了第 24 行 —— 正好是影子的那一行，半透明影子把脚描边盖成半透明，
#    于是 `solid_rows` 量出的实心底行从 24 掉回 23，**各帧高度变成 19 与 20 两种**，
#    `verify_npc_scale` 判据 1（勇者各帧高度必须一致）当场红。
#    影子必须紧贴脚下、又必须半透明，所以「整体挪」这条路在 26 行的画布里走不通 ——
#    靠腿部相位表达迈步反而更接近真实走路（脚一直踩在地上）。

HERO_W, HERO_H = 16, 26
# 挥剑帧**不比走路帧宽**（曾经是 20，注释写着「旧素材也是 20」）。
# 两个理由：
#   ① 抬剑只改 y（剑在 x=1..2 固定两列），横向范围根本没变 —— 20 是白送的 4 列透明边；
#   ② 落屏 = 帧宽 ×2，20 → 40px，比 32px 的格子还宽，挥剑时人会**横向溢出格子**
#      压到邻格上。走路帧 16 → 32px 正好一格。
# 渲染层 A14 靠 `frame` 的**尺寸**判「挥剑不变小」，两套帧同尺寸也是它成立的前提。
HERO_DRAW_TOP = 5                # 绘制顶行（描边后 = 可见顶行 4）
HERO_DRAW_FEET = 22              # 绘制底行（描边后 = 可见底行 23）
HERO_SHADOW_Y0, HERO_SHADOW_Y1 = 24, 25      # 影子占的两行

# 调色板（前缀 H_ = hero）。这套色只属于勇者，别处不要再引用。
H_SKIN = (247, 214, 178, 255)
H_SKIN_DK = (206, 166, 128, 255)
H_MOUTH = (186, 118, 106, 255)
H_HAIR = (110, 68, 34, 255)
H_HAIR_DK = (68, 40, 20, 255)
H_HI = (232, 238, 248, 255)      # 铠甲高光
H_ARMOR = (166, 178, 198, 255)   # 铠甲主色（银蓝）
H_ARMOR_DK = (100, 112, 134, 255)
H_LEATHER = (120, 78, 44, 255)
H_BOOT = (74, 54, 40, 255)
H_CLOAK = (176, 52, 58, 255)     # 战袍红 —— 旧勇者的红衣记号，留在胸口
H_STEEL = (222, 230, 244, 255)
H_STEEL_HI = (250, 253, 255, 255)
H_GOLD = (236, 192, 78, 255)
H_GRIP = (104, 66, 34, 255)
H_SHIELD = (56, 94, 168, 255)
H_SHIELD_HI = (96, 142, 214, 255)
# 盾徽。⚠️ **这个色不许用白**（原来是 246,248,252）—— 见 `verify_hero_art` 的判据 5：
# 那里靠「接近某色」在帧里找剑（`H_STEEL_HI` 是近白的高光），逐分量容差 6。
# 白徽记与它的差只有 (4,5,3)，**落在容差内** → 盾徽被误认成剑像素，
# 报出「剑的像素跑到了第 13 列（帧宽 16）」这种假红（2026-09-23 实际踩到）。
# 判据色的选择因此不是美术自由，是有约束的：彼此至少隔开 2×tol。
H_SHIELD_MARK = (168, 206, 248, 255)

# ── 横向解剖（16 列画布）────────────────────────────────────────────
#    剑（右手）  剑身 x=1..2（左列更亮 = 剑刃）、护手 x=1..3、柄 x=2、剑尖朝上
#    左臂        x=3..4
#    躯干        x=5..10（肩甲压在 x=4 与 x=11）
#    右臂        x=11..12
#    盾（左手）   x=12..14（盖住右臂外侧 1 列 = 「手臂在盾后」）
# 剑与左臂各自描边后会在 x=2 处相接 —— 像素画里武器贴着身体是常态，
# 中间那条深色描边正好把它们分开，读得出是「剑」而不是「身体的一部分」。
#
# ⚠️ 剑身**必须 2 列宽**。1 列宽时描边会在它两侧各糊一列深色，整把剑读出来是
#    「一根白线套着黑框」—— 第一版就是这样，放大图上一眼像根晾衣绳。
H_SWORD_X0, H_SWORD_X1 = 1, 2
H_GUARD_X0 = 1
H_GRIP_X = 2
H_ARM_L, H_ARM_R = 3, 11
H_TORSO_X0, H_TORSO_X1 = 5, 10
H_LEG_L, H_LEG_R = 5, 9
H_SHIELD_X0, H_SHIELD_X1 = 11, 14
# 剑盾换到另一侧时的落点（背面 / 侧面用）：
#   正面 —— 剑在画面左（x=1）、盾在画面右（x=11）
#   背面 —— 背对时右手在画面**右**，所以剑在 x=13、盾在 x=1
#   侧面 —— 剑在身前（画面右 x=13）、盾垂在身后侧（x=1）
H_SWORD_X0_OTHER = 13
H_SHIELD_X0_OTHER = 1

# ── 纵向解剖（绘制行号，画布 26 行）─────────────────────────────────
#    发顶 5..7 / 脸 8..13 / 眼 9..10
#    躯干 14..18（腰带在 18）/ 腿 19..21 / 靴 22
# 头（9 行）比躯干（5 行）+ 腿（4 行）还高一点 —— Q 版头身比，与旧素材一致。
H_HAIR_TOP = 5
H_FACE_TOP, H_FACE_BOT = 8, 13
H_EYE_ROW = 9
H_TORSO_TOP, H_TORSO_BOT = 14, 18
H_LEG_TOP = 19
H_BOOT_ROW = 22


def _hero_shadow(im: Image.Image, cx: int) -> None:
    """
    脚下的落地影（两行、半透明）。三个必须记住的点：

      · **alpha 必须 < `SOLID_ALPHA`(250)。** 否则 `solid_rows()` 会把影子算进
        「可见内容」，勇者的基准行区间就从 4..23 变成 4..25 —— 六个 NPC 的比例
        断言会集体误报。这不是审美问题，是量法的前提。
      · **必须在 `add_outline()` 之后叠。** 描边把 alpha>120 的像素当内容，
        影子先画就会被描一圈深色，看起来像地上挖了个坑。
      · **直接写像素，不要 `paste(im, pos, im)`。** 后者拿自己当 mask 会把 alpha
        平方（102 → 41）—— 旧素材的影子被平方两次后只剩 alpha≈7，等于没有影子，
        这正是「勇者看不出站在哪」的根因。

    内圈比外圈深一档：两行的高度差做不出「扁椭圆」的读感时，靠深浅分层补。
    """
    d = ImageDraw.Draw(im)
    d.ellipse([cx - 5, HERO_SHADOW_Y0, cx + 4, HERO_SHADOW_Y1], fill=(58, 48, 68, 164))
    d.ellipse([cx - 3, HERO_SHADOW_Y0, cx + 2, HERO_SHADOW_Y1], fill=(44, 36, 54, 206))


def _hero_legs(p, step: int) -> None:
    """
    两条腿 + 靴。`step` = 0 并拢 / 1 抬右腿 / -1 抬左腿。

    16 网格上「迈步」只能靠**腿的长短**读出来：抬起的那条腿少两行、靴子跟着抬两行。
    差 1 行在 8× 放大图上还看得出来，落到 32px 的格子上就完全没了 ——
    第一版就是只差 1 行，走路读起来像「两条腿在抖」而不是在迈。
    """
    for x0, raised in ((H_LEG_L, step == -1), (H_LEG_R, step == 1)):
        if raised:
            p(x0, H_LEG_TOP, 2, 1, H_LEATHER)
            p(x0, H_LEG_TOP + 1, 2, 1, H_BOOT)
        else:
            p(x0, H_LEG_TOP, 2, 3, H_LEATHER)
            p(x0, H_BOOT_ROW, 2, 1, H_BOOT)


def _hero_torso(p, back: bool = False) -> None:
    """
    铠甲躯干：胸甲（正面）/ 背板（背面）+ 双肩甲 + 腰带。

    三样东西一起才读得出「铠甲」：
      · 肩甲（x=4 / x=11，两行）—— 比胸甲亮一阶，是铠甲最显眼的记号；
      · 胸甲中缝（一条暗竖线）—— 只涂一整块灰会读成「穿了件灰衣服」；
      · 腰带 —— 把躯干和下摆分开，不然上下连成一根柱子。
    """
    th = H_TORSO_BOT - H_TORSO_TOP + 1
    p(H_TORSO_X0, H_TORSO_TOP, 6, th, H_ARMOR)
    p(H_TORSO_X0, H_TORSO_TOP, 1, th, H_HI)              # 左受光列
    p(H_TORSO_X1, H_TORSO_TOP, 1, th, H_ARMOR_DK)        # 右背光列
    for x in (H_TORSO_X0 - 1, H_TORSO_X1 + 1):           # 肩甲：x=4 与 x=11
        p(x, H_TORSO_TOP, 1, 2, H_HI)
    if back:
        p(7, H_TORSO_TOP + 1, 2, th - 2, H_LEATHER)      # 背带
    else:
        p(7, H_TORSO_TOP + 1, 2, 2, H_CLOAK)             # 胸口露出的战袍红
        p(7, H_TORSO_TOP, 1, th, H_ARMOR_DK)             # 胸甲中缝
    p(H_TORSO_X0, H_TORSO_BOT, 6, 1, H_LEATHER)          # 腰带


# 剑的「举到哪一档」。三档都只是**整体上抬**：剑身、护手、柄、以及持剑臂
# 全部按同一个 lift 平移 —— 分开处理就会出现「手在腰上、剑飘在头顶」。
#   0 = 竖握在身侧（走路 / 收势）
#   2 = 提到胸口（挥砍的中段）
#   4 = 高举过顶（再高一行剑尖就会被画布裁掉，见下）
#
# ⚠️ `up` 不能取 5 以上：剑尖在绘制行 `5 - lift`，描边再往上占一行，
#    lift=5 时描边落到 -1 行、**被画布裁掉** —— 整把剑会短一截而且没有尖。
#    4 是「剑尖到第 1 行、描边正好落在第 0 行」的上限。
HERO_SWORD_LIFT = {"rest": 0, "mid": 2, "up": 4}


def _hero_sword(p, x0: int, lift: int) -> None:
    """
    剑：剑身 2 列（**左列更亮 = 刃**）+ 3 列护手 + 1 列柄 + 收成三角的剑尖。

    ⚠️ 剑身必须 2 列宽。1 列宽时描边会在两侧各糊一列深色，整把剑读出来是
    「一根白线套着黑框」—— 第一版就是这样，放大图上一眼像根晾衣绳。
    """
    p(x0, 6 - lift, 2, 1, H_STEEL_HI)                # 剑尖：2 列
    p(x0 + 1, 5 - lift, 1, 1, H_STEEL_HI)            # 再收 1 列 → 三角
    p(x0, 7 - lift, 2, 10, H_STEEL)                  # 剑身 7..16
    p(x0, 7 - lift, 1, 10, H_STEEL_HI)               # 左列 = 刃
    p(x0 - 1, 17 - lift, 3, 1, H_GOLD)               # 护手
    p(x0, 18 - lift, 2, 2, H_GRIP)                   # 柄 18..19（2 列宽，手正好握在这里）


def _hero_sword_arm(p, x0: int, lift: int) -> None:
    """持剑臂 + 手。`lift` 必须与 `_hero_sword` 用同一个值，否则剑会「脱手」。"""
    p(x0, H_TORSO_TOP + 1 - lift, 2, 3, H_ARMOR)
    p(x0 - 1, H_TORSO_TOP + 4 - lift, 3, 1, H_SKIN)      # 手伸向柄


def _hero_arm(p, x0: int) -> None:
    """**非持剑**那只手臂的臂甲。持剑那只走 `_hero_sword_arm`（它要跟着剑上抬）。"""
    p(x0, H_TORSO_TOP + 1, 2, 3, H_ARMOR)


def _hero_shield(p, x0: int) -> None:
    """
    鸢盾（4 列宽）：上 3 行满宽 → 收 2 行 → 下尖 1 行。金边 + 白色徽记。

    2 列宽时描边会把它糊成一枚「蓝色小方块」，读不出是盾。4 列宽正好盖住
    持盾那条手臂（x=11..12）—— 「手臂在盾后」本身就是「举盾」这个动作的读法。
    """
    p(x0, H_TORSO_TOP, 4, 3, H_SHIELD)                   # 14..16
    p(x0, H_TORSO_TOP, 4, 1, H_GOLD)                     # 顶边金饰
    p(x0, H_TORSO_TOP + 1, 1, 2, H_SHIELD_HI)            # 左受光列
    p(x0 + 1, H_TORSO_TOP + 1, 2, 1, H_SHIELD_MARK)      # 徽记
    p(x0 + 1, H_TORSO_TOP + 3, 2, 2, H_SHIELD)           # 17..18 收窄
    p(x0 + 2, H_TORSO_TOP + 5, 1, 1, H_SHIELD)           # 19 下尖


def _hero_head_front(p) -> None:
    """
    正面头部：头发 5..7、脸 8..13、眼 9..10。

    脸和头发**同宽**（x=4..11，8 列），只有鬓角两列压在脸的两侧。
    改前头发占了 4 行、脸只剩 6 列被包在中间，放大图上看是一颗大棕方块 +
    中间一小条脸 —— 这正是 NPC 那轮踩过的「头上的长方形太细」，同一种错不犯第二次。
    """
    p(6, H_HAIR_TOP, 4, 1, H_HAIR)                       # 行 5 发顶收口
    p(4, H_HAIR_TOP + 1, 8, 2, H_HAIR)                   # 行 6..7 头发
    p(4, H_FACE_TOP, 8, H_FACE_BOT - H_FACE_TOP + 1, H_SKIN)
    p(4, H_FACE_BOT, 8, 1, H_SKIN_DK)                    # 下巴压暗
    p(4, H_FACE_TOP, 1, 3, H_HAIR)                       # 行 8..10 左鬓
    p(H_TORSO_X1 + 1, H_FACE_TOP, 1, 3, H_HAIR)          # 右鬓
    p(5, H_EYE_ROW, 1, 2, NPC_INK)
    p(10, H_EYE_ROW, 1, 2, NPC_INK)
    p(7, H_FACE_BOT - 1, 2, 1, H_MOUTH)


def _hero_head_back(p) -> None:
    """背面头部：整颗后脑都是头发（无脸），两侧压暗读出圆颅。"""
    p(6, H_HAIR_TOP, 4, 1, H_HAIR)
    p(4, H_HAIR_TOP + 1, 8, 2, H_HAIR)                   # 行 6..7
    p(4, H_HAIR_TOP + 3, 8, 6, H_HAIR)                   # 行 8..13 后脑
    p(4, H_FACE_TOP, 1, 6, H_HAIR_DK)
    p(H_TORSO_X1 + 1, H_FACE_TOP, 1, 6, H_HAIR_DK)


def _hero_head_side(p) -> None:
    """侧面头部：后脑在左（x=4..5）、脸朝右（x=5..11）、鼻尖凸出到 x=12。"""
    p(5, H_HAIR_TOP, 4, 1, H_HAIR)                       # 行 5
    p(4, H_HAIR_TOP + 1, 5, 2, H_HAIR)                   # 行 6..7（x=4..8）
    p(5, H_FACE_TOP, 7, H_FACE_BOT - H_FACE_TOP + 1, H_SKIN)   # 脸 x=5..11
    p(4, H_FACE_TOP, 2, 6, H_HAIR)                       # 行 8..13 后脑
    p(4, H_FACE_TOP, 1, 6, H_HAIR_DK)                    # 后脑外缘压暗
    p(5, H_FACE_BOT, 7, 1, H_SKIN_DK)                    # 下巴
    p(10, H_EYE_ROW, 1, 2, NPC_INK)                      # 眼（靠脸的前缘）
    p(12, H_EYE_ROW + 1, 1, 1, H_SKIN)                   # 鼻尖凸出一列 —— 侧面朝哪边全靠它


def _hero_front(layer, pose: dict) -> None:
    """正面（朝下）：看得见脸；剑在画面左（右手），盾在画面右（左手）。"""

    def p(x, y, w, h, c):
        _put(layer, x, y, w, h, c)

    lift = HERO_SWORD_LIFT[pose["sword"]]
    _hero_legs(p, pose["leg"])
    _hero_torso(p)
    _hero_head_front(p)
    _hero_sword_arm(p, H_ARM_L, lift)
    _hero_arm(p, H_ARM_R)
    p(H_ARM_R, H_TORSO_TOP + 4, 2, 1, H_SKIN)            # 左手持盾
    _hero_sword(p, H_SWORD_X0, lift)
    _hero_shield(p, H_SHIELD_X0)


def _hero_back(layer, pose: dict) -> None:
    """背面（朝上）：后脑 + 背板 + 背带。背对时右手在画面**右** —— 剑盾跟着换边。"""

    def p(x, y, w, h, c):
        _put(layer, x, y, w, h, c)

    lift = HERO_SWORD_LIFT[pose["sword"]]
    _hero_legs(p, pose["leg"])
    _hero_torso(p, back=True)
    _hero_head_back(p)
    _hero_arm(p, H_ARM_L)
    p(H_ARM_L, H_TORSO_TOP + 4, 2, 1, H_SKIN)            # 左手（画面左）持盾
    _hero_sword_arm(p, H_ARM_R, lift)
    _hero_sword(p, H_SWORD_X0_OTHER, lift)               # 剑换到画面右
    _hero_shield(p, H_SHIELD_X0_OTHER)                   # 盾换到画面左


def _hero_side(layer, pose: dict) -> None:
    """侧面（朝右）：脸朝右；剑在身前（画面右），盾在身侧（画面左）。`left` 是它的镜像。"""

    def p(x, y, w, h, c):
        _put(layer, x, y, w, h, c)

    lift = HERO_SWORD_LIFT[pose["sword"]]
    _hero_legs(p, pose["leg"])
    _hero_torso(p)
    _hero_head_side(p)
    _hero_arm(p, H_ARM_L)                                # 后手（持盾）
    p(H_ARM_L, H_TORSO_TOP + 4, 2, 1, H_SKIN)
    _hero_sword_arm(p, H_ARM_R, lift)                    # 前手（持剑）
    _hero_sword(p, H_SWORD_X0_OTHER, lift)               # 剑在身前
    _hero_shield(p, H_SHIELD_X0_OTHER)                   # 盾垂在身后侧


def _hero_pose(kind: str, i: int) -> dict:
    """
    这一帧的姿态参数。

      走路：`leg` 在 0 / 1 / 0 / -1 之间交替（并拢 / 抬右 / 并拢 / 抬左），
            剑始终竖握 —— 走路时保持持剑，玩家一眼知道「这是带装备的勇者」。
      挥剑：`sword` 走 竖握 → 提到胸前 → 高举过顶 → 收势。
            三档之间是**整体上抬**（见 `HERO_SWORD_LIFT`），配渲染层的刀光演出挥砍，
            所以这一侧不需要画出真实的挥剑轨迹 —— 画了也会被刀光盖住。
    """
    if kind == "walk":
        return {"leg": (0, 1, 0, -1)[i % 4], "sword": "rest"}
    return {"leg": 0, "sword": ("rest", "mid", "up", "rest")[i % 4]}


def hero_frame(direction: str, kind: str, i: int) -> Image.Image:
    """
    勇者的一帧（含描边与落地影），返回**完整画布**。

    画布尺寸**两套动画一致**：走路与挥剑都是 16×26。曾经挥剑帧是 20×26
    （「留给以后真的要把剑抡出去」），实测图集里就是 **80×104 的帧** ——
    而 `bottom_center()` 并不裁宽度，于是落屏 40px，比 32px 的格子还宽，
    挥剑时人会横向压到邻格上。抬剑只改 y，横向范围压根没变，那 4 列是白送的。

    两套同尺寸还有个直接好处：`verify-visual` 的 A14 靠 `frame` 的**尺寸**判
    「挥剑不变小」，尺寸一致时这条判据只需要关心「有没有换成挥剑帧」，
    不必再为两种尺寸单独写一套期望值。
    """
    base = "right" if direction == "left" else direction
    im = Image.new("RGBA", (HERO_W, HERO_H), (0, 0, 0, 0))
    pose = _hero_pose(kind, i)
    if base == "down":
        _hero_front(im, pose)
    elif base == "up":
        _hero_back(im, pose)
    else:
        _hero_side(im, pose)
    im = add_outline(im, INK)
    # 影子跟着**解剖表的中心**（x=8），不是画布中心 —— 挥剑帧画布更宽，
    # 用 w//2 会让影子整体偏右两列、与脚对不上。
    _hero_shadow(im, HERO_W // 2)
    if direction == "left":
        # 镜像放在最后：连影子和描边一起翻，不需要为「左」再画一套像素
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    return im


def build_actor_sheet():
    """
    产出勇者的走路 / 挥剑帧 —— 4 向 × 4 帧各一套，按 `HERO_DIRS` 顺序排列。

    返回 (walk, attack)：`walk[di][fi]` / `attack[di][fi]`。
    NPC 不在这里 —— 它们由 `npc_art_frames()` 单独产出（见九之二）。
    """
    walk = [[hero_frame(d, "walk", i) for i in range(4)] for d in HERO_DIRS]
    attack = [[hero_frame(d, "attack", i) for i in range(4)] for d in HERO_DIRS]
    return walk, attack


# 判据色匹配的逐分量容差。
# 为什么不是 0：`add_outline` 不碰原像素，但将来微调调色板时不该因为 ±2 的
# 微调就把判据打红。代价是判据色之间必须**隔开至少 2×这个值** ——
# 那条约束由 verify_hero_art 的判据 5 强制（写成断言，不靠注释提醒）。
HERO_COLOR_TOL = 6


def verify_hero_art(walk: list, attack: list) -> list:
    """
    勇者造型断言：**三件装备必须在位、在正确的一侧**。
    用户的诉求是「增加剑、盾、铠甲」。而「画了但没画上」「剑盾左右画反」
    「挥剑四帧一模一样」这三件事**在代码里都看不出来**（写的是三次调用，长得也对），
    所以判据全部落在像素上 —— 颜色 + 位置：

      1. 朝下第 0 帧必须同时出现钢色（剑）、靛蓝（盾）、银灰（铠甲）；
      2. 剑的像素都在帧的**左侧**、盾的都在**右侧** —— 抓左右画反；
      3. 四个方向的静止帧都要有剑和盾 —— 抓「只画了正面」；
      4. 挥剑的举剑帧里剑的最上沿要比静止帧高 ≥3 行 —— 抓「四帧一样」；
      5. **判据色彼此远离**（自检，见下）。

    ⚠️ 颜色比较用「接近」而不是相等：`add_outline` 不碰原像素，取 ±6 的容差
    是为了将来微调调色板时不误报。

    ⚠️⚠️ 但「容差」是一把双刃的刀，判据 5 就是为它配的保险 —— 见下面那段注释。
    """
    problems: list[str] = []

    def where(im: Image.Image, color, tol: int = HERO_COLOR_TOL):
        """该颜色的像素落在哪些列、最上行是第几行（都没有则 cols 为空、top 为 None）。"""
        px = im.load()
        cols, top = set(), None
        for y in range(im.height):
            for x in range(im.width):
                r, g, b, a = px[x, y]
                if a < 200:
                    continue
                if abs(r - color[0]) <= tol and abs(g - color[1]) <= tol and abs(b - color[2]) <= tol:
                    cols.add(x)
                    top = y if top is None else min(top, y)
        return cols, top

    front = walk[0][0]
    w = front.width
    for name, color in (("剑（钢）", H_STEEL_HI), ("盾（靛蓝）", H_SHIELD), ("铠甲（银灰）", H_ARMOR)):
        if not where(front, color)[0]:
            problems.append(f"勇者朝下帧里找不到{name}色 rgba{color} —— 三件装备必须都在")
    sword_cols = where(front, H_STEEL_HI)[0]
    shield_cols = where(front, H_SHIELD)[0]
    if sword_cols and max(sword_cols) > w * 0.45:
        problems.append(
            f"剑的像素跑到了第 {max(sword_cols)} 列（帧宽 {w}）—— 剑该在画面左（右手）"
        )
    if shield_cols and min(shield_cols) < w * 0.5:
        problems.append(
            f"盾的像素跑到了第 {min(shield_cols)} 列（帧宽 {w}）—— 盾该在画面右（左手）"
        )

    for d, frames in zip(HERO_DIRS, walk):
        f = frames[0]
        if not where(f, H_STEEL_HI)[0] or not where(f, H_SHIELD)[0]:
            problems.append(f"勇者的 {d} 向静止帧缺剑或缺盾 —— 四个方向都要能看出装备")

    # 挥剑：举剑帧的剑尖必须真的比静止帧高（`attack[i][2]` 是 up 档）
    rest_top = where(walk[0][0], H_STEEL_HI)[1]
    up_top = where(attack[0][2], H_STEEL_HI)[1]
    if rest_top is None or up_top is None:
        problems.append("挥剑帧里量不到剑的最上沿，无法确认「举起来了」")
    elif rest_top - up_top < 3:
        problems.append(
            f"挥剑的举剑帧剑尖在第 {up_top} 行、静止帧在第 {rest_top} 行 —— "
            f"只高了 {rest_top - up_top} 行，读不出「举起来」"
        )

    # ── 判据 5：判据色必须彼此远离（自检） ───────────────────────────
    #
    # 为什么需要这条：判据 1/2 是**按近似色在整帧里找像素**。只要调色板里还有
    # 第二个颜色落在容差内，它就会被算成「剑」或「盾」—— 于是「装备跑错边」
    # 立刻报出来。**报错信息指向绘制，实际病因在调色板**，
    # 下一个人会先去改画法（改错地方），这是最昂贵的一类假红。
    #
    # 2026-09-23 实际踩到：盾徽原本是近白 (246,248,252)，与剑刃 (250,253,255)
    # 逐分量只差 (4,5,3)，全在 tol=6 内 → 报「剑的像素跑到了第 13 列」，
    # 而剑明明在 1..2 列。把「谁可能撞上谁」做成构建时就红的检查，
    # 比写一句「注意别用近似色」的注释可靠 —— 注释不会拦人。
    palette = {
        k: v
        for k, v in globals().items()
        if k.startswith("H_") and isinstance(v, tuple) and len(v) == 4
    }
    for pname, pc in (("剑（钢）", H_STEEL_HI), ("盾（靛蓝）", H_SHIELD), ("铠甲（银灰）", H_ARMOR)):
        for k, c in palette.items():
            if c == pc:
                continue   # 判据色自己（含同值别名）
            if all(abs(c[i] - pc[i]) <= HERO_COLOR_TOL for i in range(3)):
                problems.append(
                    f"调色板里的 {k} rgba{c} 与判据色「{pname}」rgba{pc} 逐分量差都 ≤ "
                    f"{HERO_COLOR_TOL} —— 判据 1/2 会把 {k} 的像素当成{pname}，"
                    f"报出「装备跑错边」的假红（改画法改不掉，得改颜色）。"
                    f"两者至少要让一个分量差 > {HERO_COLOR_TOL}"
                )
    return problems


# ─────────────────────────────────────────────────────────────────────
# 九之二、NPC 造型（程序化手绘）
# ─────────────────────────────────────────────────────────────────────
# ## 为什么必须自己画
#
# 六家素材包里**没有一个可用的 NPC 角色集**：
#   · ArMM 的 NPC_test.png 是单角色表（64×128，全图同一个人四个方向）——
#     之前 6 个 NPC 就是用这一张图配上一对「暗→亮」颜色渐变来区分的，
#     结果是一排**剪影完全相同、只有颜色不同**的人。玩家说的「模版太差」
#     就是这个：不同职能的人分不出谁是谁。
#   · 0x72 包里有 elf_f / knight_f 之类没被怪物用掉的人形，但只有两三个，
#     而且和怪物（法师 / 骑士 / 兽人）同源 —— NPC 和怪物长得像比长得丑更糟。
#
# 所以直接手绘：**每个职能一套 16×26 的像素画**，靠剪影、帽子、手持物区分，
# 而不是靠颜色。配色与 src/render/theme.ts 的 NPC_ROLE 一一对应，
# 棋盘上的职能徽章、对话框的职能章因此和本人同色 ——
# 「看到什么颜色就知道这个人能干什么」。
#
# ## 为什么不画四向
#
# NPC 是静止实体，渲染层永远只取 `down`（board.ts: atlas.npcFrame(id, 'down', 0)）。
# 画四个方向是四倍工作量、零收益。MANIFEST 里四个方向写同一组帧，
# 只是为了让 `walk[dir]` 这个既有形状继续成立，渲染层一行都不用改。

NPC_W, NPC_H = 16, 26
SKIN = (247, 217, 184, 255)
SKIN_DK = (206, 168, 132, 255)
NPC_INK = (44, 34, 42, 255)

# ── 量「内容占几行」时用哪种像素 ──────────────────────────────────────
#
# ⚠️ **只量实心像素（alpha = 255）。**
#
# 为什么不能量「非透明」：
#   · ArMM 的角色每帧脚底下都带一片**半透明影子**（源素材 alpha=102）。
#     用 `getbbox()` / `any(alpha)` 量，影子会被算成内容 —— 勇者量出来高 22~23，
#     肉眼看到的身体只有 20 行。上一轮就是拿被撑大的 23 当基准，
#     把 NPC 画成 23 行高，于是「比例适中」改完之后**实际还是比勇者高 15%**，
#     用户第二次反馈「应该和玩家角色类似」才追到这里。
#   · 半透明像素的 alpha 还会被下面的打包流程改动（见下），
#     按它量等于把断言建在一个会变的数上。实心像素是唯一不变的锚。
#
# 为什么阈值取 250 而不是 255：留一点余量给将来可能出现、但确实该算实心的
# 极淡边缘（例如描边抗锯齿）。半透明装饰（仙子的翅膀 alpha=200）与影子
# （alpha ≤ 178）都远在这条线之下，会被排除 —— 这正是我们要的：
# **量的是身体，不是影子也不是装饰。**
#
# ⚠️ 顺带记一个**已知缺陷**（本轮没改，改动会波及勇者和全部怪物的观感）：
# `Image.paste(im, pos, im)` 用自己当 mask 时会**把 alpha 平方**、
# 并把 RGB 往黑色压（实测 102 → 41、200 → 157，颜色 (42,43,53) → (17,17,21)）。
# `bottom_center()` 和图集装配各来一次，于是勇者的影子被平方了两次：
# 102 → 41 → **7**，等于画了个看不见的影子。怪物/仙子的半透明部分各被平方一次。
# 正确的写法是 `alpha_composite`（对空画布就是逐像素拷贝，实测 102 → 102）。
# 修它会让勇者重新长出影子 —— 那是另一件事，得连 NPC 一起补影子才协调。
SOLID_ALPHA = 250

# `verify_boss_art` 用的门槛。三个都是「先量、再定」的 —— 每一版素材都要重新量
# 改前/改后的分布，阈值定在**改前必红、改后有余量**的位置，否则它只是一条
# 永远为真的装饰性断言（见 §「断言红了先怀疑期望值」那条铁律的反向用法）。
#
# BOSS_DETAIL_MIN：每个 8×8 块的**中位**独立颜色数。
#   实测（2026-09-23 定稿这一版）：改前 2.0 ~ 3.0，改后 **3.0 ~ 4.0**。
#   门槛取 3.0 —— 改前 vampire 恰好是 2.0（大面积纯色斗篷），会被这条抓住。
#   ⚠️ 改后有 5 只**恰好落在 3.0**：这就是地板值本身，掉一色即红，
#   是刻意的（它保护的就是「每个 8×8 区域至少三色」这件事）。
# BOSS_INNER_MIN：只统计**身体内部**（离透明边缘 ≥2px）的 4×4 块，
#   取均值。为什么要它：8×8 密度里**轮廓线**贡献很大，边缘复杂但内部偷懒的
#   造型也能过线。实测改前 1.61 ~ 2.13、改后 **1.97 ~ 2.28**，门槛 1.8。
# BOSS_HEAD_SYM_MAX：正面朝向的 BOSS，头部区域的不对称像素占比上限。
#   实测：改前 dragon（侧视）39.4%、demonKingTrue 15.1%（角与手臂左右各差
#   1~7 列，之前没人发现）；改后最大 2.3%。门槛 12% 留足余量。
# BOSS_SIL_MIN_DIFF：两只 BOSS 剪影至少差这么多像素。不写「不相等」是因为
#   差 1 个像素也叫不相等 —— 那种判据拦不住「八只都长一个样、只是换了色」。
BOSS_DETAIL_MIN = 3.0
BOSS_INNER_MIN = 1.80
BOSS_HEAD_SYM_MAX = 0.12
BOSS_SIL_MIN_DIFF = 400

# 哪些 BOSS 是**正面朝向玩家**的（判据 7 只对它们生效）。
#
# 名单写死、而不是「对所有 BOSS 都量对称度」：骷髅队长手持圆盾、骑士队长
# 手持大剑、法师抱着法杖、吸血鬼**刻意**做成不对称（竖领一高一低、斗篷偏披）
# —— 这些是合法的不对称，全局判据会把它们全部误杀。
# 往名单里加一只之前，先确认它的不对称**全部**来自剧情道具或刻意的站姿。
HEAD_FRONT = ("dragon", "demonKing", "demonKingTrue", "kraken")


def solid_rows(im: Image.Image) -> tuple[int, int]:
    """**实心**内容所占的行区间 [top, bottom]（含端点）。全透明返回 (h, -1)。"""
    px = im.load()
    ys = [y for y in range(im.height) if any(px[x, y][3] >= SOLID_ALPHA for x in range(im.width))]
    return (ys[0], ys[-1]) if ys else (im.height, -1)


# ── NPC 的纵向解剖（绝对行号，画布 26 行）────────────────────────────
#
# ⚠️ 这张表的目标不是「NPC 自己好看」，而是**和勇者一样大、一样的头身比**。
#
# 两个基准都是从勇者帧上量出来的（量法见 verify_npc_scale），不是估的：
#
# ① **可见高度 = 20 行（4..23）**。走路起伏让整张精灵上下移 1 行
#    （朝上那两帧是 3..22），但**每一帧的高度都是 20**。
# ② **头身比：头（含头发）最宽 13、躯干（含手臂）最宽 14** —— 几乎一样宽，
#    这是它看起来「敦实」的原因。
#
# 改前的 NPC 是「头 8 + 身体 15」：头是一根细高的长方形，身体鼓成钟形，
# 正是用户说的「头上的长方形太细，身体太宽」。所以横向一起重排了：
#    头（含发）10 → 躯干（含手臂）10 → 下摆 8 → 脚 4
# 头不再比身体窄，整条轮廓上下收放对称。
#
# 三件容易搞错的事：
#  ① 别用「非透明包围盒」量勇者 —— 见 SOLID_ALPHA。
#  ② `add_outline` 会往上、往下各多占 1 行。所以**画的时候顶到第 5 行**、
#     脚踩到第 22 行，产出后可见区间才是 4..23。
#  ③ 行号一律用下面这张表，**不要在 _npc_base 里写裸数字** ——
#     否则下一次「NPC 又变大了」会是六个角色各错一点，很难查。
#
# 行分配（自上而下，数字是**绘制**行号）：
#   hat     5..7   帽/冠/发（尖顶 / 宽檐 / 兜帽 / 金冠 / 皮帽 / 花冠）
#   face    8..14  脸 7 行 —— 与勇者的脸（9..15）等长
#   eyes   11..12
#   torso  15..18  躯干 4 行
#   robe   19..21  长袍下段（下摆）3 行
#   foot   22      鞋 1 行 —— 描边后踩到第 23 行 = 勇者的脚底行
NPC_HAT_TOP, NPC_HAT_BOT = 5, 7
NPC_FACE_TOP, NPC_FACE_BOT = 8, 14
NPC_EYE_TOP = 11
NPC_TORSO_TOP, NPC_TORSO_BOT = 15, 18
NPC_ROBE_TOP, NPC_ROBE_BOT = 19, 21
NPC_FOOT_ROW = 22

NPC_ART_TOP, NPC_ART_FEET = NPC_HAT_TOP, NPC_FOOT_ROW   # 绘制行区间（描边前）
NPC_CONTENT_TOP = NPC_ART_TOP - 1    # 产出后可见顶行（add_outline 往上占一行）
NPC_FEET = NPC_ART_FEET
# 注：这里曾经有 `NPC_BREATH_SPLIT`（呼吸帧的上下身分界行）。呼吸已经整体移到
# 渲染层，素材里不再有位移帧，所以那个常量连同它的两处误用一起删了 ——
# 留着一个「呼吸分界」等于给下一个人指一条已经废弃的路。

# ── 横向解剖（列号，画布 16 列）────────────────────────────────────────
#
# 安排的原则是**头不比身体窄**，而且**肩要比下摆宽**。三条一起定死了：
#
#   脸 / 头    x=4..11（8 宽）→ 可见 10
#   躯干       x=5..10（6 宽）
#   手臂       x=3..4 与 x=11..12（各 2 宽）→ 含手臂 10 宽 → 可见 12（最宽处）
#   下摆       x=5..10（6 宽）→ 可见 8 —— **与躯干同宽，不再是 A 字大摆**
#   脚         x=5..6 与 x=9..10
#
# 为什么下摆必须收窄：`add_outline` 是 **1px 八邻域膨胀**，所以「可见宽度」
# ≈ 该行及上下各一行里最宽的那一段再 +2。改前的下摆画到 12 宽（可见 15），
# 而头只有 6 宽（可见 8）—— 用户说的「头上的长方形太细，身体太宽」就是这个。
#
# 同理，想让某一段在**画面上**显出收腰，相邻两段的**绘制**宽度至少要差 2，
# 只差 1 会被描边抹平（第一版重画就踩了这个：头和肩都画 10 宽，结果整只
# 精灵在 12 宽上从头顶平到脚，变成一根柱子）。
NPC_FACE_X, NPC_FACE_W = 4, 8        # 脸 = 头的绘制宽度：x=4..11（与勇者的脸等宽）
NPC_TORSO_X, NPC_TORSO_W = 5, 6      # 躯干：x=5..10
NPC_ARM_X, NPC_ARM_W = 3, 2          # 手臂：x=3..4 与 x=11..12（各 2 宽）→ 含臂 10 宽
NPC_ROBE_X, NPC_ROBE_W = 5, 6        # 下摆：x=5..10（与躯干同宽）
NPC_FOOT_X = 5                       # 脚：x=5..6 与 x=9..10


def _put(im, x, y, w, h, color):
    """按像素块填色。所有 NPC 造型只用这一个原语 —— 保证是硬边像素画，不是矢量缩放。"""
    if color is None:
        return
    px = im.load()
    for j in range(h):
        for i in range(w):
            if 0 <= x + i < im.width and 0 <= y + j < im.height:
                px[x + i, y + j] = color


# 每个职能的造型参数。颜色与 src/render/theme.ts 的 NPC_ROLE 对应：
#   sage 蓝 / merchant 金 / shop 绿 / thief 灰 / fairy 青 / princess 粉
NPC_ART = {
    # 智慧老人：灰白长袍、白须、尖顶软帽，手拄法杖（书卷气，不是战斗感）
    "sage": dict(
        robe=(226, 224, 214, 255), robe_dark=(148, 146, 140, 255), robe_light=(250, 250, 246, 255),
        hat="point", hat_color=(88, 92, 106, 255), hair=(238, 236, 230, 255),
        beard=(244, 242, 236, 255), beard_len=4,
        prop="staff", prop_color=(122, 86, 48, 255), prop_gem=(96, 156, 246, 255),
    ),
    # 商人：暖褐短袍、宽檐帽，腰侧挂钱袋（宽檐帽是「摆摊的」最直白的记号）
    "merchant": dict(
        robe=(178, 118, 58, 255), robe_dark=(112, 70, 30, 255), robe_light=(222, 172, 106, 255),
        hat="wide", hat_color=(206, 156, 92, 255), hair=(96, 62, 30, 255),
        prop="pouch", prop_color=(226, 176, 72, 255),
    ),
    # 商店：深绿外袍 + 皮围裙 + 皮帽，手边一摞金币（属性买卖＝柜台生意）
    "shop": dict(
        robe=(58, 132, 84, 255), robe_dark=(32, 82, 52, 255), robe_light=(120, 196, 138, 255),
        apron=(226, 208, 168, 255), hat="cap", hat_color=(168, 128, 84, 255),
        hair=(74, 52, 34, 255),
        prop="coins", prop_color=(240, 202, 84, 255),
    ),
    # 小偷：兜帽 + 蒙面，只露两条眼缝，腰间短匕（不像是能讲道理的人）
    "thief": dict(
        robe=(74, 78, 92, 255), robe_dark=(40, 42, 54, 255), robe_light=(112, 118, 136, 255),
        hat="hood", hat_color=(52, 56, 70, 255), mask=(38, 40, 54, 255),
        prop="dagger", prop_color=(198, 204, 216, 255), prop_grip=(126, 82, 42, 255),
    ),
    # 仙子：青白长裙、花冠、背后一双薄翅、手持星杖
    # （一眼看出「不是人、是来帮你的」）
    "fairy": dict(
        robe=(206, 240, 250, 255), robe_dark=(120, 190, 216, 255), robe_light=(248, 254, 255, 255),
        hat="tiara", hat_color=(246, 252, 255, 255), hair=(150, 220, 246, 255),
        wings=(178, 232, 250, 200),
        prop="wand", prop_color=(240, 246, 255, 255), prop_gem=(86, 214, 250, 255),
    ),
    # 公主：粉裙、长发、金冠（视觉上就该是「被关在这里的那个人」）
    "princess": dict(
        robe=(240, 168, 208, 255), robe_dark=(186, 96, 150, 255), robe_light=(252, 214, 234, 255),
        hat="crown", hat_color=(246, 202, 70, 255), hair=(126, 74, 40, 255), hair_len=6,
        prop="none",
    ),
}


def _npc_shadow(im: Image.Image) -> None:
    """
    脚下两行半透明落地影 —— 与勇者同一套参数（见 `_hero_shadow` 的三条注意）。

    为什么要跟着勇者一起加：勇者的影子是**技术上必需**的（它要撑住帧的包围盒，
    否则 `bottom_center()` 贴底之后可见行区间会跑偏，NPC 的比例基准会跟着错）。
    但勇者有影子、六个 NPC 没有，并排站在棋盘上就很怪 —— 上下两个人一个踩地、
    一个悬着。所以两边一起补，这才是「一起补影子才协调」那句备注的落地。
    """
    d = ImageDraw.Draw(im)
    d.ellipse([3, 24, 12, 25], fill=(58, 48, 68, 164))
    d.ellipse([5, 24, 10, 25], fill=(44, 36, 54, 206))


def _npc_base(spec) -> Image.Image:
    """
    画一帧静止姿态。解剖常量都在这里，改一处六个 NPC 一起对齐。

    行号全部取自上面的纵向解剖表 —— **不要在这里写裸数字**，
    否则下一次「NPC 又变大了」会是六个角色各错一点，很难查。

    画法上有一处是这次改动的核心：**头不是「脸」本身**。
    先铺一层头发/兜帽占满 x=3..12，再把 8 宽的脸盖在中间 ——
    于是「头」是 10 宽，和含手臂的躯干（也是 10 宽）一样宽。
    改前是直接用 6 宽的脸当整颗头，于是头上顶着一根细高的长方形。
    """
    im = Image.new("RGBA", (NPC_W, NPC_H), (0, 0, 0, 0))
    robe = spec["robe"]
    dark = spec.get("robe_dark", spec["robe"])
    light = spec.get("robe_light", spec["robe"])

    # ── 下摆（x=5..10）：与躯干同宽 —— 收掉 A 字大摆，「身体太宽」就是它 ─
    rh = NPC_ROBE_BOT - NPC_ROBE_TOP + 1
    _put(im, NPC_ROBE_X, NPC_ROBE_TOP, NPC_ROBE_W, rh, robe)
    _put(im, NPC_ROBE_X, NPC_ROBE_TOP, 1, rh, light)                     # 左受光
    _put(im, NPC_ROBE_X + NPC_ROBE_W - 1, NPC_ROBE_TOP, 1, rh, dark)     # 右背光

    # ── 躯干（x=5..10）────────────────────────────────────────────────
    th = NPC_TORSO_BOT - NPC_TORSO_TOP + 1
    _put(im, NPC_TORSO_X, NPC_TORSO_TOP, NPC_TORSO_W, th, robe)
    _put(im, NPC_TORSO_X, NPC_TORSO_TOP, 1, th, light)
    _put(im, NPC_TORSO_X + NPC_TORSO_W - 1, NPC_TORSO_TOP, 1, th, dark)
    if spec.get("apron"):
        _put(im, NPC_TORSO_X + 1, NPC_TORSO_TOP + 1, NPC_TORSO_W - 2, th - 2, spec["apron"])

    # ── 手臂（x=3..4 与 x=11..12）：全帧最宽的一段（含臂 10 → 可见 12）──
    arm_top, arm_bot = NPC_TORSO_TOP + 1, NPC_TORSO_BOT
    for ax in (NPC_ARM_X, NPC_W - NPC_ARM_X - NPC_ARM_W):
        _put(im, ax, arm_top, NPC_ARM_W, arm_bot - arm_top + 1, robe)
        _put(im, ax, arm_bot, NPC_ARM_W, 1, SKIN)          # 手

    # ── 脚（第 22 行）：描边后踩到第 23 行 = 勇者的脚底行 ──────────────
    _put(im, NPC_FOOT_X, NPC_FOOT_ROW, 2, 1, dark)
    _put(im, NPC_FOOT_X + 4, NPC_FOOT_ROW, 2, 1, dark)

    # ── 翅膀（仙子）：露在手臂外侧各 1 列 ─────────────────────────────
    if spec.get("wings"):
        w = spec["wings"]
        _put(im, NPC_ARM_X - 1, NPC_TORSO_TOP, 1, th, w)                   # x=2
        _put(im, NPC_W - NPC_ARM_X - 1, NPC_TORSO_TOP, 1, th, w)           # x=13

    # ── 长发（公主）：顺着**手臂外侧那一列**垂到肩，不额外占宽度 ────────
    if spec.get("hair_len"):
        hc = spec.get("hair", dark)
        hb = min(NPC_FACE_BOT + spec["hair_len"], NPC_TORSO_BOT - 1)
        _put(im, NPC_ARM_X, NPC_FACE_BOT + 1, 1, hb - NPC_FACE_BOT, hc)
        _put(im, NPC_W - NPC_ARM_X - 1, NPC_FACE_BOT + 1, 1, hb - NPC_FACE_BOT, hc)

    # ── 头：就是那张 8 宽的脸（可见 10），发际线压一行头发/帽檐 ─────────
    # 改前这里只有 6 宽、却有 8 行高 —— 那根细高的长方形就是用户说的「太细」。
    hair = spec.get("hair", dark)
    _put(im, NPC_FACE_X, NPC_HAT_BOT, NPC_FACE_W, 1, hair)
    _put(im, NPC_FACE_X, NPC_FACE_TOP, NPC_FACE_W, NPC_FACE_BOT - NPC_FACE_TOP + 1, SKIN)
    _put(im, NPC_FACE_X, NPC_FACE_BOT, NPC_FACE_W, 1, SKIN_DK)     # 下巴压暗一行

    # 蒙面（小偷）：下半张脸盖住 —— 在眼睛之前画，眼睛正好落在面罩上变成两条眼缝
    if spec.get("mask"):
        _put(im, NPC_FACE_X, NPC_FACE_BOT - 2, NPC_FACE_W, 3, spec["mask"])

    # 眼睛：离脸的左右边各 1 列、2 行高 —— 与勇者的眼睛同一套比例
    _put(im, NPC_FACE_X + 1, NPC_EYE_TOP, 1, 2, NPC_INK)
    _put(im, NPC_FACE_X + NPC_FACE_W - 2, NPC_EYE_TOP, 1, 2, NPC_INK)

    # 胡须（老人）：从下巴往下铺，与脸同宽（窄了又会变成「细长条」）
    if spec.get("beard_len"):
        bc = spec["beard"]
        bl = min(spec["beard_len"], NPC_TORSO_BOT - NPC_FACE_BOT)
        _put(im, NPC_FACE_X, NPC_FACE_BOT + 1, NPC_FACE_W, bl, bc)

    # ── 帽子 / 头顶记号：一律落在第 5..7 行，帽檐与头同宽（8）──────────
    # 只有商人的宽檐帽刻意伸到 x=3..12（可见 12），作为「摆摊的」的记号。
    hat = spec.get("hat", "none")
    hc = spec.get("hat_color", dark)
    if hat == "point":      # 尖顶软帽：智者（2 → 4 → 8，逐行张开的锥形）
        _put(im, 7, NPC_HAT_TOP, 2, 1, hc)
        _put(im, 6, NPC_HAT_TOP + 1, 4, 1, hc)
        _put(im, NPC_FACE_X, NPC_HAT_BOT, NPC_FACE_W, 1, hc)
    elif hat == "wide":     # 宽檐帽：商人（唯一比头宽的一顶）
        _put(im, 6, NPC_HAT_TOP, 4, 1, hc)
        _put(im, NPC_TORSO_X, NPC_HAT_TOP + 1, NPC_TORSO_W, 1, hc)
        _put(im, NPC_ARM_X, NPC_HAT_BOT, NPC_FACE_W + 2, 1, hc)   # x=3..12
    elif hat == "hood":     # 兜帽：小偷 —— 罩住头顶，两侧垂布把脸夹成一条
        _put(im, NPC_FACE_X, NPC_HAT_TOP, NPC_FACE_W, 3, hc)
        _put(im, NPC_FACE_X, NPC_FACE_TOP, 1, 6, hc)
        _put(im, NPC_FACE_X + NPC_FACE_W - 1, NPC_FACE_TOP, 1, 6, hc)
    elif hat == "crown":    # 金冠：公主（一圈金带 + 三根尖）
        _put(im, NPC_FACE_X, NPC_HAT_BOT, NPC_FACE_W, 1, hc)
        for px in (NPC_FACE_X, NPC_FACE_X + 3, NPC_FACE_X + NPC_FACE_W - 1):
            _put(im, px, NPC_HAT_TOP, 2 if px == NPC_FACE_X + 3 else 1, 2, hc)
    elif hat == "cap":      # 皮帽：商店（扁顶 + 与头同宽的檐，与商人的宽檐帽分得开）
        _put(im, NPC_TORSO_X, NPC_HAT_TOP, NPC_TORSO_W, 2, hc)
        _put(im, NPC_FACE_X, NPC_HAT_BOT, NPC_FACE_W, 1, hc)
    elif hat == "tiara":    # 花冠：仙子（发箍 + 两侧各一朵）
        _put(im, NPC_FACE_X, NPC_HAT_TOP, NPC_FACE_W, 2, hair)
        _put(im, NPC_FACE_X, NPC_HAT_BOT, NPC_FACE_W, 1, hc)
        _put(im, NPC_ARM_X, NPC_HAT_BOT - 1, 1, 2, hc)                    # x=3
        _put(im, NPC_W - NPC_ARM_X - 1, NPC_HAT_BOT - 1, 1, 2, hc)        # x=12
    else:
        _put(im, NPC_FACE_X, NPC_HAT_TOP, NPC_FACE_W, 3, hair)

    # 手持物 —— 「这个人是干什么的」最直接的表达。
    # 一律放在右侧（x=13..15）且**不高于第 9 行**：抬高了会把内容顶行顶上去，
    # 又变成「NPC 比勇者高」；也一律只占 1~2 列，免得把它算进「身体有多宽」。
    # （量宽度时用的是「含中心那一列的主块」，道具是独立的一段，不会混进来。）
    prop = spec.get("prop", "none")
    pc = spec.get("prop_color", dark)
    gem = spec.get("prop_gem", pc)
    if prop == "staff":     # 法杖：杖身从腰边撑到地面，顶端一颗宝石
        _put(im, 14, NPC_TORSO_TOP - 3, 1, NPC_FOOT_ROW - NPC_TORSO_TOP + 3, pc)
        _put(im, 13, 9, 3, 3, gem)
    elif prop == "wand":    # 星杖：再短一截，顶端一颗星
        _put(im, 14, NPC_TORSO_TOP + 1, 1, NPC_FOOT_ROW - NPC_TORSO_TOP - 1, pc)
        _put(im, 13, NPC_TORSO_TOP - 2, 3, 2, gem)
        _put(im, 14, NPC_TORSO_TOP - 3, 1, 1, gem)
    elif prop == "pouch":   # 钱袋：挂在腰侧
        _put(im, 13, NPC_ROBE_TOP, 3, 4, pc)
        _put(im, 13, NPC_ROBE_TOP - 1, 3, 1, dark)
    elif prop == "coins":   # 手边一摞金币
        _put(im, 13, NPC_TORSO_BOT - 1, 3, 2, pc)
        _put(im, 13, NPC_TORSO_BOT - 2, 3, 1, gem)
    elif prop == "dagger":  # 短匕：斜插在腰侧
        _put(im, 13, NPC_TORSO_TOP, 2, 2, spec.get("prop_grip", dark))
        _put(im, 13, NPC_TORSO_TOP + 2, 2, 3, pc)
        _put(im, 14, NPC_TORSO_TOP + 5, 1, 1, pc)

    out = add_outline(im, INK)
    _npc_shadow(out)      # 影子必须在描边之后叠 —— 理由见 _npc_shadow
    return out


def npc_art_frames(npc_id: str) -> list[Image.Image]:
    """
    一个 NPC 的 idle 帧 —— **只有 1 帧，这是刻意的，不是漏画**。

    ## 为什么素材里不再有「呼吸帧」（2026-09-23 改）

    原先这里出 4 帧「静止 / 上身抬起 / 静止 / 上身抬起」。抬起的做法是把**上半身
    整体上移 1 行**（脚不动），再用下摆首行填住腰上让出来的那条缝。玩家连着两轮
    反馈「抖动时出现压缩，像是图层层级错了」，说的就是它。

    根因不在缝填得对不对，而在**「呼吸」被做进了素材几何**：只要在素材里把精灵
    拆成「上半身 / 下半身」两层做相对位移，那条接缝就必须有补偿 ——

      · 复制一行来填 → 腰上多出一行重复像素，读出来就是「被压了一下」；
      · 留空不填     → 躯干与下摆之间透出背景，读出来是「上下分离」；
      · 干脆整图上移 → 底部锚定下脚离地 1px，读出来是「在飘」。

    三条路都是错的，因为它们都在**改像素的形状**。

    ## 现在的分工

      素材（本函数）：只出**静止帧**，几何永远正确。
      渲染层（src/render/board.ts 的 `update()`）：让整只精灵做 1 个落屏像素的
      **刚体位移**，上半程抬起、下半程落回，各实体相位错开。

    刚体位移不改变任何像素的位置关系，「压缩」在原理上就不可能发生 ——
    这比「把缝填得更好看」高一个层次：前者是消除病因，后者是修饰症状。

    `verify_npc_art` 有一条判据钉死「帧数 == 1」，防止将来有人又把位移帧加回来。
    """
    return [_npc_base(NPC_ART[npc_id])]


def verify_npc_art(images: dict) -> list:
    """
    NPC 造型断言。**必须写成断言，不能靠眼看** —— 「六个 NPC 长得一样」这个问题
    在代码里完全看不出来（它们本来就都是「一个 16×26 的精灵」）。

    四条判据：
      1. 任意两个职能的静止帧不能逐像素相同；
      2. 剪影（实心像素集合）必须不同 —— 「同一张图换色」会被这条拦下；
      3. 实心底行必须正好落在**鞋下一行的描边**上（`NPC_FOOT_ROW + 1`）——
         精灵是底部锚定的（`anchor.set(0.5, 1)`），脚没有确定的落点就会出现
         「一只脚踩地、一只脚悬空」这种只在画面上看得见的错。
      4. **每个 NPC 的 idle 帧数必须是 1。** 呼吸归渲染层做刚体位移，
         素材里一旦又出现「上半身/下半身错位」的位移帧，压缩就会跟着回来 ——
         判据 1~3 全都看不见这件事（它们只看静止帧），所以必须单独钉一条。

    判据 3 的期望行数**不是帧底**（第 25 行）：勇者那套素材脚底下还带着
    2 行半透明影子，但身体本身也落在第 23 行（见 SOLID_ALPHA）。
    NPC 要和勇者站得一样高，就得落在同一行 —— 所以这里钉的是解剖表，
    不是「帧的最后一行为空就报错」那种想当然的写法。

    比较用 `tobytes()` 而不是 `getdata()`：后者在 Pillow 12 起被标记弃用
    （计划 Pillow 14 移除），而这个脚本每次构建都跑，警告会一直刷屏。
    """
    problems = []
    ids = list(images)

    def silhouette(im):
        alpha = im.getchannel("A").tobytes()
        return {i for i, a in enumerate(alpha) if a >= SOLID_ALPHA}

    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            fa, fb = images[a][0], images[b][0]
            if fa.tobytes() == fb.tobytes():
                problems.append(f"{a} 与 {b} 的静止帧逐像素完全相同")
            elif silhouette(fa) == silhouette(fb):
                problems.append(f"{a} 与 {b} 剪影完全相同（只换了颜色）")
    for npc_id, frames in images.items():
        if len(frames) != 1:
            problems.append(
                f"{npc_id} 出了 {len(frames)} 帧 idle —— 素材里只允许静止帧。"
                f"呼吸是渲染层的刚体位移（board.ts 的 NPC_BOB_PX），"
                f"在素材里做上下错位必然要在接缝处补偿，那就是「抖动时压缩」的来源"
            )
            continue
        base = frames[0]
        _, bottom = solid_rows(base)
        if bottom != NPC_FOOT_ROW + 1:
            problems.append(
                f"{npc_id} 的实心底行在 {bottom}，解剖表要求 {NPC_FOOT_ROW + 1}"
                f"（鞋画在第 {NPC_FOOT_ROW} 行，描边再往下占一行）—— "
                f"底部锚定下脚没踩在该在的位置，就会比勇者高一点或低一点"
            )
    return problems


def solid_core_width(im: Image.Image, y: int) -> int:
    """
    第 y 行上**含画布中心**的那一段实心像素有多宽。

    为什么不是「最左到最右的跨度」：手持物（法杖 / 钱袋 / 金币）画在身体右侧，
    描边之后会和身体的轮廓连成一片，跨度就会把道具算进「身体有多宽」里 ——
    而「身体太宽」恰恰是这条断言要抓的东西，量法不能自己把它放大。
    取「含中心的那一段」正好把独立的道具段排除在外。
    """
    px = im.load()
    cx = im.width // 2
    xs = [x for x in range(im.width) if px[x, y][3] >= SOLID_ALPHA]
    if not xs:
        return 0
    if cx not in xs:
        cx = min(xs, key=lambda v: abs(v - im.width // 2))
    lo = hi = cx
    while lo - 1 in xs:
        lo -= 1
    while hi + 1 in xs:
        hi += 1
    return hi - lo + 1


# ── 勇者身上量出来的基准值（用上面的**实心**量法，别用包围盒）──────────
#
#   · 每一帧的实心内容都占 **20 行**：朝下 / 左 / 右是 4..23，朝上的两帧是 3..22
#     —— walk 的起伏让整张精灵上下移 1 行，**高度始终是 20**。
#     （帧高 26，脚底下那 2 行是半透明影子，不算内容。见 SOLID_ALPHA 的说明。）
#   · 头（帽子 + 脸）那一段最宽 15，躯干（含手臂）14 —— **头不比身体窄**。
#   · 全图最宽 15（朝下那帧的帽子两侧）。
HERO_VISIBLE_H = 20
HERO_MAX_W = 15

# NPC 的头（发际线到下巴）主块宽度下限。
# 脸 8 宽 + 左右各 1 描边 = 10。改前是「6 宽的脸 + 描边」= 8，
# 那根又细又高的长方形就是用户说的「头上的长方形太细」。
NPC_HEAD_MIN_W = 10
# 下摆主块相对头允许超出多少。改前下摆量到 15（A 字大摆 + 手臂描边连成一片），
# 头只有 8 —— 差 7。留 2 是给「肩比头略宽」这点正常结构。
NPC_HEM_OVER_HEAD = 2


def verify_npc_scale(npc_images: dict, hero_frames: list) -> list:
    """
    NPC 必须和勇者**一样高、头身比也一样**。

    这条断言来自两次真实反馈：
      · 第一次「NPC 模型改小一点，比例适中」—— 当时 NPC 内容高 26，是勇者的 1.13 倍；
      · 第二次「NPC 的模型应该和玩家角色类似，头上的长方形太细、身体太宽」
        —— 高度对上了，**形状没对上**：头只有 6+2 宽，下摆却宽到 15。

    两次都栽在同一件事上：**「内容占几行」的量法**。
    第一版用「非透明包围盒」量勇者，把素材自带的 alpha=7 极淡边缘算了进去，
    量出 22~23，于是把 NPC 也画成 23 —— 肉眼上看还是大了一圈。
    现在一律走 `SOLID_ALPHA`（见那个常量的说明）。

    判据：
      1. 勇者自己各帧的可见高度必须一致（基准要靠它，不一致说明素材切帧变了）；
      2. 静止帧的可见行区间 == 勇者朝下那帧的行区间（4..23），高度 == 20；
      3. 若将来又出现额外的 idle 帧：脚不走（底行不变）、顶行不越过勇者的最顶行。
         ⚠️ 现在素材只有静止帧，这条一次都不进循环 —— 呼吸已经挪到渲染层
         （见 `npc_art_frames`），所以「帧数 == 1」由 `verify_npc_art` 判据 4 钉。
         留着这段是为了万一有人加回第二帧时，至少能拦住「脚离地」这一种；
      4. 头（发际线..下巴）主块宽度 ≥ `NPC_HEAD_MIN_W`；
      5. 下摆主块宽度 ≤ 头 + `NPC_HEM_OVER_HEAD`；
      6. 任意一行的可见跨度 ≤ 勇者的最宽行。

    宽度用 `solid_core_width`（含中心的那一段），理由见那个函数。
    """
    problems: list[str] = []
    if not hero_frames:
        return ["verify_npc_scale 拿不到勇者帧，无法比较比例"]

    hero_spans = [solid_rows(f) for f in hero_frames]
    hero_heights = {b - a + 1 for a, b in hero_spans}
    if len(hero_heights) != 1:
        problems.append(
            f"勇者各帧的可见高度不一致：{sorted(hero_heights)} —— 基准值要靠它，"
            f"先查切帧（真正的走起伏只挪位置、不改高度）"
        )

    def core(im, y):
        return solid_core_width(im, y)

    # 帧序是 HERO_DIRS = 朝下/右/上/左 各 4 帧，第 0 帧就是朝下（最常看到的姿态）
    ref_top, ref_bottom = hero_spans[0]
    hero_top = min(a for a, _ in hero_spans)
    hero_max_w = max(core(f, y) for f in hero_frames for y in range(f.height))

    for npc_id, frames in npc_images.items():
        base = frames[0]
        top, bottom = solid_rows(base)
        h = bottom - top + 1
        if (top, bottom) != (ref_top, ref_bottom):
            problems.append(
                f"NPC {npc_id} 静止帧可见行 {top}..{bottom}，勇者朝下那帧是 "
                f"{ref_top}..{ref_bottom} —— 同帧尺寸同倍数下这就是「谁更大」。"
                f"绘制区间应为 {NPC_ART_TOP}..{NPC_ART_FEET}（描边后即 {ref_top}..{ref_bottom}）"
            )
        elif h != HERO_VISIBLE_H:
            problems.append(f"NPC {npc_id} 可见高 {h}，勇者是 {HERO_VISIBLE_H}")

        head_w = max(core(base, y) for y in range(NPC_FACE_TOP, NPC_FACE_BOT))
        hem_w = max(core(base, y) for y in range(NPC_ROBE_TOP + 1, NPC_ROBE_BOT + 1))
        if head_w < NPC_HEAD_MIN_W:
            problems.append(
                f"NPC {npc_id} 的头只有 {head_w} 列宽（要求 ≥ {NPC_HEAD_MIN_W}）—— "
                f"脸是 {NPC_FACE_W} 宽 + 左右各 1 描边，再窄就回到「头上的长方形太细」"
            )
        if hem_w > head_w + NPC_HEM_OVER_HEAD:
            problems.append(
                f"NPC {npc_id} 下摆 {hem_w} 列宽、头才 {head_w} 列 —— 差 {hem_w - head_w}。"
                f"这就是「身体太宽」：下摆别做成 A 字大摆，与躯干同宽即可"
            )

        widest = max((core(base, y) for y in range(base.height)), default=0)
        if widest > hero_max_w:
            problems.append(
                f"NPC {npc_id} 最宽的一行 {widest} 列，勇者最宽 {hero_max_w} 列 —— 站一起会显得更大"
            )

        # 若真有额外的 idle 帧：脚不能走，头顶也不能越界（现在帧数恒为 1，不会进这里）
        for i, fr in enumerate(frames[1:], start=1):
            b_top, b_bottom = solid_rows(fr)
            if b_bottom != ref_bottom:
                problems.append(
                    f"NPC {npc_id} 第 {i} 帧底行到了 {b_bottom} —— "
                    f"底部锚定下脚离地会变成「在飘」。素材里不该有第二帧："
                    f"呼吸是渲染层的刚体位移，请改 board.ts 而不是再加素材帧"
                )
            if b_top < hero_top:
                problems.append(
                    f"NPC {npc_id} 第 {i} 帧（呼吸）顶行到了 {b_top}，超过勇者最高的 {hero_top} 行"
                )
    return problems


# ─────────────────────────────────────────────────────────────────────
# 九·B、程序化怪物造型（按**名称**画，不按手里有什么素材画）
# ─────────────────────────────────────────────────────────────────────
#
# ## 为什么必须自己画
#
# 0x72 地牢包一共 24 张角色底图（skelet / knight / imp / swampy / chort / ogre …），
# **全都是人形**——它根本没有蝙蝠、没有龙、没有乌贼、没有石头人、没有史莱姆。
# 于是第一版只能硬凑：
#
#   小蝙蝠 / 大蝙蝠 / 吸血蝙蝠  ← imp（有角的小恶魔人形）
#   魔龙                      ← chort（小鬼）
#   大乌贼                    ← swampy（绿衣人形）
#   石头人                    ← ogre（食人魔）
#   绿/红/大史莱姆、史莱姆王     ← swampy / muddy（穿绿衣的小人）
#
# 棋盘上因此出现「标着『绿史』却是个拿铲子的绿衣人」这种画面。
# **换素材解决不了**（包里没有非人形），所以改成按名称手绘 ——
# 做法与 NPC 完全一致：`_put()` 一个原语填像素块，硬边、不是矢量缩放。
#
# ## 形状与颜色分开，是为了「同形换色」这件事是显式的
#
# 史莱姆族四只是同一个形状、四套颜色（绿 / 红 / 更大 / 金冠）。
# 旧写法用 `hue_shift` 去猜（把 swampy 的绿推到红），结果是把明暗结构一起推糊了。
# 这里颜色直接写在 `PROC_MONSTERS` 的 spec 里 —— 想要什么色就是什么色。
#
# ## 一条纪律：任何一帧的底行都必须有像素
#
# 渲染层让精灵「站在脚下名牌的上沿」（board.ts: sp.anchor.set(0.5, 1)），
# 帧底留白 = 怪物浮在半空。有断言（verify_monster_fit 的 padIdle，与旧素材同一套）。

MON_W = MON_H = 32  # 手绘怪物绘制网格：相对旧版 16 翻 4 倍像素，是「更精细」的主来源（落屏尺寸不变，仍经 _mon_out 升到 64）

MON_INK = (42, 32, 40, 255)
MON_WHITE = (250, 250, 252, 255)
MON_BONE = (232, 226, 206, 255)


def _mon_canvas() -> Image.Image:
    return Image.new("RGBA", (MON_W, MON_H), (0, 0, 0, 0))


def _ell(im, cx, cy, rx, ry, color):
    """轴对齐实心椭圆（含边）。坐标可为小数，自动夹在画布内 —— 怪物造型的主力原语。

    裁剪边界取 `im.height` 而不是常量 `MON_H` —— BOSS 画在 64 网格上（`BOS_H`），
    写死 32 会让所有 BOSS 在第 32 行被**无声截断**（椭圆下半截消失）。
    32 网格上两者恒等，所以这条改动对旧素材零影响。
    """
    if ry <= 0 or rx <= 0:
        return
    y0 = max(0, int(math.floor(cy - ry)))
    y1 = min(im.height, int(math.ceil(cy + ry)) + 1)
    for y in range(y0, y1):
        dy = (y + 0.5 - cy) / ry
        if abs(dy) >= 1:
            continue
        hw = int(round(rx * math.sqrt(max(0.0, 1 - dy * dy))))
        if hw < 0:
            continue
        x0 = int(round(cx - hw))
        x1 = int(round(cx + hw))
        if x1 < x0:
            continue
        _put(im, x0, y, x1 - x0 + 1, 1, color)


def _sym(im, x, y, w, h, color):
    """
    左右镜像地填两块。

    翅膀、角、耳朵、手臂、腿这些成对结构**只写一次** ——
    手写成对坐标时最容易两边差 1px（棋盘上就是「翅膀一高一低」），
    而且改形状时必然漏掉一半。

    镜像轴取 `im.width` 而不是常量 `MON_W`，理由同 `_ell`：BOSS 画在 64 网格上，
    写死 32 会让右半边画到画布外（无声消失，左边一半孤零零）。
    """
    _put(im, x, y, w, h, color)
    _put(im, im.width - x - w, y, w, h, color)


# ⚠️ 这里**曾经**有一个 `_stamp(rows, legend)` 字符模板原语，配着 BAT_NARROW /
# BAT_WIDE / DRAGON_ROWS 三张 16 列的模板。2026-09-23 全部删掉，三条理由：
#   ① 它是 **16 网格时代**的产物，而 `MON_W` 早就提到 32 —— 三张模板的字符串
#      只有 16 个字符，喂进去会直接被 `len(row) != MON_W` 抛错。也就是说它们
#      **早就调不动了**（死代码），而注释还在讲「蝙蝠/龙用模板画」，
#      下一个人会照着改模板、改完发现毫无反应。
#   ② 「模板」和「算法」从来不是二选一：`_mon_bat` 现在用**逐列剖面表**
#      （BAT_WING_*）表达翼形，同样是「源码里看得见形状」，而且能整体缩放。
#   ③ 留着一套「形状其实不在这儿画」的注释，比没有注释更贵。

# ── 形状 ────────────────────────────────────────────────────────────
#
# 每个形状只吃 spec 里的颜色，不关心自己代表谁 —— 「皇帝史莱姆」和
# 「绿史莱姆」的差别在 spec，不在函数里。
#
# 全部形状都用 `_put` / `_sym` / `_ell` 一行行程序化生成 —— 半径、张角、椭圆
# 本来就是算法，坐标法在 32 网格上写起来比字符模板更准也更易复查。

# ── 蝙蝠的膜翼剖面表（2026-09-23 重画）──────────────────────────────
#
# 每一项是**一列**的 `(顶行, 底行)`，索引 0 = 贴着球身的肩部，
# 最后一项 = 翼尖。左翼由这张表画，右翼交给 `_sym` 镜像
# （手写成对坐标必然一边差 1px，棋盘上是「两个翅膀一高一低」）。
#
# ## 为什么是「逐列底边」而不是「几段横条」
#
# 上一版把翼画成「每列交替 `body`/`dark`」，落屏后是一根**带条纹的竖柱子**：
#   玩家在第 15 层的实拍里把它读成「羊角」，第 50 层魔王的膜翼也是同一副样子
#   （两颗品红竖条）。**竖条不构成翅膀** —— 翅膀的识别信号只有一个：
#   **底边的锯齿**（指骨把膜撑开、指骨之间的膜往上内凹）。
#
# ## 两条硬约束
#
#   · 底边相邻两列的落差必须 ≥ **3 行**。`add_outline` 是 1px 八邻域膨胀，
#     落差 1~2 行的锯齿会被描边**直接填平**，等于没画（本项目第 6 条铁律）。
#   · 顶行只能往翼尖方向**单调减小**（外高内低）—— 翼是往上扬的。
#     写成中间凹下去就变成「折翼」，剪影会读成一条蠕动的带子。
#
# ## 两个变体
#
#   NARROW：7 列，翼尖到第 2 列 —— 普通蝙蝠，翼收得紧。
#   WIDE  ：9 列，翼尖到第 0 列（贴画布边）—— 大蝙蝠 / 吸血蝙蝠，翼展明显更大。
BAT_WING_NARROW = [
    (13, 25), (12, 24), (11, 19), (10, 23), (9, 17), (8, 20), (6, 10),
]
BAT_WING_WIDE = [
    (13, 26), (12, 25), (11, 20), (10, 24), (9, 19), (8, 22), (7, 16), (6, 19), (5, 9),
]

# 哪些列是「指骨」—— 整列走 `body`（亮），膜走 `dark`（暗）。
# 亮骨架 + 暗膜是翅膀读得出来的第二层信号；全用一个色就只剩剪影。
# 索引与上面的剖面表对齐（0 = 肩）：肩 + 三个「底边凸出来的」指节。
BAT_RIB_NARROW = (0, 3, 5)
BAT_RIB_WIDE = (0, 3, 5, 7)

# 肩部贴在第几列 —— 球身在 y=17..25 最宽时占 9..23，所以肩取 9：
# 翼根正好压在球身的边缘那一列上（`body` 同色 → 看不见缝），
# 翼**看起来是从身上长出来的**而不是贴在旁边。取 8 会在肩部留 1 列空隙，
# 靠 `add_outline` 的 1px 膨胀勉强接上，但放大看是一条缝。
BAT_SHOULDER_X = 9
# 翼的顶边（前缘 / 小臂）厚度：2 行。只写 1 行会被描边吃成「白色的细线」
BAT_EDGE_H = 2

def _mon_slime(s) -> Image.Image:
    """史莱姆（DQ 风）：圆顶水滴身 + 大白眼黑瞳 + 微笑 + 左上高光 + 右下阴影；`top` 越小越「大只」。"""
    im = _mon_canvas()
    body, dark, light = s["body"], s["dark"], s["light"]
    top = s.get("top", 7)
    cx = MON_W / 2
    maxhw = 13
    # 身体：sqrt 圆顶（窄顶、宽底），底两行收一点成「脚」
    for y in range(top, MON_H):
        t = (y - top) / (MON_H - 1 - top)
        hw = int(round(maxhw * math.sqrt(max(0.0, t))))
        if y >= MON_H - 3:
            hw -= (y - (MON_H - 4))
        if hw < 1:
            hw = 1
        _put(im, int(round(cx - hw)), y, hw * 2 + 1, 1, body)
    # 底两行压暗（坐在地上）
    for y in (MON_H - 2, MON_H - 1):
        t = (y - top) / (MON_H - 1 - top)
        hw = int(round(maxhw * math.sqrt(max(0.0, t))))
        if y >= MON_H - 3:
            hw -= (y - (MON_H - 4))
        if hw < 1:
            hw = 1
        _put(im, int(round(cx - hw)), y, hw * 2 + 1, 1, dark)
    # 左上高光
    _ell(im, cx - 5, top + 6, 4, 3, light)
    # 右下阴影（身体右侧）
    for y in range(top + 10, MON_H - 1):
        t = (y - top) / (MON_H - 1 - top)
        hw = int(round(maxhw * math.sqrt(max(0.0, t))))
        if y >= MON_H - 3:
            hw -= (y - (MON_H - 4))
        if hw < 1:
            hw = 1
        _put(im, int(round(cx + hw - 3)), y, 3, 1, dark)
    # 大白眼 + 黑瞳（DQ 标志）
    _ell(im, cx - 5, top + 11, 3, 4, MON_WHITE)
    _ell(im, cx + 5, top + 11, 3, 4, MON_WHITE)
    _ell(im, cx - 5, top + 12, 1, 2, MON_INK)
    _ell(im, cx + 5, top + 12, 1, 2, MON_INK)
    # 微笑弧
    my = top + 18
    for dx in range(-3, 4):
        yy = my + (dx * dx) // 5
        _put(im, int(round(cx + dx)), yy, 1, 1, MON_INK)
    # 史莱姆王：金冠
    if s.get("crown"):
        g = s["crown"]
        _put(im, int(round(cx - 6)), max(0, top - 1), 13, 2, g)
        for sx in (int(round(cx - 6)), int(round(cx)), int(round(cx + 6))):
            _put(im, sx, max(0, top - 4), 2, 3, g)
    return im


def _mon_bat(s) -> Image.Image:
    """蝙蝠：**圆球身 + 大眼 + 尖耳 + 一对真膜翼**（DQ「德拉基」的可爱度，蝙蝠的剪影）。

    ## 这一版改了什么（2026-09-23，玩家「优化蝙蝠类怪物模型」）

    | | 上一版 | 这一版 |
    |---|---|---|
    | 翼 | 「上尖下圆的小圆叶」，逐列交替 `body`/`dark` —— 落屏是**两根带条纹的竖柱** | 逐列剖面表 `BAT_WING_*`：前缘 2 行 + **底边锯齿** + 指骨亮线 |
    | 头 | 两根直立的「呆毛」（读起来像触角） | 一对**外撇的尖耳** + 内耳亮色 —— 蝙蝠的身份记号 |
    | 身 | 球心 y=19、半径 11（与翼挤在一起） | 球心 y=21、rx=7/ry=11 —— 左右各让出 9 列给翼 |

    保留三件「可爱」特征：**球身、占脸一半的大眼、獠牙**（`fangs`）。
    `span` 换成宽翼，翼尖一直伸到画布边（大蝙蝠 / 吸血蝙蝠）。

    ## 两个画序约束（都被咬过）

    · **翼必须在球身之后画。** 翼根压在球身边上（翅膀是从身上长出来的），
      顺序反了会被球身吃掉一列，翼就「断」在半空。
    · **眼与瞳孔用 `_sym` 逐行画，不用 `_ell`。** `_ell` 以 `cx = MON_W/2 = 16`
      为心时，左右两只会差 1 列（9..15 的镜像是 8..14 而不是 17..23）——
      球身差 1px 看不出来，但两只大眼不对称是**一眼可见**的。
    """
    im = _mon_canvas()
    body, dark, light = s["body"], s["dark"], s["light"]
    wide = bool(s.get("span"))
    wing = BAT_WING_WIDE if wide else BAT_WING_NARROW
    ribs = BAT_RIB_WIDE if wide else BAT_RIB_NARROW

    # 1) 圆球身体：占画布中下 2/3，且**底行必须有像素**（底部锚定，见模块头那条纪律）
    _ell(im, 16, 21, 7, 11, body)

    # 2) 膜翼：只画左半边，右半边由 _sym 镜像（手写成对坐标必然一边差 1px）
    for i, (top, bot) in enumerate(wing):
        x = BAT_SHOULDER_X - i
        for y in range(top, bot + 1):
            # 前缘 BAT_EDGE_H 行 + 整根指骨走亮色；其余是暗色的膜 ——
            # 亮骨架在暗膜上，是剪影之外的第二层识别信号
            col = body if (i in ribs or y < top + BAT_EDGE_H) else dark
            _sym(im, x, y, 1, 1, col)

    # 3) 尖耳（外撇的三角，不是直立的触角）。耳根 5 列宽 ——
    #    上一版只有 3 列，落屏后是「一根斜线」，读不成耳朵。
    _sym(im, 10, 12, 5, 1, body)
    _sym(im, 10, 10, 5, 2, body)
    _sym(im, 10, 8, 4, 2, body)
    _sym(im, 10, 6, 3, 2, body)
    _sym(im, 10, 4, 2, 2, body)
    _sym(im, 11, 8, 2, 3, light)      # 内耳

    # 4) 大眼（逐行镜像，见上面的说明）+ 瞳孔偏内下（「呆萌」的来源）
    for dy, (x0, w) in enumerate([(10, 4), (9, 6), (9, 6), (9, 6), (10, 4)]):
        _sym(im, x0, 15 + dy, w, 1, MON_WHITE)
    _sym(im, 12, 17, 2, 2, MON_INK)

    # 5) 嘴 + 獠牙
    _put(im, 15, 24, 2, 1, MON_INK)
    if s.get("fangs"):
        _sym(im, 14, 25, 1, 3, MON_WHITE)

    # 6) 脸颊高光（球身被眼占满，高光只能落在眼下 —— 硬挪到左上会越出剪影）
    _ell(im, 11, 23, 2, 2, light)
    return im


def _mon_golem(s) -> Image.Image:
    """石头人（DQ 风）：方块头 + 发光眼 + 砖缝躯干 + 方块手臂拳头 + 短腿落地。全程直角，和生物剪影区分。"""
    im = _mon_canvas()
    face, dark, light, seam = s["body"], s["dark"], s["light"], s["seam"]
    cx = MON_W / 2
    # 头（方块，比躯干窄）
    _put(im, 10, 4, 12, 9, face)
    _put(im, 10, 4, 12, 1, light)            # 头顶高光
    _put(im, 10, 4, 1, 9, light)             # 左缘高光
    _put(im, 11, 7, 3, 3, s["glow"])         # 左眼（发光）
    _put(im, 18, 7, 3, 3, s["glow"])         # 右眼
    _put(im, 14, 12, 4, 1, dark)             # 嘴
    # 躯干（方块）
    _put(im, 7, 13, 18, 12, face)
    _put(im, 7, 13, 18, 1, light)
    # 砖缝：竖缝 + 错开横缝（立刻读成「砌起来的石头」）
    _put(im, 15, 14, 1, 11, seam)
    _put(im, 7, 17, 8, 1, seam)
    _put(im, 16, 20, 9, 1, seam)
    _put(im, 10, 16, 1, 3, seam)             # 裂缝
    _put(im, 21, 18, 1, 3, seam)
    # 手臂 + 拳头（贴躯干两侧，比躯干矮一档）
    _sym(im, 3, 14, 4, 10, dark)
    _sym(im, 3, 14, 4, 2, face)
    _sym(im, 3, 23, 4, 2, dark)              # 拳头
    # 腿（短，落地到最底行）
    _sym(im, 9, 25, 5, 7, dark)
    return im


# ── 人形怪（六个形状，22 只）：职业 × 等级 ────────────────────────────
#
# 0x72 的人形底图有两个解决不了的问题：
#   ① `knight_m/f` 源图是**像素机器人**（浅蓝方壳 + 独眼），守卫/骑士 8 只全顶着它；
#   ② 同族等级只靠换色（ramp 铁→银→金），16px 下阶差几乎不可读。
# 所以人形怪也搬进 32 网格手绘，设计语言是**两个正交维度**：
#
#   职业（你是什么兵）→ 靠**装备剪影**：枪+圆盾=守卫、大剑+鸢盾=骑士、
#     尖帽+法杖=法师、战斧+獠牙=兽人、锈剑+骨架=骷髅、兜帽+飘尾=幽魂。
#   等级（你练到几级）→ 靠**材质与覆盖度**：甲色三阶（青铜→白银→黄金）、
#     盔羽无→短→高、披风无→有、护甲覆盖度（裸骨→铁甲→金甲）。
#
# 换等级只改颜色/加一件装备，剪影骨架不动 —— 同族一眼认出「是一家人」。

_SKIN = (232, 190, 150, 255)
_WOOD = (122, 86, 48, 255)
_STEEL = (198, 204, 214, 255)

# 材质三阶（等级的通用语言）。(armor, dark, light) —— 手绘不走 ramp，直接给三档。
BRONZE_A = dict(armor=(150, 94, 46, 255), dark=(94, 56, 24, 255), light=(216, 152, 88, 255))
SILVER_A = dict(armor=(158, 164, 180, 255), dark=(96, 102, 118, 255), light=(226, 232, 244, 255))
GOLD_A = dict(armor=(216, 162, 44, 255), dark=(140, 94, 16, 255), light=(250, 216, 98, 255))
IRON_A = dict(armor=(122, 128, 140, 255), dark=(74, 78, 90, 255), light=(192, 198, 210, 255))


def _mon_soldier(s) -> Image.Image:
    """
    守卫：长枪（顶天立地杵在地上）+ 左臂圆盾 + 全盔。

    等级记号：`plume_h` 盔羽 0=无(青铜) 1=短(白银) 2=高(黄金)；甲色即材质三阶；
    `trim`/`boss` 黄金阶的金饰。枪杆落地 → 底行必有像素。
    """
    im = _mon_canvas()
    armor, dark, light = s["armor"], s["dark"], s["light"]
    # 长枪：枪尖 + 杆（y=4..31 落地）
    _put(im, 25, 0, 4, 3, s["tip"])
    _put(im, 26, 3, 2, 1, s["tip"])
    _put(im, 26, 4, 2, 28, s["shaft"])
    # 全盔：圆顶 + 盔沿 + 护鼻
    _ell(im, 15, 7, 6, 4, armor)
    _put(im, 10, 8, 11, 2, armor)
    _put(im, 9, 9, 13, 1, dark)
    _put(im, 14, 9, 3, 4, light)
    # 盔羽（等级）
    ph = s.get("plume_h", 0)
    if ph and s.get("plume"):
        _put(im, 13, 4 - ph * 2, 5, ph * 2 + 1, s["plume"])
        _put(im, 14, 3 - ph * 2, 3, ph, s["plume"])
    # 脸（盔沿下的窄条）
    _put(im, 10, 10, 11, 3, s["skin"])
    _put(im, 11, 10, 2, 2, MON_INK)
    _put(im, 18, 10, 2, 2, MON_INK)
    # 躯干甲 + 胸口金饰
    _put(im, 9, 13, 13, 9, armor)
    _put(im, 9, 13, 13, 1, light)
    _put(im, 20, 14, 2, 7, dark)
    if s.get("trim"):
        _put(im, 9, 16, 13, 1, s["trim"])
    # 腰带 + 腿 + 靴（靴到 y=31）
    _put(im, 9, 21, 13, 2, dark)
    _put(im, 15, 21, 2, 2, light)
    _put(im, 10, 23, 5, 7, dark)
    _put(im, 17, 23, 5, 7, dark)
    _put(im, 9, 29, 7, 3, armor)
    _put(im, 16, 29, 7, 3, armor)
    # 持枪的手
    _put(im, 22, 15, 5, 3, s["skin"])
    # 圆盾（左臂）：外圈 + 盾面 + 盾钉
    _ell(im, 5, 19, 5, 7, s["shield_rim"])
    _ell(im, 5, 19, 3, 5, s["shield"])
    _put(im, 4, 18, 2, 2, s.get("boss", light))
    return im


def _mon_knight(s) -> Image.Image:
    """
    重甲骑士：全盔 + 宽肩甲 + 鸢盾 + 大剑。

    职业内分工：`open=1` 露脸戴头带（剑士的轻装）、全盔为重装；
    等级记号：甲材质 + `plume` 盔羽 + `cape` 披风 + `trim` 金饰 +
    `glow` 目缝发光（暗黑骑士）。
    """
    im = _mon_canvas()
    armor, dark, light = s["armor"], s["dark"], s["light"]
    # 披风（画在身后，只露两摆）
    if s.get("cape"):
        _put(im, 3, 12, 6, 16, s["cape"])
        _put(im, 23, 12, 6, 16, s["cape"])
        _put(im, 3, 26, 6, 2, dark)
        _put(im, 23, 26, 6, 2, dark)
    # 头：全盔（T 形目缝）or 露脸（头带 + 鬓发）
    if s.get("open"):
        _put(im, 10, 4, 12, 8, s["skin"])
        _put(im, 9, 3, 14, 3, s["band"])
        _put(im, 9, 6, 2, 6, s["band"])
        _put(im, 21, 6, 2, 6, s["band"])
        _put(im, 12, 8, 2, 2, MON_INK)
        _put(im, 18, 8, 2, 2, MON_INK)
        _put(im, 14, 11, 4, 1, dark)
    else:
        _put(im, 9, 3, 14, 9, armor)
        _put(im, 9, 3, 14, 1, light)
        _put(im, 14, 5, 3, 6, dark)
        _put(im, 11, 8, 10, 2, dark)
        if s.get("glow"):
            _put(im, 11, 8, 3, 2, s["glow"])
            _put(im, 18, 8, 3, 2, s["glow"])
    # 盔羽
    if s.get("plume"):
        _put(im, 13, 0, 5, 4, s["plume"])
        _put(im, 12, 1, 2, 3, s["plume"])
    # 肩甲（宽出躯干）+ 胸甲
    _put(im, 6, 12, 6, 4, light)
    _put(im, 20, 12, 6, 4, light)
    _put(im, 8, 14, 16, 8, armor)
    _put(im, 8, 14, 16, 1, light)
    if s.get("trim"):
        _put(im, 8, 17, 16, 1, s["trim"])
        _put(im, 15, 14, 2, 8, s["trim"])
    # 腹甲 + 腿甲 + 铁靴（y=29..31 落地）
    _put(im, 10, 22, 12, 3, dark)
    _put(im, 10, 25, 5, 5, armor)
    _put(im, 17, 25, 5, 5, armor)
    _put(im, 9, 29, 7, 3, dark)
    _put(im, 16, 29, 7, 3, dark)
    # 大剑（右手直举：刃 + 护手 + 柄）
    _put(im, 26, 1, 3, 15, s["blade"])
    _put(im, 26, 1, 1, 15, light)
    _put(im, 23, 16, 9, 2, s.get("trim", light))
    _put(im, 26, 18, 3, 5, dark)
    _put(im, 24, 20, 3, 2, s.get("skin", light))
    # 鸢盾（左臂）：上宽下收尖
    if s.get("shield"):
        _put(im, 1, 12, 8, 10, s["shield"])
        _put(im, 2, 22, 6, 3, s["shield"])
        _put(im, 3, 25, 4, 2, s["shield"])
        _put(im, 1, 12, 8, 1, light)
        _put(im, 3, 15, 4, 4, light)
    return im


def _mon_mage(s) -> Image.Image:
    """
    法师：尖帽/兜帽 + A 字长袍（下摆触地）+ 法杖顶宝珠。

    职业记号：尖帽（`hat`）或兜帽（`hood`，魔卫）+ 杖顶宝珠；
    等级记号：袍色（蓝→紫→金）+ `hat_h` 帽高 + 须（男）/长发（女）+ 宝珠色。
    """
    im = _mon_canvas()
    robe, dark, light = s["robe"], s["dark"], s["light"]
    hat = s.get("hat")
    hood = s.get("hood")
    # 帽（锥形，帽尖随 hat_h 抬高）或兜帽（圆顶包脸）
    if hat:
        hh = s.get("hat_h", 1)
        apex = 4 - hh * 3
        for k, y in enumerate(range(apex, 8)):
            w = min(16, 2 + k * 2)
            _put(im, 16 - w // 2, y, w, 1, hat)
        _put(im, 7, 8, 18, 2, hat)
        _put(im, 7, 9, 18, 1, dark)
    else:
        _ell(im, 16, 9, 8, 6, hood)
        _put(im, 8, 12, 16, 2, hood)
    # 脸 + 眼
    _put(im, 11, 10, 10, 5, s["skin"])
    _put(im, 12, 11, 2, 2, MON_INK)
    _put(im, 18, 11, 2, 2, MON_INK)
    # 袍（A 字，左右缘压暗，下摆 y=29..31 触地）
    for y in range(15, 32):
        w = 12 + int(round((y - 15) / 16 * 12))
        x0 = 16 - w // 2
        _put(im, x0, y, w, 1, robe)
        _put(im, x0, y, 2, 1, dark)
        _put(im, x0 + w - 2, y, 2, 1, dark)
    _put(im, 3, 29, 26, 3, robe)
    _put(im, 3, 31, 26, 1, dark)
    if s.get("trim"):
        _put(im, 10, 19, 12, 2, s["trim"])
    # 须（男）或长发（女），画在袍之上
    if s.get("beard"):
        bl = s.get("beard_len", 0)
        _put(im, 12, 14, 8, 4 + bl, s["beard"])
        _put(im, 14, 18 + bl, 4, 2, s["beard"])
    if s.get("hair"):
        _put(im, 9, 10, 2, 7, s["hair"])
        _put(im, 21, 10, 2, 7, s["hair"])
    # 持杖的手 + 法杖（杆落地）+ 宝珠
    _put(im, 22, 18, 4, 3, s["skin"])
    _put(im, 26, 5, 2, 27, s["staff"])
    _ell(im, 27, 3, 3, 3, s["orb"])
    _put(im, 25, 1, 2, 2, light)
    return im


def _mon_orc(s) -> Image.Image:
    """
    兽人：绿皮 + 獠牙 + 尖耳，弯腰驼背的壮汉。

    职业记号：武器（`weapon`：club 木棒 / axe 战斧 / dagger 短匕）；
    等级记号：`pads` 铁肩甲、皮色深浅；`small=1` 矮化（哥布林：头大身短）。
    """
    im = _mon_canvas()
    skin, dark, light = s["skin"], s["dark"], s["light"]
    sm = 4 if s.get("small") else 0
    # 尖耳（向外上）
    _put(im, 5, 7 + sm, 3, 2, skin)
    _put(im, 4, 9 + sm, 3, 3, skin)
    _put(im, 24, 7 + sm, 3, 2, skin)
    _put(im, 25, 9 + sm, 3, 3, skin)
    # 头（宽颅 + 眉 + 大颚）+ 眼 + 獠牙
    _ell(im, 16, 10 + sm, 8, 5, skin)
    _put(im, 10, 8 + sm, 12, 1, dark)
    _put(im, 11, 9 + sm, 2, 2, s["eye"])
    _put(im, 19, 9 + sm, 2, 2, s["eye"])
    _put(im, 11, 13 + sm, 10, 3, light)
    _put(im, 12, 11 + sm, 2, 3, MON_WHITE)
    _put(im, 18, 11 + sm, 2, 3, MON_WHITE)
    # 躯干（壮）+ 肚皮 + 肩甲
    _ell(im, 16, 20 + sm, 9 - sm // 2, 6, skin)
    _ell(im, 16, 21 + sm, 5, 3, light)
    if s.get("pads"):
        _ell(im, 7, 15 + sm, 3, 3, s["pads"])
        _ell(im, 25, 15 + sm, 3, 3, s["pads"])
    # 腰带 + 腿 + 脚（y=31 触底）
    _put(im, 9, 24 + sm, 14, 2, s["belt"])
    leg_h = 4 if sm else 6
    _put(im, 11, 26 + sm, 5, leg_h, dark)
    _put(im, 17, 26 + sm, 5, leg_h, dark)
    _put(im, 10, 31, 6, 1, dark)
    _put(im, 16, 31, 6, 1, dark)
    # 武器（右手）
    wp = s.get("weapon", "club")
    if wp == "axe":
        _put(im, 26, 8, 2, 20, s["shaft"])
        _put(im, 22, 4, 8, 5, s["blade"])
        _put(im, 24, 3, 4, 2, s["blade"])
    elif wp == "dagger":
        _put(im, 27, 18, 2, 8, MON_WHITE)
        _put(im, 26, 24, 4, 2, s["belt"])
    else:
        _put(im, 26, 6, 2, 22, s["shaft"])
        _put(im, 24, 3, 6, 5, s["shaft"])
        _put(im, 23, 2, 2, 2, s["belt"])
        _put(im, 29, 4, 2, 2, s["belt"])
    return im


def _mon_skeleton(s) -> Image.Image:
    """
    骷髅：颅骨 + 肋骨 + 细骨腿 + 锈剑。

    等级记号是**护甲覆盖度**：裸骨（skeleton）→ 铁盔铁甲（soldier）→
    金盔金甲 + 圆盾（captain）。骨色不变，一眼读出「同一族练到几级」。
    """
    im = _mon_canvas()
    bone, dark = s["bone"], s["joint"]
    # 颅骨 + 眼窝 + 鼻腔 + 牙缝
    _ell(im, 15, 7, 7, 5, bone)
    _put(im, 9, 6, 13, 3, bone)
    _ell(im, 11, 7, 2, 2, MON_INK)
    _ell(im, 19, 7, 2, 2, MON_INK)
    _put(im, 14, 9, 3, 2, MON_INK)
    _put(im, 11, 12, 9, 2, bone)
    for x in (12, 15, 18):
        _put(im, x, 12, 1, 2, dark)
    # 颈 + 胸腔（肋缝 + 中缝）
    _put(im, 14, 14, 3, 1, dark)
    _put(im, 9, 15, 13, 7, bone)
    for y in (16, 18, 20):
        _put(im, 10, y, 11, 1, dark)
    _put(im, 15, 15, 1, 7, dark)
    # 护甲（等级）：盖住肋
    if s.get("armor"):
        _put(im, 8, 14, 15, 7, s["armor"])
        _put(im, 8, 14, 15, 1, s.get("trim", bone))
        if s.get("trim"):
            _put(im, 8, 18, 15, 1, s["trim"])
    # 骨盆 + 臂骨 + 腿骨 + 足（y=31 触底）
    _put(im, 10, 22, 11, 3, bone)
    _put(im, 13, 23, 5, 1, dark)
    _sym(im, 6, 15, 2, 9, bone)
    _put(im, 5, 24, 3, 2, bone)
    _put(im, 24, 24, 3, 2, bone)
    _put(im, 11, 25, 4, 6, bone)
    _put(im, 17, 25, 4, 6, bone)
    _put(im, 10, 31, 6, 1, bone)
    _put(im, 16, 31, 6, 1, bone)
    # 锈剑（右手）
    _put(im, 27, 5, 2, 14, s["blade"])
    _put(im, 25, 19, 6, 2, dark)
    _put(im, 27, 21, 2, 4, dark)
    # 盔（等级）
    if s.get("helm"):
        _ell(im, 15, 4, 7, 3, s["helm"])
        _put(im, 9, 5, 13, 1, s["helm"])
        _put(im, 8, 6, 15, 1, dark)
    # 圆盾（等级：队长）
    if s.get("shield"):
        _ell(im, 4, 18, 4, 6, s["shield"])
        _ell(im, 4, 18, 2, 4, s.get("trim", bone))
    return im


def _mon_wraith(s) -> Image.Image:
    """
    幽魂武士：尖顶兜帽 + 虚化的飘尾下摆（中尾触地）+ 幽光剑。

    `alpha` 半透明（幻影）由 mon_art_base 统一处理 —— 兜帽下是一张
    只有两只发光眼的黑脸，没有可辨认的五官，这是「已经不是人」的关键。
    """
    im = _mon_canvas()
    body, dark, light = s["body"], s["dark"], s["light"]
    # 兜帽（尖顶）
    _put(im, 13, 1, 6, 3, body)
    _put(im, 11, 3, 10, 3, body)
    _ell(im, 16, 9, 8, 5, body)
    # 脸洞 + 发光眼
    _ell(im, 16, 10, 4, 3, MON_INK)
    _put(im, 12, 9, 3, 2, s["eye"])
    _put(im, 17, 9, 3, 2, s["eye"])
    # 袍身（上宽下收）+ 胸口幽光
    _ell(im, 16, 17, 9, 6, body)
    _ell(im, 16, 16, 6, 3, light)
    _put(im, 8, 20, 16, 3, body)
    # 飘尾：三条，中长侧短（中尾 y=29..31 触底）
    _put(im, 12, 23, 8, 6, body)
    _put(im, 13, 29, 6, 3, body)
    _put(im, 7, 23, 4, 4, body)
    _put(im, 8, 27, 3, 2, dark)
    _put(im, 21, 23, 4, 4, body)
    _put(im, 21, 27, 3, 2, dark)
    # 幽光剑（右手）
    if s.get("blade"):
        _put(im, 27, 6, 2, 12, s["blade"])
        _put(im, 27, 6, 1, 12, light)
        _put(im, 25, 18, 6, 1, light)
        _put(im, 26, 19, 4, 2, dark)
    return im


# ════════════════════════════════════════════════════════════════════
# BOSS：64 网格的独立绘制体系（2026-09-23）
# ════════════════════════════════════════════════════════════════════
#
# ## 为什么 BOSS 要另开一套网格，而不是把 32 网格的造型放大
#
# ① **要更大。** 改前 8 只玩法 BOSS 里只有 4 只放大（`drawScale 0.75` → 落屏 48px），
#    另外 4 只（骷髅队长 / 骑士队长 / 吸血鬼 / 大法师）与杂兵同为 32px ——
#    「BOSS 比杂兵大」这第一眼信号，有一半的 BOSS 是缺的，而且缺的正好是前中期的。
#
# ② **要更精致，而 32 网格给不了。** 32 网格的素材落到 48px 屏上，等于把每个源像素
#    摊成 1.5 个设备像素；再往上放只是把同一批像素摊得更开 —— 超采样不创造信息
#    （本项目第 10 条铁律）。要真细节只有一个办法：**画在更大的网格上**。
#
# ③ **不能靠「画大再缩小」凑。** 64 网格画完缩到 48/56 这种非整数倍，nearest 采样下
#    每 4 列丢 1 列 —— 1px 的轮廓线会时断时续（这正是改前那 4 只大 BOSS 发糊的原因：
#    32 网格 → Scale2x 到 64 → 再缩到 48）。所以 BOSS 一律 **1:1 落屏**：
#    画在 64 网格 → 落屏 64px，零重采样，1 源像素 = 1 屏像素，
#    像素密度与杂兵完全相同，而**每个方向的信息量是杂兵的 4 倍**。
#
# ## 已知取舍（是刻意的，不是没想到）
#
# 64px 的精灵在 32px 的格子里向上溢 2 格、左右各溢半格。渲染层本来就允许 BOSS 越格
# （A5a 只卡非 BOSS），越格正是「这个东西占两格」的读法。
# **底边仍严格踩在格子下沿**：A5a 的「脚不越线」对 BOSS 同样生效，所以脚不会飘。
#
# ## 复用蝙蝠那套「膜翼」
#
# 魔王 / 魔龙的翼和蝙蝠的翼是同一个问题：**竖条不构成翅膀，底边的锯齿才构成**。
# `_wing_fan()` 把蝙蝠那两张手写剖面表换成可缩放的生成器（线性收 + 指骨下探 +
# 齿间上凹），三处共用一套语言 —— 这是「一个项目里的生物长在同一种骨骼上」。
BOS_W = BOS_H = 64
BOS_CX = BOS_W // 2

# BOSS 的落屏倍数：**恒为 1.0**，即 64 网格 1 源像素 = 1 屏像素。
#
# 为什么不做成「每只一个倍数」：64 网格画完缩到 48/56 这种非整数倍，
# nearest 采样下每 4 列丢 1 列 —— 1px 的轮廓线会时断时续。
# 要区分「谁更凶」不靠尺寸（全塔最大的两只本来就在最后一层），
# 靠的是剪影与细节密度。
BOSS_DRAW_SCALE = 1.0


def _bos_canvas() -> Image.Image:
    return Image.new("RGBA", (BOS_W, BOS_H), (0, 0, 0, 0))


def _half(im, cx, cy, rx, ry, color, up=True):
    """椭圆的**上半**或**下半** —— 头盔顶、帽檐、下颌、外套膜的底缘都用它。

    为什么不写成「画整圆再拿别的东西盖掉一半」：`add_outline` 只在**整张画布**
    的最外圈描边，两个内部形状之间是没有线的；用别的东西去盖，会把该留下的
    那半边的边界一起吃掉，读出来是「头盔没有下沿」。
    """
    if up:
        ys = range(max(0, int(cy - ry)), int(cy))
    else:
        ys = range(int(cy), min(im.height, int(math.ceil(cy + ry)) + 1))
    for y in ys:
        dy = (y + 0.5 - cy) / ry
        if abs(dy) >= 1:
            continue
        hw = int(round(rx * math.sqrt(max(0.0, 1 - dy * dy))))
        _put(im, int(round(cx - hw)), y, 2 * hw + 1, 1, color)


def _beam(im, x0, y0, x1, y1, thick, color):
    """两点之间一条**粗细均匀**的斜带 —— 角 / 尾 / 手臂 / 法杖的通用原语。

    逐行 `_put` 写斜线必然「一段粗一段细」（行距与列距不成比例），看着像竹节；
    沿参数直线密集采样、每个采样点落一块 `thick×thick`，宽度才是一致的。
    """
    n = max(1, int(max(abs(x1 - x0), abs(y1 - y0))))
    for k in range(n + 1):
        t = k / n
        _put(im, int(round(x0 + (x1 - x0) * t)), int(round(y0 + (y1 - y0) * t)),
             thick, thick, color)


def _bez(p0, p1, bow, t):
    """二次贝塞尔取点。`p0`/`p1` 是端点，`bow` 是控制点相对弦中点的横向偏移。

    存在的理由：腕上的吸盘必须落在**腕自己那条曲线上**。六条腕的弯度各不相同，
    给吸盘手写坐标必然有几颗飘在腕外（1:1 落屏后是「腕旁边有几个紫点」）。
    把它抽出来之后，`_tentacle` 与吸盘共用同一条曲线。
    """
    x0, y0 = p0
    x1, y1 = p1
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    dx, dy = x1 - x0, y1 - y0
    ln = math.hypot(dx, dy) or 1.0
    cx, cy = mx - dy / ln * bow, my + dx / ln * bow
    return ((1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t ** 2 * x1,
            (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t ** 2 * y1)


def _tentacle(im, x0, y0, x1, y1, bow, thick0, c_main, c_tip):
    """一条腕（二次贝塞尔）：粗细由 `thick0` 收到 1，末端 1/4 换 `c_tip` 色。

    `bow` 是控制点相对弦中点的**横向**偏移（正数往右弯）。用参数曲线而不是
    「逐行给一个 x」：六条腕手写坐标必然长短不一、弯度各异，而「六条对称的腕」
    恰恰是乌贼最好认的地方。
    """
    n = max(2, int(math.hypot(x1 - x0, y1 - y0)))
    for k in range(n + 1):
        t = k / n
        x, y = _bez((x0, y0), (x1, y1), bow, t)
        th = max(1, int(round(1 + (thick0 - 1) * (1 - t) ** 0.85)))
        _put(im, int(round(x)) - th // 2, int(round(y)) - th // 2, th, th,
             c_main if t < 0.72 else c_tip)


def _wing_fan(n, top0, bot0, top1, bot1, teeth, tooth):
    """膜翼剖面：n 组 `(顶行, 底行, 是否指骨)`，索引 0 = 肩、n-1 = 翼尖。

    前缘 top0→top1 线性上收、后缘 bot0→bot1 线性上收，再按 `teeth`
    做出「指骨下探 `tooth` 行 / 齿间上凹 `tooth` 行」的锯齿。

    ⚠️ `tooth ≥ 3`。`add_outline` 是 1px 八邻域膨胀，落差 1~2 行的锯齿会被
    描边**直接填平**（等于没画）。这是蝙蝠那两张手写剖面表定下的同一条约束。
    """
    prof = []
    for i in range(n):
        t = i / (n - 1) if n > 1 else 0.0
        top = int(round(top0 + (top1 - top0) * t))
        bot = int(round(bot0 + (bot1 - bot0) * t))
        if i in teeth:
            bot += tooth
        elif (i - 1) in teeth or (i + 1) in teeth:
            bot -= tooth
        prof.append((top, bot, i in teeth))
    return prof


def _wing_draw(im, x_shoulder, cols, c_rib, c_mem, edge=2, mirror=True):
    """按 `_wing_fan` 的剖面画一片翼。`c_rib` 走前缘与指骨、`c_mem` 走膜。

    `mirror=True` 时同时画关于画布中轴的镜像 —— 成对结构只写一次。
    """
    for i, (top, bot, rib) in enumerate(cols):
        x = x_shoulder - i
        for y in range(top, bot + 1):
            col = c_rib if (rib or y < top + edge) else c_mem
            if mirror:
                _sym(im, x, y, 1, 1, col)
            else:
                _put(im, x, y, 1, 1, col)


def _beam_sym(im, x0, y0, x1, y1, thick, color):
    """`_beam` 的**镜像版**：只写左半（或右半），另一半由 `_sym` 出来。

    为什么需要它：`_beam` 内部是 `_put(x, y, …)` 左对齐的，手工算「另一侧该从
    哪个 x 起笔」要写 `im.width - x - thick` —— 这正是 `_sym` 的注释里说的
    「手写成对坐标时最容易两边差 1px」。BOSS 的角 / 手臂 / 腿全是成对的斜带，
    所以补这个原语，而不是每处手算。
    """
    n = max(1, int(max(abs(x1 - x0), abs(y1 - y0))))
    for k in range(n + 1):
        t = k / n
        x = int(round(x0 + (x1 - x0) * t))
        y = int(round(y0 + (y1 - y0) * t))
        _sym(im, x - thick // 2, y - thick // 2, thick, thick, color)


def _scales(im, x0, y0, cols, rows, step, color, mirror=False):
    """错行铺的鳞片/铆钉阵：每行 `cols` 枚、共 `rows` 行，行间横向错开半格。

    这是本轮「增加细节」的主力原语。细节密度的最大杀手是**一整块纯色**
    （一整块纯色 = 每块 1 色）；铺一层错行鳞片就把同一块变成 2~3 色。
    错行（而不是方格阵）是因为方格阵在 1:1 落屏后会读成「网格纸」。
    """
    for r in range(rows):
        off = step // 2 if r % 2 else 0
        for c in range(cols):
            x, y = x0 + c * step + off, y0 + r * step
            if mirror:
                _sym(im, x, y, 2, 1, color)
            else:
                _put(im, x, y, 2, 1, color)


def _rivets(im, x0, y, n, step, color, mirror=False):
    """一排 1px 铆钉/宝石 —— 金饰边缘、甲片接缝用。"""
    for k in range(n):
        x = x0 + k * step
        if mirror:
            _sym(im, x, y, 1, 1, color)
        else:
            _put(im, x, y, 1, 1, color)


def _gem(im, cx, cy, r, color, hi=MON_WHITE):
    """菱形宝石 + 一点高光 —— 胸甲/剑格/额冠上的单点装饰。

    用菱形而不是圆：1:1 落屏后 3~5px 的圆读成一个脏点，菱形的四个尖角还留着，
    在 64 网格上是**唯一能在 4×4 块里同时给出「亮色 + 底色 + 高光」三色的形状**。
    """
    for k in range(-r, r + 1):
        w = r - abs(k)
        _put(im, cx - w, cy + k, 2 * w + 1, 1, color)
    _put(im, cx - 1, cy - r + 1, 2, 1, hi)


# ── 1. 骷髅队长（第 10 层） ─────────────────────────────────────────

def _boss_skeleton(s) -> Image.Image:
    """骷髅队长：**金盔 + 金肩甲 + 大圆盾 + 白骨长剑**，一副「守墓的百夫长」。

    识别按观看距离分三层，64 网格刚好放得下：远看是「一身金」，
    中看是「大圆盾 + 长兵器」，近看才见肋骨缝、牙缝、关节环。
    """
    im = _bos_canvas()
    bone, joint = s["bone"], s["joint"]
    armor, trim = s["armor"], s["trim"]
    blade, shield, rim = s["blade"], s["shield"], s["shield_rim"]

    # 腿：两根骨柱（膝盖套关节环），脚向外张 —— 底三行必须有像素
    #
    # ⚠️ 成对结构一律改走 `_sym`。原稿手写 `for x0 in (21, 37)`：左柱 x23..28 的
    # 镜像应该是 x35..40，而 37+2=39 —— 两条腿左右**差 4 列**，1:1 落屏后
    # 是「一只脚内八、一只脚外八」。剪影判据只看总差异像素，抓不到这种错位。
    _sym(im, 23, 46, 6, 9, bone)             # 胫骨
    _sym(im, 22, 54, 8, 2, joint)            # 踝关节环
    _sym(im, 23, 57, 6, 5, bone)
    _sym(im, 20, 60, 12, 4, bone)            # 脚掌
    _sym(im, 21, 62, 3, 2, joint)            # 趾缝
    _sym(im, 26, 62, 3, 2, joint)
    # 骨盆 + 腰甲带 + 带扣
    _ell(im, BOS_CX, 45, 11, 6, bone)
    _put(im, 26, 44, 13, 2, joint)
    _put(im, 23, 47, 19, 2, armor)
    _gem(im, BOS_CX, 48, 3, trim)
    # 脊柱 + 脊椎节 + **六对**肋骨（原为四对 —— 肋骨是这只最大的纯色块）
    _put(im, 30, 22, 4, 24, joint)
    for y in range(24, 48, 3):
        _put(im, 30, y, 4, 2, bone)
    for k, y in enumerate((23, 27, 31, 35, 39, 43)):
        w = 14 - 2 * (k // 2)
        _ell(im, BOS_CX, y + 2, w, 3, bone)
        _put(im, BOS_CX - w + 3, y + 3, 2 * w - 5, 1, joint)
    # 骨上的暗阶 + 亮阶（骨是米白，不加这两阶的话整片就是一色）
    _sym(im, 24, 33, 3, 8, joint)
    _sym(im, 28, 30, 3, 10, blade)
    # 肩甲 + 高光 + 边缘铆钉（镜像点：cx 的搭档是 63-cx，腋下写 47 会偏 1 列）
    _ell(im, 17, 28, 10, 7, armor)
    _ell(im, 46, 28, 10, 7, armor)
    _ell(im, 17, 26, 5, 3, trim)
    _ell(im, 46, 26, 5, 3, trim)
    _rivets(im, 11, 22, 3, 5, trim, mirror=True)
    # 手臂（骨）+ 肘环
    _put(im, 14, 33, 6, 13, bone)
    _put(im, 44, 33, 6, 13, bone)
    _put(im, 13, 45, 8, 5, bone)
    _put(im, 43, 45, 8, 5, bone)
    _put(im, 14, 37, 6, 2, joint)
    _put(im, 44, 37, 6, 2, joint)
    # 头盔拱顶 + 帽檐 + 冠饰（原稿三枚写 22/29/36 —— 22..24 的搭档是 39..41，
    # 36..38 是**偏 3 列**的，正面看是「歪的王冠」）
    _half(im, BOS_CX, 22, 15, 15, armor, up=True)
    _put(im, 17, 19, 31, 4, armor)
    _put(im, 17, 23, 31, 1, trim)
    _put(im, 22, 7, 21, 3, armor)
    for sx in (22, 30, 39):
        _put(im, sx, 3, 3, 5, armor)
    _put(im, 22, 7, 21, 1, trim)
    _rivets(im, 19, 20, 6, 5, trim, mirror=True)
    # 颅骨下半 + 面颊 + 下颌 + 牙缝（`_put` 宽 1 的镜像搭档是 63-x）
    _half(im, BOS_CX, 22, 12, 12, bone, up=False)
    _put(im, 22, 24, 21, 5, bone)
    _put(im, 24, 29, 17, 5, bone)
    _put(im, 26, 30, 13, 1, joint)
    for tx in (27, 31, 32, 35):
        _put(im, tx, 30, 1, 3, joint)
    # 眼窝 / 鼻腔 / 眼内红光（原稿右眼窝写 38，搭档是 63-26=37）
    _ell(im, 26, 19, 4, 5, MON_INK)
    _ell(im, 37, 19, 4, 5, MON_INK)
    _put(im, 30, 23, 5, 3, MON_INK)
    _sym(im, 26, 19, 2, 2, blade)
    # 大圆盾（画面左侧 —— 离观众近的那一侧）：辐条 + 铆钉 + 中心宝石
    _ell(im, 12, 43, 12, 14, rim)
    _ell(im, 12, 43, 10, 12, shield)
    _put(im, 2, 42, 21, 3, trim)
    _put(im, 12, 32, 1, 23, trim)
    _rivets(im, 4, 33, 4, 6, trim)
    _gem(im, 12, 43, 4, trim)
    # 白骨长剑（画面右侧，斜握）：血槽 + 剑格宝石
    _beam(im, 56, 12, 51, 48, 4, blade)
    _beam(im, 56, 13, 52, 48, 1, trim)
    _put(im, 45, 48, 14, 3, armor)
    _gem(im, 52, 50, 3, trim)
    _put(im, 49, 53, 4, 9, s["grip"])
    return im


# ── 2. 骑士队长（第 40/42 层） ─────────────────────────────────────

def _boss_knight(s) -> Image.Image:
    """骑士队长：**白银全身甲 + 金饰 + 红披风 + 金羽**，双手大剑。

    与骷髅队长共用「金」这套语言，所以识别必须落在别的地方 ——
    这只押的是**披风与羽饰的体量**：披风在 64 网格里铺开 56 列，
    「等级感」靠面积而不是靠颜色。
    """
    im = _bos_canvas()
    armor, dark, light = s["armor"], s["dark"], s["light"]
    trim, cape, blade = s["trim"], s["cape"], s["blade"]

    # 披风（最里层）：从肩到地的喇叭 + 压暗的内衬，**再在内衬上压亮褶**
    for k in range(28):
        hw = 13 + int(round(k * 0.52))
        _put(im, BOS_CX - hw, 30 + k, 2 * hw + 1, 1, cape)
    _put(im, BOS_CX - 28, 58, 57, 6, cape)
    for k in range(22):
        hw = 9 + int(round(k * 0.42))
        _put(im, BOS_CX - hw, 36 + k, 2 * hw + 1, 1, s["cape_dk"])
    # 布褶：亮暗交替的竖条（一整片纯色是这只最大的密度洼地，
    # 而且「披风的褶」本身就是骑士盔甲的读数关键 —— 没褶就是一块红布）
    for x in range(18, 47, 6):
        _put(im, x, 36, 2, 22, cape)
    # 腿甲 + 靴（压三行暗，靴底踩在格底）
    for x0 in (22, 34):
        _put(im, x0, 46, 8, 12, dark)
        _put(im, x0 + 1, 46, 3, 12, armor)
    _sym(im, 23, 47, 2, 9, light)            # 腿甲高光阶
    _put(im, 20, 58, 12, 5, armor)
    _put(im, 32, 58, 12, 5, armor)
    _put(im, 20, 60, 12, 1, dark)            # 靴甲分片
    _put(im, 32, 60, 12, 1, dark)
    _put(im, 20, 62, 12, 2, dark)
    _put(im, 32, 62, 12, 2, dark)
    # 躯干 + 胸甲 + 金色十字徽 + 中心宝石 + 上缘铆钉
    _ell(im, BOS_CX, 36, 16, 12, armor)
    _put(im, 17, 34, 31, 13, armor)
    _put(im, 17, 46, 31, 3, dark)
    _put(im, 30, 30, 5, 18, trim)
    _put(im, 23, 36, 19, 5, trim)
    _gem(im, BOS_CX, 38, 4, trim)
    _rivets(im, 19, 33, 5, 6, trim, mirror=True)
    _put(im, 17, 33, 31, 2, light)
    _sym(im, 20, 39, 4, 8, light)            # 胸甲高光阶
    # 肩甲（镜像点：cx=15 的搭档是 48，原稿写 49 是偏 1 列的）
    _ell(im, 15, 26, 10, 7, armor)
    _ell(im, 48, 26, 10, 7, armor)
    _ell(im, 15, 24, 5, 3, light)
    _ell(im, 48, 24, 5, 3, light)
    _sym(im, 12, 29, 6, 3, light)            # 肩甲下缘高光阶
    # 头盔 + 面罩（加竖缝）+ 金羽（加节）
    _ell(im, BOS_CX, 16, 13, 13, armor)
    _put(im, 19, 12, 27, 5, dark)
    _ell(im, BOS_CX, 12, 13, 7, armor)
    _put(im, 27, 13, 11, 4, s["visor"])
    _sym(im, 29, 13, 1, 4, dark)
    _sym(im, 32, 13, 1, 4, dark)
    _put(im, 30, 2, 5, 10, trim)
    _put(im, 26, 4, 13, 3, trim)
    _put(im, 30, 5, 5, 1, trim)
    _put(im, 30, 7, 5, 1, dark)
    _put(im, 30, 10, 5, 1, dark)
    # 鸢盾（左手）：上圆下尖 + 横带 + 铆钉
    _put(im, 2, 30, 18, 13, s["shield"])
    for k in range(9):
        _put(im, 3 + k, 43 + k, 16 - 2 * k, 1, s["shield"])
    _put(im, 2, 30, 18, 2, trim)
    _put(im, 10, 32, 3, 13, trim)
    _put(im, 2, 36, 18, 2, trim)
    _rivets(im, 4, 33, 4, 5, trim)
    _gem(im, 11, 41, 3, s["blade"])
    # 大剑（右手，竖握）：中线 + 剑格宝石
    _put(im, 54, 4, 5, 40, blade)
    _put(im, 54, 4, 1, 40, light)
    _put(im, 56, 6, 1, 36, light)
    _put(im, 49, 42, 15, 3, trim)
    _gem(im, 56, 44, 3, trim)
    _put(im, 55, 47, 3, 9, s["grip"])
    return im


# ── 3. 吸血鬼 ──────────────────────────────────────────────────────

def _boss_vampire(s) -> Image.Image:
    """吸血鬼：**高竖领 + 铺开的斗篷 + 苍白面孔 + 红瞳 + 獠牙**。

    与魔王要一眼分得开，所以刻意做得**不对称**：竖领左高右低、斗篷偏一侧披，
    站姿微微侧身 —— 读起来才是「一个人」，而不是「一块对称的形状」。
    """
    im = _bos_canvas()
    skin, cape, cape_in = s["skin"], s["cape"], s["cape_in"]
    eye, hair, fang, light = s["eye"], s["hair"], s["fang"], s["light"]

    # 斗篷：喇叭形，左侧多披 3 列（不对称的来源）
    for k in range(32):
        hw = 12 + int(round(k * 0.55))
        shift = -3 if k < 16 else 0
        _put(im, BOS_CX - hw + shift, 28 + k, 2 * hw + 1, 1, cape)
    _put(im, 1, 59, 62, 5, cape)
    # 内衬（暗）：胸口往上收成 V，把脸「框」出来
    for k in range(20):
        hw = 9 - int(round(k * 0.28))
        _put(im, BOS_CX - hw, 30 + k, 2 * hw + 1, 1, cape_in)
    # 斗篷褶皱：**跟着喇叭的宽度走**（写死 x 会在窄处落到斗篷外、在宽处堆在中间），
    # 只压在内衬之外的两侧 —— 内衬本来就是暗的，压上去等于没画。
    for k in range(20):
        hw = 12 + int(round((k + 12) * 0.55))
        shift = -3 if (k + 12) < 16 else 0
        for d in (8, 13):
            _put(im, BOS_CX - d + shift, 40 + k, 2, 1, cape_in)
            _put(im, BOS_CX + d - 2 + shift, 40 + k, 2, 1, cape_in)
    # 褶边的亮线（三阶化：cape / cape_in / light）—— 只压暗不提高光的话，
    # 每个 8×8 块里永远只有「底色 + 暗色」两种，细节密度卡在 2.0 上不去
    for k in range(20):
        hw = 12 + int(round((k + 12) * 0.55))
        shift = -3 if (k + 12) < 16 else 0
        for d in (8, 13):
            _put(im, BOS_CX - d + shift - 1, 40 + k, 1, 1, light)
            _put(im, BOS_CX + d + shift, 40 + k, 1, 1, light)
    # 下摆的扇形垂边
    for x in range(4, 60, 9):
        _put(im, x, 62, 5, 2, cape_in)
    # 高竖领（两片向上外撇的尖，本就一高一低）+ 领内衬亮线
    _beam(im, 20, 32, 9, 8, 6, cape)
    _beam(im, 44, 32, 55, 14, 6, cape)
    _beam(im, 9, 8, 15, 5, 4, cape)
    _beam(im, 55, 14, 49, 6, 4, cape)
    _beam(im, 22, 30, 11, 10, 2, light)
    _beam(im, 46, 30, 57, 14, 2, light)
    # 身（暗袍）+ 交叠的手臂 + 袖口 + 指爪 + 胸针
    _ell(im, BOS_CX, 46, 13, 14, cape_in)
    _put(im, 22, 42, 21, 5, light)
    _put(im, 22, 42, 21, 2, cape)
    _sym(im, 21, 41, 2, 8, cape)
    _sym(im, 21, 46, 3, 2, skin)
    _gem(im, BOS_CX, 40, 3, eye)
    # 头：苍白面孔 + 尖下颌
    _ell(im, BOS_CX, 24, 10, 11, skin)
    _put(im, 27, 33, 11, 5, skin)
    _half(im, BOS_CX, 38, 6, 5, skin, up=False)
    # 黑发 + 美人尖
    _half(im, BOS_CX, 24, 12, 12, hair, up=True)
    _put(im, 30, 22, 5, 7, hair)
    _put(im, 32, 28, 1, 5, hair)
    _put(im, 22, 16, 21, 4, hair)
    # 红瞳 + 眉毛 + 獠牙（镜像点：cx=27 的搭档是 36，原稿写 38 是偏 2 列的）
    _ell(im, 27, 24, 4, 3, MON_WHITE)
    _ell(im, 36, 24, 4, 3, MON_WHITE)
    _ell(im, 27, 24, 2, 3, eye)
    _ell(im, 36, 24, 2, 3, eye)
    _sym(im, 26, 22, 1, 1, MON_WHITE)
    _put(im, 23, 20, 9, 2, hair)
    _put(im, 32, 20, 9, 2, hair)
    _put(im, 28, 31, 9, 2, MON_INK)
    _put(im, 29, 33, 2, 4, fang)
    _put(im, 33, 33, 2, 4, fang)
    return im


# ── 4. 大法师（第 25 层） ──────────────────────────────────────────

def _boss_mage(s) -> Image.Image:
    """大法师：**高尖帽 + 金袍 + 长白须 + 大金宝珠法杖**。

    画序是这只的全部难点：法杖在身后 → 金袍 → 上身 → 白须（压在袍上）→
    脸 → 尖帽（压住发际）。顺序错一处，就是「胡子长在袍子后面」这种硬伤。
    """
    im = _bos_canvas()
    robe, dark, light = s["robe"], s["dark"], s["light"]
    hat, skin, beard = s["hat"], s["skin"], s["beard"]
    staff, orb, trim = s["staff"], s["orb"], s["trim"]

    # 法杖（最里层）+ 大金宝珠 + 杖身环纹 + 宝珠符文
    _put(im, 47, 14, 5, 50, staff)
    _put(im, 47, 14, 1, 50, light)
    _ell(im, 49, 11, 10, 10, dark)
    _ell(im, 49, 11, 8, 8, orb)
    _ell(im, 47, 8, 3, 3, (255, 250, 226, 255))
    _put(im, 43, 8, 13, 1, dark)
    _put(im, 45, 15, 9, 1, dark)
    for k in range(7):
        _put(im, 46, 20 + k * 6, 7, 1, trim)
    # 金袍：从腰到地的喇叭 + 袍褶
    #
    # ⚠️ 袍褶原来是四条**写死 x** 的竖线（13, 22, 42, 51）：既偏了 2 列
    # （13..14 的搭档是 49..50，不是 51），又在袍窄的上段落到袍外（y47 时
    # 袍只到 x16..48，x13 那条压在须和袍的边界上）。现在跟着喇叭宽度走。
    for k in range(24):
        hw = 11 + int(round(k * 0.68))
        _put(im, BOS_CX - hw, 40 + k, 2 * hw + 1, 1, robe)
    _put(im, 3, 61, 58, 3, robe)
    for k in range(18):
        hw = 11 + int(round((k + 4) * 0.68))
        for d in (5, 10, 15):
            if d < hw - 2:
                _put(im, BOS_CX - d - 1, 44 + k, 2, 1, dark)
                _put(im, BOS_CX + d - 1, 44 + k, 2, 1, dark)
        # 褶边亮线（三阶：robe / dark / light）
        for d in (3, 8, 13):
            if d < hw - 2:
                _put(im, 31 - d, 44 + k, 1, 1, light)
                _put(im, 32 + d, 44 + k, 1, 1, light)
    # 上身 + 金披肩 + 披肩铆钉
    _ell(im, BOS_CX, 38, 14, 9, robe)
    _ell(im, BOS_CX, 34, 17, 7, dark)
    _put(im, 15, 34, 35, 3, trim)
    _rivets(im, 18, 35, 5, 7, dark, mirror=True)
    # 白须（压在袍上、框住脸；从第 40 行起，正好接在下巴）+ 须缕
    for k in range(18):
        hw = 12 - int(round(k * 0.12))
        _put(im, BOS_CX - hw, 40 + k, 2 * hw + 1, 1, beard)
    _put(im, BOS_CX - 6, 58, 13, 5, beard)
    for d in (4, 9):
        _put(im, BOS_CX - d - 1, 42, 2, 18, s["beard_dk"])
        _put(im, BOS_CX + d - 1, 42, 2, 18, s["beard_dk"])
    # 脸 + 鼻 + 眼
    #
    # ⚠️ 改前脸中心在 y28、帽檐椭圆在 y27（ry=5 → 覆盖 22..32）——
    # **帽檐正压在两只眼睛上**（眼在 y26..28），落屏后是一张没有五官的脸，
    # 只剩一团白胡子。判据没拦住它（密度够、颜色够），是肉眼看出来的。
    # 现在脸下移到 y32（覆盖 22..42）、帽檐上收到 y21（覆盖 17..25），
    # 眼睛落在 y27 —— 帽檐压额发、不再压眼。
    _ell(im, BOS_CX, 32, 10, 10, skin)
    _put(im, 30, 34, 5, 3, (232, 186, 142, 255))
    _put(im, 25, 27, 3, 3, MON_INK)
    _put(im, 36, 27, 3, 3, MON_INK)
    # 尖帽：锥体 + 帽檐 + 帽带 + 带扣宝石 + 穗
    for k in range(19):
        hw = 3 + int(round(k * 0.68))
        _put(im, BOS_CX - hw, 2 + k, 2 * hw + 1, 1, hat)
    _ell(im, BOS_CX, 21, 19, 4, hat)
    _put(im, 12, 19, 41, 3, trim)
    _put(im, 13, 23, 39, 1, dark)
    _gem(im, BOS_CX, 20, 3, orb)
    _put(im, 31, 0, 3, 4, trim)
    return im


# ── 5. 大乌贼（第 15 层） ──────────────────────────────────────────

def _boss_kraken(s) -> Image.Image:
    """巨型乌贼：**纵向水滴形外套膜 + 一对侧鳍 + 两只巨眼 + 角质喙 + 六条长腕**。

    ⚠️ 改前的身体是 `_ell(rx=23, ry=20)` —— 一个**正圆**，配上同样圆的两只大眼，
    落屏后和史莱姆族是一家人（构建期断言没有拦住，因为它量的是「颜色密度」，
    不量「像不像乌贼」）。乌贼在外套膜上有两个记号，且都体现在**比例**上：

    | 记号 | 含义 | 本函数 |
    |---|---|---|
    | 纵向长（rx < ry） | 头是筒形，不是球 | rx 18 / ry 24（高比宽长 1/3） |
    | 侧鳍 | 外套膜中上部向外上伸出的一对角 | `_sym` 画的收尖三角 |

    腕也必须**明显长于身体**：改前腕只画到第 62 行、而身体占到第 46 行，
    六条腕几乎被外套膜吃掉，只剩一排小凸起 —— 这正是「读成水母」的原因之一。
    现在腕从第 40 行拉到 63（画布底），弯度也加大（bow 6~10 而不是 2~6）。
    """
    im = _bos_canvas()
    body, dark, light = s["body"], s["dark"], s["light"]
    eye, pupil = s["eye"], s["pupil"]

    # 侧鳍（最里层，向外上收尖的三角；`_sym` 保证左右一致）+ 鳍上的纹
    for k in range(12):
        _sym(im, 15 - k, 19 - k, 1, 12 - k, dark)
    for k in range(5):
        _sym(im, 13 - k, 19 - k, 1, 2, light)
    # 六条长腕（三条向左弯、三条向右弯；末梢换色收尾）
    tents = ((16, 1, 10, 8), (21, 10, 6, 8), (26, 24, -3, 8),
             (48, 63, -10, 8), (43, 54, -6, 8), (38, 40, 3, 8))
    for (x0, x1, bow, th) in tents:
        _tentacle(im, x0, 40, x1, 63, bow, th, dark, light)
    # 腕上的吸盘：**与腕共用同一条贝塞尔**（见 `_bez` 的注释）
    for (x0, x1, bow, th) in tents:
        for t in (0.32, 0.52, 0.72):
            sx, sy = _bez((x0, 40), (x1, 63), bow, t)
            _put(im, int(round(sx)), int(round(sy)), 1, 1, body)
    # 外套膜：**纵向水滴形**（rx 18 / ry 24 —— 高比宽长三分之一）+ 膜斑
    _ell(im, BOS_CX, 26, 18, 24, body)
    _scales(im, 22, 36, 5, 3, 4, dark, mirror=True)
    _scales(im, 24, 34, 4, 3, 4, light, mirror=True)
    _half(im, BOS_CX, 20, 15, 12, light, up=True)
    # 眼下压暗，把巨眼从外套膜上「抠」出来（一条横贯的暗带就够，
    # 原稿写成两条各 21 列、其中右条起自 x36 —— 与左条差 15 列，等于没压）
    _put(im, 21, 30, 22, 4, dark)
    # 两只巨眼 + 竖瞳 + 高光（镜像点：cx=22 的搭档是 41，cx=19 的搭档是 44）
    _ell(im, 22, 28, 9, 10, eye)
    _ell(im, 41, 28, 9, 10, eye)
    _ell(im, 22, 29, 5, 7, pupil)
    _ell(im, 41, 29, 5, 7, pupil)
    _ell(im, 19, 24, 3, 3, MON_WHITE)
    _ell(im, 44, 24, 3, 3, MON_WHITE)
    # 角质喙（外套膜下缘的 V 形开口）+ 下伸的钩尖
    _put(im, 26, 46, 13, 8, dark)
    for k in range(7):
        _put(im, 27 + k, 47 + k, 11 - 2 * k, 1, MON_INK)
    _put(im, 31, 52, 2, 11, MON_INK)
    return im


# ── 6. 魔龙（第 35 层） ────────────────────────────────────────────

def _boss_dragon(s) -> Image.Image:
    """魔龙：**正面朝向玩家** —— 横展双翼 + 方吻张口 + 竖瞳 + 粗腿利爪 + 甩到右下的尾。

    ## 为什么从侧视改成正面（本轮）

    改前是侧视朝左，理由是「正面龙会与魔王撞剪影」。这条理由只对了一半：
    两只撞剪影的真正原因是**共用同一套骨架**（对称的角 + 一对膜翼 + 一张脸），
    而不是「正面」本身。侧视躲开了撞车，代价是把龙的辨识度全押在**长吻**
    这一个记号上 —— 而长吻缩到 64px 后只剩几像素宽的横条，玩家读到的
    是「一只大蜥蜴」，不是龙（这也是上一轮它被改了三次形状的那个东西）。

    正面重画之后，记号改成五条**互相独立**的（任何一条单独成立就够认出来）：

    | 记号 | 内容 | 魔王有没有 |
    |---|---|---|
    | 方吻 + 张口 | 头部下半是一块比头略窄的方形，中间一道黑口 + 上下交错獠牙 | 无（魔王圆头无吻） |
    | 竖瞳 | 金底眼 + 一道**竖直**的缝 | 无（魔王是横的发光条） |
    | 颊鳍 | 头两侧向外下收的膜鳍 | 无 |
    | 甩尾 | 尾从身体右侧甩到画面右下，末端下勾 | 无（魔王不画尾） |
    | 横展翼 | 翼根在肩、**向左右外侧**展开成 T 形 | 不同（魔王翼是贴身上扬的） |

    ⚠️ 这五条**没有一条靠颜色** —— 缩到 32px 或转灰度也分得开。
    判据也换了：`verify_boss_art` ⑦ 量**头部区域的左右对称度** —— 正面朝向的头
    必然左右对称，而侧视的头偏在一边会直接报红（改前实测 39.4%，阈值 12%）。
    没有这条判据，「转成正面」只是这次改对了、下次改形状时没人拦得住。
    """
    im = _bos_canvas()
    body, wing, belly = s["body"], s["wing"], s["belly"]
    dark, eye, horn, claw = s["dark"], s["eye"], s["horn"], s["claw"]

    # ① 双翼（最里层）：翼根在肩（y30..40）、**向左右下外展开**到翼尖（y46..62）。
    #
    # ⚠️ 展开方向是本轮试出来的第二个坑。第一版照蝙蝠那样「向上外扬」，
    # 落屏后**读不出是翼**：躯干 rx=17 占了 x15..49，两侧各只剩 15 列，
    # 向上的窄膜在这 15 列里只是一根斜柱。改成**向下展开**之后：
    #   ① 可见面积大（外侧 15 列 × 纵向 30 行都是膜）；
    #   ② 与魔王的「贴身上扬膜翼」正好相反，剪影差异反而更大；
    #   ③ 正面龙两翼下垂护体，本身就是这类生物的经典站姿。
    _wing_draw(im, 26, _wing_fan(21, 30, 40, 46, 62, (0, 5, 10, 15, 20), 5),
               body, wing, edge=3, mirror=True)
    # 翼膜上的暗斑（膜不能是一整块纯色）+ 翼尖的钩爪
    _sym(im, 10, 46, 3, 2, dark)
    _sym(im, 13, 55, 3, 2, dark)
    _sym(im, 6, 58, 4, 5, claw)
    # ② 尾：从身体右侧甩出，末端收成箭尖（正面龙唯一伸到画面右缘的细结构）
    _beam(im, 44, 44, 61, 48, 5, body)
    _beam(im, 61, 48, 53, 57, 4, body)
    for k in range(4):
        _put(im, 47 + k, 52 + k, 9 - 2 * k, 1, dark)
    # ③ 腿 + 脚 + 每脚三只爪（爪踩在最后一行 —— 底行必须有像素）
    #
    # ⚠️ 爪的左右坐标是**镜像算出来的**（镜像轴 x=31.5，所以 15..18 的搭档是 45..48），
    # 不是「另一只脚从 31 起步」—— 手写成对坐标差了 2 列，1:1 落屏后就是
    # 「两只脚的爪不对称」，而这种 1px 级的错位肉眼极难定位。
    for x0 in (17, 34):
        _put(im, x0, 50, 13, 10, body)
        _put(im, x0 - 2, 58, 17, 5, body)
    for k in range(3):
        _put(im, 15 + k * 6, 61, 4, 3, claw)
        _put(im, 45 - k * 6, 61, 4, 3, claw)
    # 腿鳞（错行）—— 一整块纯色是细节密度最大的杀手
    _scales(im, 18, 49, 3, 3, 4, dark, mirror=True)
    # ④ 躯干：**宽胸 + 收腰**（两段叠加），腹甲从中线一条铺下来
    #
    # 单一椭圆（rx=ry）落屏后读成「甲虫的圆壳」—— 兽形靠的是轮廓起伏。
    _ell(im, 32, 38, 18, 11, body)
    _ell(im, 32, 47, 15, 9, body)
    _ell(im, 32, 46, 11, 12, belly)
    for k in range(4):
        _put(im, 24, 40 + k * 4, 17, 1, dark)
    # 三阶化：躯干两侧压暗、中线提亮（只有两阶的色块在 8×8 尺度上永远只有 2 色）
    _sym(im, 15, 34, 4, 12, wing)
    _sym(im, 20, 12, 3, 6, wing)
    _put(im, 30, 32, 4, 5, belly)
    # ⑤ 颈（两侧对称压暗）
    _put(im, 26, 27, 13, 12, body)
    _sym(im, 26, 27, 3, 12, dark)
    # ⑥ 头盖（比躯干窄）+ 颊鳍
    _ell(im, 32, 16, 14, 12, body)
    for k in range(6):
        _sym(im, 17 - k, 18 + k, 2, 9 - k, dark)
    # ⑦ 方吻：**比头窄**（x25..39 vs 头盖 x18..46）—— 这一步是「楔形头」的全部，
    #    第一版把吻做成与头齐宽，1:1 落屏后读出来是「一张圆脸 + 一张大嘴」，
    #    仍然是「放大的杂兵」，不是龙。
    _put(im, 25, 21, 15, 11, body)
    _put(im, 25, 21, 15, 1, belly)           # 吻背亮线：头与吻的分界
    _put(im, 26, 25, 13, 5, MON_INK)         # 口腔
    for x in (27, 31, 34):                   # 上獠牙（朝下）
        _put(im, x, 25, 3, 3, claw)
    for x in (29, 32):                       # 下獠牙（朝上）
        _put(im, x, 28, 3, 2, claw)
    _put(im, 27, 22, 3, 2, MON_INK)          # 鼻孔
    _put(im, 34, 22, 3, 2, MON_INK)
    # ⑧ 眼 + **竖瞳** + 眉脊 + 额脊（右眼中心 = 63-25 = 38）
    _ell(im, 25, 14, 6, 5, eye)
    _ell(im, 38, 14, 6, 5, eye)
    _put(im, 24, 10, 3, 9, MON_INK)
    _put(im, 37, 10, 3, 9, MON_INK)
    _sym(im, 18, 7, 13, 2, dark)
    _put(im, 31, 6, 2, 7, dark)              # 额脊：跨镜像轴 2px，天然对称
    # ⑨ 双角：从头顶两侧向上外弯（比魔王那对短而粗、**只有一段**）+ 环纹
    _beam_sym(im, 23, 8, 17, 0, 6, horn)
    _sym(im, 18, 4, 5, 1, dark)
    _sym(im, 20, 8, 6, 1, dark)
    # ⑩ 肩刺
    _beam_sym(im, 21, 32, 14, 25, 4, horn)
    return im


# ── 7. 魔王 / 真魔王（第 50 层 / 终局） ─────────────────────────────

def _boss_demon(s) -> Image.Image:
    """魔王：**对称的巨角 + 膜翼 + 发光眼 + 胸甲**；`true_form` 换成真身剪影。

    ## 普通魔王与真身必须是两个能一眼分开的剪影

    `verify_boss_art` 判据 ⑤（轮廓差异像素 ≥ 400）在改前**报红**：
    两只魔王只差 199 像素 —— 因为它们是**同一个骨架 + 一顶王冠**，
    玩家看到的读法是「同一个魔王换了颜色」，而不是「我打到了真身」。
    断言是这个函数今天被改写的唯一原因。

    所以真身走另一套骨架：

    |        | 普通魔王 | 真身 |
    |---|---|---|
    | 膜翼   | 身侧扬起，翼尖到第 4 行 | **高举过头**，翼尖顶到第 0 行、展幅更宽 |
    | 巨角   | 外弯两段 | **外弯三段**，伸到画布左右边缘 |
    | 手臂   | 垂在身侧 | **斜向上举**（战斗姿态） |
    | 下盘   | 并腿站立 | **双腿张开** |
    | 头饰   | 无 | 金冠 + 冠顶白高光 |

    这五行**没有一行是靠颜色** —— 剪影差异全部来自形体，缩到 32px 甚至
    灰度看也分得开。

    与魔龙的分工写在 `_boss_dragon` 里：这只走**对称 + 正面**，两只不撞剪影。
    膜翼沿用蝙蝠那套剖面法 —— 魔王张开的是**两片膜**，不是两根带条纹的柱子
    （改前就是这个毛病：两颗品红竖条，玩家读成「门帘」）。
    """
    im = _bos_canvas()
    body, dark, light = s["body"], s["dark"], s["light"]
    glow, horn, plate = s["glow"], s["horn"], s["plate"]
    true_form = bool(s.get("true_form"))

    # 膜翼（最里层，左右各一片）
    if true_form:
        # 高举的巨翼：肩 y18..50 → 翼尖 y0..30，比普通魔王高出一倍
        _wing_draw(im, 20, _wing_fan(17, 18, 50, 0, 30, (0, 5, 10, 15), 6),
                   light, dark, edge=3, mirror=True)
    else:
        _wing_draw(im, 18, _wing_fan(15, 24, 46, 4, 24, (0, 4, 8, 12), 5),
                   light, dark, edge=3, mirror=True)
    # 翼膜斑（膜上不能只有三根指骨 —— 一整片纯色是细节密度最大的杀手）
    _sym(im, 12, 30, 4, 2, dark)
    _sym(im, 9, 26, 3, 2, dark)
    # 腿（粗壮，踩在格底）+ 腿甲分片 + 脚爪
    #
    # ⚠️ 成对结构统一改走 `_sym`。原稿是两行手写坐标，腿（16/38）**碰巧**对了，
    # 但同一段里的脚掌（14/37）与分片（18/…）各错各的 —— 同一个函数里
    # 「一半对、一半差 1 列」比全错更难查。镜像点恒为 63-cx。
    if true_form:
        # 真身站得更开 —— 下盘一宽，整个剪影就与「并腿站着」的普通魔王不同
        _sym(im, 16, 52, 10, 10, body)
        _sym(im, 14, 60, 13, 4, dark)
        _sym(im, 18, 56, 7, 1, dark)          # 腿甲分片
        _sym(im, 16, 60, 5, 3, horn)          # 脚爪
    else:
        _sym(im, 20, 52, 10, 10, body)
        _sym(im, 18, 60, 13, 4, dark)
        _sym(im, 22, 56, 7, 1, dark)
        _sym(im, 20, 60, 5, 3, horn)
    # 腹甲横排（两腿之间的躯干下缘）
    for k in range(3):
        _put(im, 26, 54 + k * 3, 13, 1, dark)
    # 躯干 + 胸甲 + 上缘铆钉 + 发光徽（徽外再套一圈亮环）
    _ell(im, BOS_CX, 46, 17, 15, body)
    _ell(im, BOS_CX, 44, 14, 12, plate)
    _put(im, BOS_CX - 14, 40, 29, 4, light)
    _rivets(im, 20, 39, 4, 8, light, mirror=True)
    _ell(im, BOS_CX, 46, 8, 9, light)
    _ell(im, BOS_CX, 46, 5, 6, glow)
    _ell(im, BOS_CX, 46, 2, 3, MON_WHITE)
    # 三阶化：躯干两侧与腿上的高光条（躯干是整片 body 纯色，只压暗不出效果）
    _sym(im, 20, 48, 4, 6, light)
    _sym(im, 22, 54, 3, 4, light)
    # 手臂
    if true_form:
        # 斜向上举的粗臂（斜带而非竖条 —— 竖条会和翼的指骨混成一片）。
        # 原稿写右手 `_beam(42,42 → 56,22)`，而左手的镜像起点是 35..41 不是 42..48
        # —— 两只手臂**差 7 列**，落屏后是「一只举手、一只搭在腰上」。
        _beam_sym(im, 22, 42, 8, 22, 7, dark)
    else:
        _sym(im, 12, 36, 7, 14, dark)
    # 巨角（骨色，向外上弯）+ 环纹
    if true_form:
        # 两段、末端伸到画布左右边缘 —— `_beam_sym` 只写左半
        _beam_sym(im, 26, 26, 10, 8, 6, horn)
        _beam_sym(im, 22, 16, 4, 0, 5, horn)
    else:
        _beam_sym(im, 24, 24, 12, 6, 6, horn)
        _beam_sym(im, 22, 16, 8, 2, 5, horn)
    _sym(im, 19, 20, 5, 1, dark)
    _sym(im, 18, 13, 5, 1, dark)
    # 头 + 发光眼 + 獠牙（原稿右眼写 34、右瞳写 38、獠牙写 37 —— 分别偏 1、1、2 列）
    _ell(im, BOS_CX, 24, 13, 13, body)
    _ell(im, BOS_CX, 20, 11, 8, dark)
    _sym(im, 23, 22, 8, 4, glow)
    _sym(im, 24, 23, 3, 2, MON_INK)
    _put(im, 26, 31, 13, 3, MON_INK)
    _sym(im, 27, 34, 2, 4, MON_WHITE)
    _put(im, 31, 34, 2, 4, MON_WHITE)
    # 王冠（真身专属）+ 冠顶嵌宝石
    if s.get("crown"):
        _put(im, 21, 8, 23, 4, s["crown"])
        for sx in (21, 29, 39):
            _put(im, sx, 2, 4, 6, s["crown"])
        _put(im, 21, 8, 23, 1, MON_WHITE)
        _gem(im, BOS_CX, 5, 3, s["crown"], MON_WHITE)
    return im


BOSS_SHAPES = {
    "skeletonBoss": _boss_skeleton,
    "knightBoss": _boss_knight,
    "vampireBoss": _boss_vampire,
    "mageBoss": _boss_mage,
    "krakenBoss": _boss_kraken,
    "dragonBoss": _boss_dragon,
    "demonBoss": _boss_demon,
}

# BOSS 的配色表。与 `PROC_MONSTERS` **刻意分开**：那张表是「同形状可成族换色」
# （守卫/骑士/法师各成一族），这张是「八只各一套」—— BOSS 之间不共享骨架，
# 把两者混在一张表里会让「换色」这个概念失去边界。
PROC_BOSSES = {
    "skeletonCaptain": dict(
        shape="skeletonBoss", bone=(240, 234, 214, 255), joint=(148, 136, 116, 255),
        armor=(216, 162, 44, 255), trim=(250, 216, 98, 255),
        blade=(226, 232, 244, 255), shield=(196, 148, 42, 255),
        shield_rim=(118, 80, 16, 255), grip=(104, 66, 34, 255)),
    "knightCaptain": dict(
        shape="knightBoss", **SILVER_A,
        trim=(250, 216, 98, 255), cape=(148, 32, 40, 255), cape_dk=(96, 18, 26, 255),
        blade=(226, 232, 244, 255), shield=(110, 116, 132, 255),
        visor=(30, 34, 46, 255), grip=(104, 66, 34, 255)),
    "vampire": dict(
        shape="vampireBoss", skin=(240, 228, 226, 255), cape=(58, 32, 72, 255),
        cape_in=(30, 18, 40, 255), light=(120, 74, 140, 255), eye=(226, 40, 54, 255),
        hair=(24, 18, 30, 255), fang=(252, 252, 252, 255)),
    "archmage": dict(
        shape="mageBoss", robe=(196, 148, 42, 255), dark=(128, 88, 18, 255),
        light=(248, 214, 106, 255), skin=(238, 200, 160, 255), hat=(160, 116, 28, 255),
        beard=(250, 250, 246, 255), beard_dk=(196, 196, 190, 255), staff=(122, 86, 48, 255),
        orb=(252, 226, 92, 255), trim=(252, 234, 142, 255)),
    "kraken": dict(
        shape="krakenBoss", body=(132, 78, 176, 255), dark=(74, 38, 112, 255),
        light=(186, 140, 226, 255), eye=(250, 242, 206, 255), pupil=(36, 20, 50, 255)),
    "dragon": dict(
        shape="dragonBoss", body=(198, 62, 52, 255), wing=(104, 30, 38, 255),
        belly=(238, 200, 128, 255), dark=(62, 18, 22, 255), eye=(250, 216, 96, 255),
        horn=(232, 226, 206, 255), claw=(246, 242, 232, 255)),
    "demonKing": dict(
        shape="demonBoss", body=(146, 62, 150, 255), dark=(84, 30, 92, 255),
        light=(202, 122, 206, 255), glow=(252, 226, 92, 255),
        horn=(232, 226, 206, 255), plate=(58, 22, 66, 255)),
    # true_form=True 让真身换一整套骨架（高举巨翼 / 三段长角 / 斜举双臂 / 张腿）——
    # 只加王冠的话，两者的轮廓只差 199 像素，构建期断言（verify_boss_art ⑤）会报红
    "demonKingTrue": dict(
        shape="demonBoss", true_form=True, body=(186, 34, 40, 255), dark=(104, 14, 20, 255),
        light=(240, 96, 88, 255), glow=(252, 226, 92, 255),
        horn=(232, 226, 206, 255), plate=(74, 12, 18, 255), crown=(250, 214, 84, 255)),
}


def boss_art_base(bid: str) -> Image.Image:
    """一只 BOSS 的静止帧（**64 网格**，1:1 落屏）。描边语言与杂兵完全一致。"""
    spec = dict(PROC_BOSSES[bid])
    shape = BOSS_SHAPES[spec.pop("shape")]
    return add_outline(shape(spec), MON_INK)


def boss_art_frames(bid: str) -> list[Image.Image]:
    """BOSS 的 idle 帧 —— 与杂兵同理，**只有 1 帧**（呼吸在渲染层的刚体位移）。"""
    return [boss_art_base(bid)]


MON_SHAPES = {
    "slime": _mon_slime,
    "bat": _mon_bat,
    "golem": _mon_golem,
    "soldier": _mon_soldier,
    "knight": _mon_knight,
    "mage": _mon_mage,
    "orc": _mon_orc,
    "skeleton": _mon_skeleton,
    "wraith": _mon_wraith,
}

# 哪些怪物按名称手绘。键必须出现在 MONSTERS 里（有断言拦漏网）。
#
# 颜色一律写在 spec 里，不再用 hue_shift 去推 —— 推出来的色会连明暗结构
# 一起偏（旧版把 swampy 的绿推成红，结果是一团脏红）。
PROC_MONSTERS = {
    # 史莱姆族：绿 → 红 → 大 → 王（王的冠与「更大」都改剪影，不只是换色）
    "greenSlime": dict(shape="slime", body=(74, 196, 92, 255), dark=(32, 116, 50, 255),
                       light=(158, 236, 166, 255), top=6),
    "redSlime":   dict(shape="slime", body=(224, 84, 72, 255), dark=(146, 34, 30, 255),
                       light=(252, 156, 138, 255), top=6),
    "bigSlime":   dict(shape="slime", body=(58, 170, 86, 255), dark=(24, 96, 44, 255),
                       light=(134, 216, 142, 255), top=3),
    "slimeKing":  dict(shape="slime", body=(236, 198, 66, 255), dark=(158, 114, 18, 255),
                       light=(252, 234, 142, 255), top=3, crown=(250, 220, 96, 255)),
    # 蝙蝠族：窄翼 → 宽翼 → 宽翼 + 獠牙
    "bat":        dict(shape="bat", body=(128, 94, 66, 255), dark=(70, 48, 34, 255),
                       light=(182, 142, 106, 255)),
    "bigBat":     dict(shape="bat", body=(90, 64, 44, 255), dark=(46, 30, 20, 255),
                       light=(140, 104, 74, 255), span=1),
    "vampireBat": dict(shape="bat", body=(170, 52, 56, 255), dark=(96, 20, 26, 255),
                       light=(228, 104, 104, 255), span=1, fangs=1),
    "stoneGolem": dict(shape="golem", body=(126, 122, 120, 255), dark=(78, 74, 74, 255),
                       light=(182, 178, 174, 255), seam=(58, 54, 54, 255),
                       glow=(248, 168, 64, 255)),
    # ⚠️ 这里**没有** 8 只 BOSS（dragon / kraken / vampire / demonKing / demonKingTrue /
    # skeletonCaptain / knightCaptain / archmage）—— 它们全部搬到 64 网格的
    # `PROC_BOSSES` 去了。一张表同时装「32 网格的杂兵」和「64 网格的 BOSS」，
    # 会让所有按 `MON_W`/`MON_H` 写的判据（剪影互不相同、底行有像素、帧数=1）
    # 在 BOSS 上**静默量错网格** —— 那比报错难查得多。
    # ── 人形怪（14 只）：0x72 的人形底图读不出职业与等级 ──────────────
    # knight_m/f 源图是像素机器人（浅蓝方壳 + 独眼），守卫/骑士 8 只全顶着它；
    # 同族等级只靠换色，16px 下阶差不可读。搬进 32 网格手绘：
    #   职业 = 装备剪影（枪盾/剑盾/法杖/战斧/锈剑/幽光剑），
    #   等级 = 材质三阶（青铜→白银→黄金）+ 羽饰/披风/护甲覆盖度。
    # 守卫族：青铜无羽 → 白银短羽 → 黄金高羽 + 金饰金盾钉
    "juniorGuard": dict(shape="soldier", **BRONZE_A, skin=_SKIN,
                        shield=(150, 108, 60, 255), shield_rim=(94, 56, 24, 255),
                        shaft=_WOOD, tip=_STEEL, plume_h=0),
    "midGuard":    dict(shape="soldier", **SILVER_A, skin=_SKIN,
                        shield=(58, 96, 168, 255), shield_rim=(30, 48, 96, 255),
                        shaft=_WOOD, tip=_STEEL, plume=(198, 48, 48, 255), plume_h=1),
    "seniorGuard": dict(shape="soldier", **GOLD_A, skin=_SKIN,
                        shield=(216, 162, 44, 255), shield_rim=(140, 94, 16, 255),
                        boss=(252, 234, 142, 255), trim=(252, 234, 142, 255),
                        shaft=_WOOD, tip=_STEEL, plume=(198, 48, 48, 255), plume_h=2),
    # 骑士族：剑士露脸轻装 → 铁甲战士 → 蓝钢骑士（红羽）→ 白银骑士长（金饰披风）→ 暗黑骑士
    "swordsman":     dict(shape="knight", armor=(172, 122, 62, 255), dark=(110, 74, 32, 255),
                          light=(226, 178, 108, 255), open=1, skin=_SKIN,
                          band=(198, 48, 48, 255), blade=_STEEL),
    "warrior":       dict(shape="knight", **IRON_A, shield=(96, 102, 118, 255), blade=_STEEL),
    "knight":        dict(shape="knight", armor=(58, 96, 168, 255), dark=(30, 52, 104, 255),
                          light=(120, 164, 228, 255), plume=(198, 48, 48, 255),
                          shield=(46, 74, 140, 255), blade=_STEEL),
    "darkKnight":    dict(shape="knight", armor=(44, 40, 54, 255), dark=(22, 20, 30, 255),
                          light=(96, 92, 112, 255), glow=(240, 62, 54, 255),
                          cape=(58, 32, 72, 255), shield=(34, 30, 44, 255),
                          blade=(150, 152, 168, 255)),
    # 法师族：蓝袍学徒 → 紫袍资深（帽更高 + 宝珠）→ 金袍大法师（长白须 + 金宝珠）；
    # 女法师同阶换长发；魔卫 = 青袍兜帽（无檐）
    "juniorMage":   dict(shape="mage", robe=(58, 96, 190, 255), dark=(32, 56, 122, 255),
                         light=(120, 164, 228, 255), skin=_SKIN, hat=(46, 76, 160, 255),
                         hat_h=1, beard=(238, 236, 228, 255), staff=_WOOD,
                         orb=(96, 156, 246, 255)),
    "seniorMage":   dict(shape="mage", robe=(128, 62, 178, 255), dark=(78, 32, 118, 255),
                         light=(190, 130, 228, 255), skin=_SKIN, hat=(96, 44, 140, 255),
                         hat_h=2, beard=(244, 242, 236, 255), staff=_WOOD,
                         orb=(214, 62, 200, 255), trim=(240, 202, 84, 255)),
    "juniorWizard": dict(shape="mage", robe=(58, 96, 190, 255), dark=(32, 56, 122, 255),
                         light=(120, 164, 228, 255), skin=_SKIN, hat=(46, 76, 160, 255),
                         hat_h=1, hair=(150, 96, 40, 255), staff=_WOOD,
                         orb=(96, 156, 246, 255)),
    "seniorWizard": dict(shape="mage", robe=(128, 62, 178, 255), dark=(78, 32, 118, 255),
                         light=(190, 130, 228, 255), skin=_SKIN, hat=(96, 44, 140, 255),
                         hat_h=2, hair=(150, 96, 40, 255), staff=_WOOD,
                         orb=(214, 62, 200, 255), trim=(240, 202, 84, 255)),
    "magicGuard":   dict(shape="mage", robe=(44, 142, 132, 255), dark=(22, 88, 82, 255),
                         light=(110, 202, 188, 255), skin=_SKIN, hood=(28, 104, 96, 255),
                         staff=_WOOD, orb=(96, 226, 206, 255)),
    # 兽人族：木棒兽人 → 铁肩甲战斧武士 → 矮身短匕哥布林
    "orc":        dict(shape="orc", skin=(96, 156, 74, 255), dark=(52, 96, 40, 255),
                       light=(150, 204, 118, 255), eye=(232, 62, 48, 255),
                       belt=(110, 74, 36, 255), weapon="club", shaft=_WOOD, blade=_STEEL),
    "orcWarrior": dict(shape="orc", skin=(64, 120, 56, 255), dark=(34, 74, 32, 255),
                       light=(112, 172, 96, 255), eye=(240, 80, 40, 255),
                       belt=(74, 50, 26, 255), weapon="axe", shaft=_WOOD,
                       blade=(176, 180, 192, 255), pads=(122, 128, 140, 255)),
    "goblin":     dict(shape="orc", skin=(122, 172, 84, 255), dark=(70, 110, 48, 255),
                       light=(178, 216, 132, 255), eye=(226, 190, 60, 255),
                       belt=(96, 66, 32, 255), weapon="dagger", small=1),
    # 骷髅族：裸骨锈剑 → 铁盔铁甲 → 金盔金甲 + 圆盾（覆盖度即等级）
    "skeleton":        dict(shape="skeleton", bone=(232, 226, 206, 255),
                            joint=(140, 128, 108, 255), blade=(148, 118, 82, 255)),
    "skeletonSoldier": dict(shape="skeleton", bone=(238, 232, 212, 255),
                            joint=(146, 134, 114, 255), armor=(122, 128, 140, 255),
                            trim=(192, 198, 210, 255), helm=(122, 128, 140, 255),
                            blade=(198, 204, 214, 255)),
    # 亡灵：幽魂武士（青白 + 幽光剑）→ 幻影（同形换紫 + 半透明）
    "ghostWarrior": dict(shape="wraith", body=(196, 226, 232, 255), dark=(120, 168, 184, 255),
                         light=(238, 250, 252, 255), eye=(96, 210, 226, 255),
                         blade=(170, 226, 238, 255)),
    "phantom":      dict(shape="wraith", body=(150, 96, 190, 255), dark=(92, 52, 128, 255),
                         light=(204, 150, 232, 255), eye=(226, 120, 250, 255),
                         alpha=0.72),
}


def mon_art_base(art_id: str) -> Image.Image:
    """画一帧静止姿态（32 网格），收尾统一补描边 —— 与整套素材的描边语言一致。

    spec 里的 `alpha`（幻影的半透明）在描边**之后**整体乘 —— 先乘再描边会把
    描边也变淡，怪物在棋盘上会「糊」进背景。
    """
    spec = dict(PROC_MONSTERS[art_id])
    shape = MON_SHAPES[spec.pop("shape")]
    alpha = spec.pop("alpha", None)
    im = add_outline(shape(spec), MON_INK)
    if alpha is not None:
        im = alpha_mul(im, alpha)
    return im


def mon_art_frames(art_id: str) -> list[Image.Image]:
    """
    怪物的 idle 帧 —— **只有 1 帧**，理由与 `npc_art_frames` 完全相同。

    这里原先的 `_mon_squash` 比 NPC 那边错得更明显：它把整只怪上移 2 行、
    再把最底 2 行复制到底部（想做出「脚不离地」）。但手绘怪物的内容本来就
    **顶在第 0 行**（kraken / knight / wraith 实测 base 内容区间是 0..31，
    画布 32 行全满），上移 2 行 = **头顶被画布裁掉 2 行**，而底部又长出 2 行
    重复的腿根 —— 一裁一补，读出来就是「整只怪被压扁了一截」。

    实测数据（改前）：
        kraken / knight / ghostWarrior   base 内容 (0,31) → breathe 仍 (0,31)
        dragon / vampire                 base 内容 (2,31) → breathe (0,31)
    顶到 0 的那几只每一轮呼吸都掉 2 行头顶，正是玩家说的「抖动时压缩」。

    现在素材只出静止帧，呼吸在渲染层做刚体位移（board.ts 的 `MONSTER_BOB_PX`）。
    """
    return [mon_art_base(art_id)]


def verify_mon_art(frames: dict[str, list[Image.Image]]) -> list:
    """
    程序化怪物造型断言。五条判据，全是「代码里看不出来、只有量才知道」的：

      1. **每个形状的剪影互不相同** —— 抓「画了半天结果都是同一个圆」；
      2. **同形状的变体必须有区别** —— 抓「换色没生效 / 两只一模一样」；
      3. **底行必须有像素** —— 底部锚定下帧底留白 = 怪物浮在半空；
      4. **每个形状至少有一只怪在用它** —— 抓「画了却忘了接进 PROC_MONSTERS」；
      5. **每只怪只出 1 帧 idle** —— 理由与 NPC 判据 4 同：呼吸归渲染层做刚体
         位移。手绘怪物的内容本来就顶到画布第 0 行，素材里再做「上移 + 补底」
         就是**裁头顶**（实测 kraken/knight/wraith 每轮掉 2 行），
         那正是玩家报的「抖动时压缩」。判据 1~4 全都看不见这件事。

    与 NPC 的断言刻意分开：NPC 是「六个各不相同」，怪物是「七种形状、同形状可成族换色」——
    两边的判据不一样，所以不能共用一个函数。
    """
    problems: list[str] = []
    bases = {k: v[0] for k, v in frames.items()}

    def sil(im: Image.Image):
        a = im.getchannel("A").tobytes()
        return {i for i, v in enumerate(a) if v > 8}

    for art_id, fs in frames.items():
        if len(fs) != 1:
            problems.append(
                f"怪物 {art_id} 出了 {len(fs)} 帧 idle —— 素材里只允许静止帧。"
                f"手绘怪物的内容顶满画布（顶行 0），在素材里上下错位只会裁掉头顶、"
                f"补出重复的腿根，读出来就是「压缩」。呼吸请改 board.ts 的 MONSTER_BOB_PX"
            )

    by_shape: dict[str, list[str]] = {}
    for art_id, spec in PROC_MONSTERS.items():
        by_shape.setdefault(spec["shape"], []).append(art_id)

    used = {spec["shape"] for spec in PROC_MONSTERS.values()}
    for sh in MON_SHAPES:
        if sh not in used:
            problems.append(f"形状 {sh} 画了但 PROC_MONSTERS 里没有一只怪用它")

    names = sorted(by_shape)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if sil(bases[by_shape[a][0]]) == sil(bases[by_shape[b][0]]):
                problems.append(f"形状 {a} 与 {b} 的剪影完全相同 —— 两种形状长一个样")

    for sh, ids in by_shape.items():
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                if bases[a].tobytes() == bases[b].tobytes():
                    problems.append(f"{a} 与 {b} 同形状且逐像素完全相同 —— 换色没生效")

    for art_id, im in bases.items():
        if not sil(im.crop((0, MON_H - 1, MON_W, MON_H))):
            problems.append(f"{art_id} 最后一行为空，底部锚定会让它浮在半空")
    return problems


def verify_boss_art(frames: dict[str, list[Image.Image]]) -> list:
    """
    BOSS 造型断言。**与 `verify_mon_art` 分开**，因为网格不同（64 vs 32）——
    那边所有判据都建立在 `MON_H` 上，对着 64 网格的帧会**静默量错一格量级**
    （「最后一行」量的是第 31 行，而 BOSS 的内容到第 63 行），
    比报错难查得多。这里六条判据：

      1. **画布必须是 64 网格** —— 抓「BOSS 悄悄退回 32 网格的杂兵造型」。
         它不是假想：`BOSS_IDS` 与 `PROC_BOSSES` 对不上时就会发生，
         而那只怪头上还顶着渲染层的金色圈，看起来「只是个有点小的 BOSS」。
      2. **底行必须有像素** —— 与杂兵同理，底部锚定下帧底留白就是浮在半空。
      3. **每只只出 1 帧 idle** —— 呼吸是渲染层的刚体位移，理由同 `verify_mon_art` ⑤。
      4. **八只 BOSS 的剪影互不相同** —— 抓「画了八只结果都是同一个轮廓换色」。
         这一条的假绿只有一种：剪影集合比较在帧尺寸上也不同的话会全不相等，
         所以断言里同时要求**它们两两之间至少差 N 个像素**，不是「不相等」就算过。
      5. **细节密度达标** —— 把「更精致」变成可量的东西：把画面切成 8×8 的块，
         数每块里的**独立颜色数**，取中位数。32 网格的素材即便放大到 64，
         每块的中位数也只有 ~1.3（像素是摊开的）；真画在 64 网格上有 3.0~4.0。
         阈值 3.0（实测分布见常量 `BOSS_DETAIL_MIN` 的注释）。
      6. **`BOSS_IDS` 与 `data/monsters.json` 的 boss 字段一致** ——
         数据里是 BOSS、素材里没画 = 会退回杂兵造型；素材画了但数据不是 BOSS =
         白画（不会有人在棋盘上看到它）。
      7. **内部细节达标**（`_inner_detail`）—— 判据 5 只看 8×8 块，
         而**轮廓线**本身就贡献 2~3 色，所以「边缘花哨 + 内部一整片纯色」
         也能过。这一条先腐蚀掉轮廓外侧 2px，只量身体内部有没有纹理。门槛 1.8。
      8. **正面朝向的 BOSS，头部必须左右对称**（`_head_asym`，名单见 `HEAD_FRONT`）
         —— 这是「正面朝向玩家」的**唯一**可量判据。改前 dragon 是侧视朝左，
         实测 39.4%；转正后 2.2%。只对 `HEAD_FRONT` 里的名字生效：另外四只
         的不对称来自剧情道具（盾 / 大剑 / 法杖）或刻意站姿（吸血鬼），
         全局量会把它们全部误杀。
    """
    problems: list[str] = []
    if set(frames) != set(BOSS_IDS):
        problems.append(
            f"产出的 BOSS 是 {sorted(frames)}，与 BOSS_IDS {sorted(BOSS_IDS)} 对不上"
        )
        return problems

    for bid, fs in frames.items():
        if len(fs) != 1:
            problems.append(
                f"BOSS {bid} 出了 {len(fs)} 帧 idle —— 素材里只允许静止帧。"
                f"呼吸是渲染层的刚体位移（board.ts 的 MONSTER_BOB_PX）"
            )
            continue
        im = fs[0]
        if (im.width, im.height) != (BOS_W, BOS_H):
            problems.append(
                f"BOSS {bid} 的画布是 {im.width}×{im.height}，应为 {BOS_W}×{BOS_H} —— "
                f"它八成退回了 32 网格的杂兵造型（PROC_BOSSES 里没有它？）"
            )
            continue
        if not im.crop((0, BOS_H - 1, BOS_W, BOS_H)).getchannel("A").getbbox():
            problems.append(f"BOSS {bid} 最后一行为空，底部锚定会让它浮在半空")
        d = _detail_density(im)
        if d < BOSS_DETAIL_MIN:
            problems.append(
                f"BOSS {bid} 的细节密度只有 {d:.2f}（每个 8×8 块的中位独立颜色数），"
                f"低于阈值 {BOSS_DETAIL_MIN} —— 这个尺寸上「一色」是读不出结构的，"
                f"要么是「把 32 网格放大到 64」（放大不创造颜色，只把同一批像素摊开），"
                f"要么是大面积纯色没有压明暗三阶"
            )
        inner = _inner_detail(im)
        if inner < BOSS_INNER_MIN:
            problems.append(
                f"BOSS {bid} 的内部细节只有 {inner:.2f}（排除轮廓 2px 后，"
                f"每个 4×4 块的平均独立颜色数），低于阈值 {BOSS_INNER_MIN} —— "
                f"边缘再花哨也不算细节：身体内部必须有阴影 / 高光 / 刻线 / 鳞片"
                f"（只压一层暗纹不够，要连高光一起给，同一个 4×4 里才会出现第三色）"
            )
        if bid in HEAD_FRONT:
            asym = _head_asym(im)
            if asym > BOSS_HEAD_SYM_MAX:
                problems.append(
                    f"BOSS {bid} 是正面朝向的，但头部区域的左右不对称像素占 "
                    f"{asym:.1%}（上限 {BOSS_HEAD_SYM_MAX:.0%}）—— 它多半是侧视/"
                    f"半侧视，或者成对结构（角 / 手臂 / 眼 / 牙）有一侧没走 `_sym`，"
                    f"左右差了几列。正面朝向的对称结构一律用 `_sym` / `_beam_sym` 写"
                )

    # 剪影两两差异：不要求「不相等」（一个像素也能让它不相等），要求差得足够多
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


def _solid_set(im: Image.Image) -> set[int]:
    """实心像素（alpha ≥ SOLID_ALPHA）的下标集合 —— 剪影比较用。"""
    a = im.getchannel("A").tobytes()
    return {i for i, v in enumerate(a) if v >= SOLID_ALPHA}


def _detail_density(im: Image.Image, block: int = 8) -> float:
    """
    细节密度 = 把画面切成 `block×block` 的块，每块数**独立颜色数**，
    再对「有内容的块」取**中位数**。

    为什么是中位数而不是均值：背景块（整块透明）会按 0 计入，把均值拉平，
    于是「画得很省」和「只在角落画了一点」得到同一个数。中位数只看有内容的块。

    为什么这个量能区分「真画在 64 网格」和「32 网格放大」：放大是**像素级复制**，
    每个 8×8 块里的颜色种类不变（一块纯色放大后还是纯色）；
    而真画在 64 网格上，同一个 8×8 区域里会有阴影、高光、边缘线，颜色自然更多。
    实测：手绘 64 网格 BOSS ≈ 2.6，32 网格放大到 64 的杂兵 ≈ 1.3。
    """
    px = im.load()
    counts = []
    for by in range(0, im.height, block):
        for bx in range(0, im.width, block):
            cols = set()
            opaque = 0
            for y in range(by, min(by + block, im.height)):
                for x in range(bx, min(bx + block, im.width)):
                    p = px[x, y]
                    if p[3] == 0:
                        continue
                    opaque += 1
                    cols.add(p)
            if opaque >= block * block * 0.25:      # 半块以上有内容才算
                counts.append(len(cols))
    if not counts:
        return 0.0
    counts.sort()
    return counts[len(counts) // 2]


def _inner_detail(im: Image.Image, block: int = 4, margin: int = 2) -> float:
    """
    内部细节 = 只统计**身体内部**（离透明区至少 `margin` 像素）的 `block×block`
    块里有多少种颜色，取**均值**。

    为什么在 `_detail_density` 之外还要这一条：8×8 的密度里**轮廓线**贡献很大 ——
    任何一只 BOSS 的复杂边缘都会自然给出 2~3 色，于是「边缘花哨、内部大面积纯色」
    也会过线。先用最小值滤波把轮廓外侧 `margin` 圈腐蚀掉，剩下的就纯粹是
    「身体内部有没有纹理」：阴影、高光、刻线、鳞片。

    实测（8 只 × 两版素材）：改前 1.61 ~ 2.13，改后 1.97 ~ 2.28。
    """
    mask = im.getchannel("A").filter(ImageFilter.MinFilter(2 * margin + 1))
    px, mk = im.load(), mask.load()
    counts = []
    for by in range(0, im.height, block):
        for bx in range(0, im.width, block):
            cols, n = set(), 0
            for y in range(by, min(by + block, im.height)):
                for x in range(bx, min(bx + block, im.width)):
                    if mk[x, y] > 0:
                        n += 1
                        cols.add(px[x, y])
            if n >= block * block * 0.5:
                counts.append(len(cols))
    return sum(counts) / len(counts) if counts else 0.0


def _head_asym(im: Image.Image, y1: int = 34) -> float:
    """
    头部区域（画布最上 `y1` 行）的**左右不对称度** = 不对称像素 / 并集像素。

    这是「正面朝向玩家」的可量判据。侧视或半侧视的头必然偏在画布一侧，
    怎么修形状都过不了这一条 —— 这正是它存在的理由：没有它，「把龙转成正面」
    只是这一次改对了，下次有人为了「看着更威风」把它转回侧面，没有任何东西会报警。

    实测：改前 dragon 39.4%（侧视朝左）、demonKingTrue 15.1%（角与手臂左右
    各差 1~7 列）、kraken 7.2%、demonKing 9.4%；改后最大 2.3%。
    """
    head = im.crop((0, 0, im.width, y1))
    a = _solid_set(head)
    b = _solid_set(head.transpose(Image.FLIP_LEFT_RIGHT))
    return len(a ^ b) / (len(a | b) or 1)


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


def _col_lums(im: Image.Image) -> list[float]:
    """
    每一列的**平均相对亮度**（0~1，只算不透明像素）。

    这是判断「形体走向」的最小工具：竖井的横剖面是两端亮、中间暗的一条**谷**，
    上升梯段则是自左向右**单调变亮**的一条坡 —— 两者用同一段代码一量就分开了，
    不必依赖「看图觉得像不像」。见 verify_terrain 第 ③ 条。

    注意返回值归一到 0~1（与 `mean_lum` 同口径）—— `_lum` 吃的是 0~255 的通道值，
    不除 255 的话阈值会整体错三个数量级（这里踩过一次，断言因为 1.25/255 的
    微小回退而误报）。
    """
    px = im.convert("RGBA").load()
    out: list[float] = []
    for x in range(im.width):
        tot = 0.0
        n = 0
        for y in range(im.height):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            tot += _lum((r, g, b))
            n += 1
        out.append(tot / n / 255 if n else 0.0)
    return out


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

    # ③ 上楼梯与下楼梯必须**结构不同**，不能只是同一张图的翻转。
    #
    # 这一条的前身只判「两张是否逐像素相同」，于是「下=floor_ladder、
    # 上=floor_ladder 垂直翻转」这种写法轻松通过 —— 而 floor_ladder 近乎上下
    # 对称，翻转后肉眼读不出区别，等于没区分（这正是用户报的第 ④ 条）。
    # 现在判四件事：完全相同的图、互为垂直翻转、**以及两者的形体走向**：
    #   下楼梯（侧视下沉）→ 横剖面自左向右**变暗**（越往下越深）；
    #   上楼梯（侧视上升）→ 横剖面自左向右**变亮**（越往上越接近出口）。
    # 只改明暗不改形体（比如简单地把一张图调亮调暗）会让第 4 条挂掉；
    # 反过来，只改走向不改明暗也一样 —— 两条一起才是「同一族画法的两个方向」。
    up, down = cells.get("4"), cells.get("3")
    if up is None or down is None:
        problems.append("上/下楼梯瓦片缺失，无法校验可区分性")
    else:
        if list(up.get_flattened_data()) == list(down.get_flattened_data()):
            problems.append("上楼梯(4) 与下楼梯(3) 图像完全相同 —— 玩家分不清方向")
        flipped = down.transpose(Image.FLIP_TOP_BOTTOM)
        if list(up.get_flattened_data()) == list(flipped.get_flattened_data()):
            problems.append(
                "上楼梯(4) 恰好等于下楼梯(3) 的垂直翻转 —— 翻转在 32px 上等价于"
                "同一张图，玩家读不出方向。两者必须是不同**形体**（下＝同心方井、"
                "上＝上升梯段），而不是同一形体的明暗颠倒"
            )

        dc, uc = _col_lums(down), _col_lums(up)
        n = len(dc)
        if n >= 8:
            # 下沉梯段：自左向右必须单调变暗，且落差够大 —— 越往右下越深
            fall = dc[0] - dc[-1]
            bumps = [(dc[i + 1] - dc[i]) for i in range(n - 1)]
            worst_down = max(bumps)
            if fall < 0.15 or worst_down > 0.02:
                problems.append(
                    f"下楼梯(3) 的横剖面不是自左向右单调变暗（左端 {dc[0]:.3f} → "
                    f"右端 {dc[-1]:.3f}，总落差 {fall:.3f}，最大回弹 {worst_down:.3f}）—— "
                    f"下沉梯段靠「越往右下越深」来表明方向，回弹或落差不足就读不出来"
                )
            # 梯段：自左向右必须单调变亮，且总落差够大
            rise = uc[-1] - uc[0]
            drops = [(uc[i] - uc[i + 1]) for i in range(n - 1)]
            worst = max(drops)
            if rise < 0.15 or worst > 0.02:
                problems.append(
                    f"上楼梯(4) 的横剖面不是自左向右单调变亮（左端 {uc[0]:.3f} → "
                    f"右端 {uc[-1]:.3f}，总落差 {rise:.3f}，最大回退 {worst:.3f}）—— "
                    f"上升梯段靠「越往右上越亮」来表明方向，回退或落差不足就读不出来"
                )

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
    # 上限按 SS² 放大：瓦片像素数变 4 倍，同样「相对幅度」的重排/杂质绝对量
    # 也是 4 倍 —— 不跟着放，这条断言就会只因为换了网格而红。
    for family, drift_cap in (("0", 8 * SPECKLE), ("1", 8 * SPECKLE), ("1:top", 24 * SPECKLE)):
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
            "rasterTile": RASTER_TILE,
            "supersample": SS,
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

    # 变体由**配方**直接生成（缝不动、只换残缺），不经过 terrain_raster ——
    # 地板与墙都是手绘的，本来就在出图网格上。
    _wall_bodies = _wall_variants()
    for vi, im in enumerate(_floor_variants()):
        if vi:
            push_terrain(_variant_key("0", vi), f"floor#{vi}", im,
                         f"由 TERRAIN[0] 派生：缝与倒角一致，碎石/磨痕换一批位置（第 {vi} 号变体）")
    for vi, im in enumerate(_wall_bodies):
        if vi:
            push_terrain(_variant_key("1", vi), f"wall#{vi}", im,
                         f"由 TERRAIN[1] 派生：砌层与错缝一致，残缺换一批位置（第 {vi} 号变体）")
    for vi, body in enumerate(_wall_bodies):
        if vi:
            push_terrain(f"1:top:{vi}", f"wallTop#{vi}", _wall_top_baked(body),
                         f"由 TERRAIN_TOP[1] 派生：墙身换变体后重新压顶（第 {vi} 号变体）")

    # 变体数量写进 MANIFEST —— 渲染层据此决定哈希取模，不写死常量
    manifest["meta"]["terrainVariants"] = {
        "0": FLOOR_VARIANTS,
        "1": WALL_VARIANTS,
        "1:top": WALL_VARIANTS,
    }

    # 出图这一步才升到出图网格（RASTER_TILE）。手绘的地板/楼梯本就画在这个网格上，
    # terrain_raster 会对它们空转；第三方位图与门则按各自起点放大到齐平。
    terr_cells = [(k, terrain_raster(im), info) for k, im, info in terr_cells]

    # 断言跑在**出图网格**（RASTER_TILE）上：变体是在出图网格上生成的，底图必须
    # 同网格，否则「像素偏离数」会被尺寸差直接顶穿（实测恒差 = 两张图面积之差），
    # 那条断言就变成了在量网格而不是量配色。
    terr_by_key = {k: im for k, im, _ in terr_cells}

    for _, im, _ in terr_cells:
        terr_shelf.add(im)
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
    walk, attack = build_actor_sheet()
    # 「剑、盾、铠甲都画上了吗、有没有画反」只有量像素才知道（见 verify_hero_art）
    for p in verify_hero_art(walk, attack):
        missing.append("勇者造型断言失败：" + p)
    actor_cells: list[tuple[str, Image.Image]] = []
    actor_meta: list[dict] = []

    def push_actor(key: str, im: Image.Image, meta: dict):
        actor_cells.append((key, im))
        actor_meta.append(meta)

    hero_w, hero_h = 0, 0
    # 攒一份勇者的走路帧，给 verify_npc_scale 量「NPC 有没有比勇者大」。
    # 必须用**产出后的真实帧**（bottom_center 补过底对齐），不能用源图 ——
    # 否则量的是源素材而不是玩家看到的那一帧。
    hero_walk_frames: list = []
    for di, d in enumerate(HERO_DIRS):
        for fi, fr in enumerate(walk[di]):
            im = bottom_center(fr, 16, 26)
            hero_w, hero_h = im.size
            hero_walk_frames.append(im)
            push_actor(f"hero.walk.{d}.{fi}", im, {"group": "hero", "anim": "walk", "dir": d, "frame": fi})
    for di, d in enumerate(HERO_DIRS):
        for fi, fr in enumerate(attack[di]):
            # ⚠️ 这里的 16 必须与上面走路帧的 16 一致。曾经这里是 **20**
            # （配合 `HERO_ATK_W`），结果是图集里出现 80×104 的挥剑帧、落屏 40px，
            # 比 32px 的格子还宽 —— 挥剑时勇者会横向压到邻格上。
            # 两套帧同尺寸还是 A14 判「挥剑不变小」的前提（它比的是帧尺寸）。
            im = bottom_center(fr, 16, 26)
            push_actor(f"hero.attack.{d}.{fi}", im, {"group": "hero", "anim": "attack", "dir": d, "frame": fi})

    # NPC：程序化手绘，四个方向写同一组帧（NPC 是静止实体，只取 down —— 见 NPC_ART 说明）
    npc_rendered: dict[str, list] = {}
    for npc_id in NPC_ART:
        frames = npc_art_frames(npc_id)
        npc_rendered[npc_id] = frames
        for d in NPC_DIRS:
            for fi, fr in enumerate(frames):
                push_actor(f"npc.{npc_id}.{d}.{fi}", fr, {"group": "npc", "npc": npc_id, "dir": d, "frame": fi})
    # 「六个 NPC 长得一样」只能靠断言发现 —— 画面上看是六个精灵，代码里看是六次调用
    for p in verify_npc_art(npc_rendered):
        missing.append("NPC 造型断言失败：" + p)
    # 「NPC 比勇者大」同理 —— 两边都是 16×26 的帧，只有量内容包围盒才知道差了 4px
    for p in verify_npc_scale(npc_rendered, hero_walk_frames):
        missing.append("NPC 比例断言失败：" + p)

    # NPC 比例断言跑完（它按 16×26 判），才把角色帧升到 32 网格
    actor_cells = [(k, supersample(im)) for k, im in actor_cells]

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
    # 注意：角色的帧宽高不是常量 —— 勇者是 16×26，而 NPC 帧是 26 行高、
    # 宽度按各自造型；所以 w/h 必须留在帧上，不能像怪物那样提到组级。
    # （2026-09-23 起勇者的走路与挥剑**同为 16×26**，但「不必留 w/h」依然不成立：
    #  NPC 那一组仍然不是同一个尺寸。）
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
    # 来源必须写实：这批不再是 ArMM 的 character.png（那张表已经不再被切）。
    # 写成 ArMM 会让人去那张图集里找一个根本不存在的「带剑盾铠甲的勇者」。
    actors.setdefault("hero", {})["src"] = (
        "本仓库手绘（tools/build-assets.py: _hero_* 系列）—— 16×26 程序化像素画，"
        "铠甲 / 剑 / 盾三件装备分区绘制，left 由 right 镜像"
    )
    actors.setdefault("hero", {})["dirOrder"] = HERO_DIRS
    for npc_id in NPC_ART:
        if npc_id in actors.get("npcs", {}):
            # 来源必须写实：这批不是任何第三方素材，是本仓库手绘的程序化像素画。
            # 写成 ArMM 会让人去那张单角色图集里找一个根本不存在的角色。
            actors["npcs"][npc_id]["src"] = (
                "本仓库手绘（tools/build-assets.py: NPC_ART）— 16×26 程序化像素画，"
                "每个职能一套剪影"
            )

    # ── 3. 怪物 ─────────────────────────────────────────────────
    mon_cells: list[tuple[str, Image.Image]] = []
    mon_meta: list[dict] = []
    proc_used: set[str] = set()
    # id -> idle 帧列表。现在恒为 1 帧（见 mon_art_frames），
    # 但断言仍按「列表」收 —— 判据「帧数必须为 1」要有东西可量。
    proc_frames: dict[str, list[Image.Image]] = {}
    # BOSS 单独收（见 PROC_BOSSES）：网格是 64，与杂兵的 32 不同。
    # 混进 proc_frames 会让所有按 MON_H 量的判据在 BOSS 上静默量错网格。
    boss_frames: dict[str, list[Image.Image]] = {}

    for mid, (src_name, xf, scale, note) in MONSTERS.items():
        # BOSS 走 64 网格的独立体系：**两条换算都不能用** ——
        # `_mon_out` 是「把 32 网格抬到出图 64」，对已经是 64 的帧是空操作但语义错；
        # `_out_scale` 是给「绘制网格 16 → 出图 64」换算倍数的。
        # BOSS 的落屏规则只有一条：**64 网格 1:1 落屏**，所以 drawScale 常量 1.0。
        if mid in BOSS_IDS:
            frames = boss_art_frames(mid)
            boss_frames[mid] = frames
            for anim in ("idle", "run"):
                for fi, im in enumerate(frames):
                    top, bot = _art_rows(im)
                    mon_cells.append((f"{mid}.{anim}.{fi}", im))
                    mon_meta.append({
                        "monster": mid, "anim": anim, "frame": fi,
                        "src": "本仓库手绘（tools/build-assets.py: PROC_BOSSES，64 网格 1:1 落屏）",
                        "note": note, "drawScale": BOSS_DRAW_SCALE,
                        "artH": bot - top + 1, "artPadBottom": im.height - 1 - bot,
                    })
            continue

        # 源名 "gen" = 本仓库按名称手绘（蝙蝠/史莱姆/龙/乌贼/石头人/吸血鬼/魔王）。
        # 形状与配色在 PROC_MONSTERS，这里只负责出帧 + 记 meta。
        if src_name == "gen":
            if mid not in PROC_MONSTERS:
                missing.append(f"{mid}: MONSTERS 标了 gen，但 PROC_MONSTERS 里没有它的造型")
                continue
            proc_used.add(mid)
            frames = mon_art_frames(mid)
            proc_frames[mid] = frames
            for anim in ("idle", "run"):
                for fi, im in enumerate(frames):
                    im = _mon_out(im, scale)          # 出图网格；artH 必须按出图后量
                    top, bot = _art_rows(im)
                    mon_cells.append((f"{mid}.{anim}.{fi}", im))
                    mon_meta.append({
                        "monster": mid, "anim": anim, "frame": fi,
                        "src": "本仓库手绘（tools/build-assets.py: MON_SHAPES）",
                        "note": note, "drawScale": _out_scale(scale),
                        "artH": bot - top + 1, "artPadBottom": im.height - 1 - bot,
                    })
            continue

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
                im = _mon_out(im, scale)
                top, bot = _art_rows(im)
                art_bbox = (bot - top + 1, im.height - 1 - bot)
                mon_cells.append((f"{mid}.{anim}.{fi}", im))
                mon_meta.append({"monster": mid, "anim": anim, "frame": fi,
                                 "src": f"0x72/{src_name}", "note": eff_note,
                                 "drawScale": _out_scale(scale),
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

    # 手绘杂兵的造型断言：形状互不相同、同形状的变体确有区别、帧底不留白、
    # 且每只怪只有 1 帧 idle（呼吸在渲染层，见 mon_art_frames）。
    # ⚠️ BOSS **不在** proc_frames 里 —— 它们是 64 网格，判据全都不一样。
    for p in verify_mon_art(proc_frames):
        missing.append("怪物造型断言失败：" + p)
    # BOSS 的造型断言：64 网格、底行有像素、单帧、八只剪影互不相同、
    # 细节密度达标、且与 data/monsters.json 的 boss 字段一一对应
    for p in verify_boss_art(boss_frames):
        missing.append("BOSS 造型断言失败：" + p)
    monsters_json_boss = {
        mid for mid, v in
        json.loads((ROOT / "data" / "monsters.json").read_text(encoding="utf-8"))["monsters"].items()
        if v.get("boss")
    }
    if monsters_json_boss != set(BOSS_IDS):
        missing.append(
            f"BOSS 名单与 data/monsters.json 对不上："
            f"数据里是 {sorted(monsters_json_boss)}，代码里是 {sorted(BOSS_IDS)}"
        )
    # 三张表必须严格一一对应 —— 「在 MONSTERS 里标了 gen 却忘了画」会静默少一只怪
    declared = {mid for mid, (s, _, _, _) in MONSTERS.items() if s == "gen"}
    for mid in sorted(declared - proc_used - set(boss_frames)):
        missing.append(f"{mid}: MONSTERS 标了 gen，但没有产出任何帧")
    for mid in sorted(set(PROC_MONSTERS) - declared - proc_used):
        missing.append(f"{mid}: PROC_MONSTERS 里有造型，但 MONSTERS 没标 gen，接不上")
    hand = len(proc_used)
    print(f"  手绘怪物 {hand} 只 / {len(MON_SHAPES)} 种形状"
          f"；BOSS {len(boss_frames)} 只 / 64 网格 1:1 落屏"
          f"（其余 {len(MONSTERS) - hand} 只取自 0x72）")

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

    # 三色钥匙是「颜色即玩法」，而黄钥匙是构建期造出来的（原素材没有），
    # 最容易在换素材时悄悄跑偏 —— 断言而不是靠眼看。
    # 顺序要紧：先按 16 网格判（判据就是照 16 写的），再升网格出图。
    for p in verify_items(dict(item_cells), ken(126)):
        missing.append("道具断言失败：" + p)

    item_cells = [(k, supersample(im)) for k, im in item_cells]

    for key, im in item_cells:
        item_shelf.add(im)
    item_sheet, item_entries = item_shelf.render()
    for (key, im), e, meta in zip(item_cells, item_entries, item_meta):
        item_sheet.paste(im, (e["x"], e["y"]), im)
        meta.update({"atlas": "items", "x": e["x"], "y": e["y"], "w": im.width, "h": im.height})
    item_sheet.save(ATLAS_DIR / "items.png")

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
    print(f"  勇者   {len(HERO_DIRS)} 向 × 4 帧走路 + {len(HERO_DIRS)} 向 × 4 帧挥剑（手绘：铠甲 / 剑 / 盾）")
    print(f"  NPC    {len(NPC_ART)} 人（程序化手绘）× {len(NPC_DIRS)} 向 × 1 帧静止 —— 呼吸在渲染层")
    total = sum((ATLAS_DIR / m["file"]).stat().st_size for m in manifest["meta"]["atlases"].values())
    print(f"\n  图集总大小 {total/1024:.1f} KB")
    if missing:
        print(f"\n=== 需注意（{len(missing)} 条）===")
        for m in missing[:20]:
            print("  -", m)
    return 0


if __name__ == "__main__":
    sys.exit(main())
