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
# ⚠️ 绘制倍数只有 BOSS 能取 3，其余一律 2 —— 这条有断言（见 verify_monster_fit）。
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
    "skeletonCaptain": ("gen",           None,                              2, "手绘·骷髅队长：金盔金甲 + 圆盾"),

    # ── 亡灵族 ──────────────────────────────────────────────────
    "ghostWarrior":    ("gen",           None,                              2, "手绘·幽魂武士：兜帽飘尾 + 幽光剑，青白"),
    "phantom":         ("gen",           None,                              2, "手绘·幻影：同幽魂换紫 + 半透明"),
    "vampire":         ("gen",           None,                              2, "手绘：高领斗篷 + 獠牙 + 红眼（旧为 zombie 换紫，毫无吸血鬼特征）"),
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
    "archmage":        ("gen",           None,                              2, "手绘·大法师：金袍最高帽 + 金宝珠 + 长白须"),
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
    "knightCaptain":   ("gen",           None,                              2, "手绘·骑士长：白银甲金饰 + 红披风金羽"),
    "darkKnight":      ("gen",           None,                              2, "手绘·暗黑骑士：黑甲红目缝 + 黑披风"),
    "stoneGolem":      ("gen",           None,                              2, "手绘：方块躯干 + 砖缝 + 发光眼（旧为 ogre 食人魔）"),

    # ── BOSS：允许 ×3（48px）。层级信号靠尺寸，但**只有 BOSS 有这个特权** ──────
    "dragon":          ("gen",           None,                              3, "手绘：角 + 长吻 + 展翼 + 卷尾（旧为 chort 小鬼）"),
    "kraken":          ("gen",           None,                              3, "手绘：圆头 + 侧鳍 + 六条打卷的腕（旧为 swampy 绿衣人）"),
    "demonKing":       ("gen",           None,                              3, "手绘：巨角 + 膜翼 + 发光眼，紫"),
    "demonKingTrue":   ("gen",           None,                              3, "手绘：同形状换猩红 + 金冠（真身）"),
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

    # NPC 不再从图集切 —— NPC_test.png 是**单角色**表（64×128 = 4 向 × 4 帧，全图一个人），
    # 6 个 NPC 只能用同一张图换色，长得一模一样。现在改为程序化手绘，见 npc_art()。
    # 勇者仍然从这里切：character.png 是真正的多角色表。
    return walk, attack


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
NPC_BREATH_SPLIT = NPC_ROBE_TOP      # 呼吸帧分界：这一行往上整体抬 1px，往下不动

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

    return add_outline(im, INK)


def _breathe(base: Image.Image, robe, lift: int = 1) -> Image.Image:
    """
    呼吸帧：头与躯干整体上移 `lift` 像素，**脚原位不动**，下摆跟着上身一起抬。

    为什么不整张图上移：精灵是底部锚定的（board.ts: sp.anchor.set(0.5, 1)），
    整图上移会让脚离地 1px —— 那是「在飘」，不是「在呼吸」。

    分界行是 `NPC_BREATH_SPLIT`（**下摆**的第一行，现在是第 19 行）。

    ⚠️ 补缝的做法是这一版的关键修复：上一版用**平铺的袍色**填那条水平缝
    （`_put(out, ..., robe)`），结果腰上出现一条全宽平色带，把角色「撕成
    上下两半」—— 正是用户说的「抖动时上下分离」。而且那条缝只覆盖
    x=3..12，手臂外侧还会透出透明缺口，看起来更像裂开了。

    现在改成：把**下摆的第一行原样向上平移 `lift` 行**填进缝里。这样躯干与上身
    始终是连续延伸的一条，袍子跟着上身一起抬，腰上不再有平色带、也不会透底，
    只是「上半身整体往上喘了一口气」。
    """
    out = Image.new("RGBA", base.size, (0, 0, 0, 0))
    out.paste(base.crop((0, lift, NPC_W, NPC_BREATH_SPLIT)), (0, 0))
    out.paste(base.crop((0, NPC_BREATH_SPLIT, NPC_W, NPC_H)), (0, NPC_BREATH_SPLIT))
    # 缝：下摆首 `lift` 行原样上移填进缝，全宽、且是真实像素 —— 杜绝平色带与透明缺口
    seam = base.crop((0, NPC_BREATH_SPLIT, NPC_W, NPC_BREATH_SPLIT + lift))
    for k in range(lift):
        out.paste(seam, (0, NPC_BREATH_SPLIT - lift + k))
    return out


