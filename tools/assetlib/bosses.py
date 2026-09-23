"""
BOSS：8 只，64 网格 1:1 落屏（不走超采样、不缩倍数）。

## 为什么单独立一层

BOSS 的落屏规则与杂兵不同：`BOSS_DRAW_SCALE` 恒为 1.0，
而 `MONSTERS` 表里那一列对它们统一写 1（**故意留着误导不了的写法**：
写 3 会让人以为改那里能放大 BOSS）。这条有断言兜底。

## 「画得比一格大」是刻意的

大块头本身是层级信号。所以 `OVERSIZE_BOSSES` 与「玩法上的 BOSS」是两张名单，
A6 断言靠它们的差集工作（见 `data.py`）。
"""

from __future__ import annotations

from .pil import Image
from .palette import MON_INK, MON_WHITE, SILVER_A
from .pixel import _put, add_outline
from .metrics import _detail_density, _head_asym, _inner_detail, _solid_set
from .shapes import (
    _beam,
    _beam_sym,
    _bez,
    _ell,
    _gem,
    _half,
    _rivets,
    _scales,
    _sym,
    _tentacle,
    _wing_draw,
    _wing_fan,
)
from .data import BOSS_IDS


# `verify_boss_art` 用的门槛。三个都是「先量、再定」的 —— 每一版素材都要重新量
# 改前/改后的分布，阈值定在**改前必红、改后有余量**的位置，否则它只是一条
# 永远为真的装饰性断言（见 §「断言红了先怀疑期望值」那条铁律的反向用法）。
#
# BOSS_DETAIL_MIN：每个 8×8 块的**中位**独立颜色数。
#   实测（2026-09-23 定稿这一版）：改前 2.0 ~ 3.0，改后 **3.0 ~ 4.0**。
#   门槛取 3.0 —— 改前 vampire 恰好是 2.0（大面积纯色斗篷），会被这条抓住。
#   ⚠️ 改后有 5 只**恰好落在 3.0**：这就是地板值本身，掉一色即红，
#   是刻意的（它保护的就是「每个 8×8 区域至少三色」这件事）。
# BOSS_INNER_MIN：只统计**身体内部**（离透明边缘 ≥2px）的 4×4 块，
#   取均值。为什么要它：8×8 密度里**轮廓线**贡献很大，边缘复杂但内部偷懒的
#   造型也能过线。实测改前 1.61 ~ 2.13、改后 **1.97 ~ 2.28**，门槛 1.8。
# BOSS_HEAD_SYM_MAX：正面朝向的 BOSS，头部区域的不对称像素占比上限。
#   实测：改前 dragon（侧视）39.4%、demonKingTrue 15.1%（角与手臂左右各差
#   1~7 列，之前没人发现）；改后最大 2.3%。门槛 12% 留足余量。
# BOSS_SIL_MIN_DIFF：两只 BOSS 剪影至少差这么多像素。不写「不相等」是因为
#   差 1 个像素也叫不相等 —— 那种判据拦不住「八只都长一个样、只是换了色」。
BOSS_DETAIL_MIN = 3.0


BOSS_INNER_MIN = 1.80


BOSS_HEAD_SYM_MAX = 0.12


BOSS_SIL_MIN_DIFF = 400



# 哪些 BOSS 是**正面朝向玩家**的（判据 7 只对它们生效）。
#
# 名单写死、而不是「对所有 BOSS 都量对称度」：骷髅队长手持圆盾、骑士队长
# 手持大剑、法师抱着法杖、吸血鬼**刻意**做成不对称（竖领一高一低、斗篷偏披）
# —— 这些是合法的不对称，全局判据会把它们全部误杀。
# 往名单里加一只之前，先确认它的不对称**全部**来自剧情道具或刻意的站姿。
HEAD_FRONT = ("dragon", "demonKing", "demonKingTrue", "kraken")




# ════════════════════════════════════════════════════════════════════
# BOSS：64 网格的独立绘制体系（2026-09-23）
# ════════════════════════════════════════════════════════════════════
#
# ## 为什么 BOSS 要另开一套网格，而不是把 32 网格的造型放大
#
# ① **要更大。** 改前 8 只玩法 BOSS 里只有 4 只放大（`drawScale 0.75` → 落屏 48px），
#    另外 4 只（骷髅队长 / 骑士队长 / 吸血鬼 / 大法师）与杂兵同为 32px ——
#    「BOSS 比杂兵大」这第一眼信号，有一半的 BOSS 是缺的，而且缺的正好是前中期的。
#
# ② **要更精致，而 32 网格给不了。** 32 网格的素材落到 48px 屏上，等于把每个源像素
#    摊成 1.5 个设备像素；再往上放只是把同一批像素摊得更开 —— 超采样不创造信息
#    （本项目第 10 条铁律）。要真细节只有一个办法：**画在更大的网格上**。
#
# ③ **不能靠「画大再缩小」凑。** 64 网格画完缩到 48/56 这种非整数倍，nearest 采样下
#    每 4 列丢 1 列 —— 1px 的轮廓线会时断时续（这正是改前那 4 只大 BOSS 发糊的原因：
#    32 网格 → Scale2x 到 64 → 再缩到 48）。所以 BOSS 一律 **1:1 落屏**：
#    画在 64 网格 → 落屏 64px，零重采样，1 源像素 = 1 屏像素，
#    像素密度与杂兵完全相同，而**每个方向的信息量是杂兵的 4 倍**。
#
# ## 已知取舍（是刻意的，不是没想到）
#
# 64px 的精灵在 32px 的格子里向上溢 2 格、左右各溢半格。渲染层本来就允许 BOSS 越格
# （A5a 只卡非 BOSS），越格正是「这个东西占两格」的读法。
# **底边仍严格踩在格子下沿**：A5a 的「脚不越线」对 BOSS 同样生效，所以脚不会飘。
#
# ## 复用蝙蝠那套「膜翼」
#
# 魔王 / 魔龙的翼和蝙蝠的翼是同一个问题：**竖条不构成翅膀，底边的锯齿才构成**。
# `_wing_fan()` 把蝙蝠那两张手写剖面表换成可缩放的生成器（线性收 + 指骨下探 +
# 齿间上凹），三处共用一套语言 —— 这是「一个项目里的生物长在同一种骨骼上」。
BOS_W = BOS_H = 64


BOS_CX = BOS_W // 2



# BOSS 的落屏倍数：**恒为 1.0**，即 64 网格 1 源像素 = 1 屏像素。
#
# 为什么不做成「每只一个倍数」：64 网格画完缩到 48/56 这种非整数倍，
# nearest 采样下每 4 列丢 1 列 —— 1px 的轮廓线会时断时续。
# 要区分「谁更凶」不靠尺寸（全塔最大的两只本来就在最后一层），
# 靠的是剪影与细节密度。
BOSS_DRAW_SCALE = 1.0




def _bos_canvas() -> Image.Image:
    return Image.new("RGBA", (BOS_W, BOS_H), (0, 0, 0, 0))




# ── 1. 骷髅队长（第 10 层） ─────────────────────────────────────────

