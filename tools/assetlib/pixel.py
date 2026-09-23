"""
像素级原语：调色板变换 + 描边 + 逐块写像素。

全部是纯函数（给同样输入出同样像素），共享颜色见 `palette.py`。

`_put()` 是最底层的写像素原语，三个绘制模块都用它 —— 它做的是
「按矩形刷色 + 越界裁剪」，而不是 `ImageDraw.rectangle`，
因为手绘要的是**整数像素的确定性**，不是抗锯齿。
"""

from __future__ import annotations

import colorsys
from .pil import Image

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




def _put(im, x, y, w, h, color):
    """按像素块填色。所有 NPC 造型只用这一个原语 —— 保证是硬边像素画，不是矢量缩放。"""
    if color is None:
        return
    px = im.load()
    for j in range(h):
        for i in range(w):
            if 0 <= x + i < im.width and 0 <= y + j < im.height:
                px[x + i, y + j] = color
