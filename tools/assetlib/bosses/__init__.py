"""
BOSS 素材包 —— **一只 BOSS 一个文件**。

```
bosses/
  common.py    网格常量、共享骨架原语、镜像轴精确对称原语、断言
  skeleton.py  骷髅队长（第 10 层）
  knight.py    骑士队长（第 40 / 42 层）
  vampire.py   吸血鬼伯爵
  mage.py      大法师（第 25 层）
  kraken.py    巨型乌贼（第 15 层）
  dragon.py    魔龙（第 35 层）
  demon.py     魔王 / 真魔王（第 50 层 / 终局，共用一套骨架）
```

## 这个包为什么存在

改一只 BOSS 的造型只应该碰一个文件。拆包之前 `bosses.py` 是 927 行，
八只 BOSS 的造型 + 配色表 + 断言挤在一起 —— 想调魔龙的吻部要在 600 行附近改造型、
在 800 行附近改配色，两边都不是「这只龙」的地方。

## 接口（每个造型模块必须导出三样）

| 名字 | 内容 |
|---|---|
| `IDS` | 该模块负责的 id 元组（`demon` 有两个形态，它们共用一套骨架） |
| `spec(bid) -> dict` | 该 BOSS 的配色，**只含它自己用到的键** |
| `draw(s, bid) -> Image` | 造型。入参 `s` 就是 `spec(bid)` 的返回值 |

`bid` 一直传到 `draw` 里，是因为 `demon` 要用它区分普通形态与真身
（两者骨架不同，不是换色）。

## 本模块只做转发

真正的门面在 `common.py`。这里重新导出是为了让外部（`main.py` / 预览脚本）
只认 `assetlib.bosses` 这一个入口，不必知道内部拆成了几个文件。

⚠️ **`common.py` 里的常量必须先定义完，才能 import 造型模块** —— 造型模块
`from .common import BOS_CX, ...`，而那一步会撞上一个「已进入 sys.modules、
但只执行到一半」的 `common`。所以 `common.py` 里那句 `from . import demon, ...`
被刻意压在文件靠后的位置，前面任何东西都不许插到它下面。
"""

from .common import (  # noqa: F401
    ART_SOURCE,
    ART_SOURCES,
    BOS_CX,
    BOS_H,
    BOS_W,
    BOSS_DRAW_SCALE,
    BOSS_TILES,
    boss_art_base,
    boss_art_frames,
    boss_art_source_of,
    boss_ids,
    verify_boss_art,
    verify_boss_source_switch,
)

__all__ = [
    "ART_SOURCE",
    "ART_SOURCES",
    "BOS_CX",
    "BOS_H",
    "BOS_W",
    "BOSS_DRAW_SCALE",
    "BOSS_TILES",
    "boss_art_base",
    "boss_art_frames",
    "boss_art_source_of",
    "boss_ids",
    "verify_boss_art",
    "verify_boss_source_switch",
]
