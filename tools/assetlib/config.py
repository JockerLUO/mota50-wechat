"""
路径与网格常量 —— 全部绘制的坐标系都定在这里。

`SS` 是唯一一个「牵一发动全身」的数字：绘制网格、出图网格、绘制倍数全由它派生，
而落屏尺寸必须**不随它变**（`verify-visual` 的 A17 断言这件事）。
所以改 SS 的正确姿势是只改这一行，其余派生量别手写。
"""

from __future__ import annotations

from pathlib import Path

# ⚠️ 拆成包之后这里从 `parent.parent` 改成了 `parents[2]`：
# 本文件现在在 tools/assetlib/ 下，比原来的 tools/build-assets.py 多一层。
# 这是整个拆分里**唯一**一处「文件位置本身就是语义」的地方 ——
# 别照抄别处的相对层数，也别把 config.py 往下再挪。
ROOT = Path(__file__).resolve().parents[2]


RAW = ROOT / "assets" / "raw"


ATLAS_DIR = ROOT / "assets" / "atlas"


PREVIEW_DIR = ROOT / "assets" / "preview"



BASE_TILE = 16          # 精灵的**绘制网格**边长（所有手绘 / 程序化坐标都在这套网格上）


CELL = 32               # 游戏棋盘的格子边长（设计像素，不随素材网格变化）



# ── 超采样：让「落屏像素点」更密 ─────────────────────────────────
# 素材画在 16 网格上、运行时放大到 32px 的格子；在 dpr=3 的手机上，
# 一个素材像素要占好几个设备像素 —— 画面的颗粒感来源就是这个，不是渲染器。
# 所以「更精细」要做的是**在高网格上出图**：帧尺寸 ×SS、drawScale ÷ SS，
# 落屏的设计像素数一点不变（verify-visual 的 A17 断言这件事）。
#
# 放大算法是 Scale2x 而不是双线性：它按 4 邻域决定 2×2 块里的对角填充，
# 消掉阶梯锯齿的同时**保留硬边**，像素画不会变糊。
#
# ⚠️ SS=4 是 Scale2x 连做两遍。第二遍会把第一遍的 1px 直角磨圆 —— 对第三方
# 位图（信息上限 16×16）这是可接受的代价（轮廓更平滑），但**程序化手绘的地形
# （地板、墙、楼梯）不这么走**：它们直接画在 RASTER_TILE 网格上（见「四、素材源」），
# 超采样对它们是空操作。手绘在高网格上 = 真·细节翻倍；超采样 = 只把已有信息摊细。
SS = 4


SS_PASSES = SS.bit_length() - 1     # 4 → 2 次 Scale2x


RASTER_TILE = BASE_TILE * SS        # 64：图集里瓦片的边长


DRAW_SCALE = CELL / RASTER_TILE     # 0.5：帧是落屏网格的 2 倍密，绘制时缩小一半


BIG_SCALE = 3                       # 「大家伙」落屏仍是 16 网格 ×3 = 48px（表里的
