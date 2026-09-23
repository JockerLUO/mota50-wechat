#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-assets.py —— 把 assets/raw 下的原始素材，加工成游戏真正加载的图集 + 映射表。

**本文件是入口，不是实现。**真正的代码在 `tools/assetlib/`，按职责分层：

    config    路径 + 网格常量（唯一一处定义坐标系的地方）
    palette   跨模块共用的调色板
    pixel     像素原语：调色板变换 / 描边 / 写像素
    metrics   量像素的统计量（只服务断言）
    shapes    手绘形状原语（怪物与 BOSS 共用）
    raster    出图归一化 + 放大 + 架子排布
    sources   第三方素材包读取
    data      构建期真值表（哪只怪用哪张图 / 谁是 BOSS）
    terrain   地形     ← 含地形断言
    items     道具     ← 含道具断言
    hero      勇者     ← 含勇者断言
    npc       NPC      ← 含 NPC 比例断言
    monsters  手绘怪物 ← 含怪物断言
    bosses    BOSS     ← 含 BOSS 断言
    main      编排 + 写文件（唯一有副作用的模块）

改素材从 **对应职责的那个模块** 入手（改配色就 `palette.py`、改地图素材就 `terrain.py`），
不要从 `main.py` 倒着找。

为什么要写这个脚本
------------------
素材来自 6 个互不相干的免费包（0x72 / ArMM1998 / Kenney x4 / wareya），
它们的尺寸、朝向顺序、命名规则全都不一样。如果让渲染层直接去引用原件，
「哪只怪物用哪张图」这件事就散落在代码各处，改一次错一次。
本脚本把这件事收敛成三张表（`TERRAIN` / `MONSTERS` / `ITEM_SRC`），可重跑、可核对、可 diff。

三条硬规则
----------
1. raw/ 只读。任何变换都在这里用代码表达，绝不手工修图 —— 否则重跑就冲掉了。
2. 保持 16px **绘制**网格。手绘与程序化坐标都写在这套网格上；出图时统一
   Scale2x 升到 64px 网格（超采样 `SS=4`，连做两遍），运行时按 `DRAW_SCALE=0.5`
   画进 32px 的格子 —— 落屏的设计像素数**一点不变**，但一个素材像素占的设备像素
   少了 4 倍。整数倍最近邻放大，像素画不会被插值糊掉。
   > 注意手绘地形不走超采样：它们本来就直接画在 64 网格上（超采样对它们是空操作）。
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

import sys
from pathlib import Path

# 直接 `python3 tools/build-assets.py` 时，sys.path[0] 已经是本文件所在的 tools/，
# 所以这句本来是多余的。留着是为了挡住两种「不该出现但会出现」的跑法：
#   - `python3 -P` / `PYTHONSAFEPATH=1`（不把脚本目录放进 sys.path）
#   - 从 IDE 里以「模块」方式运行
# 两种情况下 import 会失败，而失败信息只会让人去猜是不是包结构错了。
sys.path.insert(0, str(Path(__file__).resolve().parent))

from assetlib.main import main  # noqa: E402  （必须排在 sys.path 调整之后）

if __name__ == "__main__":
    sys.exit(main())