def npc_art_frames(npc_id: str) -> list[Image.Image]:
    """
    一个 NPC 的 4 帧 idle，节奏是「吸气—回位」。

    帧数与 0x72 那批怪物刻意保持一致（都是 4 帧），
    这样 board.ts 的换帧逻辑对两者是同一条路径。
    """
    spec = NPC_ART[npc_id]
    base = _npc_base(spec)
    up = _breathe(base, spec["robe"], 1)
    return [base, up, base, up]


def verify_npc_art(images: dict) -> list:
    """
    NPC 造型断言。**必须写成断言，不能靠眼看** —— 「六个 NPC 长得一样」这个问题
    在代码里完全看不出来（它们本来就都是「一个 16×26 的精灵」）。

    三条判据：
      1. 任意两个职能的静止帧不能逐像素相同；
      2. 剪影（实心像素集合）必须不同 —— 「同一张图换色」会被这条拦下；
      3. 实心底行必须正好落在**鞋下一行的描边**上（`NPC_FOOT_ROW + 1`）——
         精灵是底部锚定的（`anchor.set(0.5, 1)`），脚没有确定的落点就会出现
         「一只脚踩地、一只脚悬空」这种只在画面上看得见的错。

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
      3. 呼吸帧：脚不走（底行不变），顶行不越过勇者的最顶行；
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

        # 呼吸帧：脚不能走，头顶也不能越界
        for i, fr in enumerate(frames[1:], start=1):
            b_top, b_bottom = solid_rows(fr)
            if b_bottom != ref_bottom:
                problems.append(
                    f"NPC {npc_id} 第 {i} 帧（呼吸）底行到了 {b_bottom} —— "
                    f"底部锚定下脚离地会变成「在飘」，呼吸只该抬上身"
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
    """轴对齐实心椭圆（含边）。坐标可为小数，自动夹在画布内 —— 怪物造型的主力原语。"""
    if ry <= 0 or rx <= 0:
        return
    y0 = max(0, int(math.floor(cy - ry)))
    y1 = min(MON_H, int(math.ceil(cy + ry)) + 1)
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
    """
    _put(im, x, y, w, h, color)
    _put(im, MON_W - x - w, y, w, h, color)


def _stamp(rows: list[str], legend: dict[str, tuple]) -> Image.Image:
    """
    按**字符模板**填像素 —— 「画出来」的造型只用这一条路。

    为什么蝙蝠/龙不再手写坐标：第一版蝙蝠的翼是「每行一段 (x, y, w)」，
    八行都写成了满宽，剪影于是成了一个**锚**（宽横梁 + 细杆 + 下面两块）。
    最要命的是**看不出来** —— 坐标是数字，读代码读不出形状，得先把图画出来才看得见。

    模板把「哪一行从第几列到第几列」直接画在源码里：可读、可 review、可 diff，
    改一列就是改一个字符。行/列长度断言在构建时拦下「多写少写一个点」。

    另外记住 `add_outline` 是 1px 八邻域膨胀（见该函数）：**1~2 列宽的缺口会被描边填满**。
    想要一条可见的分缝，缺口至少要 3 列。想靠「留 1 列空隙」把两块分开是徒劳的。
    """
    im = _mon_canvas()
    if len(rows) != MON_H:
        raise ValueError(f"模板 {len(rows)} 行，应为 {MON_H} 行")
    for y, row in enumerate(rows):
        if len(row) != MON_W:
            raise ValueError(f"模板第 {y} 行有 {len(row)} 列，应为 {MON_W} 列：{row!r}")
        x = 0
        while x < MON_W:
            ch = row[x]
            if ch == ".":
                x += 1
                continue
            if ch not in legend:
                raise ValueError(f"模板第 {y} 行第 {x} 列的字符 {ch!r} 不在图例里")
            x2 = x
            while x2 < MON_W and row[x2] == ch:
                x2 += 1
            _put(im, x, y, x2 - x, 1, legend[ch])
            x = x2
    return im


