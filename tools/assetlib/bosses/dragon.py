"""
魔龙（`dragon`，第 35 层）—— **正面朝向玩家**：横展双翼 + 方吻张口 + 竖瞳 + 粗腿利爪 + 甩到右下的尾。

## 为什么是正面（而不是「侧视更威风」）

改前是侧视朝左，理由是「正面龙会与魔王撞剪影」。这条理由只对了一半：
两只撞剪影的真正原因是**共用同一套骨架**（对称的角 + 一对膜翼 + 一张脸），
而不是「正面」本身。侧视躲开了撞车，代价是把龙的辨识度全押在**长吻**
这一个记号上 —— 而长吻缩到 64px 后只剩几像素宽的横条，玩家读到的是
「一只大蜥蜴」，不是龙（这也是它被反复改了三次形状的那个东西）。

正面之后，记号改成五条**互相独立**的（任何一条单独成立就够认出来）：

| 记号 | 内容 | 魔王有没有 |
|---|---|---|
| 方吻 + 张口 | 头部下半是一块比头略窄的方形，中间一道黑口 + 交错獠牙 | 无（魔王圆头无吻） |
| 竖瞳 | 金底眼 + 一道**竖直**的缝 | 无（魔王是横的发光条） |
| 颊鳍 | 头两侧向外下收的膜鳍 | 无 |
| 甩尾 | 尾从身体右侧甩到画面右下，末端下勾 | 无（魔王不画尾） |
| 横展翼 | 翼根在肩、向左右外侧展开成 T 形 | 不同（魔王翼是贴身上扬的） |

⚠️ 这五条**没有一条靠颜色** —— 缩到 32px 或转灰度也分得开。

## 头部区域必须严格对称

`verify_boss_art` 的判据 8 量「头部区域（`metrics.HEAD_BAND_RATIO × 画布高` = 前 51 行）
的左右不对称度」，改前实测 39.4%（侧视朝左），阈值 12%。所以本模块里：

- 头 / 吻 / 眼 / 角 / 颊鳍 / 翼 / 肩刺 **全部**走 `_sym` / `ell_pair` / `bar_sym` / `horn_pair`；
- **唯一不对称的尾被压在 y66 以下** —— 保证它不进头部区域。
  这不是巧合，是判据逼出来的布局：尾一旦上移，判据会报红。
"""

from __future__ import annotations

from ..palette import MON_INK
from ..pixel import _put
from ..shapes import _sym
from .common import (
    bar_sym,
    bos_canvas,
    ell_pair,
    ell_sym,
    horn_pair,
    limb_pair,
    scale_band,
    wing_pair,
)

IDS = ("dragon",)

DRAGON = dict(
    body=(198, 62, 52, 255),
    # 膜比身体明显暗一档（不是同色深浅）：同色系的膜在 32px 下会和躯干糊成一片，
    # 整只读成「一团红」，翼就白画了。实测第一版 wing=(104,30,38) 仍然偏红，
    # 现在再压到棕红。
    wing=(96, 34, 30, 255),
    wing_lt=(150, 52, 56, 255),
    belly=(238, 200, 128, 255),
    belly_dk=(190, 146, 82, 255),
    dark=(62, 18, 22, 255),
    eye=(250, 216, 96, 255),
    horn=(232, 226, 206, 255),
    claw=(246, 242, 232, 255),
)

# 尾部**下界**：整条尾必须落在 `metrics.HEAD_BAND_RATIO`（0.53 × 96 = 51）之下。
# 改尾部造型时先回来核这个数 —— 越界会被判据 8 报红（实测改前 39.4%）。
TAIL_TOP = 66


def spec(bid: str) -> dict:
    if bid != "dragon":
        raise KeyError(f"dragon 模块不负责 {bid}")
    return dict(DRAGON)


