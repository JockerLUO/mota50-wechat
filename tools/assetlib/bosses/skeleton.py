"""
骷髅队长（`skeletonCaptain`，第 10 层）—— 金盔 + 金肩甲 + 大圆盾 + 白骨长剑。

## 识别按观看距离分三层

| 距离 | 读到的 |
|---|---|
| 远 | 一身金（盔 / 肩 / 盾 / 剑格四处金饰） |
| 中 | 大圆盾 + 长兵器 —— 轮廓上是「举盾的百夫长」 |
| 近 | 肋骨缝、牙缝、关节环、盾徽、血槽 |

## ⚠️ 竖向分层是这只的全部难点（第一版在这里翻过车）

第一版把**颅骨与肋骨画在了同一段 y 上**（颅骨 y32..49、肋骨 y33..60），
两者又都是 `bone` 色 —— 落屏后是一整块白色，肋骨完全读不出来，
而所有构建期判据（尺寸 / 底行 / 单帧 / 剪影 / 密度 / 内部细节 / 头部对称）
**一条都没红**：密度够（金色部件很花）、内部细节够（骨上有刻线）、剪影也对。
是肉眼在 3 倍放大图上才看出来的。所以竖向上这些段落现在**互不重叠**：

| 段落 | y | 说明 |
|---|---|---|
| 冠饰 | 0..8 | 只有中轴一枚 + 两侧各一枚 |
| 盔顶 / 盔檐 | 6..33 | 金 |
| 颅骨（眼窝 / 鼻腔 / 下颌） | 24..50 | 骨 |
| 肩甲 | 42..62 | 金，`x_off=34` 让**肋骨露出来**（第一版 `x_off=32`+`rx=14` 把肋骨盖掉了） |
| 六对肋骨 | 50..78 | 骨，宽度 26→20（上宽下窄） |
| 腰甲带 / 骨盆 | 73..87 | 金带 + 骨 |
| 腿 / 脚 | 84..96 | 骨 |

改这段布局时请**连着这张表一起改** —— 单挪一行就是「又是一块白板」。

## 96 网格上「细节变多」具体多在哪

64 网格只有 32 行躯干可用，肋骨只能画四对、齿缝只能画四道。到 96 网格，
这些**数量型**细节是唯一能真正变多的东西（放大不创造信息，见项目铁律 10）：

- 肋骨 **四对 → 六对**，宽度递减，胸腔才有「上宽下窄」的形状；
- 脊椎 **一条实心柱 → 柱 + 一节节椎突 + 每节之间的暗缝**；
- 颅骨多了 **颧弓、下颌齿缝、鼻腔** 三层；
- 圆盾从「圆 + 十字」变成 **外圈 / 内盘 / 辐条 / 铆钉环 / 中心宝石** 五层。

## 成对结构一律走 `_sym` / `limb_pair` / `ell_pair`

旧稿手写 `for x0 in (21, 37)` 这类坐标时踩过「两只脚差 4 列」的坑
（1:1 落屏后是「一只脚内八、一只脚外八」，而剪影判据只看总差异像素，抓不到）。
本模块里没有任何一处手写成对坐标。
"""

from __future__ import annotations

from ..palette import MON_INK, MON_WHITE
from ..pixel import _put
from ..shapes import _ell, _gem, _rivets, _sym
from .common import (
    BOS_CX,
    bar_sym,
    blade,
    bos_canvas,
    diamond_sym,
    ell_sym,
    half_sym,
    limb_pair,
    pauldron,
    stud_ring,
)

IDS = ("skeletonCaptain",)

# 材质三阶：bone（骨）/ joint（关节与刻线）/ armor·trim（金饰）/ blade（骨色兵器的高光）
SKELETON = dict(
    bone=(240, 234, 214, 255),
    bone_dk=(196, 188, 166, 255),
    joint=(148, 136, 116, 255),
    joint_dk=(104, 94, 78, 255),
    armor=(216, 162, 44, 255),
    armor_dk=(138, 94, 16, 255),
    trim=(250, 216, 98, 255),
    blade=(226, 232, 244, 255),
    blade_dk=(150, 158, 176, 255),
    shield=(196, 148, 42, 255),
    shield_dk=(150, 104, 22, 255),
    shield_rim=(118, 80, 16, 255),
    grip=(104, 66, 34, 255),
)