def _mon_squash(base: Image.Image, lift: int = 2) -> Image.Image:
    """
    呼吸帧：内容整体上抬 `lift` px，再把最底 `lift` 行补回最底 —— **脚不离地**。

    整张图上移是不行的：底部锚定下那就是「怪物飘起来了」。
    补回底行的做法让身体看起来在「喘」，与 NPC 的呼吸帧是同一个套路。
    `lift` 取 2（32 网格下 = 1 个落屏像素），1px 在 32 网格上会被 Scale2x 吃掉看不见。
    """
    out = Image.new("RGBA", base.size, (0, 0, 0, 0))
    out.paste(base.crop((0, lift, MON_W, MON_H)), (0, 0))
    out.paste(base.crop((0, MON_H - lift, MON_W, MON_H)), (0, MON_H - lift))
    return out


# ── 形状 ────────────────────────────────────────────────────────────
#
# 每个形状只吃 spec 里的颜色，不关心自己代表谁 —— 「皇帝史莱姆」和
# 「绿史莱姆」的差别在 spec，不在函数里。
#
# 全部形状都用 `_put` / `_sym` / `_ell` 一行行程序化生成 —— 半径、张角、椭圆
# 本来就是算法，坐标法在 32 网格上写起来比字符模板更准也更易复查。

# ── 蝙蝠模板 ───────────────────────────────────────────────────────
#
# 腰鼓形：第 3~9 行做翼，宽度走 8 → 10 → 16 → 14 → 12 → 10 → 8，
# 上下各收回去，中间一鼓 —— 这是「展开的膜翼」在剪影上唯一读得出来的特征。
# 耳朵（第 0 行两个点）与垂在下面的身体（第 10~15 行）是另外两个记号。
BAT_NARROW = [
    "......m..m......",
    "......bbbb......",
    "......ibbi......",
    "....MMbbbbMM....",
    "...MMmbbbbmMM...",
    "MMMmmmbbbbmmmMMM",
    ".MMmmmbbbbmmmMM.",
    "..mmmmbbbbmmmm..",
    "...mmmbbbbmmm...",
    "....mmbbbbmm....",
    "......bbbb......",
    "......bbbb......",
    "......bbbb......",
    "......bbbb......",
    ".....bbbbbb.....",
    ".....bbbbbb.....",
]

# 宽翼：中腰多两行到满幅（第 5、6 行），剪影明显比窄翼宽 —— 大蝙蝠 / 吸血蝙蝠。
BAT_WIDE = [
    "......m..m......",
    "......bbbb......",
    "......ibbi......",
    "...MMMbbbbMMM...",
    "..MMmmbbbbmmMM..",
    "MMMmmmbbbbmmmMMM",
    "MMMMmmbbbbmmMMMM",
    ".MMmmmbbbbmmmMM.",
    "..mmmmbbbbmmmm..",
    "...mmmbbbbmmm...",
    "....mmbbbbmm....",
    "......bbbb......",
    "......bbbb......",
    "......bbbb......",
    ".....bbbbbb.....",
    ".....bbbbbb.....",
]