def _boss_skeleton(s) -> Image.Image:
    """骷髅队长：**金盔 + 金肩甲 + 大圆盾 + 白骨长剑**，一副「守墓的百夫长」。

    识别按观看距离分三层，64 网格刚好放得下：远看是「一身金」，
    中看是「大圆盾 + 长兵器」，近看才见肋骨缝、牙缝、关节环。
    """
    im = _bos_canvas()
    bone, joint = s["bone"], s["joint"]
    armor, trim = s["armor"], s["trim"]
    blade, shield, rim = s["blade"], s["shield"], s["shield_rim"]

    # 腿：两根骨柱（膝盖套关节环），脚向外张 —— 底三行必须有像素
    #
    # ⚠️ 成对结构一律改走 `_sym`。原稿手写 `for x0 in (21, 37)`：左柱 x23..28 的
    # 镜像应该是 x35..40，而 37+2=39 —— 两条腿左右**差 4 列**，1:1 落屏后
    # 是「一只脚内八、一只脚外八」。剪影判据只看总差异像素，抓不到这种错位。
    _sym(im, 23, 46, 6, 9, bone)             # 胫骨
    _sym(im, 22, 54, 8, 2, joint)            # 踝关节环
    _sym(im, 23, 57, 6, 5, bone)
    _sym(im, 20, 60, 12, 4, bone)            # 脚掌
    _sym(im, 21, 62, 3, 2, joint)            # 趾缝
    _sym(im, 26, 62, 3, 2, joint)
    # 骨盆 + 腰甲带 + 带扣
    _ell(im, BOS_CX, 45, 11, 6, bone)
    _put(im, 26, 44, 13, 2, joint)
    _put(im, 23, 47, 19, 2, armor)
    _gem(im, BOS_CX, 48, 3, trim)
    # 脊柱 + 脊椎节 + **六对**肋骨（原为四对 —— 肋骨是这只最大的纯色块）
    _put(im, 30, 22, 4, 24, joint)
    for y in range(24, 48, 3):
        _put(im, 30, y, 4, 2, bone)
    for k, y in enumerate((23, 27, 31, 35, 39, 43)):
        w = 14 - 2 * (k // 2)
        _ell(im, BOS_CX, y + 2, w, 3, bone)
        _put(im, BOS_CX - w + 3, y + 3, 2 * w - 5, 1, joint)
    # 骨上的暗阶 + 亮阶（骨是米白，不加这两阶的话整片就是一色）
    _sym(im, 24, 33, 3, 8, joint)
    _sym(im, 28, 30, 3, 10, blade)
    # 肩甲 + 高光 + 边缘铆钉（镜像点：cx 的搭档是 63-cx，腋下写 47 会偏 1 列）
    _ell(im, 17, 28, 10, 7, armor)
    _ell(im, 46, 28, 10, 7, armor)
    _ell(im, 17, 26, 5, 3, trim)
    _ell(im, 46, 26, 5, 3, trim)
    _rivets(im, 11, 22, 3, 5, trim, mirror=True)
    # 手臂（骨）+ 肘环
    _put(im, 14, 33, 6, 13, bone)
    _put(im, 44, 33, 6, 13, bone)
    _put(im, 13, 45, 8, 5, bone)
    _put(im, 43, 45, 8, 5, bone)
    _put(im, 14, 37, 6, 2, joint)
    _put(im, 44, 37, 6, 2, joint)
    # 头盔拱顶 + 帽檐 + 冠饰（原稿三枚写 22/29/36 —— 22..24 的搭档是 39..41，
    # 36..38 是**偏 3 列**的，正面看是「歪的王冠」）
    _half(im, BOS_CX, 22, 15, 15, armor, up=True)
    _put(im, 17, 19, 31, 4, armor)
    _put(im, 17, 23, 31, 1, trim)
    _put(im, 22, 7, 21, 3, armor)
    for sx in (22, 30, 39):
        _put(im, sx, 3, 3, 5, armor)
    _put(im, 22, 7, 21, 1, trim)
    _rivets(im, 19, 20, 6, 5, trim, mirror=True)
    # 颅骨下半 + 面颊 + 下颌 + 牙缝（`_put` 宽 1 的镜像搭档是 63-x）
    _half(im, BOS_CX, 22, 12, 12, bone, up=False)
    _put(im, 22, 24, 21, 5, bone)
    _put(im, 24, 29, 17, 5, bone)
    _put(im, 26, 30, 13, 1, joint)
    for tx in (27, 31, 32, 35):
        _put(im, tx, 30, 1, 3, joint)
    # 眼窝 / 鼻腔 / 眼内红光（原稿右眼窝写 38，搭档是 63-26=37）
    _ell(im, 26, 19, 4, 5, MON_INK)
    _ell(im, 37, 19, 4, 5, MON_INK)
    _put(im, 30, 23, 5, 3, MON_INK)
    _sym(im, 26, 19, 2, 2, blade)
    # 大圆盾（画面左侧 —— 离观众近的那一侧）：辐条 + 铆钉 + 中心宝石
    _ell(im, 12, 43, 12, 14, rim)
    _ell(im, 12, 43, 10, 12, shield)
    _put(im, 2, 42, 21, 3, trim)
    _put(im, 12, 32, 1, 23, trim)
    _rivets(im, 4, 33, 4, 6, trim)
    _gem(im, 12, 43, 4, trim)
    # 白骨长剑（画面右侧，斜握）：血槽 + 剑格宝石
    _beam(im, 56, 12, 51, 48, 4, blade)
    _beam(im, 56, 13, 52, 48, 1, trim)
    _put(im, 45, 48, 14, 3, armor)
    _gem(im, 52, 50, 3, trim)
    _put(im, 49, 53, 4, 9, s["grip"])
    return im




# ── 2. 骑士队长（第 40/42 层） ─────────────────────────────────────

def _boss_knight(s) -> Image.Image:
    """骑士队长：**白银全身甲 + 金饰 + 红披风 + 金羽**，双手大剑。

    与骷髅队长共用「金」这套语言，所以识别必须落在别的地方 ——
    这只押的是**披风与羽饰的体量**：披风在 64 网格里铺开 56 列，
    「等级感」靠面积而不是靠颜色。
    """
    im = _bos_canvas()
    armor, dark, light = s["armor"], s["dark"], s["light"]
    trim, cape, blade = s["trim"], s["cape"], s["blade"]

    # 披风（最里层）：从肩到地的喇叭 + 压暗的内衬，**再在内衬上压亮褶**
    for k in range(28):
        hw = 13 + int(round(k * 0.52))
        _put(im, BOS_CX - hw, 30 + k, 2 * hw + 1, 1, cape)
    _put(im, BOS_CX - 28, 58, 57, 6, cape)
    for k in range(22):
        hw = 9 + int(round(k * 0.42))
        _put(im, BOS_CX - hw, 36 + k, 2 * hw + 1, 1, s["cape_dk"])
    # 布褶：亮暗交替的竖条（一整片纯色是这只最大的密度洼地，
    # 而且「披风的褶」本身就是骑士盔甲的读数关键 —— 没褶就是一块红布）
    for x in range(18, 47, 6):
        _put(im, x, 36, 2, 22, cape)
    # 腿甲 + 靴（压三行暗，靴底踩在格底）
    for x0 in (22, 34):
        _put(im, x0, 46, 8, 12, dark)
        _put(im, x0 + 1, 46, 3, 12, armor)
    _sym(im, 23, 47, 2, 9, light)            # 腿甲高光阶
    _put(im, 20, 58, 12, 5, armor)
    _put(im, 32, 58, 12, 5, armor)
    _put(im, 20, 60, 12, 1, dark)            # 靴甲分片
    _put(im, 32, 60, 12, 1, dark)
    _put(im, 20, 62, 12, 2, dark)
    _put(im, 32, 62, 12, 2, dark)
    # 躯干 + 胸甲 + 金色十字徽 + 中心宝石 + 上缘铆钉
    _ell(im, BOS_CX, 36, 16, 12, armor)
    _put(im, 17, 34, 31, 13, armor)
    _put(im, 17, 46, 31, 3, dark)
    _put(im, 30, 30, 5, 18, trim)
    _put(im, 23, 36, 19, 5, trim)
    _gem(im, BOS_CX, 38, 4, trim)
    _rivets(im, 19, 33, 5, 6, trim, mirror=True)
    _put(im, 17, 33, 31, 2, light)
    _sym(im, 20, 39, 4, 8, light)            # 胸甲高光阶
    # 肩甲（镜像点：cx=15 的搭档是 48，原稿写 49 是偏 1 列的）
    _ell(im, 15, 26, 10, 7, armor)
    _ell(im, 48, 26, 10, 7, armor)
    _ell(im, 15, 24, 5, 3, light)
    _ell(im, 48, 24, 5, 3, light)
    _sym(im, 12, 29, 6, 3, light)            # 肩甲下缘高光阶
    # 头盔 + 面罩（加竖缝）+ 金羽（加节）
    _ell(im, BOS_CX, 16, 13, 13, armor)
    _put(im, 19, 12, 27, 5, dark)
    _ell(im, BOS_CX, 12, 13, 7, armor)
    _put(im, 27, 13, 11, 4, s["visor"])
    _sym(im, 29, 13, 1, 4, dark)
    _sym(im, 32, 13, 1, 4, dark)
    _put(im, 30, 2, 5, 10, trim)
    _put(im, 26, 4, 13, 3, trim)
    _put(im, 30, 5, 5, 1, trim)
    _put(im, 30, 7, 5, 1, dark)
    _put(im, 30, 10, 5, 1, dark)
    # 鸢盾（左手）：上圆下尖 + 横带 + 铆钉
    _put(im, 2, 30, 18, 13, s["shield"])
    for k in range(9):
        _put(im, 3 + k, 43 + k, 16 - 2 * k, 1, s["shield"])
    _put(im, 2, 30, 18, 2, trim)
    _put(im, 10, 32, 3, 13, trim)
    _put(im, 2, 36, 18, 2, trim)
    _rivets(im, 4, 33, 4, 5, trim)
    _gem(im, 11, 41, 3, s["blade"])
    # 大剑（右手，竖握）：中线 + 剑格宝石
    _put(im, 54, 4, 5, 40, blade)
    _put(im, 54, 4, 1, 40, light)
    _put(im, 56, 6, 1, 36, light)
    _put(im, 49, 42, 15, 3, trim)
    _gem(im, 56, 44, 3, trim)
    _put(im, 55, 47, 3, 9, s["grip"])
    return im




# ── 3. 吸血鬼 ──────────────────────────────────────────────────────

def _boss_vampire(s) -> Image.Image:
    """吸血鬼：**高竖领 + 铺开的斗篷 + 苍白面孔 + 红瞳 + 獠牙**。

    与魔王要一眼分得开，所以刻意做得**不对称**：竖领左高右低、斗篷偏一侧披，
    站姿微微侧身 —— 读起来才是「一个人」，而不是「一块对称的形状」。
    """
    im = _bos_canvas()
    skin, cape, cape_in = s["skin"], s["cape"], s["cape_in"]
    eye, hair, fang, light = s["eye"], s["hair"], s["fang"], s["light"]

    # 斗篷：喇叭形，左侧多披 3 列（不对称的来源）
    for k in range(32):
        hw = 12 + int(round(k * 0.55))
        shift = -3 if k < 16 else 0
        _put(im, BOS_CX - hw + shift, 28 + k, 2 * hw + 1, 1, cape)
    _put(im, 1, 59, 62, 5, cape)
    # 内衬（暗）：胸口往上收成 V，把脸「框」出来
    for k in range(20):
        hw = 9 - int(round(k * 0.28))
        _put(im, BOS_CX - hw, 30 + k, 2 * hw + 1, 1, cape_in)
    # 斗篷褶皱：**跟着喇叭的宽度走**（写死 x 会在窄处落到斗篷外、在宽处堆在中间），
    # 只压在内衬之外的两侧 —— 内衬本来就是暗的，压上去等于没画。
    for k in range(20):
        hw = 12 + int(round((k + 12) * 0.55))
        shift = -3 if (k + 12) < 16 else 0
        for d in (8, 13):
            _put(im, BOS_CX - d + shift, 40 + k, 2, 1, cape_in)
            _put(im, BOS_CX + d - 2 + shift, 40 + k, 2, 1, cape_in)
    # 褶边的亮线（三阶化：cape / cape_in / light）—— 只压暗不提高光的话，
    # 每个 8×8 块里永远只有「底色 + 暗色」两种，细节密度卡在 2.0 上不去
    for k in range(20):
        hw = 12 + int(round((k + 12) * 0.55))
        shift = -3 if (k + 12) < 16 else 0
        for d in (8, 13):
            _put(im, BOS_CX - d + shift - 1, 40 + k, 1, 1, light)
            _put(im, BOS_CX + d + shift, 40 + k, 1, 1, light)
    # 下摆的扇形垂边
    for x in range(4, 60, 9):
        _put(im, x, 62, 5, 2, cape_in)
    # 高竖领（两片向上外撇的尖，本就一高一低）+ 领内衬亮线
    _beam(im, 20, 32, 9, 8, 6, cape)
    _beam(im, 44, 32, 55, 14, 6, cape)
    _beam(im, 9, 8, 15, 5, 4, cape)
    _beam(im, 55, 14, 49, 6, 4, cape)
    _beam(im, 22, 30, 11, 10, 2, light)
    _beam(im, 46, 30, 57, 14, 2, light)
    # 身（暗袍）+ 交叠的手臂 + 袖口 + 指爪 + 胸针
    _ell(im, BOS_CX, 46, 13, 14, cape_in)
    _put(im, 22, 42, 21, 5, light)
    _put(im, 22, 42, 21, 2, cape)
    _sym(im, 21, 41, 2, 8, cape)
    _sym(im, 21, 46, 3, 2, skin)
    _gem(im, BOS_CX, 40, 3, eye)
    # 头：苍白面孔 + 尖下颌
    _ell(im, BOS_CX, 24, 10, 11, skin)
    _put(im, 27, 33, 11, 5, skin)
    _half(im, BOS_CX, 38, 6, 5, skin, up=False)
    # 黑发 + 美人尖
    _half(im, BOS_CX, 24, 12, 12, hair, up=True)
    _put(im, 30, 22, 5, 7, hair)
    _put(im, 32, 28, 1, 5, hair)
    _put(im, 22, 16, 21, 4, hair)
    # 红瞳 + 眉毛 + 獠牙（镜像点：cx=27 的搭档是 36，原稿写 38 是偏 2 列的）
    _ell(im, 27, 24, 4, 3, MON_WHITE)
    _ell(im, 36, 24, 4, 3, MON_WHITE)
    _ell(im, 27, 24, 2, 3, eye)
    _ell(im, 36, 24, 2, 3, eye)
    _sym(im, 26, 22, 1, 1, MON_WHITE)
    _put(im, 23, 20, 9, 2, hair)
    _put(im, 32, 20, 9, 2, hair)
    _put(im, 28, 31, 9, 2, MON_INK)
    _put(im, 29, 33, 2, 4, fang)
    _put(im, 33, 33, 2, 4, fang)
    return im




# ── 4. 大法师（第 25 层） ──────────────────────────────────────────

def _boss_mage(s) -> Image.Image:
    """大法师：**高尖帽 + 金袍 + 长白须 + 大金宝珠法杖**。

    画序是这只的全部难点：法杖在身后 → 金袍 → 上身 → 白须（压在袍上）→
    脸 → 尖帽（压住发际）。顺序错一处，就是「胡子长在袍子后面」这种硬伤。
    """
    im = _bos_canvas()
    robe, dark, light = s["robe"], s["dark"], s["light"]
    hat, skin, beard = s["hat"], s["skin"], s["beard"]
    staff, orb, trim = s["staff"], s["orb"], s["trim"]

    # 法杖（最里层）+ 大金宝珠 + 杖身环纹 + 宝珠符文
    _put(im, 47, 14, 5, 50, staff)
    _put(im, 47, 14, 1, 50, light)
    _ell(im, 49, 11, 10, 10, dark)
    _ell(im, 49, 11, 8, 8, orb)
    _ell(im, 47, 8, 3, 3, (255, 250, 226, 255))
    _put(im, 43, 8, 13, 1, dark)
    _put(im, 45, 15, 9, 1, dark)
    for k in range(7):
        _put(im, 46, 20 + k * 6, 7, 1, trim)
    # 金袍：从腰到地的喇叭 + 袍褶
    #
    # ⚠️ 袍褶原来是四条**写死 x** 的竖线（13, 22, 42, 51）：既偏了 2 列
    # （13..14 的搭档是 49..50，不是 51），又在袍窄的上段落到袍外（y47 时
    # 袍只到 x16..48，x13 那条压在须和袍的边界上）。现在跟着喇叭宽度走。
    for k in range(24):
        hw = 11 + int(round(k * 0.68))
        _put(im, BOS_CX - hw, 40 + k, 2 * hw + 1, 1, robe)
    _put(im, 3, 61, 58, 3, robe)
    for k in range(18):
        hw = 11 + int(round((k + 4) * 0.68))
        for d in (5, 10, 15):
            if d < hw - 2:
                _put(im, BOS_CX - d - 1, 44 + k, 2, 1, dark)
                _put(im, BOS_CX + d - 1, 44 + k, 2, 1, dark)
        # 褶边亮线（三阶：robe / dark / light）
        for d in (3, 8, 13):
            if d < hw - 2:
                _put(im, 31 - d, 44 + k, 1, 1, light)
                _put(im, 32 + d, 44 + k, 1, 1, light)
    # 上身 + 金披肩 + 披肩铆钉
    _ell(im, BOS_CX, 38, 14, 9, robe)
    _ell(im, BOS_CX, 34, 17, 7, dark)
    _put(im, 15, 34, 35, 3, trim)
    _rivets(im, 18, 35, 5, 7, dark, mirror=True)
    # 白须（压在袍上、框住脸；从第 40 行起，正好接在下巴）+ 须缕
    for k in range(18):
        hw = 12 - int(round(k * 0.12))
        _put(im, BOS_CX - hw, 40 + k, 2 * hw + 1, 1, beard)
    _put(im, BOS_CX - 6, 58, 13, 5, beard)
    for d in (4, 9):
        _put(im, BOS_CX - d - 1, 42, 2, 18, s["beard_dk"])
        _put(im, BOS_CX + d - 1, 42, 2, 18, s["beard_dk"])
    # 脸 + 鼻 + 眼
    #
    # ⚠️ 改前脸中心在 y28、帽檐椭圆在 y27（ry=5 → 覆盖 22..32）——
    # **帽檐正压在两只眼睛上**（眼在 y26..28），落屏后是一张没有五官的脸，
    # 只剩一团白胡子。判据没拦住它（密度够、颜色够），是肉眼看出来的。
    # 现在脸下移到 y32（覆盖 22..42）、帽檐上收到 y21（覆盖 17..25），
    # 眼睛落在 y27 —— 帽檐压额发、不再压眼。
    _ell(im, BOS_CX, 32, 10, 10, skin)
    _put(im, 30, 34, 5, 3, (232, 186, 142, 255))
    _put(im, 25, 27, 3, 3, MON_INK)
    _put(im, 36, 27, 3, 3, MON_INK)
    # 尖帽：锥体 + 帽檐 + 帽带 + 带扣宝石 + 穗
    for k in range(19):
        hw = 3 + int(round(k * 0.68))
        _put(im, BOS_CX - hw, 2 + k, 2 * hw + 1, 1, hat)
    _ell(im, BOS_CX, 21, 19, 4, hat)
    _put(im, 12, 19, 41, 3, trim)
    _put(im, 13, 23, 39, 1, dark)
    _gem(im, BOS_CX, 20, 3, orb)
    _put(im, 31, 0, 3, 4, trim)
    return im




# ── 5. 大乌贼（第 15 层） ──────────────────────────────────────────

def _boss_kraken(s) -> Image.Image:
    """巨型乌贼：**纵向水滴形外套膜 + 一对侧鳍 + 两只巨眼 + 角质喙 + 六条长腕**。

    ⚠️ 改前的身体是 `_ell(rx=23, ry=20)` —— 一个**正圆**，配上同样圆的两只大眼，
    落屏后和史莱姆族是一家人（构建期断言没有拦住，因为它量的是「颜色密度」，
    不量「像不像乌贼」）。乌贼在外套膜上有两个记号，且都体现在**比例**上：

    | 记号 | 含义 | 本函数 |
    |---|---|---|
    | 纵向长（rx < ry） | 头是筒形，不是球 | rx 18 / ry 24（高比宽长 1/3） |
    | 侧鳍 | 外套膜中上部向外上伸出的一对角 | `_sym` 画的收尖三角 |

    腕也必须**明显长于身体**：改前腕只画到第 62 行、而身体占到第 46 行，
    六条腕几乎被外套膜吃掉，只剩一排小凸起 —— 这正是「读成水母」的原因之一。
    现在腕从第 40 行拉到 63（画布底），弯度也加大（bow 6~10 而不是 2~6）。
    """
    im = _bos_canvas()
    body, dark, light = s["body"], s["dark"], s["light"]
    eye, pupil = s["eye"], s["pupil"]

    # 侧鳍（最里层，向外上收尖的三角；`_sym` 保证左右一致）+ 鳍上的纹
    for k in range(12):
        _sym(im, 15 - k, 19 - k, 1, 12 - k, dark)
    for k in range(5):
        _sym(im, 13 - k, 19 - k, 1, 2, light)
    # 六条长腕（三条向左弯、三条向右弯；末梢换色收尾）
    tents = ((16, 1, 10, 8), (21, 10, 6, 8), (26, 24, -3, 8),
             (48, 63, -10, 8), (43, 54, -6, 8), (38, 40, 3, 8))
    for (x0, x1, bow, th) in tents:
        _tentacle(im, x0, 40, x1, 63, bow, th, dark, light)
    # 腕上的吸盘：**与腕共用同一条贝塞尔**（见 `_bez` 的注释）
    for (x0, x1, bow, th) in tents:
        for t in (0.32, 0.52, 0.72):
            sx, sy = _bez((x0, 40), (x1, 63), bow, t)
            _put(im, int(round(sx)), int(round(sy)), 1, 1, body)
    # 外套膜：**纵向水滴形**（rx 18 / ry 24 —— 高比宽长三分之一）+ 膜斑
    _ell(im, BOS_CX, 26, 18, 24, body)
    _scales(im, 22, 36, 5, 3, 4, dark, mirror=True)
    _scales(im, 24, 34, 4, 3, 4, light, mirror=True)
    _half(im, BOS_CX, 20, 15, 12, light, up=True)
    # 眼下压暗，把巨眼从外套膜上「抠」出来（一条横贯的暗带就够，
    # 原稿写成两条各 21 列、其中右条起自 x36 —— 与左条差 15 列，等于没压）
    _put(im, 21, 30, 22, 4, dark)
    # 两只巨眼 + 竖瞳 + 高光（镜像点：cx=22 的搭档是 41，cx=19 的搭档是 44）
    _ell(im, 22, 28, 9, 10, eye)
    _ell(im, 41, 28, 9, 10, eye)
    _ell(im, 22, 29, 5, 7, pupil)
    _ell(im, 41, 29, 5, 7, pupil)
    _ell(im, 19, 24, 3, 3, MON_WHITE)
    _ell(im, 44, 24, 3, 3, MON_WHITE)
    # 角质喙（外套膜下缘的 V 形开口）+ 下伸的钩尖
    _put(im, 26, 46, 13, 8, dark)
    for k in range(7):
        _put(im, 27 + k, 47 + k, 11 - 2 * k, 1, MON_INK)
    _put(im, 31, 52, 2, 11, MON_INK)
    return im




# ── 6. 魔龙（第 35 层） ────────────────────────────────────────────

def _boss_dragon(s) -> Image.Image:
    """魔龙：**正面朝向玩家** —— 横展双翼 + 方吻张口 + 竖瞳 + 粗腿利爪 + 甩到右下的尾。

    ## 为什么从侧视改成正面（本轮）

    改前是侧视朝左，理由是「正面龙会与魔王撞剪影」。这条理由只对了一半：
    两只撞剪影的真正原因是**共用同一套骨架**（对称的角 + 一对膜翼 + 一张脸），
    而不是「正面」本身。侧视躲开了撞车，代价是把龙的辨识度全押在**长吻**
    这一个记号上 —— 而长吻缩到 64px 后只剩几像素宽的横条，玩家读到的
    是「一只大蜥蜴」，不是龙（这也是上一轮它被改了三次形状的那个东西）。

    正面重画之后，记号改成五条**互相独立**的（任何一条单独成立就够认出来）：

    | 记号 | 内容 | 魔王有没有 |
    |---|---|---|
    | 方吻 + 张口 | 头部下半是一块比头略窄的方形，中间一道黑口 + 上下交错獠牙 | 无（魔王圆头无吻） |
    | 竖瞳 | 金底眼 + 一道**竖直**的缝 | 无（魔王是横的发光条） |
    | 颊鳍 | 头两侧向外下收的膜鳍 | 无 |
    | 甩尾 | 尾从身体右侧甩到画面右下，末端下勾 | 无（魔王不画尾） |
    | 横展翼 | 翼根在肩、**向左右外侧**展开成 T 形 | 不同（魔王翼是贴身上扬的） |

    ⚠️ 这五条**没有一条靠颜色** —— 缩到 32px 或转灰度也分得开。
    判据也换了：`verify_boss_art` ⑦ 量**头部区域的左右对称度** —— 正面朝向的头
    必然左右对称，而侧视的头偏在一边会直接报红（改前实测 39.4%，阈值 12%）。
    没有这条判据，「转成正面」只是这次改对了、下次改形状时没人拦得住。
    """
    im = _bos_canvas()
    body, wing, belly = s["body"], s["wing"], s["belly"]
    dark, eye, horn, claw = s["dark"], s["eye"], s["horn"], s["claw"]

    # ① 双翼（最里层）：翼根在肩（y30..40）、**向左右下外展开**到翼尖（y46..62）。
    #
    # ⚠️ 展开方向是本轮试出来的第二个坑。第一版照蝙蝠那样「向上外扬」，
    # 落屏后**读不出是翼**：躯干 rx=17 占了 x15..49，两侧各只剩 15 列，
    # 向上的窄膜在这 15 列里只是一根斜柱。改成**向下展开**之后：
    #   ① 可见面积大（外侧 15 列 × 纵向 30 行都是膜）；
    #   ② 与魔王的「贴身上扬膜翼」正好相反，剪影差异反而更大；
    #   ③ 正面龙两翼下垂护体，本身就是这类生物的经典站姿。
    _wing_draw(im, 26, _wing_fan(21, 30, 40, 46, 62, (0, 5, 10, 15, 20), 5),
               body, wing, edge=3, mirror=True)
    # 翼膜上的暗斑（膜不能是一整块纯色）+ 翼尖的钩爪
    _sym(im, 10, 46, 3, 2, dark)
    _sym(im, 13, 55, 3, 2, dark)
    _sym(im, 6, 58, 4, 5, claw)
    # ② 尾：从身体右侧甩出，末端收成箭尖（正面龙唯一伸到画面右缘的细结构）
    _beam(im, 44, 44, 61, 48, 5, body)
    _beam(im, 61, 48, 53, 57, 4, body)
    for k in range(4):
        _put(im, 47 + k, 52 + k, 9 - 2 * k, 1, dark)
    # ③ 腿 + 脚 + 每脚三只爪（爪踩在最后一行 —— 底行必须有像素）
    #
    # ⚠️ 爪的左右坐标是**镜像算出来的**（镜像轴 x=31.5，所以 15..18 的搭档是 45..48），
    # 不是「另一只脚从 31 起步」—— 手写成对坐标差了 2 列，1:1 落屏后就是
    # 「两只脚的爪不对称」，而这种 1px 级的错位肉眼极难定位。
    for x0 in (17, 34):
        _put(im, x0, 50, 13, 10, body)
        _put(im, x0 - 2, 58, 17, 5, body)
    for k in range(3):
        _put(im, 15 + k * 6, 61, 4, 3, claw)
        _put(im, 45 - k * 6, 61, 4, 3, claw)
    # 腿鳞（错行）—— 一整块纯色是细节密度最大的杀手
    _scales(im, 18, 49, 3, 3, 4, dark, mirror=True)
    # ④ 躯干：**宽胸 + 收腰**（两段叠加），腹甲从中线一条铺下来
    #
    # 单一椭圆（rx=ry）落屏后读成「甲虫的圆壳」—— 兽形靠的是轮廓起伏。
    _ell(im, 32, 38, 18, 11, body)
    _ell(im, 32, 47, 15, 9, body)
    _ell(im, 32, 46, 11, 12, belly)
    for k in range(4):
        _put(im, 24, 40 + k * 4, 17, 1, dark)
    # 三阶化：躯干两侧压暗、中线提亮（只有两阶的色块在 8×8 尺度上永远只有 2 色）
    _sym(im, 15, 34, 4, 12, wing)
    _sym(im, 20, 12, 3, 6, wing)
    _put(im, 30, 32, 4, 5, belly)
    # ⑤ 颈（两侧对称压暗）
    _put(im, 26, 27, 13, 12, body)
    _sym(im, 26, 27, 3, 12, dark)
    # ⑥ 头盖（比躯干窄）+ 颊鳍
    _ell(im, 32, 16, 14, 12, body)
    for k in range(6):
        _sym(im, 17 - k, 18 + k, 2, 9 - k, dark)
    # ⑦ 方吻：**比头窄**（x25..39 vs 头盖 x18..46）—— 这一步是「楔形头」的全部，
    #    第一版把吻做成与头齐宽，1:1 落屏后读出来是「一张圆脸 + 一张大嘴」，
    #    仍然是「放大的杂兵」，不是龙。
    _put(im, 25, 21, 15, 11, body)
    _put(im, 25, 21, 15, 1, belly)           # 吻背亮线：头与吻的分界
    _put(im, 26, 25, 13, 5, MON_INK)         # 口腔
    for x in (27, 31, 34):                   # 上獠牙（朝下）
        _put(im, x, 25, 3, 3, claw)
    for x in (29, 32):                       # 下獠牙（朝上）
        _put(im, x, 28, 3, 2, claw)
    _put(im, 27, 22, 3, 2, MON_INK)          # 鼻孔
    _put(im, 34, 22, 3, 2, MON_INK)
    # ⑧ 眼 + **竖瞳** + 眉脊 + 额脊（右眼中心 = 63-25 = 38）
    _ell(im, 25, 14, 6, 5, eye)
    _ell(im, 38, 14, 6, 5, eye)
    _put(im, 24, 10, 3, 9, MON_INK)
    _put(im, 37, 10, 3, 9, MON_INK)
    _sym(im, 18, 7, 13, 2, dark)
    _put(im, 31, 6, 2, 7, dark)              # 额脊：跨镜像轴 2px，天然对称
    # ⑨ 双角：从头顶两侧向上外弯（比魔王那对短而粗、**只有一段**）+ 环纹
    _beam_sym(im, 23, 8, 17, 0, 6, horn)
    _sym(im, 18, 4, 5, 1, dark)
    _sym(im, 20, 8, 6, 1, dark)
    # ⑩ 肩刺
    _beam_sym(im, 21, 32, 14, 25, 4, horn)
    return im




# ── 7. 魔王 / 真魔王（第 50 层 / 终局） ─────────────────────────────

def _boss_demon(s) -> Image.Image:
    """魔王：**对称的巨角 + 膜翼 + 发光眼 + 胸甲**；`true_form` 换成真身剪影。

    ## 普通魔王与真身必须是两个能一眼分开的剪影

    `verify_boss_art` 判据 ⑤（轮廓差异像素 ≥ 400）在改前**报红**：
    两只魔王只差 199 像素 —— 因为它们是**同一个骨架 + 一顶王冠**，
    玩家看到的读法是「同一个魔王换了颜色」，而不是「我打到了真身」。
    断言是这个函数今天被改写的唯一原因。

    所以真身走另一套骨架：

    |        | 普通魔王 | 真身 |
    |---|---|---|
    | 膜翼   | 身侧扬起，翼尖到第 4 行 | **高举过头**，翼尖顶到第 0 行、展幅更宽 |
    | 巨角   | 外弯两段 | **外弯三段**，伸到画布左右边缘 |
    | 手臂   | 垂在身侧 | **斜向上举**（战斗姿态） |
    | 下盘   | 并腿站立 | **双腿张开** |
    | 头饰   | 无 | 金冠 + 冠顶白高光 |

    这五行**没有一行是靠颜色** —— 剪影差异全部来自形体，缩到 32px 甚至
    灰度看也分得开。

    与魔龙的分工写在 `_boss_dragon` 里：这只走**对称 + 正面**，两只不撞剪影。
    膜翼沿用蝙蝠那套剖面法 —— 魔王张开的是**两片膜**，不是两根带条纹的柱子
    （改前就是这个毛病：两颗品红竖条，玩家读成「门帘」）。
    """
    im = _bos_canvas()
    body, dark, light = s["body"], s["dark"], s["light"]
    glow, horn, plate = s["glow"], s["horn"], s["plate"]
    true_form = bool(s.get("true_form"))

    # 膜翼（最里层，左右各一片）
    if true_form:
        # 高举的巨翼：肩 y18..50 → 翼尖 y0..30，比普通魔王高出一倍
        _wing_draw(im, 20, _wing_fan(17, 18, 50, 0, 30, (0, 5, 10, 15), 6),
                   light, dark, edge=3, mirror=True)
    else:
        _wing_draw(im, 18, _wing_fan(15, 24, 46, 4, 24, (0, 4, 8, 12), 5),
                   light, dark, edge=3, mirror=True)
    # 翼膜斑（膜上不能只有三根指骨 —— 一整片纯色是细节密度最大的杀手）
    _sym(im, 12, 30, 4, 2, dark)
    _sym(im, 9, 26, 3, 2, dark)
    # 腿（粗壮，踩在格底）+ 腿甲分片 + 脚爪
    #
    # ⚠️ 成对结构统一改走 `_sym`。原稿是两行手写坐标，腿（16/38）**碰巧**对了，
    # 但同一段里的脚掌（14/37）与分片（18/…）各错各的 —— 同一个函数里
    # 「一半对、一半差 1 列」比全错更难查。镜像点恒为 63-cx。
    if true_form:
        # 真身站得更开 —— 下盘一宽，整个剪影就与「并腿站着」的普通魔王不同
        _sym(im, 16, 52, 10, 10, body)
        _sym(im, 14, 60, 13, 4, dark)
        _sym(im, 18, 56, 7, 1, dark)          # 腿甲分片
        _sym(im, 16, 60, 5, 3, horn)          # 脚爪
    else:
        _sym(im, 20, 52, 10, 10, body)
        _sym(im, 18, 60, 13, 4, dark)
        _sym(im, 22, 56, 7, 1, dark)
        _sym(im, 20, 60, 5, 3, horn)
    # 腹甲横排（两腿之间的躯干下缘）
    for k in range(3):
        _put(im, 26, 54 + k * 3, 13, 1, dark)
    # 躯干 + 胸甲 + 上缘铆钉 + 发光徽（徽外再套一圈亮环）
    _ell(im, BOS_CX, 46, 17, 15, body)
    _ell(im, BOS_CX, 44, 14, 12, plate)
    _put(im, BOS_CX - 14, 40, 29, 4, light)
    _rivets(im, 20, 39, 4, 8, light, mirror=True)
    _ell(im, BOS_CX, 46, 8, 9, light)
    _ell(im, BOS_CX, 46, 5, 6, glow)
    _ell(im, BOS_CX, 46, 2, 3, MON_WHITE)
    # 三阶化：躯干两侧与腿上的高光条（躯干是整片 body 纯色，只压暗不出效果）
    _sym(im, 20, 48, 4, 6, light)
    _sym(im, 22, 54, 3, 4, light)
    # 手臂
    if true_form:
        # 斜向上举的粗臂（斜带而非竖条 —— 竖条会和翼的指骨混成一片）。
        # 原稿写右手 `_beam(42,42 → 56,22)`，而左手的镜像起点是 35..41 不是 42..48
        # —— 两只手臂**差 7 列**，落屏后是「一只举手、一只搭在腰上」。
        _beam_sym(im, 22, 42, 8, 22, 7, dark)
    else:
        _sym(im, 12, 36, 7, 14, dark)
    # 巨角（骨色，向外上弯）+ 环纹
    if true_form:
        # 两段、末端伸到画布左右边缘 —— `_beam_sym` 只写左半
        _beam_sym(im, 26, 26, 10, 8, 6, horn)
        _beam_sym(im, 22, 16, 4, 0, 5, horn)
    else:
        _beam_sym(im, 24, 24, 12, 6, 6, horn)
        _beam_sym(im, 22, 16, 8, 2, 5, horn)
    _sym(im, 19, 20, 5, 1, dark)
    _sym(im, 18, 13, 5, 1, dark)
    # 头 + 发光眼 + 獠牙（原稿右眼写 34、右瞳写 38、獠牙写 37 —— 分别偏 1、1、2 列）
    _ell(im, BOS_CX, 24, 13, 13, body)
    _ell(im, BOS_CX, 20, 11, 8, dark)
    _sym(im, 23, 22, 8, 4, glow)
    _sym(im, 24, 23, 3, 2, MON_INK)
    _put(im, 26, 31, 13, 3, MON_INK)
    _sym(im, 27, 34, 2, 4, MON_WHITE)
    _put(im, 31, 34, 2, 4, MON_WHITE)
    # 王冠（真身专属）+ 冠顶嵌宝石
    if s.get("crown"):
        _put(im, 21, 8, 23, 4, s["crown"])
        for sx in (21, 29, 39):
            _put(im, sx, 2, 4, 6, s["crown"])
        _put(im, 21, 8, 23, 1, MON_WHITE)
        _gem(im, BOS_CX, 5, 3, s["crown"], MON_WHITE)
    return im




BOSS_SHAPES = {
    "skeletonBoss": _boss_skeleton,
    "knightBoss": _boss_knight,
    "vampireBoss": _boss_vampire,
    "mageBoss": _boss_mage,
    "krakenBoss": _boss_kraken,
    "dragonBoss": _boss_dragon,
    "demonBoss": _boss_demon,
}



# BOSS 的配色表。与 `PROC_MONSTERS` **刻意分开**：那张表是「同形状可成族换色」
# （守卫/骑士/法师各成一族），这张是「八只各一套」—— BOSS 之间不共享骨架，
# 把两者混在一张表里会让「换色」这个概念失去边界。
PROC_BOSSES = {
    "skeletonCaptain": dict(
        shape="skeletonBoss", bone=(240, 234, 214, 255), joint=(148, 136, 116, 255),
        armor=(216, 162, 44, 255), trim=(250, 216, 98, 255),
        blade=(226, 232, 244, 255), shield=(196, 148, 42, 255),
        shield_rim=(118, 80, 16, 255), grip=(104, 66, 34, 255)),
    "knightCaptain": dict(
        shape="knightBoss", **SILVER_A,
        trim=(250, 216, 98, 255), cape=(148, 32, 40, 255), cape_dk=(96, 18, 26, 255),
        blade=(226, 232, 244, 255), shield=(110, 116, 132, 255),
        visor=(30, 34, 46, 255), grip=(104, 66, 34, 255)),
    "vampire": dict(
        shape="vampireBoss", skin=(240, 228, 226, 255), cape=(58, 32, 72, 255),
        cape_in=(30, 18, 40, 255), light=(120, 74, 140, 255), eye=(226, 40, 54, 255),
        hair=(24, 18, 30, 255), fang=(252, 252, 252, 255)),
    "archmage": dict(
        shape="mageBoss", robe=(196, 148, 42, 255), dark=(128, 88, 18, 255),
        light=(248, 214, 106, 255), skin=(238, 200, 160, 255), hat=(160, 116, 28, 255),
        beard=(250, 250, 246, 255), beard_dk=(196, 196, 190, 255), staff=(122, 86, 48, 255),
        orb=(252, 226, 92, 255), trim=(252, 234, 142, 255)),
    "kraken": dict(
        shape="krakenBoss", body=(132, 78, 176, 255), dark=(74, 38, 112, 255),
        light=(186, 140, 226, 255), eye=(250, 242, 206, 255), pupil=(36, 20, 50, 255)),
    "dragon": dict(
        shape="dragonBoss", body=(198, 62, 52, 255), wing=(104, 30, 38, 255),
        belly=(238, 200, 128, 255), dark=(62, 18, 22, 255), eye=(250, 216, 96, 255),
        horn=(232, 226, 206, 255), claw=(246, 242, 232, 255)),
    "demonKing": dict(
        shape="demonBoss", body=(146, 62, 150, 255), dark=(84, 30, 92, 255),
        light=(202, 122, 206, 255), glow=(252, 226, 92, 255),
        horn=(232, 226, 206, 255), plate=(58, 22, 66, 255)),
    # true_form=True 让真身换一整套骨架（高举巨翼 / 三段长角 / 斜举双臂 / 张腿）——
    # 只加王冠的话，两者的轮廓只差 199 像素，构建期断言（verify_boss_art ⑤）会报红
    "demonKingTrue": dict(
        shape="demonBoss", true_form=True, body=(186, 34, 40, 255), dark=(104, 14, 20, 255),
        light=(240, 96, 88, 255), glow=(252, 226, 92, 255),
        horn=(232, 226, 206, 255), plate=(74, 12, 18, 255), crown=(250, 214, 84, 255)),
}




def boss_art_base(bid: str) -> Image.Image:
    """一只 BOSS 的静止帧（**64 网格**，1:1 落屏）。描边语言与杂兵完全一致。"""
    spec = dict(PROC_BOSSES[bid])
    shape = BOSS_SHAPES[spec.pop("shape")]
    return add_outline(shape(spec), MON_INK)




def boss_art_frames(bid: str) -> list[Image.Image]:
    """BOSS 的 idle 帧 —— 与杂兵同理，**只有 1 帧**（呼吸在渲染层的刚体位移）。"""
    return [boss_art_base(bid)]




def verify_boss_art(frames: dict[str, list[Image.Image]]) -> list:
    """
    BOSS 造型断言。**与 `verify_mon_art` 分开**，因为网格不同（64 vs 32）——
    那边所有判据都建立在 `MON_H` 上，对着 64 网格的帧会**静默量错一格量级**
    （「最后一行」量的是第 31 行，而 BOSS 的内容到第 63 行），
    比报错难查得多。这里六条判据：

      1. **画布必须是 64 网格** —— 抓「BOSS 悄悄退回 32 网格的杂兵造型」。
         它不是假想：`BOSS_IDS` 与 `PROC_BOSSES` 对不上时就会发生，
         而那只怪头上还顶着渲染层的金色圈，看起来「只是个有点小的 BOSS」。
      2. **底行必须有像素** —— 与杂兵同理，底部锚定下帧底留白就是浮在半空。
      3. **每只只出 1 帧 idle** —— 呼吸是渲染层的刚体位移，理由同 `verify_mon_art` ⑤。
      4. **八只 BOSS 的剪影互不相同** —— 抓「画了八只结果都是同一个轮廓换色」。
         这一条的假绿只有一种：剪影集合比较在帧尺寸上也不同的话会全不相等，
         所以断言里同时要求**它们两两之间至少差 N 个像素**，不是「不相等」就算过。
      5. **细节密度达标** —— 把「更精致」变成可量的东西：把画面切成 8×8 的块，
         数每块里的**独立颜色数**，取中位数。32 网格的素材即便放大到 64，
         每块的中位数也只有 ~1.3（像素是摊开的）；真画在 64 网格上有 3.0~4.0。
         阈值 3.0（实测分布见常量 `BOSS_DETAIL_MIN` 的注释）。
      6. **`BOSS_IDS` 与 `data/monsters.json` 的 boss 字段一致** ——
         数据里是 BOSS、素材里没画 = 会退回杂兵造型；素材画了但数据不是 BOSS =
         白画（不会有人在棋盘上看到它）。
      7. **内部细节达标**（`_inner_detail`）—— 判据 5 只看 8×8 块，
         而**轮廓线**本身就贡献 2~3 色，所以「边缘花哨 + 内部一整片纯色」
         也能过。这一条先腐蚀掉轮廓外侧 2px，只量身体内部有没有纹理。门槛 1.8。
      8. **正面朝向的 BOSS，头部必须左右对称**（`_head_asym`，名单见 `HEAD_FRONT`）
         —— 这是「正面朝向玩家」的**唯一**可量判据。改前 dragon 是侧视朝左，
         实测 39.4%；转正后 2.2%。只对 `HEAD_FRONT` 里的名字生效：另外四只
         的不对称来自剧情道具（盾 / 大剑 / 法杖）或刻意站姿（吸血鬼），
         全局量会把它们全部误杀。
    """
    problems: list[str] = []
    if set(frames) != set(BOSS_IDS):
        problems.append(
            f"产出的 BOSS 是 {sorted(frames)}，与 BOSS_IDS {sorted(BOSS_IDS)} 对不上"
        )
        return problems

    for bid, fs in frames.items():
        if len(fs) != 1:
            problems.append(
                f"BOSS {bid} 出了 {len(fs)} 帧 idle —— 素材里只允许静止帧。"
                f"呼吸是渲染层的刚体位移（board.ts 的 MONSTER_BOB_PX）"
            )
            continue
        im = fs[0]
        if (im.width, im.height) != (BOS_W, BOS_H):
            problems.append(
                f"BOSS {bid} 的画布是 {im.width}×{im.height}，应为 {BOS_W}×{BOS_H} —— "
                f"它八成退回了 32 网格的杂兵造型（PROC_BOSSES 里没有它？）"
            )
            continue
        if not im.crop((0, BOS_H - 1, BOS_W, BOS_H)).getchannel("A").getbbox():
            problems.append(f"BOSS {bid} 最后一行为空，底部锚定会让它浮在半空")
        d = _detail_density(im)
        if d < BOSS_DETAIL_MIN:
            problems.append(
                f"BOSS {bid} 的细节密度只有 {d:.2f}（每个 8×8 块的中位独立颜色数），"
                f"低于阈值 {BOSS_DETAIL_MIN} —— 这个尺寸上「一色」是读不出结构的，"
                f"要么是「把 32 网格放大到 64」（放大不创造颜色，只把同一批像素摊开），"
                f"要么是大面积纯色没有压明暗三阶"
            )
        inner = _inner_detail(im)
        if inner < BOSS_INNER_MIN:
            problems.append(
                f"BOSS {bid} 的内部细节只有 {inner:.2f}（排除轮廓 2px 后，"
                f"每个 4×4 块的平均独立颜色数），低于阈值 {BOSS_INNER_MIN} —— "
                f"边缘再花哨也不算细节：身体内部必须有阴影 / 高光 / 刻线 / 鳞片"
                f"（只压一层暗纹不够，要连高光一起给，同一个 4×4 里才会出现第三色）"
            )
        if bid in HEAD_FRONT:
            asym = _head_asym(im)
            if asym > BOSS_HEAD_SYM_MAX:
                problems.append(
                    f"BOSS {bid} 是正面朝向的，但头部区域的左右不对称像素占 "
                    f"{asym:.1%}（上限 {BOSS_HEAD_SYM_MAX:.0%}）—— 它多半是侧视/"
                    f"半侧视，或者成对结构（角 / 手臂 / 眼 / 牙）有一侧没走 `_sym`，"
                    f"左右差了几列。正面朝向的对称结构一律用 `_sym` / `_beam_sym` 写"
                )

    # 剪影两两差异：不要求「不相等」（一个像素也能让它不相等），要求差得足够多
    ids = sorted(frames)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            sa = _solid_set(frames[a][0])
            sb = _solid_set(frames[b][0])
            diff = len(sa ^ sb)
            if diff < BOSS_SIL_MIN_DIFF:
                problems.append(
                    f"BOSS {a} 与 {b} 的剪影只差 {diff} 个像素（门槛 {BOSS_SIL_MIN_DIFF}）"
                    f"—— 八只 BOSS 的轮廓必须一眼分得开，否则「谁是谁」全靠颜色"
                )
    return problems
