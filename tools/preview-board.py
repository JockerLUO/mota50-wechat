#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
preview-board.py —— 用 MANIFEST.json 拼一张「模拟棋盘」。

为什么要单独做这个
------------------
图集平铺出来好看，不代表摆进 11×11 的格子里也好看。素材来自 6 个包，
风格是否真的兼容，只有按真实比例、真实邻接关系拼一次才知道。
这个脚本就是那次「拼一次」——它读的是游戏运行时同一份 MANIFEST，
所以它显示什么，游戏里就会显示什么。

用法
----
    python3 tools/preview-board.py
产物
----
    assets/preview/mock-board.png
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
MANIFEST = json.loads((ASSETS / "MANIFEST.json").read_text(encoding="utf-8"))

CELL = MANIFEST["meta"]["cell"]        # 32
GRID = 11
PAD = 12

# ── 先声明「这一格放什么」，再统一渲染 ─────────────────────────────
# 布局刻意覆盖了所有需要检验的组合：三色门相邻、墙顶边、蜘蛛网式的
# 怪物密度、以及道具叠在怪物旁边。真实楼层就是这样。
#
#   # 墙   . 空地   y/b/r 三色门   ^ 上楼梯   v 下楼梯   ~ 岩浆
#   D 牢门   a 自动门   * 星级空间   w 假墙
LAYOUT = [
    "###########",   # 0
    "#..#...y..#",   # 1
    "#..#......#",   # 2
    "#.b#...r..#",   # 3
    "#.....^...#",   # 4
    "#..D......#",   # 5
    "#..#...~..*",   # 6
    "#..#......#",   # 7
    "#.....v...#",   # 8
    "#..w...a..#",   # 9
    "###########",   # 10
]

# 怪物按格子坐标布置（x, y, 怪物 id, 动作, 帧）
MONSTERS = [
    (4, 1, "skeleton", "idle", 0),
    (8, 2, "greenSlime", "idle", 1),
    (3, 4, "bat", "idle", 0),
    (8, 4, "juniorMage", "idle", 2),
    (4, 5, "orc", "idle", 0),
    (8, 6, "juniorGuard", "idle", 1),
    (2, 8, "slimeKing", "idle", 3),
    (9, 8, "dragon", "idle", 2),
    (5, 9, "demonKing", "idle", 0),
]

ITEMS = [
    (2, 2, "redPotion"),
    (6, 2, "yellowKey"),
    (2, 4, "ironSword"),
    (9, 4, "blueGem"),
    (6, 6, "bomb"),
    (9, 6, "quakeScroll"),
    (2, 9, "cross"),
]

NPC = (5, 5, "merchant")
HERO = (5, 6, "walk", "down", 1)


def sprite(atlas_name: str, x: int, y: int, w: int, h: int) -> Image.Image:
    atlas = Image.open(ASSETS / "atlas" / f"{atlas_name}.png").convert("RGBA")
    return atlas.crop((x, y, x + w, y + h))


def mon_sprite(node: dict, frame: dict) -> Image.Image:
    """怪物的帧尺寸在组级（monster.frame），帧对象里只有 x,y。"""
    f = node["frame"]
    return sprite(node["atlas"], frame["x"], frame["y"], f["w"], f["h"])


def actor_sprite(node: dict, frame: dict) -> Image.Image:
    """角色的帧尺寸在帧上（走路与挥剑的宽高不同）。"""
    return sprite(node["atlas"], frame["x"], frame["y"], frame["w"], frame["h"])


def draw_char(canvas: Image.Image, cx: int, cy: int, im: Image.Image, scale: int) -> None:
    """
    把角色贴到格子里 —— 水平居中、底边贴齐格子下沿。

    这个对齐规则和渲染层必须完全一致：俯视游戏里精灵「脚踩格子底边」
    才站得住，居中的话会像浮在半空。
    """
    w, h = im.width * scale, im.height * scale
    up = im.resize((w, h), Image.NEAREST)
    x = cx + (CELL - w) // 2
    y = cy + CELL - h
    canvas.alpha_composite(up, (x, y))