# ── 龙模板（侧视，头朝左） ──────────────────────────────────────────
#
# 四个识别记号被分到四个方向，互不打架：
#   角       第 0~1 行左上（`k`）
#   长吻大头  第 2~4 行左侧（`b` + 第 3 行两颗眼 `i`、第 4 行獠牙 `w`）
#   翼       第 0~4 行右上扇开（`W`），下缘台阶状收到背脊
#   尾巴     第 7~8 行右端伸出去（`L`）
#   两条腿   第 10~15 行（`L`），两腿之间留 4 列缝才不被描边糊成一块
#
# 三条纪律（都是被咬过的）：
#   · **翼 / 尾 / 腿 必须是三种不同的颜色**。第一版全用 `dark`，结果右侧
#     一整团黑红看不出哪是翅膀哪是尾巴哪是腿 —— 剪影糊成一块砖。
#   · **别让身体横贯满幅超过 3 行** —— 那读出来是一块砖，不是兽（旧版就是 7 行满幅）。
#     身体的右端到第 10 列，只有尾巴才伸到 15。
#   · **第 0 行要用上**：底部锚定 + 16px 画布，空一行就是白矮 1px。
DRAGON_ROWS = [
    "...k......WWWW..",
    "..kk....WWWWWW..",
    "bbbbbbWWWWWWWWW.",
    "bibbibWWWWWWW...",
    "bwwbbbWW........",
    ".bbbbbbbbbb.....",
    ".bbbBBBBbbb.....",
    "..bbBBBBbbLLLLLL",
    "..bbbbbbbLLLL...",
    "...bbbbb........",
    "...LL....LL.....",
    "...LL....LL.....",
    "...LL....LL.....",
    "...LL....LL.....",
    "...LLL...LLL....",
    "...LLL...LLL....",
]


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
    """蝙蝠（DQ「德拉基」风）：**圆球身 + 大眼 + 头顶呆毛 + 一对小圆翅**。

    与上一版的关键差别：上一版把「像蝙蝠」押在**翼展**上（大张的膜翼 + 指骨），
    画出来是一团方块。DQ 的德拉基恰好相反 —— 身体是**一颗球**（占画面 2/3），
    翅膀只是贴在身后的**两片小圆叶**，识别靠的是**大眼与獠牙**。
    `span` 让翅膀更长（大蝙蝠）、`fangs` 加獠牙（吸血蝙蝠）。
    """
    im = _mon_canvas()
    body, dark, light = s["body"], s["dark"], s["light"]
    cx = MON_W / 2
    # 小圆翅：两侧各一片「上尖下圆」的小叶，上端与身体上部齐平 —— 贴身，不张
    for side in (-1, 1):
        for k in range(6):
            x = int(round(cx + side * (10 + k)))
            if not (0 <= x < MON_W):
                continue
            top = int(round(13 - k * 1.6))
            bot = int(round(23 - k * 0.8))
            for y in range(max(0, top), min(MON_H, bot + 1)):
                _put(im, x, y, 1, 1, body if (k % 2 == 0) else dark)
        # 翅外缘一行压暗，让小叶从球身上读得出来
        tipx = int(round(cx + side * 15))
        if 0 <= tipx < MON_W:
            _put(im, tipx, 12, 1, 9, dark)
    # 圆球身体：一颗球占画面 2/3（y=7..31）
    _ell(im, cx, 19, 11, 12, body)
    _ell(im, cx - 4, 13, 4, 4, light)          # 左上高光（右下不压暗 —— 深色椭圆会读成黑斑）
    # 头顶呆毛（两根，德拉基的招牌），毛尖压暗
    _put(im, int(round(cx - 4)), 2, 2, 6, body)
    _put(im, int(round(cx + 2)), 2, 2, 6, body)
    _put(im, int(round(cx - 4)), 2, 2, 2, dark)
    _put(im, int(round(cx + 2)), 2, 2, 2, dark)
    # 大眼：眼白占脸近 1/3，瞳孔小而偏下（DQ 德拉基的「呆萌」来源）
    _ell(im, cx - 4, 16, 3, 4, MON_WHITE)
    _ell(im, cx + 4, 16, 3, 4, MON_WHITE)
    _put(im, int(round(cx - 4)), 17, 2, 3, MON_INK)
    _put(im, int(round(cx + 2)), 17, 2, 3, MON_INK)
    # 嘴 + 獠牙
    _put(im, int(round(cx - 1)), 23, 2, 1, MON_INK)
    if s.get("fangs"):
        _put(im, int(round(cx - 2)), 24, 1, 3, MON_WHITE)
        _put(im, int(round(cx + 1)), 24, 1, 3, MON_WHITE)
    return im


