"""
魔王（`demonKing`，第 50 层）与真魔王（`demonKingTrue`，终局）—— 共用一套骨架，两个形态。

## 两个形态必须是两个一眼分得开的剪影

判据（`verify_boss_art` 判据 4）在改前**报红**：两只魔王只差 199 像素 ——
因为它们是**同一个骨架 + 一顶王冠**，玩家看到的读法是「同一个魔王换了颜色」，
而不是「我打到了真身」。断言是这个文件今天长成这样的唯一原因。

所以真身走另一套骨架：

|        | 普通魔王 | 真身 |
|---|---|---|
| 膜翼   | 身侧扬起，翼尖到 y16 | **高举过头**，翼尖顶到 y0、展幅更宽 |
| 巨角   | 外弯**两段** | 外弯**三段**，伸到画布左右边缘 |
| 手臂   | 垂在身侧 | **斜向上举**（战斗姿态） |
| 下盘   | 并腿站立 | **双腿张开** |
| 头饰   | 无 | 金冠 + 冠顶白高光 |

这五行**没有一行是靠颜色** —— 剪影差异全部来自形体，缩到 32px 甚至灰度看也分得开。

## 与魔龙的分工

魔龙走「正面 + 方吻 + 竖瞳 + 甩尾 + 横展翼」；这只走「对称 + 圆头 + 横的发光条 +
**贴身上扬**的膜翼 + 无尾」。两只不撞剪影（判据 4 量剪影差异，判据 8 量头部对称度，
两条都对这两只生效）。

膜翼沿用蝙蝠那套剖面法 —— 魔王张开的是**两片膜**，不是两根带条纹的柱子
（旧稿就是这个毛病：两颗品红竖条，玩家读成「门帘」）。
"""

from __future__ import annotations

import math

from ..palette import MON_INK, MON_WHITE
from ..pixel import _put
from ..shapes import _rivets, _sym
from .common import (
    BOS_CX,
    bar_sym,
    bos_canvas,
    diamond_sym,
    ell_sym,
    horn_pair,
    limb_pair,
    wing_pair,
)

IDS = ("demonKing", "demonKingTrue")

DEMON = dict(
    # 普通形态：封印前的魔王
    body=(146, 62, 150, 255),
    dark=(84, 30, 92, 255),
    light=(202, 122, 206, 255),
    glow=(252, 226, 92, 255),
    horn=(232, 226, 206, 255),
    plate=(58, 22, 66, 255),
)
# true_form=True 让真身换一整套骨架（高举巨翼 / 三段长角 / 斜举双臂 / 张腿）——
# 只加王冠的话两者的轮廓只差 199 像素（96 网格上按面积比约 450），判据 4 会报红
DEMON_TRUE = dict(
    body=(186, 34, 40, 255),
    dark=(104, 14, 20, 255),
    light=(240, 96, 88, 255),
    glow=(252, 226, 92, 255),
    horn=(232, 226, 206, 255),
    plate=(74, 12, 18, 255),
    crown=(250, 214, 84, 255),
)


def spec(bid: str) -> dict:
    if bid == "demonKing":
        return dict(DEMON)
    if bid == "demonKingTrue":
        return dict(DEMON_TRUE)
    raise KeyError(f"demon 模块不负责 {bid}")