def main() -> int:
    W = GRID * CELL + PAD * 2
    canvas = Image.new("RGBA", (W, W), (24, 20, 32, 255))

    terr = MANIFEST["terrain"]

    def cell_xy(col: int, row: int) -> tuple[int, int]:
        return PAD + col * CELL, PAD + row * CELL

    # ── 1. 地形 ──────────────────────────────────────────────────
    for row in range(GRID):
        for col in range(GRID):
            ch = LAYOUT[row][col]
            code = {
                "#": "1", ".": "0", "y": "7", "b": "8", "r": "9",
                "^": "4", "v": "3", "~": "5", "D": "2", "a": "10",
                "*": "6", "w": "11",
            }[ch]
            node = terr.get(code)
            if node is None:
                continue
            # 假墙必须和真墙长得一样，否则玩法失效 —— 这里显式断言一次
            if ch == "w":
                node = terr["1"]
            # 上方没有墙时用「顶边」变体，地牢才有立体感
            if code == "1" or ch == "w":
                above = row > 0 and LAYOUT[row - 1][col] in "#w"
                if not above and "1:top" in terr:
                    node = terr["1:top"]
            im = sprite(node["atlas"], node["x"], node["y"], node["w"], node["h"])
            im = im.resize((CELL, CELL), Image.NEAREST)
            canvas.alpha_composite(im, cell_xy(col, row))

    # ── 2. 道具（先画，让怪物压在上面） ─────────────────────────
    # 缩放规则必须和渲染层 `src/render/atlas.ts` 的 fitSize() 一致：
    # **等比填进 (CELL-4) 的方框、底部居中**。
    # 不能像以前那样一律 resize 成方形 —— 剑是 10×21、药水是 16×16、金币是 8×8，
    # 拉平方会把剑压扁加宽，一眼看出变形。预览图一旦和实际不符就失去意义了。
    ITEM_BOX = CELL - 4
    for col, row, iid in ITEMS:
        node = MANIFEST["items"].get(iid)
        if not node:
            print(f"  ! 道具 {iid} 无素材")
            continue
        x, y = cell_xy(col, row)
        im = sprite(node["atlas"], node["x"], node["y"], node["w"], node["h"])
        w, h = im.size
        s = ITEM_BOX / max(w, h)
        tw, th = max(1, round(w * s)), max(1, round(h * s))
        im = im.resize((tw, th), Image.NEAREST)
        canvas.alpha_composite(im, (x + (CELL - tw) // 2, y + CELL - th))

    # ── 3. NPC ───────────────────────────────────────────────────
    col, row, npc_id = NPC
    npc = MANIFEST["actors"]["npcs"].get(npc_id)
    if npc:
        draw_char(canvas, *cell_xy(col, row), actor_sprite(npc, npc["walk"]["down"][0]), npc["drawScale"])

    # ── 4. 怪物 ──────────────────────────────────────────────────
    for col, row, mid, anim, fi in MONSTERS:
        node = MANIFEST["monsters"].get(mid)
        if not node:
            print(f"  ! 怪物 {mid} 无素材")
            continue
        frames = node[anim]
        im = mon_sprite(node, frames[fi % len(frames)])
        draw_char(canvas, *cell_xy(col, row), im, node["drawScale"])

    # ── 5. 勇者 ──────────────────────────────────────────────────
    col, row, anim, d, fi = HERO
    hero = MANIFEST["actors"]["hero"]
    hero_im = actor_sprite(hero, hero[anim][d][fi])
    x, y = cell_xy(col, row)
    draw_char(canvas, x, y, hero_im, hero["drawScale"])
    # 勇者定位框：和游戏里一样，让玩家一眼找到自己
    hl = Image.new("RGBA", (CELL + 4, CELL + 4), (0, 0, 0, 0))
    px = hl.load()
    for i in range(CELL + 4):
        for t in range(2):
            for p in ((i, t), (i, CELL + 3 - t), (t, i), (CELL + 3 - t, i)):
                px[p] = (250, 214, 96, 190)
    canvas.alpha_composite(hl, (x - 2, y - 2))

    canvas.convert("RGB").save(ASSETS / "preview" / "mock-board.png")
    print(f"✓ assets/preview/mock-board.png  {canvas.width}×{canvas.height}")
    print(f"  格子 {CELL}px × {GRID} 格　含 {len(MONSTERS)} 怪物 / {len(ITEMS)} 道具 / 1 NPC / 1 勇者")
    return 0


if __name__ == "__main__":
    sys.exit(main())