def _mon_dragon(s) -> Image.Image:
    """魔龙（DQ 风，侧视朝左）：大头长吻 + 双角 + 巨眼 + 张口獠牙；背脊展翼；身体 + 腹甲；两腿落地；尾带箭尖。"""
    im = _mon_canvas()
    body, belly, wing, dark, eye = s["body"], s["belly"], s["wing"], s["dark"], s["eye"]
    cx = MON_W / 2
    # 身体（椭圆，偏右）
    _ell(im, cx + 3, 19, 9, 8, body)
    _ell(im, cx + 3, 22, 7, 5, belly)            # 腹甲（亮）
    # 颈（从左上头连到身体）
    for y in range(11, 20):
        x = int(round(cx + 3 - (y - 11) * 0.9))
        _put(im, x, y, 5, 1, body)
    # 头（左上）
    _ell(im, cx - 6, 11, 6, 5, body)
    # 长吻（向左突出）
    _put(im, int(round(cx - 13)), 10, 8, 4, body)
    _put(im, int(round(cx - 14)), 11, 4, 2, body)
    # 嘴（开口 + 獠牙）
    _put(im, int(round(cx - 13)), 13, 9, 1, dark)
    _put(im, int(round(cx - 12)), 14, 1, 2, MON_WHITE)
    _put(im, int(round(cx - 8)), 14, 1, 2, MON_WHITE)
    # 眼
    _put(im, int(round(cx - 6)), 9, 3, 3, MON_WHITE)
    _put(im, int(round(cx - 5)), 10, 2, 2, eye)
    # 双角（从头顶向右上弯，骨色）
    for k in range(7):
        _put(im, int(round(cx - 6 + k * 0.6)), int(round(9 - k)), 2, 2, MON_BONE)
    _put(im, int(round(cx - 1)), 3, 2, 2, MON_BONE)
    # 背脊翼（膜，从背向右上扇开，带指骨）
    for k in range(1, 13):
        x = int(round(cx + 6 + k * 0.7))
        if x > MON_W - 2:
            break
        up = int(round(8 - 4 * (k / 12)))
        down = int(round(20 - 2 * (k / 12)))
        if down < up + 3:
            down = up + 3
        col = wing if (k % 2 == 0) else dark
        for y in range(up, down + 1):
            _put(im, x, y, 1, 1, col)
        if k in (4, 8, 11):
            _put(im, x, up, 1, down - up + 1, dark)
    # 两腿（落地到最底行）
    for side in (-1, 1):
        _put(im, int(round(cx + 3 + side * 5)), 26, 3, 6, dark)
        _put(im, int(round(cx + 3 + side * 5)), 30, 4, 2, body)
    # 尾（从身体右下方伸出，带箭尖，到最底行）
    for k in range(10):
        y = 24 + k
        x = int(round(cx + 11 + k * 0.8))
        if x > MON_W - 2 or y > MON_H - 1:
            break
        _put(im, x, y, 2, 2, body)
    _put(im, int(round(cx + 18)), MON_H - 1, 3, 1, body)
    return im



def _mon_kraken(s) -> Image.Image:
    """大乌贼（DQ 风）：**饱满圆头占 2/3 + 正面大眼 + 六条短触手（短、弯、末端卷）**。

    与上一版的关键差别：上一版触手是**竖直长色条**（一直伸到画布底），
    读出来像外星人。DQ 的头足怪关键词是**头大触手短** —— 头占画面 2/3，
    触手只有头直径那么长、向外弯、末端向内卷一个小钩。
    """
    im = _mon_canvas()
    body, dark, light = s["body"], s["dark"], s["light"]
    cx = MON_W / 2
    # 饱满圆头（y=1..20，占画面 2/3）：顶部窄、中部鼓、底部略收
    for y in range(1, 21):
        t = (y - 1) / 20
        hw = int(round(12 * math.sin(min(1.0, t) * math.pi * 0.66)))
        if hw < 2:
            hw = 2
        _put(im, int(round(cx - hw)), y, hw * 2 + 1, 1, body)
    _ell(im, cx - 5, 7, 4, 4, light)             # 左上高光
    _ell(im, cx + 6, 15, 4, 3, dark)             # 右下阴影
    # 侧鳍（小，贴头两侧）
    _put(im, 2, 8, 3, 5, dark)
    _put(im, MON_W - 5, 8, 3, 5, dark)
    # 大眼（长在头的**正面**，白底黑瞳）
    _ell(im, cx - 4, 13, 3, 4, MON_WHITE)
    _ell(im, cx + 4, 13, 3, 4, MON_WHITE)
    _put(im, int(round(cx - 4)), 14, 2, 3, MON_INK)
    _put(im, int(round(cx + 2)), 14, 2, 3, MON_INK)
    # 六条短触手：从头底伸出，锥形、向外弯、末端向内卷钩 —— 只到 y=31（12 行）
    for x0, dr in [(-9, -0.9), (-5, -0.45), (-1, 0.0),
                   (1, 0.0), (5, 0.45), (9, 0.9)]:
        x = int(round(cx + x0))
        for i in range(11):
            y = 20 + i
            if y >= MON_H:
                break
            cur = dr if i < 8 else -dr * 0.6     # 末端反向 = 卷钩
            x = max(0, min(MON_W - 2, int(round(x + cur))))
            _put(im, x, y, 2, 1, body if (i % 2 == 0) else dark)
            if i in (2, 6):                      # 吸盘
                _put(im, x + 1, y, 1, 1, light)
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