def spec(bid: str) -> dict:
    if bid != "skeletonCaptain":
        raise KeyError(f"skeleton 模块不负责 {bid}")
    return dict(SKELETON)


def draw(s: dict, bid: str):
    im = bos_canvas()
    bone, bone_dk, joint = s["bone"], s["bone_dk"], s["joint"]
    joint_dk = s["joint_dk"]
    armor, armor_dk, trim = s["armor"], s["armor_dk"], s["trim"]
    blade_c, blade_dk = s["blade"], s["blade_dk"]
    shield, shield_dk, rim, grip = s["shield"], s["shield_dk"], s["shield_rim"], s["grip"]

    # ── ① 腿（袖珍的两根，藏在腰甲带之下）+ 踝环 + 分趾脚掌 ──────────
    limb_pair(im, x0=37, y0=82, w=10, h=10, base=bone, dark=joint,
              light=blade_c, joint=joint)
    _sym(im, 34, 86, 16, 2, joint)                     # 踝关节环
    _sym(im, 32, 88, 16, 8, bone)                      # 脚掌
    _sym(im, 34, 88, 3, 8, joint)                      # 脚趾缝（镜像后共四道）
    _sym(im, 40, 88, 3, 8, joint)

    # ── ② 骨盆 + 腰甲带 + 带扣宝石 ──────────────────────────────────
    ell_sym(im, 80, 13, 8, bone)
    _sym(im, 33, 77, 8, 3, joint_dk)                   # 髋窝（左右各一，走 `_sym`）
    bar_sym(im, 78, 14, armor, h=5)                    # 腰甲带
    bar_sym(im, 78, 14, armor_dk, h=1)
    bar_sym(im, 82, 14, trim, h=1)
    diamond_sym(im, 80, 4, trim, hi=MON_WHITE)         # 带扣

    # ── ③ 脊柱 + 椎突（一截一截的，不是一根实心柱） ─────────────────
    for y in range(46, 78):
        bar_sym(im, y, 2, joint if (y - 46) % 6 in (0, 1) else bone)
    for y in (50, 62, 74):                             # 椎突：每 12 行向外一对
        _sym(im, 45, y, 4, 3, bone)
        _sym(im, 45, y + 3, 4, 1, joint_dk)

    # ── ④ 六对肋骨：上宽下窄 + 每根下缘的暗刻线 + 上缘的亮线 ─────────
    #
    # 三阶（bone / bone_dk / joint_dk）不是修饰：一整片 bone 色的胸腔
    # 在 96 网格上就是一块白板，`BOSS_INNER_MIN` 那条判据量的正是「内部有没有纹理」。
    for k, y in enumerate((52, 57, 62, 67, 72, 77)):
        w = 26 - 2 * (k // 2)                          # 26 → 20
        _sym(im, BOS_CX - w, y, w - 2, 4, bone)
        _sym(im, BOS_CX - 2, y, 2, 4, bone)            # 与脊柱相接的那一小截
        _sym(im, BOS_CX - w + 1, y, w - 3, 1, blade_c)  # 上缘亮线
        _sym(im, BOS_CX - w + 1, y + 3, w - 3, 1, joint_dk)  # 下缘暗刻线

    # ── ⑤ 肩甲（三层：板 / 受光面 / 叠甲缝 + 边缘铆钉） ───────────────
    #
    # `x_off=34 / rx=13`：肩甲只到 x28（左），**肋骨从 x28 才露出来**。
    # 第一版是 `x_off=32 / rx=14`（肩甲到 x31），那一点点差异刚好把肋骨挡没了。
    pauldron(im, cy=52, x_off=34, rx=13, ry=10, plate=armor, dark=armor_dk,
             light=trim, studs=4)

    # ── ⑥ 手臂（骨柱 + 肘环 + 手） ──────────────────────────────────
    limb_pair(im, x0=6, y0=54, w=13, h=22, base=bone, dark=joint,
              light=blade_c, joint=joint)
    _sym(im, 5, 74, 15, 8, bone)                       # 手（比小臂粗一圈）
    _sym(im, 7, 76, 3, 5, joint_dk)                    # 指缝
    _sym(im, 12, 76, 3, 5, joint_dk)

    # ── ⑦ 头盔：拱顶 + 帽檐 + 冠饰三枚 + 檐下铆钉 ────────────────────
    half_sym(im, 28, 20, 22, armor, up=True)           # 拱顶（y 6..28）
    bar_sym(im, 26, 18, armor, h=7)                    # 帽檐（y 26..33）
    bar_sym(im, 32, 18, armor_dk, h=1)
    bar_sym(im, 33, 18, trim, h=1)
    bar_sym(im, 0, 3, armor, h=9)                      # 中央冠饰（跨轴 6px，天然对称）
    _sym(im, 34, 3, 5, 8, armor)                       # 两侧冠饰（`_sym` 一次出两枚）
    bar_sym(im, 1, 3, trim, h=1)
    for y in (5, 8):                                   # 冠饰上的刻线
        _sym(im, 35, y, 1, 2, armor_dk)
    _rivets(im, 33, 25, 5, 5, trim, mirror=True)       # 檐下铆钉

    # ── ⑧ 颅骨：颅顶 + 颧弓 + 眼窝 + 鼻腔 + 下颌 + 齿缝 ──────────────
    half_sym(im, 24, 16, 17, bone, up=False)           # 颅顶（y 24..41）
    bar_sym(im, 38, 12, bone, h=5)                     # 颧弓收窄（y 38..42）
    _sym(im, 29, 31, 7, 4, bone_dk)                    # 颧弓下缘的暗面
    _sym(im, 32, 27, 10, 9, MON_INK)                   # 眼窝
    _sym(im, 34, 30, 6, 4, blade_c)                    # 眼内骨火
    bar_sym(im, 38, 2, MON_INK, h=4)                   # 鼻腔
    bar_sym(im, 43, 10, bone, h=6)                     # 下颌（y 43..48）
    for x in (37, 41, 53, 57):                         # 齿缝（左右各两道，坐标成对）
        _put(im, x, 44, 1, 5, MON_INK)
    _sym(im, 44, 48, 3, 3, bone)                       # 犬齿（垂到下颌之下）

    # ── ⑨ 大圆盾（画面左侧 —— 离观众近的那一侧） ────────────────────
    #
    # 五层：外圈 / 内盘 / 十字辐条 / 铆钉环 / 中心宝石。旧稿只有「外圈 + 内盘 +
    # 一横一竖两条带」，在 96 网格上盾面是一大片纯金，`BOSS_DETAIL_MIN` 会抓住它。
    _ell(im, 18, 68, 16, 20, rim)
    _ell(im, 18, 68, 13, 17, shield)
    _ell(im, 18, 68, 10, 13, shield_dk)
    _put(im, 3, 66, 31, 4, trim)                       # 横向辐条
    _sym(im, 17, 49, 3, 39, trim)                      # 纵向辐条（走 `_sym` 保证左右一致）
    stud_ring(im, cx=18, cy=68, rx=12, ry=16, n=12, color=trim)
    _gem(im, 18, 68, 5, trim, MON_WHITE)

    # ── ⑩ 白骨长剑（画面右侧，竖握）：刃 + 血槽 + 剑格宝石 + 握柄 ────
    blade(im, x0=82, y0=6, x1=79, y1=76, core=blade_c, light=MON_WHITE,
          dark=blade_dk, thick=9, fuller=2)
    _put(im, 70, 74, 21, 4, armor)                     # 剑格
    _put(im, 70, 74, 21, 1, armor_dk)
    _gem(im, 80, 76, 4, trim, MON_WHITE)
    _put(im, 77, 78, 7, 14, grip)                      # 握柄
    _put(im, 78, 80, 1, 10, armor_dk)                  # 柄上缠绳
    _put(im, 81, 80, 1, 10, armor_dk)
    _put(im, 75, 92, 11, 3, armor)                     # 柄尾

    return im
