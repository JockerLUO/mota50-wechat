#!/usr/bin/env python3
"""
把两张「同一裁剪区域」的实机截图拼成一张前后对比图。

为什么需要它：
  视觉改动最怕的就是「我记得以前不是这样」。把 before/after 摆在同一张图上，
  差异就变成可核对的证据，而不是记忆。裁剪区域必须一致 —— 否则你看到的
  「变化」可能只是取景不同。

对齐方式（关键）：
  两张图的裁剪矩形可能差几个像素（工具版本不同）。这里**不靠文件尺寸对齐**，
  而是各自去找棋盘面板的描边线（theme 里的 panelBorder = #d7dfeb），
  以面板左上角为原点取同样大的窗口。面板是画面上唯一的浅灰描边矩形，
  用它当锚点比假设「裁剪一定对称」可靠。

用法：
  python3 tools/make-comparison.py --before a.png --after b.png --out c.png \
      --title "第 1 层 · 视觉美化第二轮" \
      --zoom 224,384,320,320 --zoom-label "怪物名牌区域 2×"
"""

import argparse
import sys

from PIL import Image, ImageDraw, ImageFont

BORDER = (0xD7, 0xDF, 0xEB)  # theme.panelBorder
TOL = 14
FONT_CANDIDATES = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/PingFang.ttc",
]


def load_font(size: int):
    for p in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def near(a, b, tol=TOL) -> bool:
    return all(abs(x - y) <= tol for x, y in zip(a, b))


def find_panel_origin(im: Image.Image) -> tuple[int, int]:
    """
    找面板描边的左上角。

    描边是一圈细线，所以从画面中部往左/往上扫，第一条命中的线就是面板边。
    比「假设裁剪留白固定」稳，因为它直接读画面本身。
    """
    px = im.load()
    w, h = im.size
    mid_y, mid_x = h // 2, w // 2

    left = None
    for x in range(0, w):
        if near(px[x, mid_y], BORDER):
            left = x
            break
    top = None
    for y in range(0, h):
        if near(px[mid_x, y], BORDER):
            top = y
            break

    if left is None or top is None:
        raise SystemExit(
            "找不到面板描边（#d7dfeb）。是不是截图里没有棋盘？或者主题色改了 —— "
            "改了的话同步更新本文件的 BORDER。"
        )
    return left, top


def crop_panel(im: Image.Image, size: tuple[int, int]) -> Image.Image:
    """以面板左上角为原点，取固定大小的窗口。"""
    ox, oy = find_panel_origin(im)
    w, h = size
    box = (ox, oy, ox + w, oy + h)
    if box[2] > im.width or box[3] > im.height:
        raise SystemExit(
            f"对齐后窗口 {box} 超出图像 {im.size}。两张截图的裁剪范围差太多，"
            f"请用同一套参数重新截。"
        )
    return im.crop(box)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", required=True)
    ap.add_argument("--after", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--title", default="")
    ap.add_argument("--before-label", default="美化前")
    ap.add_argument("--after-label", default="美化后")
    ap.add_argument(
        "--zoom",
        action="append",
        default=[],
        help="放大区域 x,y,w,h（相对面板原点，CSS/图像像素按截图自身 dpr 算）",
    )
    ap.add_argument("--zoom-label", action="append", default=[])
    ap.add_argument("--zoom-scale", type=int, default=2)
    ap.add_argument("--panel-size", type=int, default=730)
    args = ap.parse_args()

    before = Image.open(args.before).convert("RGB")
    after = Image.open(args.after).convert("RGB")
    box = (args.panel_size, args.panel_size)
    before = crop_panel(before, box)
    after = crop_panel(after, box)

    f_title = load_font(34)
    f_label = load_font(24)
    f_small = load_font(18)

    gap = 18
    pad = 22
    # 标题和「前/后」标签都要放在画面上沿之外，所以头部高度按「标题高 + 标签高」留，
    # 写死一个小值会让标题压到标签上（第一版就是这样）
    head = 104 if args.title else 62
    board_w, board_h = before.size
    row_w = board_w * 2 + gap

    zoom_blocks = []
    for i, spec in enumerate(args.zoom):
        try:
            x, y, w, h = (int(v) for v in spec.split(","))
        except ValueError:
            raise SystemExit(f"--zoom 需要 x,y,w,h 四段数字，收到 {spec!r}")
        label = args.zoom_label[i] if i < len(args.zoom_label) else ""
        s = args.zoom_scale
        pair = []
        for src in (before, after):
            region = src.crop((x, y, x + w, y + h))
            pair.append(region.resize((w * s, h * s), Image.NEAREST))
        zoom_blocks.append((pair, label, w * s, h * s))

    # 放大块**竖着排**，每行一组「前 | 后」。
    # 横着排会在放大倍数高的时候冲出画布宽度（第一版就被截掉了）。
    zoom_h = 0
    per_row_h = []
    for _pair, _label, _w, hpx in zoom_blocks:
        per_row_h.append(hpx + 34)
        zoom_h += hpx + 34

    total_w = pad * 2 + row_w
    total_h = head + board_h + (gap + zoom_h if zoom_blocks else 0) + pad
    canvas = Image.new("RGB", (total_w, total_h), (0xF2, 0xF5, 0xFA))
    d = ImageDraw.Draw(canvas)

    if args.title:
        d.text((pad, 16), args.title, font=f_title, fill=(0x0F, 0x17, 0x2A))

    y0 = head
    canvas.paste(before, (pad, y0))
    canvas.paste(after, (pad + board_w + gap, y0))

    # 标题条：前后各一条，压在画面上沿外侧
    d.text((pad, y0 - 34), args.before_label, font=f_label, fill=(0x64, 0x74, 0x8B))
    d.text(
        (pad + board_w + gap, y0 - 34), args.after_label, font=f_label, fill=(0x25, 0x63, 0xEB)
    )

    if zoom_blocks:
        yz = y0 + board_h + gap
        for (pair, label, wpx, hpx) in zoom_blocks:
            if label:
                d.text((pad, yz), label, font=f_small, fill=(0x64, 0x74, 0x8B))
            yz += 26
            canvas.paste(pair[0], (pad, yz))
            canvas.paste(pair[1], (pad + wpx + 10, yz))
            yz += hpx + 8

    canvas.save(args.out)
    print(f"已保存 {args.out}  {canvas.size[0]}×{canvas.size[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