def _mon_vampire(s) -> Image.Image:
    """吸血鬼（DQ「德拉库拉」风）：**竖起的高领尖角**（最标志性的剪影）+ 白脸 + 红眼獠牙。

    与上一版的关键差别：上一版领子矮（6 行）脸小（8×7），整体读成「穿紫袍的幽灵」。
    DQ 吸血鬼的剪影是**两片竖起的尖领**包住一张白脸 —— 领高接近脸高的一倍，
    白脸与深领形成强对比，一眼认出「这是吸血鬼不是法师」。
    """
    im = _mon_canvas()
    skin, cape, dark, light = s["body"], s["cape"], s["dark"], s["light"]
    cx = MON_W / 2
    # 竖起的高领：两侧「尖朝上、底朝下」的三角，领尖上放高举的手 —— DQ 吸血鬼的招牌姿势
    for k in range(9):                  # k=0 顶(尖) → 8 底(宽)
        y = 5 + k
        w = 2 + k // 3                  # 2 → 4
        x = int(round(cx - 8 - k * 0.4))
        _put(im, x, y, w, 1, cape)
        _put(im, MON_W - x - w, y, w, 1, cape)
        if k < 3:                       # 领尖受光
            _put(im, x, y, 1, 1, light)
            _put(im, MON_W - x - w, y, 1, 1, light)
    # 高举的双手（苍白）：按在领尖外侧 —— DQ 吸血鬼就是「双手举起」的姿势
    _put(im, int(round(cx - 10)), 3, 2, 3, skin)
    _put(im, int(round(cx + 8)), 3, 2, 3, skin)
    # 黑发（美人尖）
    _put(im, int(round(cx - 4)), 5, 9, 2, dark)
    _put(im, int(round(cx - 1)), 7, 3, 2, dark)
    # 白脸（与深领强对比 —— 上一版败在脸太小太暗）
    _put(im, int(round(cx - 4)), 7, 9, 8, skin)
    _put(im, int(round(cx - 3)), 9, 2, 2, s["eye"])   # 红眼
    _put(im, int(round(cx + 1)), 9, 2, 2, s["eye"])
    _put(im, int(round(cx - 1)), 13, 3, 1, dark)      # 嘴
    _put(im, int(round(cx - 2)), 13, 1, 2, MON_WHITE) # 獠牙
    _put(im, int(round(cx + 1)), 13, 1, 2, MON_WHITE)
    # 斗篷：钟形到脚，最底行满宽（落地断言）
    for y in range(15, MON_H):
        t = (y - 15) / (MON_H - 1 - 15)
        w = int(round(16 + t * 14))     # 16 → 30
        _put(im, int(round(cx - w / 2)), y, w, 1, cape)
    _put(im, int(round(cx - 3)), 16, 6, 5, light)     # 胸前内衬
    return im


