"""
第三方素材包的读取入口。

6 个包的目录结构与命名规则都不一样，全部收敛在这里 ——
其余模块只认 `o72()` / `ken()` 这样的取图函数，不碰原始路径。

`raw/` 只读：任何变换都在代码里表达，绝不手工修图（否则重跑就冲掉了）。
"""

from __future__ import annotations

from pathlib import Path
from .pil import Image
from .config import BASE_TILE, RAW



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
