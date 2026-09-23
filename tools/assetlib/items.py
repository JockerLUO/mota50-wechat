"""
道具图标：钥匙/药水/宝石等的手绘，以及道具断言。

道具是最小的一批素材（32 项），但配色判据最细：`verify_items` 要核对
「钥匙的齿形色相」与「底图色相」的关系，防止改色时把钥匙改得不像钥匙。
"""

from __future__ import annotations

from .pil import Image, ImageDraw
from .config import BASE_TILE
from .palette import INK
from .pixel import add_outline
from .metrics import dominant_hue, key_accent_hue
from .data import KEY_HUE_EXPECT



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
