#!/usr/bin/env python3
"""
把 8 只 BOSS 的静止帧排成一张**目视核对图**：每只按 1:1 落屏尺寸画两遍
（左边灰底看剪影、右边棋盘底看实际观感），并叠 32px 格子线。

为什么单独一个脚本，而不是复用 `assets/preview/atlas-monsters.png`：
那张图把 BOSS 和三十几只杂兵混在一张 512 宽的图集里，BOSS 只有 96px 的一小块，
「重绘之后到底好没好」在那种尺寸下根本看不出来。这个脚本专门为
「一次看全 8 只 + 看清格子对齐」而写。

用法：
    PYTHON=/Users/jockerluo/.workbuddy/binaries/python/envs/default/bin/python \\
        tools/build-assets.py --preview-bosses
或直接：
    tools/preview-bosses.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from assetlib.bosses import BOS_W, BOSS_DRAW_SCALE, boss_art_frames, boss_ids  # noqa: E402
from assetlib.config import CELL, ROOT  # noqa: E402
from assetlib.pil import Image, ImageDraw  # noqa: E402

# 落屏倍数（= 1 / BOSS_SS）。帧是 192，乘上它就是**落屏的 96px** ——
# 预览图要看的正是「玩家看到的那一版」，所以跟着 MANIFEST 那条规则走，
# 不在这里另写一个缩放。
SCALE = BOSS_DRAW_SCALE


def _checker(size: int, a=(214, 218, 226, 255), b=(238, 240, 245, 255), step: int = 8):
    im = Image.new("RGBA", (size, size), a)
    px = im.load()
    for y in range(size):
        for x in range(size):
            if ((x // step) + (y // step)) % 2:
                px[x, y] = b
    return im


def main() -> int:
    ids = list(boss_ids())
    cols = 4
    rows = (len(ids) + cols - 1) // cols
    pad = 18
    label_h = 20
    # 每只占两格宽（96*2）留 1 格间隙，是为了让「它压住几格」一眼可见
    cell_w = BOS_W * 2 + CELL
    cell_h = BOS_W * 2 + label_h

    W = cols * cell_w + pad * 2
    H = rows * cell_h + pad * 2
    out = Image.new("RGBA", (W, H), (250, 250, 252, 255))
    d = ImageDraw.Draw(out)

    # 画布上的 32px 格子线 —— 「精灵中心 = 格子中心、脚踩占位块下沿」靠它核对
    for y in range(pad, pad + rows * cell_h, 32):
        d.line([(0, y), (W, y)], fill=(228, 231, 238, 255))
    for x in range(pad, W, 32):
        d.line([(x, 0), (x, H)], fill=(228, 231, 238, 255))

    for i, bid in enumerate(ids):
        col, row = i % cols, i // cols
        ox = pad + col * cell_w
        oy = pad + row * cell_h
        # `boss_art_frames` 现在恒返回 1 帧（呼吸在渲染层）—— 仍然按列表遍历，
        # 让「某天加了帧」这件事不需要改这里。
        for im in boss_art_frames(bid):
            w = int(round(im.width * SCALE))
            h = int(round(im.height * SCALE))
            if SCALE != 1:
                im = im.resize((w, h), Image.NEAREST)
            # 左：深底看剪影与描边；右：浅棋盘底看实际观感（游戏里是浅色地板）
            dark = Image.new("RGBA", (w, h), (54, 58, 70, 255))
            dark.alpha_composite(im)
            out.alpha_composite(dark, (ox, oy + label_h))
            light = _checker(w)
            light.alpha_composite(im)
            out.alpha_composite(light, (ox + w + 8, oy + label_h))
        d.text((ox + 2, oy + 5), f"{bid}", fill=(30, 34, 44, 255))

    dest = ROOT / "assets" / "preview" / "bosses.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    out.convert("RGB").save(dest)
    print(f"已写出 {dest.relative_to(ROOT)} —— {out.width}×{out.height}，{len(ids)} 只 ×2 遍")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