def _mon_demon(s) -> Image.Image:
    """魔王（DQ 风）：巨角 + 发光眼 + 膜翼 + 獠牙 + 胸甲；`crown` 给真身加王冠以区分两只。"""
    im = _mon_canvas()
    body, dark, light = s["body"], s["dark"], s["light"]
    cx = MON_W / 2
    # 巨角（往外上方弯，骨色）
    for k in range(9):
        _put(im, int(round(cx - 4 - k * 0.7)), int(round(2 + k * 0.6)), 3, 2, MON_BONE)
        _put(im, int(round(cx + 1 + k * 0.7)), int(round(2 + k * 0.6)), 3, 2, MON_BONE)
    # 膜翼（两侧，从肩扇开，带指骨）
    for side in (-1, 1):
        bx = cx + side * 7
        for k in range(1, 13):
            x = int(round(bx + side * k * 0.9))
            if x < 1 or x > MON_W - 2:
                continue
            up = int(round(7 - 4 * (k / 12)))
            down = int(round(20 - (k / 12)))
            if down < up + 3:
                down = up + 3
            col = dark if (k % 2 == 0) else body
            for y in range(up, down + 1):
                _put(im, x, y, 1, 1, col)
            if k in (4, 8, 11):
                _put(im, x, up, 1, down - up + 1, MON_BONE)
    # 头
    _ell(im, cx, 12, 6, 5, body)
    _put(im, int(round(cx - 4)), 11, 2, 2, s["glow"])
    _put(im, int(round(cx + 2)), 11, 2, 2, s["glow"])
    _put(im, int(round(cx - 3)), 15, 6, 1, dark)     # 嘴
    _put(im, int(round(cx - 2)), 16, 1, 2, MON_WHITE)  # 獠牙
    _put(im, int(round(cx + 1)), 16, 1, 2, MON_WHITE)
    if s.get("crown"):
        _put(im, int(round(cx - 5)), 5, 10, 2, s["crown"])     # 冠圈
        for sx in (int(round(cx - 5)), int(round(cx)), int(round(cx + 5))):
            _put(im, sx, 2, 2, 3, s["crown"])                  # 三尖
    # 躯干 + 胸甲
    _ell(im, cx, 22, 8, 8, body)
    _ell(im, cx, 24, 5, 5, dark)
    # 腿（落地到最底行）
    _sym(im, int(round(cx - 9)), 28, 4, 4, dark)
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


