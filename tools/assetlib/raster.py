"""
出图归一化与放大：Scale2x 超采样、内容框对齐、架子排布。

## 「放大到多少」对两类素材是两套规则，别用一个函数

地形 → 统一放大到 `RASTER_TILE`（`terrain_raster`，while 循环）；
角色/怪物/BOSS → **源 ×SS**（`supersample`，固定次数）。

门是个反例：它的源本就 32×32，按 ×SS 会到 128×128、落屏 64px（一扇门顶两格宽）——
所以门走的是 `terrain_raster` 那条。

⚠️ 超采样**不创造信息**：第三方 16×16 位图摊到 64 网格只是把同一批像素占的地方变小。
要真细节只能手绘在高网格上（地形就是这么做的）。
"""

from __future__ import annotations

from .pil import Image
from .config import RASTER_TILE, SS, SS_PASSES



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