def _horn_rings(segs, step=7):
    """
    沿角的分段**算出**环纹坐标 —— 不再手写。

    为什么：手写环纹必然在某一节上漏掉，而漏掉的那一段在 96 网格上就是一整块
    纯骨色。量出来的后果是内部细节只有 2.33（门槛 2.40 必红）—— 八个 6×6 的
    「1 色块」里有一半来自这两只的角与头腔，而它们正是最该有刻纹的地方。

    环纹的宽与起点由该段的粗细 `th` 推出（`_beam_sym` 落的是
    `[x - th//2, x - th//2 + th)`），所以换粗细时环纹会自动跟着变，
    不会出现「角变粗了、环纹还停在角外面」。
    """
    out = []
    for (x0, y0, x1, y1, th) in segs:
        n = max(1, int(round(math.hypot(x1 - x0, y1 - y0) / step)))
        for k in range(1, n + 1):
            t = k / (n + 1)
            x = x0 + (x1 - x0) * t
            y = y0 + (y1 - y0) * t
            out.append((int(round(x)) - th // 2 + 1, int(round(y)), max(3, th - 2), 2))
    return tuple(out)


def draw(s: dict, bid: str):
    im = bos_canvas()
    true_form = bid == "demonKingTrue"
    body, dark, light = s["body"], s["dark"], s["light"]
    glow, horn, plate = s["glow"], s["horn"], s["plate"]

    # ── ① 膜翼（最里层，左右各一片） ────────────────────────────────
    if true_form:
        # 高举的巨翼：翼根 y34..70 → 翼尖 y0..26，比普通形态高出一倍
        wing_pair(im, shoulder=36,
                  fan=(24, 34, 70, 0, 26, (0, 5, 10, 15, 20), 7),
                  rib=light, mem=dark, edge=4,
                  spots=((22, 52, 6, 3), (16, 42, 5, 3), (12, 28, 5, 3)))
    else:
        wing_pair(im, shoulder=34,
                  fan=(20, 34, 62, 16, 40, (0, 5, 10, 15), 6),
                  rib=light, mem=dark, edge=4,
                  spots=((22, 46, 5, 3), (16, 38, 5, 3)))
    _sym(im, 26, 56, 4, 2, light)                      # 翼膜上的亮脉
    _sym(im, 20, 64, 4, 2, light)

    # ── ② 腿（踩在格底）+ 腿甲分片 + 脚爪 ───────────────────────────
    #
    # 真身站得更开 —— 下盘一宽，整个剪影就与「并腿站着」的普通形态不同。
    # 成对结构一律走 `limb_pair`（内部每一笔都过 `_sym`），
    # 旧稿手写成对坐标时腿碰巧对了、同一段里的脚掌与分片却各错 1 列
    # ——「一半对、一半差 1 列」比全错更难查。
    if true_form:
        limb_pair(im, x0=29, y0=62, w=15, h=26, base=body, dark=dark,
                  light=light, edge=4, joint=dark)
        _sym(im, 22, 85, 24, 11, body)                 # 脚掌（张得更开）
        _sym(im, 24, 89, 8, 4, dark)                   # 脚背分片
        for k in range(3):
            _sym(im, 23 + k * 8, 90, 6, 6, horn)       # 脚爪
    else:
        limb_pair(im, x0=36, y0=62, w=12, h=26, base=body, dark=dark,
                  light=light, edge=3, joint=dark)
        _sym(im, 30, 85, 20, 11, body)
        _sym(im, 33, 89, 7, 4, dark)
        for k in range(2):
            _sym(im, 32 + k * 8, 90, 6, 6, horn)
        bar_sym(im, 90, 2, horn, h=6)

    # ── ③ 腹甲横排 + 躯干 + 胸甲 + 发光徽（外再套一圈亮环） ──────────
    for k in range(4):
        bar_sym(im, 74 + k * 4, 10, dark)
    ell_sym(im, 58, 25, 21, body)
    ell_sym(im, 56, 20, 17, plate)
    bar_sym(im, 41, 19, light, h=5)                    # 胸甲上缘受光
    _rivets(im, 30, 42, 4, 5, light, mirror=True)      # 上缘铆钉
    _sym(im, 23, 48, 7, 16, light)                     # 躯干两侧的高光条（三阶）
    _sym(im, 26, 66, 5, 10, light)
    bar_sym(im, 68, 16, dark, h=2)                     # 腹甲分片横线
    bar_sym(im, 74, 14, dark, h=2)
    # 发光徽：**比第一版小一圈**。第一版 `ry=14 / rx=12` 的徽在缩到 32px 后
    # 与头上的嘴（同是「暗底 + 白牙」的横条）读成同一个东西 —— 一张脸上两张嘴。
    ell_sym(im, 58, 10, 12, plate)
    ell_sym(im, 58, 7, 9, glow)
    ell_sym(im, 58, 3, 5, MON_WHITE)

    # ── ④ 手臂：普通形态垂在身侧，真身斜向上举 ───────────────────────
    #
    # 真身那条走 `_beam_sym`（斜带而非竖条 —— 竖条会和翼的指骨混成一片）。
    # 旧稿写右手而左手的镜像是另一串坐标，两只手臂**差 7 列**，
    # 落屏后是「一只举手、一只搭在腰上」。
    if true_form:
        horn_pair(im, segs=((34, 58, 14, 30, 11),), color=dark, thick=11,
                  rings=((28, 48, 6, 2), (20, 38, 6, 2)))
        _sym(im, 12, 26, 10, 10, light)                # 拳头
    else:
        limb_pair(im, x0=13, y0=46, w=14, h=32, base=dark, dark=body,
                  light=light, edge=4, joint=body)
        _sym(im, 11, 76, 18, 8, dark)                  # 手
        _sym(im, 13, 78, 3, 5, body)

    # ── ⑤ 巨角（骨色，向外上弯）+ 环纹 ──────────────────────────────
    #
    # 环纹由 `_horn_rings` **沿分段算**，不手写 —— 手写时这两只的角各有一段
    # 完全光秃（一整块纯骨色），内部细节判据就是被它拖到 2.33 的。
    if true_form:
        # 三段、末端伸到画布左右边缘 —— `horn_pair` 内部走 `_beam_sym`，只写左半
        segs = ((37, 36, 20, 14, 10), (30, 22, 10, 4, 9), (18, 10, 2, 0, 8))
        horn_pair(im, segs=segs, color=horn, thick=10, rings=_horn_rings(segs))
    else:
        segs = ((36, 36, 20, 14, 9), (30, 22, 12, 4, 8))
        horn_pair(im, segs=segs, color=horn, thick=9, rings=_horn_rings(segs))

    # ── ⑥ 头 + 发光眼（**横的**发光条）+ 獠牙 ───────────────────────
    ell_sym(im, 34, 19, 19, body)
    ell_sym(im, 30, 16, 13, dark)

    # 头腔（`ell_sym(30,16,13,dark)`）在 96 网格上是一整片纯暗，贡献了 8 个
    # 「1 色块」。额与颊本来就有起伏 —— 补眉弓与颧影，它们落在暗腔**之内**，
    # 用的是比 `dark` 亮一档的 `body`，所以是看得见的第三阶（同色叠同色不算）。
    _sym(im, 37, 19, 8, 5, body)                       # 眉弓
    _sym(im, 36, 26, 5, 9, body)                       # 颧（两侧）
    bar_sym(im, 21, 5, body, h=4)                      # 额中（跨轴，天然对称）

    _sym(im, 29, 32, 15, 11, dark)                     # 眼窝
    _sym(im, 31, 35, 11, 6, glow)                      # 横的发光条
    _sym(im, 34, 36, 5, 4, MON_INK)                    # 条中的暗核（读作竖起的瞳）
    bar_sym(im, 46, 11, MON_INK, h=4)                  # 口
    _sym(im, 38, 49, 4, 6, MON_WHITE)                  # 獠牙（两对）
    _sym(im, 44, 49, 3, 5, MON_WHITE)
    bar_sym(im, 53, 13, dark, h=3)                     # 颈甲（把「头」与「胸」切开）

    # ── ⑦ 王冠（真身专属）+ 冠顶嵌宝石 ──────────────────────────────
    if "crown" in s:
        crown = s["crown"]
        bar_sym(im, 12, 14, crown, h=6)                # 冠带
        bar_sym(im, 12, 14, MON_WHITE, h=1)
        bar_sym(im, 4, 3, crown, h=9)                  # 中央尖（跨轴，天然对称）
        _sym(im, 33, 6, 7, 7, crown)                   # 两侧尖
        _sym(im, 24, 9, 5, 4, crown)                   # 再外侧两枚小尖
        _sym(im, 33, 9, 7, 1, dark)                    # 尖上的刻线
        diamond_sym(im, 15, 4, crown, hi=MON_WHITE)

    return im