MON_SHAPES = {
    "slime": _mon_slime,
    "bat": _mon_bat,
    "dragon": _mon_dragon,
    "kraken": _mon_kraken,
    "golem": _mon_golem,
    "vampire": _mon_vampire,
    "demon": _mon_demon,
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
    # 巨龙 / 乌贼 / 石头人 —— 三只名字与旧素材完全无关的
    "dragon":     dict(shape="dragon", body=(198, 62, 52, 255), wing=(104, 30, 38, 255),
                       belly=(238, 200, 128, 255), dark=(62, 18, 22, 255),
                       eye=(250, 216, 96, 255)),
    "kraken":     dict(shape="kraken", body=(132, 78, 176, 255), dark=(74, 38, 112, 255),
                       light=(186, 140, 226, 255)),
    "stoneGolem": dict(shape="golem", body=(126, 122, 120, 255), dark=(78, 74, 74, 255),
                       light=(182, 178, 174, 255), seam=(58, 54, 54, 255),
                       glow=(248, 168, 64, 255)),
    # 吸血鬼：旧版是 zombie 换紫，人形但毫无「吸血鬼」特征
    "vampire":    dict(shape="vampire", body=(238, 226, 226, 255), cape=(58, 32, 72, 255),
                       dark=(34, 22, 44, 255), light=(112, 68, 132, 255),
                       eye=(214, 40, 54, 255)),
    # 魔王族：旧版用 big_demon（是恶魔，但 32×32 归一化到 16 丢掉了大量像素）
    "demonKing":  dict(shape="demon", body=(146, 62, 150, 255), dark=(84, 30, 92, 255),
                       light=(202, 122, 206, 255), glow=(252, 226, 92, 255)),
    "demonKingTrue": dict(shape="demon", body=(186, 34, 40, 255), dark=(104, 14, 20, 255),
                          light=(240, 96, 88, 255), glow=(252, 226, 92, 255),
                          crown=(250, 214, 84, 255)),
    # ── 人形怪（22 只）：0x72 的人形底图读不出职业与等级 ──────────────
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
    "knightCaptain": dict(shape="knight", **SILVER_A, trim=(250, 216, 98, 255),
                          cape=(148, 32, 40, 255), plume=(250, 216, 98, 255),
                          shield=(110, 116, 132, 255), blade=_STEEL),
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
    "archmage":     dict(shape="mage", robe=(196, 148, 42, 255), dark=(128, 88, 18, 255),
                         light=(248, 214, 106, 255), skin=_SKIN, hat=(160, 116, 28, 255),
                         hat_h=2, beard=(250, 250, 246, 255), beard_len=3,
                         staff=_WOOD, orb=(252, 226, 92, 255), trim=(252, 234, 142, 255)),
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
    "skeletonCaptain": dict(shape="skeleton", bone=(238, 232, 212, 255),
                            joint=(146, 134, 114, 255), armor=(216, 162, 44, 255),
                            trim=(250, 216, 98, 255), helm=(216, 162, 44, 255),
                            blade=(250, 216, 98, 255), shield=(196, 148, 42, 255)),
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
    4 帧 idle，节奏与 0x72 的怪物一致（「吸—回—吸—回」），
    这样 board.ts 的换帧逻辑对新旧两批怪物是同一条路径。

    帧序 [静止, 呼吸, 静止, 呼吸] 与 NPC 的 [静止, 抬, 静止, 抬] 对齐。
    """
    base = mon_art_base(art_id)
    return [base, _mon_squash(base), base, _mon_squash(base)]


def verify_mon_art(bases: dict[str, Image.Image]) -> list:
    """
    程序化怪物造型断言。四条判据，全是「代码里看不出来、只有量才知道」的：

      1. **每个形状的剪影互不相同** —— 抓「画了半天结果都是同一个圆」；
      2. **同形状的变体必须有区别** —— 抓「换色没生效 / 两只一模一样」；
      3. **底行必须有像素** —— 底部锚定下帧底留白 = 怪物浮在半空；
      4. **每个形状至少有一只怪在用它** —— 抓「画了却忘了接进 PROC_MONSTERS」。

    与 NPC 的断言刻意分开：NPC 是「六个各不相同」，怪物是「七种形状、同形状可成族换色」——
    两边的判据不一样，所以不能共用一个函数。
    """
    problems: list[str] = []

    def sil(im: Image.Image):
        a = im.getchannel("A").tobytes()
        return {i for i, v in enumerate(a) if v > 8}

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
            im = bottom_center(fr, 20, 26)
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
    proc_bases: dict[str, Image.Image] = {}

    for mid, (src_name, xf, scale, note) in MONSTERS.items():
        # 源名 "gen" = 本仓库按名称手绘（蝙蝠/史莱姆/龙/乌贼/石头人/吸血鬼/魔王）。
        # 形状与配色在 PROC_MONSTERS，这里只负责出帧 + 记 meta。
        if src_name == "gen":
            if mid not in PROC_MONSTERS:
                missing.append(f"{mid}: MONSTERS 标了 gen，但 PROC_MONSTERS 里没有它的造型")
                continue
            proc_used.add(mid)
            proc_bases[mid] = mon_art_base(mid)
            frames = mon_art_frames(mid)
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

    # 手绘怪物的造型断言：七种形状互不相同、同形状的变体确有区别、帧底不留白
    for p in verify_mon_art(proc_bases):
        missing.append("怪物造型断言失败：" + p)
    # 两张表必须严格一一对应 —— 「在 MONSTERS 里标了 gen 却忘了画」会静默少一只怪
    declared = {mid for mid, (s, _, _, _) in MONSTERS.items() if s == "gen"}
    for mid in sorted(declared - proc_used):
        missing.append(f"{mid}: MONSTERS 标了 gen，但没有产出任何帧")
    for mid in sorted(set(PROC_MONSTERS) - declared - proc_used):
        missing.append(f"{mid}: PROC_MONSTERS 里有造型，但 MONSTERS 没标 gen，接不上")
    hand = len(proc_used)
    print(f"  手绘怪物 {hand} 只 / {len(MON_SHAPES)} 种形状"
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
    print(f"  勇者   {len(HERO_DIRS)} 向 × 4 帧走路 + {len(HERO_DIRS)} 向 × 4 帧挥剑")
    print(f"  NPC    {len(NPC_ART)} 人（程序化手绘）× {len(NPC_DIRS)} 向 × 4 帧")
    total = sum((ATLAS_DIR / m["file"]).stat().st_size for m in manifest["meta"]["atlases"].values())
    print(f"\n  图集总大小 {total/1024:.1f} KB")
    if missing:
        print(f"\n=== 需注意（{len(missing)} 条）===")
        for m in missing[:20]:
            print("  -", m)
    return 0


if __name__ == "__main__":
    sys.exit(main())