def draw(s: dict, bid: str):
    im = bos_canvas()
    body, wing, wing_lt = s["body"], s["wing"], s["wing_lt"]
    belly, belly_dk = s["belly"], s["belly_dk"]
    dark, eye, horn, claw = s["dark"], s["eye"], s["horn"], s["claw"]

    # ── ① 双翼（最里层）：翼根在**肩的外缘**（x26），向左右**上外**张到画布角 ──
    #
    # 两个坑，都是实测出来的：
    #  ① 展开方向。第一版照蝙蝠那样「向上外扬」但翼根放在躯干中心（x38），
    #     26 列全部落在躯干（rx=28）之内 —— 落屏后**根本看不到翼**。
    #     翼根必须在躯干**之外**，外侧才轮得到膜。
    #  ② 上扬 vs 下垂。第二版改成向下展开：面积是够了，但与魔王的「贴身上扬
    #     膜翼」撞了形态（两只都成了「下垂的膜」）。现在这只**上扬到画布角**、
    #     魔王**贴身上扬且下缘到 y70**，两者的上下界完全不同。
    wing_pair(im, shoulder=26,
              fan=(24, 46, 62, 6, 30, (0, 6, 12, 18), 6),
              rib=body, mem=wing, edge=5,
              spots=((16, 30, 5, 3), (10, 20, 5, 3), (20, 44, 5, 4)))
    _sym(im, 14, 24, 4, 2, wing_lt)                    # 翼膜上的亮脉
    _sym(im, 19, 38, 4, 2, wing_lt)
    _sym(im, 4, 14, 5, 6, claw)                        # 翼尖的钩爪

    # ── ② 尾：从身体右侧甩出，末端收成箭尖（y 全部 ≥ TAIL_TOP） ───────
    _put(im, 66, TAIL_TOP, 28, 8, body)
    _put(im, 86, TAIL_TOP + 6, 8, 14, body)
    _put(im, 80, TAIL_TOP + 16, 12, 8, body)
    for k in range(5):                                 # 尾上的环纹（三阶）
        _put(im, 68 + k * 5, TAIL_TOP + 2, 3, 6, dark)
    _put(im, 86, TAIL_TOP + 2, 3, 6, dark)
    _put(im, 78, TAIL_TOP + 21, 4, 6, claw)            # 尾刺

    # ── ③ 腿 + 脚 + 每脚三只爪（爪踩在最后一行 —— 底行必须有像素） ────
    limb_pair(im, x0=28, y0=56, w=14, h=28, base=body, dark=dark,
              light=belly, edge=4)
    scale_band(im, x0=29, y=60, cols=3, rows=2, step=6, base=dark, dark=dark, mirror=True)
    _sym(im, 22, 82, 20, 10, body)                     # 脚掌
    _sym(im, 22, 86, 20, 1, dark)                      # 脚掌与趾的分界
    for k in range(3):                                 # 三只爪（坐标成对，走 `_sym`）
        _sym(im, 23 + k * 7, 88, 5, 8, claw)
    _sym(im, 24, 87, 1, 2, dark)                       # 趾缝

    # ── ④ 躯干：**宽胸 + 收腰**（两段叠加），腹甲从中线一条铺下来 ─────
    #
    # 单一椭圆（rx = ry）落屏后读成「甲虫的圆壳」—— 兽形靠的是轮廓起伏。
    ell_sym(im, 54, 24, 16, body)
    ell_sym(im, 64, 21, 13, body)
    ell_sym(im, 58, 11, 15, belly)
    for k in range(4):                                 # 腹甲横排（甲片感）
        bar_sym(im, 48 + k * 6, 9, belly_dk)
    _sym(im, 25, 44, 5, 18, wing)                      # 两侧压暗（三阶）
    _sym(im, 28, 34, 4, 10, wing_lt)                   # 侧面亮阶
    bar_sym(im, 44, 3, belly, h=6)                     # 胸口中线提亮

    # ── ⑤ 颈（两侧对称压暗） ────────────────────────────────────────
    bar_sym(im, 34, 12, body, h=14)
    _sym(im, 34, 34, 4, 14, dark)

    # ── ⑥ 头盖（比躯干窄）+ 颊鳍 ────────────────────────────────────
    ell_sym(im, 24, 16, 16, body)
    bar_sym(im, 6, 13, body, h=5)                      # 颅顶加宽一点
    for k in range(9):                                 # 颊鳍：向外下收的膜
        _sym(im, 28 - k, 26 + k, 2, 12 - k, dark)
    for k in range(4):
        _sym(im, 26 - k, 28 + k, 1, 3, wing_lt)

    # ── ⑦ 方吻：**比头窄**（x37..59 vs 头盖 x32..64） ────────────────
    #
    # 这一步是「楔形头」的全部。第一版把吻做成与头齐宽，1:1 落屏后读出来是
    # 「一张圆脸 + 一张大嘴」，仍然是「放大的杂兵」，不是龙。
    bar_sym(im, 31, 10, body, h=15)
    bar_sym(im, 31, 10, belly, h=1)                    # 吻背亮线：头与吻的分界
    bar_sym(im, 38, 8, MON_INK, h=4)                   # 口腔
    _sym(im, 40, 38, 4, 4, claw)                       # 上獠牙（朝下，两对）
    _sym(im, 45, 38, 3, 3, claw)
    _sym(im, 43, 41, 3, 3, claw)                       # 下獠牙（朝上，一对）
    _sym(im, 40, 34, 3, 2, MON_INK)                    # 鼻孔
    bar_sym(im, 45, 10, dark, h=2)                     # 吻的下缘暗面

    # ── ⑧ 眼 + **竖瞳** + 眉脊 + 额脊 ───────────────────────────────
    ell_pair(im, 37, 22, 7, 6, eye)
    _sym(im, 35, 16, 3, 13, MON_INK)                   # 竖瞳（左右各一道）
    _sym(im, 31, 14, 6, 3, dark)                       # 眉脊
    bar_sym(im, 8, 4, dark, h=3)                       # 额脊（跨轴，天然对称）

    # ── ⑨ 双角：从头顶两侧向上外弯（比魔王短而粗、**只有一段**）+ 环纹 ──
    horn_pair(im, segs=((30, 11, 17, 1, 8),), color=horn, thick=8,
              rings=((23, 6, 7, 2), (18, 2, 6, 2)))

    return im
