"""
量像素的各种统计量 —— **只服务于断言，不参与出图**。

单独一层是因为这些函数的调用者横跨地形 / 勇者 / NPC / 怪物 / BOSS 五个模块，
而它们彼此之间没有从属关系。

⚠️ 两个量法上的坑（都写在各自的 docstring 里，这里只提醒存在）：
「实心像素」与「非透明像素」是两个不同的量法（`SOLID_ALPHA`），
以及「含中心的那一段宽度」与「最左到最右跨度」也是两个不同的量法 ——
用错会让整组断言假绿或假红。
"""

from __future__ import annotations

import colorsys
import math
from .pil import Image, ImageFilter



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




def _art_rows(im: Image.Image) -> tuple[int, int]:
    """素材内容所占的行区间 [top, bottom]（含端点）。全透明返回 (h, -1)。"""
    a = im.getchannel("A")
    rows = [y for y in range(im.height) if any(a.getpixel((x, y)) for x in range(im.width))]
    return (rows[0], rows[-1]) if rows else (im.height, -1)



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
