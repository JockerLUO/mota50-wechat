"""
手绘怪物：13 种形状 / 35 只（唯一的例外是 `ice_zombie`，仍取 0x72）。

## 设计语言：职业 × 等级两个正交维度

职业 = 装备剪影（枪盾/剑盾/法杖/战斧/锈剑/幽光剑）；
等级 = 材质三阶（`BRONZE_A` → `SILVER_A` → `GOLD_A`，定义在 `palette.py`）
+ 覆盖度（盔羽 / 披风 / 帽高）。
**换等级只改颜色与装备，剪影骨架不动** —— 同族一眼是一家人，这是刻意的。

## 32 网格，不是 16

相对旧版翻 4 倍像素，是「更精细」的主来源（落屏尺寸不变，仍经 `_mon_out` 升到 64）。
"""

from __future__ import annotations

import math
from .pil import Image
from .config import CELL
from .palette import BRONZE_A, GOLD_A, IRON_A, MON_INK, MON_WHITE, SILVER_A
from .pixel import _put, add_outline, alpha_mul
from .shapes import _ell, _sym
from .data import OVERSIZE_BOSSES



def verify_monster_fit(art: dict[str, dict]) -> list[str]:
    """
    怪物素材的两条布局断言。

    `art`： id -> {"h": 内容高度最坏值, "scale": 绘制倍数, "padIdle": idle 帧底留白最坏值}

    ① **非 BOSS 必须装得进一格。** 落屏内容高度 ≤ CELL。
       抓的是「精灵比格子还高」——它会让「怪物占哪一格」在画面上变得不确定，
       而魔塔是靠走进某格来打怪的。实测踩过：5 只非 BOSS 取了 ×3，
       全塔 479 只怪物里 145 只是它们。

    ② **idle 帧必须底对齐（底留白为 0）。**
       渲染层让精灵「站在脚下名牌的上沿」，站的位置就是帧底沿；idle 又是棋盘上
       唯一会用到的动画。帧底若留白，怪物就会浮在名牌上方 —— 而且不同怪浮的量不同，
       非常难查。
       注意**只断言 idle**：`run` 帧实测有 1–3px 底留白，那是源动画本身的起伏，
       而棋盘不用 run 帧（`grep "run" src/` 为空）。对所有帧一刀切会误报。
    """
    problems: list[str] = []
    for mid, info in sorted(art.items()):
        if info["padIdle"] != 0:
            problems.append(
                f"怪物 {mid} 的 idle 帧底部有 {info['padIdle']}px 透明留白 —— 渲染层让精灵"
                f"站在脚下名牌的上沿，留白会让它浮在半空。idle 帧必须底对齐"
            )
        if mid in OVERSIZE_BOSSES:
            continue
        h, scale = info["h"], info["scale"]
        if h * scale > CELL:
            problems.append(
                f"怪物 {mid} 落屏内容高 {h}×{scale}={h * scale}px，超过格子 {CELL}px —— "
                f"非加大的精灵必须装得进一格，否则「它占哪一格」在画面上不确定。"
                f"（确实要更大且是 BOSS，就加进 OVERSIZE_BOSSES）"
            )
    return problems




# ─────────────────────────────────────────────────────────────────────
# 九·B、程序化怪物造型（按**名称**画，不按手里有什么素材画）
# ─────────────────────────────────────────────────────────────────────
#
# ## 为什么必须自己画
#
# 0x72 地牢包一共 24 张角色底图（skelet / knight / imp / swampy / chort / ogre …），
# **全都是人形**——它根本没有蝙蝠、没有龙、没有乌贼、没有石头人、没有史莱姆。
# 于是第一版只能硬凑：
#
#   小蝙蝠 / 大蝙蝠 / 吸血蝙蝠  ← imp（有角的小恶魔人形）
#   魔龙                      ← chort（小鬼）
#   大乌贼                    ← swampy（绿衣人形）
#   石头人                    ← ogre（食人魔）
#   绿/红/大史莱姆、史莱姆王     ← swampy / muddy（穿绿衣的小人）
#
# 棋盘上因此出现「标着『绿史』却是个拿铲子的绿衣人」这种画面。
# **换素材解决不了**（包里没有非人形），所以改成按名称手绘 ——
# 做法与 NPC 完全一致：`_put()` 一个原语填像素块，硬边、不是矢量缩放。
#
# ## 形状与颜色分开，是为了「同形换色」这件事是显式的
#
# 史莱姆族四只是同一个形状、四套颜色（绿 / 红 / 更大 / 金冠）。
# 旧写法用 `hue_shift` 去猜（把 swampy 的绿推到红），结果是把明暗结构一起推糊了。
# 这里颜色直接写在 `PROC_MONSTERS` 的 spec 里 —— 想要什么色就是什么色。
#
# ## 一条纪律：任何一帧的底行都必须有像素
#
# 渲染层让精灵「站在脚下名牌的上沿」（board.ts: sp.anchor.set(0.5, 1)），
# 帧底留白 = 怪物浮在半空。有断言（verify_monster_fit 的 padIdle，与旧素材同一套）。

MON_W = MON_H = 32  # 手绘怪物绘制网格：相对旧版 16 翻 4 倍像素，是「更精细」的主来源（落屏尺寸不变，仍经 _mon_out 升到 64）




def _mon_canvas() -> Image.Image:
    return Image.new("RGBA", (MON_W, MON_H), (0, 0, 0, 0))




# ⚠️ 这里**曾经**有一个 `_stamp(rows, legend)` 字符模板原语，配着 BAT_NARROW /
# BAT_WIDE / DRAGON_ROWS 三张 16 列的模板。2026-09-23 全部删掉，三条理由：
#   ① 它是 **16 网格时代**的产物，而 `MON_W` 早就提到 32 —— 三张模板的字符串
#      只有 16 个字符，喂进去会直接被 `len(row) != MON_W` 抛错。也就是说它们
#      **早就调不动了**（死代码），而注释还在讲「蝙蝠/龙用模板画」，
#      下一个人会照着改模板、改完发现毫无反应。
#   ② 「模板」和「算法」从来不是二选一：`_mon_bat` 现在用**逐列剖面表**
#      （BAT_WING_*）表达翼形，同样是「源码里看得见形状」，而且能整体缩放。
#   ③ 留着一套「形状其实不在这儿画」的注释，比没有注释更贵。

# ── 形状 ────────────────────────────────────────────────────────────
#
# 每个形状只吃 spec 里的颜色，不关心自己代表谁 —— 「皇帝史莱姆」和
# 「绿史莱姆」的差别在 spec，不在函数里。
#
# 全部形状都用 `_put` / `_sym` / `_ell` 一行行程序化生成 —— 半径、张角、椭圆
# 本来就是算法，坐标法在 32 网格上写起来比字符模板更准也更易复查。

# ── 蝙蝠的膜翼剖面表（2026-09-23 重画）──────────────────────────────
#
# 每一项是**一列**的 `(顶行, 底行)`，索引 0 = 贴着球身的肩部，
# 最后一项 = 翼尖。左翼由这张表画，右翼交给 `_sym` 镜像
# （手写成对坐标必然一边差 1px，棋盘上是「两个翅膀一高一低」）。
#
# ## 为什么是「逐列底边」而不是「几段横条」
#
# 上一版把翼画成「每列交替 `body`/`dark`」，落屏后是一根**带条纹的竖柱子**：
#   玩家在第 15 层的实拍里把它读成「羊角」，第 50 层魔王的膜翼也是同一副样子
#   （两颗品红竖条）。**竖条不构成翅膀** —— 翅膀的识别信号只有一个：
#   **底边的锯齿**（指骨把膜撑开、指骨之间的膜往上内凹）。
#
# ## 两条硬约束
#
#   · 底边相邻两列的落差必须 ≥ **3 行**。`add_outline` 是 1px 八邻域膨胀，
#     落差 1~2 行的锯齿会被描边**直接填平**，等于没画（本项目第 6 条铁律）。
#   · 顶行只能往翼尖方向**单调减小**（外高内低）—— 翼是往上扬的。
#     写成中间凹下去就变成「折翼」，剪影会读成一条蠕动的带子。
#
# ## 两个变体
#
#   NARROW：7 列，翼尖到第 2 列 —— 普通蝙蝠，翼收得紧。
#   WIDE  ：9 列，翼尖到第 0 列（贴画布边）—— 大蝙蝠 / 吸血蝙蝠，翼展明显更大。
BAT_WING_NARROW = [
    (13, 25), (12, 24), (11, 19), (10, 23), (9, 17), (8, 20), (6, 10),
]


BAT_WING_WIDE = [
    (13, 26), (12, 25), (11, 20), (10, 24), (9, 19), (8, 22), (7, 16), (6, 19), (5, 9),
]



# 哪些列是「指骨」—— 整列走 `body`（亮），膜走 `dark`（暗）。
# 亮骨架 + 暗膜是翅膀读得出来的第二层信号；全用一个色就只剩剪影。
# 索引与上面的剖面表对齐（0 = 肩）：肩 + 三个「底边凸出来的」指节。
BAT_RIB_NARROW = (0, 3, 5)


BAT_RIB_WIDE = (0, 3, 5, 7)



# 肩部贴在第几列 —— 球身在 y=17..25 最宽时占 9..23，所以肩取 9：
# 翼根正好压在球身的边缘那一列上（`body` 同色 → 看不见缝），
# 翼**看起来是从身上长出来的**而不是贴在旁边。取 8 会在肩部留 1 列空隙，
# 靠 `add_outline` 的 1px 膨胀勉强接上，但放大看是一条缝。
BAT_SHOULDER_X = 9


# 翼的顶边（前缘 / 小臂）厚度：2 行。只写 1 行会被描边吃成「白色的细线」
BAT_EDGE_H = 2



def _mon_slime(s) -> Image.Image:
    """史莱姆（DQ 风）：圆顶水滴身 + 大白眼黑瞳 + 微笑 + 左上高光 + 右下阴影；`top` 越小越「大只」。"""
    im = _mon_canvas()
    body, dark, light = s["body"], s["dark"], s["light"]
    top = s.get("top", 7)
    cx = MON_W / 2
    maxhw = 13
    # 身体：sqrt 圆顶（窄顶、宽底），底两行收一点成「脚」
    for y in range(top, MON_H):
        t = (y - top) / (MON_H - 1 - top)
        hw = int(round(maxhw * math.sqrt(max(0.0, t))))
        if y >= MON_H - 3:
            hw -= (y - (MON_H - 4))
        if hw < 1:
            hw = 1
        _put(im, int(round(cx - hw)), y, hw * 2 + 1, 1, body)
    # 底两行压暗（坐在地上）
    for y in (MON_H - 2, MON_H - 1):
        t = (y - top) / (MON_H - 1 - top)
        hw = int(round(maxhw * math.sqrt(max(0.0, t))))
        if y >= MON_H - 3:
            hw -= (y - (MON_H - 4))
        if hw < 1:
            hw = 1
        _put(im, int(round(cx - hw)), y, hw * 2 + 1, 1, dark)
    # 左上高光
    _ell(im, cx - 5, top + 6, 4, 3, light)
    # 右下阴影（身体右侧）
    for y in range(top + 10, MON_H - 1):
        t = (y - top) / (MON_H - 1 - top)
        hw = int(round(maxhw * math.sqrt(max(0.0, t))))
        if y >= MON_H - 3:
            hw -= (y - (MON_H - 4))
        if hw < 1:
            hw = 1
        _put(im, int(round(cx + hw - 3)), y, 3, 1, dark)
    # 大白眼 + 黑瞳（DQ 标志）
    _ell(im, cx - 5, top + 11, 3, 4, MON_WHITE)
    _ell(im, cx + 5, top + 11, 3, 4, MON_WHITE)
    _ell(im, cx - 5, top + 12, 1, 2, MON_INK)
    _ell(im, cx + 5, top + 12, 1, 2, MON_INK)
    # 微笑弧
    my = top + 18
    for dx in range(-3, 4):
        yy = my + (dx * dx) // 5
        _put(im, int(round(cx + dx)), yy, 1, 1, MON_INK)
    # 史莱姆王：金冠
    if s.get("crown"):
        g = s["crown"]
        _put(im, int(round(cx - 6)), max(0, top - 1), 13, 2, g)
        for sx in (int(round(cx - 6)), int(round(cx)), int(round(cx + 6))):
            _put(im, sx, max(0, top - 4), 2, 3, g)
    return im




def _mon_bat(s) -> Image.Image:
    """蝙蝠：**圆球身 + 大眼 + 尖耳 + 一对真膜翼**（DQ「德拉基」的可爱度，蝙蝠的剪影）。

    ## 这一版改了什么（2026-09-23，玩家「优化蝙蝠类怪物模型」）

    | | 上一版 | 这一版 |
    |---|---|---|
    | 翼 | 「上尖下圆的小圆叶」，逐列交替 `body`/`dark` —— 落屏是**两根带条纹的竖柱** | 逐列剖面表 `BAT_WING_*`：前缘 2 行 + **底边锯齿** + 指骨亮线 |
    | 头 | 两根直立的「呆毛」（读起来像触角） | 一对**外撇的尖耳** + 内耳亮色 —— 蝙蝠的身份记号 |
    | 身 | 球心 y=19、半径 11（与翼挤在一起） | 球心 y=21、rx=7/ry=11 —— 左右各让出 9 列给翼 |

    保留三件「可爱」特征：**球身、占脸一半的大眼、獠牙**（`fangs`）。
    `span` 换成宽翼，翼尖一直伸到画布边（大蝙蝠 / 吸血蝙蝠）。

    ## 两个画序约束（都被咬过）

    · **翼必须在球身之后画。** 翼根压在球身边上（翅膀是从身上长出来的），
      顺序反了会被球身吃掉一列，翼就「断」在半空。
    · **眼与瞳孔用 `_sym` 逐行画，不用 `_ell`。** `_ell` 以 `cx = MON_W/2 = 16`
      为心时，左右两只会差 1 列（9..15 的镜像是 8..14 而不是 17..23）——
      球身差 1px 看不出来，但两只大眼不对称是**一眼可见**的。
    """
    im = _mon_canvas()
    body, dark, light = s["body"], s["dark"], s["light"]
    wide = bool(s.get("span"))
    wing = BAT_WING_WIDE if wide else BAT_WING_NARROW
    ribs = BAT_RIB_WIDE if wide else BAT_RIB_NARROW

    # 1) 圆球身体：占画布中下 2/3，且**底行必须有像素**（底部锚定，见模块头那条纪律）
    _ell(im, 16, 21, 7, 11, body)

    # 2) 膜翼：只画左半边，右半边由 _sym 镜像（手写成对坐标必然一边差 1px）
    for i, (top, bot) in enumerate(wing):
        x = BAT_SHOULDER_X - i
        for y in range(top, bot + 1):
            # 前缘 BAT_EDGE_H 行 + 整根指骨走亮色；其余是暗色的膜 ——
            # 亮骨架在暗膜上，是剪影之外的第二层识别信号
            col = body if (i in ribs or y < top + BAT_EDGE_H) else dark
            _sym(im, x, y, 1, 1, col)

    # 3) 尖耳（外撇的三角，不是直立的触角）。耳根 5 列宽 ——
    #    上一版只有 3 列，落屏后是「一根斜线」，读不成耳朵。
    _sym(im, 10, 12, 5, 1, body)
    _sym(im, 10, 10, 5, 2, body)
    _sym(im, 10, 8, 4, 2, body)
    _sym(im, 10, 6, 3, 2, body)
    _sym(im, 10, 4, 2, 2, body)
    _sym(im, 11, 8, 2, 3, light)      # 内耳

    # 4) 大眼（逐行镜像，见上面的说明）+ 瞳孔偏内下（「呆萌」的来源）
    for dy, (x0, w) in enumerate([(10, 4), (9, 6), (9, 6), (9, 6), (10, 4)]):
        _sym(im, x0, 15 + dy, w, 1, MON_WHITE)
    _sym(im, 12, 17, 2, 2, MON_INK)

    # 5) 嘴 + 獠牙
    _put(im, 15, 24, 2, 1, MON_INK)
    if s.get("fangs"):
        _sym(im, 14, 25, 1, 3, MON_WHITE)

    # 6) 脸颊高光（球身被眼占满，高光只能落在眼下 —— 硬挪到左上会越出剪影）
    _ell(im, 11, 23, 2, 2, light)
    return im




def _mon_golem(s) -> Image.Image:
    """石头人（DQ 风）：方块头 + 发光眼 + 砖缝躯干 + 方块手臂拳头 + 短腿落地。全程直角，和生物剪影区分。"""
    im = _mon_canvas()
    face, dark, light, seam = s["body"], s["dark"], s["light"], s["seam"]
    cx = MON_W / 2
    # 头（方块，比躯干窄）
    _put(im, 10, 4, 12, 9, face)
    _put(im, 10, 4, 12, 1, light)            # 头顶高光
    _put(im, 10, 4, 1, 9, light)             # 左缘高光
    _put(im, 11, 7, 3, 3, s["glow"])         # 左眼（发光）
    _put(im, 18, 7, 3, 3, s["glow"])         # 右眼
    _put(im, 14, 12, 4, 1, dark)             # 嘴
    # 躯干（方块）
    _put(im, 7, 13, 18, 12, face)
    _put(im, 7, 13, 18, 1, light)
    # 砖缝：竖缝 + 错开横缝（立刻读成「砌起来的石头」）
    _put(im, 15, 14, 1, 11, seam)
    _put(im, 7, 17, 8, 1, seam)
    _put(im, 16, 20, 9, 1, seam)
    _put(im, 10, 16, 1, 3, seam)             # 裂缝
    _put(im, 21, 18, 1, 3, seam)
    # 手臂 + 拳头（贴躯干两侧，比躯干矮一档）
    _sym(im, 3, 14, 4, 10, dark)
    _sym(im, 3, 14, 4, 2, face)
    _sym(im, 3, 23, 4, 2, dark)              # 拳头
    # 腿（短，落地到最底行）
    _sym(im, 9, 25, 5, 7, dark)
    return im




# ── 人形怪（六个形状，22 只）：职业 × 等级 ────────────────────────────
#
# 0x72 的人形底图有两个解决不了的问题：
#   ① `knight_m/f` 源图是**像素机器人**（浅蓝方壳 + 独眼），守卫/骑士 8 只全顶着它；
#   ② 同族等级只靠换色（ramp 铁→银→金），16px 下阶差几乎不可读。
# 所以人形怪也搬进 32 网格手绘，设计语言是**两个正交维度**：
#
#   职业（你是什么兵）→ 靠**装备剪影**：枪+圆盾=守卫、大剑+鸢盾=骑士、
#     尖帽+法杖=法师、战斧+獠牙=兽人、锈剑+骨架=骷髅、兜帽+飘尾=幽魂。
#   等级（你练到几级）→ 靠**材质与覆盖度**：甲色三阶（青铜→白银→黄金）、
#     盔羽无→短→高、披风无→有、护甲覆盖度（裸骨→铁甲→金甲）。
#
# 换等级只改颜色/加一件装备，剪影骨架不动 —— 同族一眼认出「是一家人」。

_SKIN = (232, 190, 150, 255)


_WOOD = (122, 86, 48, 255)


_STEEL = (198, 204, 214, 255)




def _mon_soldier(s) -> Image.Image:
    """
    守卫：长枪（顶天立地杵在地上）+ 左臂圆盾 + 全盔。

    等级记号：`plume_h` 盔羽 0=无(青铜) 1=短(白银) 2=高(黄金)；甲色即材质三阶；
    `trim`/`boss` 黄金阶的金饰。枪杆落地 → 底行必有像素。
    """
    im = _mon_canvas()
    armor, dark, light = s["armor"], s["dark"], s["light"]
    # 长枪：枪尖 + 杆（y=4..31 落地）
    _put(im, 25, 0, 4, 3, s["tip"])
    _put(im, 26, 3, 2, 1, s["tip"])
    _put(im, 26, 4, 2, 28, s["shaft"])
    # 全盔：圆顶 + 盔沿 + 护鼻
    _ell(im, 15, 7, 6, 4, armor)
    _put(im, 10, 8, 11, 2, armor)
    _put(im, 9, 9, 13, 1, dark)
    _put(im, 14, 9, 3, 4, light)
    # 盔羽（等级）
    ph = s.get("plume_h", 0)
    if ph and s.get("plume"):
        _put(im, 13, 4 - ph * 2, 5, ph * 2 + 1, s["plume"])
        _put(im, 14, 3 - ph * 2, 3, ph, s["plume"])
    # 脸（盔沿下的窄条）
    _put(im, 10, 10, 11, 3, s["skin"])
    _put(im, 11, 10, 2, 2, MON_INK)
    _put(im, 18, 10, 2, 2, MON_INK)
    # 躯干甲 + 胸口金饰
    _put(im, 9, 13, 13, 9, armor)
    _put(im, 9, 13, 13, 1, light)
    _put(im, 20, 14, 2, 7, dark)
    if s.get("trim"):
        _put(im, 9, 16, 13, 1, s["trim"])
    # 腰带 + 腿 + 靴（靴到 y=31）
    _put(im, 9, 21, 13, 2, dark)
    _put(im, 15, 21, 2, 2, light)
    _put(im, 10, 23, 5, 7, dark)
    _put(im, 17, 23, 5, 7, dark)
    _put(im, 9, 29, 7, 3, armor)
    _put(im, 16, 29, 7, 3, armor)
    # 持枪的手
    _put(im, 22, 15, 5, 3, s["skin"])
    # 圆盾（左臂）：外圈 + 盾面 + 盾钉
    _ell(im, 5, 19, 5, 7, s["shield_rim"])
    _ell(im, 5, 19, 3, 5, s["shield"])
    _put(im, 4, 18, 2, 2, s.get("boss", light))
    return im




def _mon_knight(s) -> Image.Image:
    """
    重甲骑士：全盔 + 宽肩甲 + 鸢盾 + 大剑。

    职业内分工：`open=1` 露脸戴头带（剑士的轻装）、全盔为重装；
    等级记号：甲材质 + `plume` 盔羽 + `cape` 披风 + `trim` 金饰 +
    `glow` 目缝发光（暗黑骑士）。
    """
    im = _mon_canvas()
    armor, dark, light = s["armor"], s["dark"], s["light"]
    # 披风（画在身后，只露两摆）
    if s.get("cape"):
        _put(im, 3, 12, 6, 16, s["cape"])
        _put(im, 23, 12, 6, 16, s["cape"])
        _put(im, 3, 26, 6, 2, dark)
        _put(im, 23, 26, 6, 2, dark)
    # 头：全盔（T 形目缝）or 露脸（头带 + 鬓发）
    if s.get("open"):
        _put(im, 10, 4, 12, 8, s["skin"])
        _put(im, 9, 3, 14, 3, s["band"])
        _put(im, 9, 6, 2, 6, s["band"])
        _put(im, 21, 6, 2, 6, s["band"])
        _put(im, 12, 8, 2, 2, MON_INK)
        _put(im, 18, 8, 2, 2, MON_INK)
        _put(im, 14, 11, 4, 1, dark)
    else:
        _put(im, 9, 3, 14, 9, armor)
        _put(im, 9, 3, 14, 1, light)
        _put(im, 14, 5, 3, 6, dark)
        _put(im, 11, 8, 10, 2, dark)
        if s.get("glow"):
            _put(im, 11, 8, 3, 2, s["glow"])
            _put(im, 18, 8, 3, 2, s["glow"])
    # 盔羽
    if s.get("plume"):
        _put(im, 13, 0, 5, 4, s["plume"])
        _put(im, 12, 1, 2, 3, s["plume"])
    # 肩甲（宽出躯干）+ 胸甲
    _put(im, 6, 12, 6, 4, light)
    _put(im, 20, 12, 6, 4, light)
    _put(im, 8, 14, 16, 8, armor)
    _put(im, 8, 14, 16, 1, light)
    if s.get("trim"):
        _put(im, 8, 17, 16, 1, s["trim"])
        _put(im, 15, 14, 2, 8, s["trim"])
    # 腹甲 + 腿甲 + 铁靴（y=29..31 落地）
    _put(im, 10, 22, 12, 3, dark)
    _put(im, 10, 25, 5, 5, armor)
    _put(im, 17, 25, 5, 5, armor)
    _put(im, 9, 29, 7, 3, dark)
    _put(im, 16, 29, 7, 3, dark)
    # 大剑（右手直举：刃 + 护手 + 柄）
    _put(im, 26, 1, 3, 15, s["blade"])
    _put(im, 26, 1, 1, 15, light)
    _put(im, 23, 16, 9, 2, s.get("trim", light))
    _put(im, 26, 18, 3, 5, dark)
    _put(im, 24, 20, 3, 2, s.get("skin", light))
    # 鸢盾（左臂）：上宽下收尖
    if s.get("shield"):
        _put(im, 1, 12, 8, 10, s["shield"])
        _put(im, 2, 22, 6, 3, s["shield"])
        _put(im, 3, 25, 4, 2, s["shield"])
        _put(im, 1, 12, 8, 1, light)
        _put(im, 3, 15, 4, 4, light)
    return im




def _mon_mage(s) -> Image.Image:
    """
    法师：尖帽/兜帽 + A 字长袍（下摆触地）+ 法杖顶宝珠。

    职业记号：尖帽（`hat`）或兜帽（`hood`，魔卫）+ 杖顶宝珠；
    等级记号：袍色（蓝→紫→金）+ `hat_h` 帽高 + 须（男）/长发（女）+ 宝珠色。
    """
    im = _mon_canvas()
    robe, dark, light = s["robe"], s["dark"], s["light"]
    hat = s.get("hat")
    hood = s.get("hood")
    # 帽（锥形，帽尖随 hat_h 抬高）或兜帽（圆顶包脸）
    if hat:
        hh = s.get("hat_h", 1)
        apex = 4 - hh * 3
        for k, y in enumerate(range(apex, 8)):
            w = min(16, 2 + k * 2)
            _put(im, 16 - w // 2, y, w, 1, hat)
        _put(im, 7, 8, 18, 2, hat)
        _put(im, 7, 9, 18, 1, dark)
    else:
        _ell(im, 16, 9, 8, 6, hood)
        _put(im, 8, 12, 16, 2, hood)
    # 脸 + 眼
    _put(im, 11, 10, 10, 5, s["skin"])
    _put(im, 12, 11, 2, 2, MON_INK)
    _put(im, 18, 11, 2, 2, MON_INK)
    # 袍（A 字，左右缘压暗，下摆 y=29..31 触地）
    for y in range(15, 32):
        w = 12 + int(round((y - 15) / 16 * 12))
        x0 = 16 - w // 2
        _put(im, x0, y, w, 1, robe)
        _put(im, x0, y, 2, 1, dark)
        _put(im, x0 + w - 2, y, 2, 1, dark)
    _put(im, 3, 29, 26, 3, robe)
    _put(im, 3, 31, 26, 1, dark)
    if s.get("trim"):
        _put(im, 10, 19, 12, 2, s["trim"])
    # 须（男）或长发（女），画在袍之上
    if s.get("beard"):
        bl = s.get("beard_len", 0)
        _put(im, 12, 14, 8, 4 + bl, s["beard"])
        _put(im, 14, 18 + bl, 4, 2, s["beard"])
    if s.get("hair"):
        _put(im, 9, 10, 2, 7, s["hair"])
        _put(im, 21, 10, 2, 7, s["hair"])
    # 持杖的手 + 法杖（杆落地）+ 宝珠
    _put(im, 22, 18, 4, 3, s["skin"])
    _put(im, 26, 5, 2, 27, s["staff"])
    _ell(im, 27, 3, 3, 3, s["orb"])
    _put(im, 25, 1, 2, 2, light)
    return im




def _mon_orc(s) -> Image.Image:
    """
    兽人：绿皮 + 獠牙 + 尖耳，弯腰驼背的壮汉。

    职业记号：武器（`weapon`：club 木棒 / axe 战斧 / dagger 短匕）；
    等级记号：`pads` 铁肩甲、皮色深浅；`small=1` 矮化（哥布林：头大身短）。
    """
    im = _mon_canvas()
    skin, dark, light = s["skin"], s["dark"], s["light"]
    sm = 4 if s.get("small") else 0
    # 尖耳（向外上）
    _put(im, 5, 7 + sm, 3, 2, skin)
    _put(im, 4, 9 + sm, 3, 3, skin)
    _put(im, 24, 7 + sm, 3, 2, skin)
    _put(im, 25, 9 + sm, 3, 3, skin)
    # 头（宽颅 + 眉 + 大颚）+ 眼 + 獠牙
    _ell(im, 16, 10 + sm, 8, 5, skin)
    _put(im, 10, 8 + sm, 12, 1, dark)
    _put(im, 11, 9 + sm, 2, 2, s["eye"])
    _put(im, 19, 9 + sm, 2, 2, s["eye"])
    _put(im, 11, 13 + sm, 10, 3, light)
    _put(im, 12, 11 + sm, 2, 3, MON_WHITE)
    _put(im, 18, 11 + sm, 2, 3, MON_WHITE)
    # 躯干（壮）+ 肚皮 + 肩甲
    _ell(im, 16, 20 + sm, 9 - sm // 2, 6, skin)
    _ell(im, 16, 21 + sm, 5, 3, light)
    if s.get("pads"):
        _ell(im, 7, 15 + sm, 3, 3, s["pads"])
        _ell(im, 25, 15 + sm, 3, 3, s["pads"])
    # 腰带 + 腿 + 脚（y=31 触底）
    _put(im, 9, 24 + sm, 14, 2, s["belt"])
    leg_h = 4 if sm else 6
    _put(im, 11, 26 + sm, 5, leg_h, dark)
    _put(im, 17, 26 + sm, 5, leg_h, dark)
    _put(im, 10, 31, 6, 1, dark)
    _put(im, 16, 31, 6, 1, dark)
    # 武器（右手）
    wp = s.get("weapon", "club")
    if wp == "axe":
        _put(im, 26, 8, 2, 20, s["shaft"])
        _put(im, 22, 4, 8, 5, s["blade"])
        _put(im, 24, 3, 4, 2, s["blade"])
    elif wp == "dagger":
        _put(im, 27, 18, 2, 8, MON_WHITE)
        _put(im, 26, 24, 4, 2, s["belt"])
    else:
        _put(im, 26, 6, 2, 22, s["shaft"])
        _put(im, 24, 3, 6, 5, s["shaft"])
        _put(im, 23, 2, 2, 2, s["belt"])
        _put(im, 29, 4, 2, 2, s["belt"])
    return im




def _mon_skeleton(s) -> Image.Image:
    """
    骷髅：颅骨 + 肋骨 + 细骨腿 + 锈剑。

    等级记号是**护甲覆盖度**：裸骨（skeleton）→ 铁盔铁甲（soldier）→
    金盔金甲 + 圆盾（captain）。骨色不变，一眼读出「同一族练到几级」。
    """
    im = _mon_canvas()
    bone, dark = s["bone"], s["joint"]
    # 颅骨 + 眼窝 + 鼻腔 + 牙缝
    _ell(im, 15, 7, 7, 5, bone)
    _put(im, 9, 6, 13, 3, bone)
    _ell(im, 11, 7, 2, 2, MON_INK)
    _ell(im, 19, 7, 2, 2, MON_INK)
    _put(im, 14, 9, 3, 2, MON_INK)
    _put(im, 11, 12, 9, 2, bone)
    for x in (12, 15, 18):
        _put(im, x, 12, 1, 2, dark)
    # 颈 + 胸腔（肋缝 + 中缝）
    _put(im, 14, 14, 3, 1, dark)
    _put(im, 9, 15, 13, 7, bone)
    for y in (16, 18, 20):
        _put(im, 10, y, 11, 1, dark)
    _put(im, 15, 15, 1, 7, dark)
    # 护甲（等级）：盖住肋
    if s.get("armor"):
        _put(im, 8, 14, 15, 7, s["armor"])
        _put(im, 8, 14, 15, 1, s.get("trim", bone))
        if s.get("trim"):
            _put(im, 8, 18, 15, 1, s["trim"])
    # 骨盆 + 臂骨 + 腿骨 + 足（y=31 触底）
    _put(im, 10, 22, 11, 3, bone)
    _put(im, 13, 23, 5, 1, dark)
    _sym(im, 6, 15, 2, 9, bone)
    _put(im, 5, 24, 3, 2, bone)
    _put(im, 24, 24, 3, 2, bone)
    _put(im, 11, 25, 4, 6, bone)
    _put(im, 17, 25, 4, 6, bone)
    _put(im, 10, 31, 6, 1, bone)
    _put(im, 16, 31, 6, 1, bone)
    # 锈剑（右手）
    _put(im, 27, 5, 2, 14, s["blade"])
    _put(im, 25, 19, 6, 2, dark)
    _put(im, 27, 21, 2, 4, dark)
    # 盔（等级）
    if s.get("helm"):
        _ell(im, 15, 4, 7, 3, s["helm"])
        _put(im, 9, 5, 13, 1, s["helm"])
        _put(im, 8, 6, 15, 1, dark)
    # 圆盾（等级：队长）
    if s.get("shield"):
        _ell(im, 4, 18, 4, 6, s["shield"])
        _ell(im, 4, 18, 2, 4, s.get("trim", bone))
    return im




def _mon_wraith(s) -> Image.Image:
    """
    幽魂武士：尖顶兜帽 + 虚化的飘尾下摆（中尾触地）+ 幽光剑。

    `alpha` 半透明（幻影）由 mon_art_base 统一处理 —— 兜帽下是一张
    只有两只发光眼的黑脸，没有可辨认的五官，这是「已经不是人」的关键。
    """
    im = _mon_canvas()
    body, dark, light = s["body"], s["dark"], s["light"]
    # 兜帽（尖顶）
    _put(im, 13, 1, 6, 3, body)
    _put(im, 11, 3, 10, 3, body)
    _ell(im, 16, 9, 8, 5, body)
    # 脸洞 + 发光眼
    _ell(im, 16, 10, 4, 3, MON_INK)
    _put(im, 12, 9, 3, 2, s["eye"])
    _put(im, 17, 9, 3, 2, s["eye"])
    # 袍身（上宽下收）+ 胸口幽光
    _ell(im, 16, 17, 9, 6, body)
    _ell(im, 16, 16, 6, 3, light)
    _put(im, 8, 20, 16, 3, body)
    # 飘尾：三条，中长侧短（中尾 y=29..31 触底）
    _put(im, 12, 23, 8, 6, body)
    _put(im, 13, 29, 6, 3, body)
    _put(im, 7, 23, 4, 4, body)
    _put(im, 8, 27, 3, 2, dark)
    _put(im, 21, 23, 4, 4, body)
    _put(im, 21, 27, 3, 2, dark)
    # 幽光剑（右手）
    if s.get("blade"):
        _put(im, 27, 6, 2, 12, s["blade"])
        _put(im, 27, 6, 1, 12, light)
        _put(im, 25, 18, 6, 1, light)
        _put(im, 26, 19, 4, 2, dark)
    return im




MON_SHAPES = {
    "slime": _mon_slime,
    "bat": _mon_bat,
    "golem": _mon_golem,
    "soldier": _mon_soldier,
    "knight": _mon_knight,
    "mage": _mon_mage,
    "orc": _mon_orc,
    "skeleton": _mon_skeleton,
    "wraith": _mon_wraith,
}



# 哪些怪物按名称手绘。键必须出现在 MONSTERS 里（有断言拦漏网）。
#
# 颜色一律写在 spec 里，不再用 hue_shift 去推 —— 推出来的色会连明暗结构
# 一起偏（旧版把 swampy 的绿推成红，结果是一团脏红）。
PROC_MONSTERS = {
    # 史莱姆族：绿 → 红 → 大 → 王（王的冠与「更大」都改剪影，不只是换色）
    "greenSlime": dict(shape="slime", body=(74, 196, 92, 255), dark=(32, 116, 50, 255),
                       light=(158, 236, 166, 255), top=6),
    "redSlime":   dict(shape="slime", body=(224, 84, 72, 255), dark=(146, 34, 30, 255),
                       light=(252, 156, 138, 255), top=6),
    "bigSlime":   dict(shape="slime", body=(58, 170, 86, 255), dark=(24, 96, 44, 255),
                       light=(134, 216, 142, 255), top=3),
    "slimeKing":  dict(shape="slime", body=(236, 198, 66, 255), dark=(158, 114, 18, 255),
                       light=(252, 234, 142, 255), top=3, crown=(250, 220, 96, 255)),
    # 蝙蝠族：窄翼 → 宽翼 → 宽翼 + 獠牙
    "bat":        dict(shape="bat", body=(128, 94, 66, 255), dark=(70, 48, 34, 255),
                       light=(182, 142, 106, 255)),
    "bigBat":     dict(shape="bat", body=(90, 64, 44, 255), dark=(46, 30, 20, 255),
                       light=(140, 104, 74, 255), span=1),
    "vampireBat": dict(shape="bat", body=(170, 52, 56, 255), dark=(96, 20, 26, 255),
                       light=(228, 104, 104, 255), span=1, fangs=1),
    "stoneGolem": dict(shape="golem", body=(126, 122, 120, 255), dark=(78, 74, 74, 255),
                       light=(182, 178, 174, 255), seam=(58, 54, 54, 255),
                       glow=(248, 168, 64, 255)),
    # ⚠️ 这里**没有** 8 只 BOSS（dragon / kraken / vampire / demonKing / demonKingTrue /
    # skeletonCaptain / knightCaptain / archmage）—— 它们全部搬到 64 网格的
    # `PROC_BOSSES` 去了。一张表同时装「32 网格的杂兵」和「64 网格的 BOSS」，
    # 会让所有按 `MON_W`/`MON_H` 写的判据（剪影互不相同、底行有像素、帧数=1）
    # 在 BOSS 上**静默量错网格** —— 那比报错难查得多。
    # ── 人形怪（14 只）：0x72 的人形底图读不出职业与等级 ──────────────
    # knight_m/f 源图是像素机器人（浅蓝方壳 + 独眼），守卫/骑士 8 只全顶着它；
    # 同族等级只靠换色，16px 下阶差不可读。搬进 32 网格手绘：
    #   职业 = 装备剪影（枪盾/剑盾/法杖/战斧/锈剑/幽光剑），
    #   等级 = 材质三阶（青铜→白银→黄金）+ 羽饰/披风/护甲覆盖度。
    # 守卫族：青铜无羽 → 白银短羽 → 黄金高羽 + 金饰金盾钉
    "juniorGuard": dict(shape="soldier", **BRONZE_A, skin=_SKIN,
                        shield=(150, 108, 60, 255), shield_rim=(94, 56, 24, 255),
                        shaft=_WOOD, tip=_STEEL, plume_h=0),
    "midGuard":    dict(shape="soldier", **SILVER_A, skin=_SKIN,
                        shield=(58, 96, 168, 255), shield_rim=(30, 48, 96, 255),
                        shaft=_WOOD, tip=_STEEL, plume=(198, 48, 48, 255), plume_h=1),
    "seniorGuard": dict(shape="soldier", **GOLD_A, skin=_SKIN,
                        shield=(216, 162, 44, 255), shield_rim=(140, 94, 16, 255),
                        boss=(252, 234, 142, 255), trim=(252, 234, 142, 255),
                        shaft=_WOOD, tip=_STEEL, plume=(198, 48, 48, 255), plume_h=2),
    # 骑士族：剑士露脸轻装 → 铁甲战士 → 蓝钢骑士（红羽）→ 白银骑士长（金饰披风）→ 暗黑骑士
    "swordsman":     dict(shape="knight", armor=(172, 122, 62, 255), dark=(110, 74, 32, 255),
                          light=(226, 178, 108, 255), open=1, skin=_SKIN,
                          band=(198, 48, 48, 255), blade=_STEEL),
    "warrior":       dict(shape="knight", **IRON_A, shield=(96, 102, 118, 255), blade=_STEEL),
    "knight":        dict(shape="knight", armor=(58, 96, 168, 255), dark=(30, 52, 104, 255),
                          light=(120, 164, 228, 255), plume=(198, 48, 48, 255),
                          shield=(46, 74, 140, 255), blade=_STEEL),
    "darkKnight":    dict(shape="knight", armor=(44, 40, 54, 255), dark=(22, 20, 30, 255),
                          light=(96, 92, 112, 255), glow=(240, 62, 54, 255),
                          cape=(58, 32, 72, 255), shield=(34, 30, 44, 255),
                          blade=(150, 152, 168, 255)),
    # 法师族：蓝袍学徒 → 紫袍资深（帽更高 + 宝珠）→ 金袍大法师（长白须 + 金宝珠）；
    # 女法师同阶换长发；魔卫 = 青袍兜帽（无檐）
    "juniorMage":   dict(shape="mage", robe=(58, 96, 190, 255), dark=(32, 56, 122, 255),
                         light=(120, 164, 228, 255), skin=_SKIN, hat=(46, 76, 160, 255),
                         hat_h=1, beard=(238, 236, 228, 255), staff=_WOOD,
                         orb=(96, 156, 246, 255)),
    "seniorMage":   dict(shape="mage", robe=(128, 62, 178, 255), dark=(78, 32, 118, 255),
                         light=(190, 130, 228, 255), skin=_SKIN, hat=(96, 44, 140, 255),
                         hat_h=2, beard=(244, 242, 236, 255), staff=_WOOD,
                         orb=(214, 62, 200, 255), trim=(240, 202, 84, 255)),
    "juniorWizard": dict(shape="mage", robe=(58, 96, 190, 255), dark=(32, 56, 122, 255),
                         light=(120, 164, 228, 255), skin=_SKIN, hat=(46, 76, 160, 255),
                         hat_h=1, hair=(150, 96, 40, 255), staff=_WOOD,
                         orb=(96, 156, 246, 255)),
    "seniorWizard": dict(shape="mage", robe=(128, 62, 178, 255), dark=(78, 32, 118, 255),
                         light=(190, 130, 228, 255), skin=_SKIN, hat=(96, 44, 140, 255),
                         hat_h=2, hair=(150, 96, 40, 255), staff=_WOOD,
                         orb=(214, 62, 200, 255), trim=(240, 202, 84, 255)),
    "magicGuard":   dict(shape="mage", robe=(44, 142, 132, 255), dark=(22, 88, 82, 255),
                         light=(110, 202, 188, 255), skin=_SKIN, hood=(28, 104, 96, 255),
                         staff=_WOOD, orb=(96, 226, 206, 255)),
    # 兽人族：木棒兽人 → 铁肩甲战斧武士 → 矮身短匕哥布林
    "orc":        dict(shape="orc", skin=(96, 156, 74, 255), dark=(52, 96, 40, 255),
                       light=(150, 204, 118, 255), eye=(232, 62, 48, 255),
                       belt=(110, 74, 36, 255), weapon="club", shaft=_WOOD, blade=_STEEL),
    "orcWarrior": dict(shape="orc", skin=(64, 120, 56, 255), dark=(34, 74, 32, 255),
                       light=(112, 172, 96, 255), eye=(240, 80, 40, 255),
                       belt=(74, 50, 26, 255), weapon="axe", shaft=_WOOD,
                       blade=(176, 180, 192, 255), pads=(122, 128, 140, 255)),
    "goblin":     dict(shape="orc", skin=(122, 172, 84, 255), dark=(70, 110, 48, 255),
                       light=(178, 216, 132, 255), eye=(226, 190, 60, 255),
                       belt=(96, 66, 32, 255), weapon="dagger", small=1),
    # 骷髅族：裸骨锈剑 → 铁盔铁甲 → 金盔金甲 + 圆盾（覆盖度即等级）
    "skeleton":        dict(shape="skeleton", bone=(232, 226, 206, 255),
                            joint=(140, 128, 108, 255), blade=(148, 118, 82, 255)),
    "skeletonSoldier": dict(shape="skeleton", bone=(238, 232, 212, 255),
                            joint=(146, 134, 114, 255), armor=(122, 128, 140, 255),
                            trim=(192, 198, 210, 255), helm=(122, 128, 140, 255),
                            blade=(198, 204, 214, 255)),
    # 亡灵：幽魂武士（青白 + 幽光剑）→ 幻影（同形换紫 + 半透明）
    "ghostWarrior": dict(shape="wraith", body=(196, 226, 232, 255), dark=(120, 168, 184, 255),
                         light=(238, 250, 252, 255), eye=(96, 210, 226, 255),
                         blade=(170, 226, 238, 255)),
    "phantom":      dict(shape="wraith", body=(150, 96, 190, 255), dark=(92, 52, 128, 255),
                         light=(204, 150, 232, 255), eye=(226, 120, 250, 255),
                         alpha=0.72),
}




def mon_art_base(art_id: str) -> Image.Image:
    """画一帧静止姿态（32 网格），收尾统一补描边 —— 与整套素材的描边语言一致。

    spec 里的 `alpha`（幻影的半透明）在描边**之后**整体乘 —— 先乘再描边会把
    描边也变淡，怪物在棋盘上会「糊」进背景。
    """
    spec = dict(PROC_MONSTERS[art_id])
    shape = MON_SHAPES[spec.pop("shape")]
    alpha = spec.pop("alpha", None)
    im = add_outline(shape(spec), MON_INK)
    if alpha is not None:
        im = alpha_mul(im, alpha)
    return im




def mon_art_frames(art_id: str) -> list[Image.Image]:
    """
    怪物的 idle 帧 —— **只有 1 帧**，理由与 `npc_art_frames` 完全相同。

    这里原先的 `_mon_squash` 比 NPC 那边错得更明显：它把整只怪上移 2 行、
    再把最底 2 行复制到底部（想做出「脚不离地」）。但手绘怪物的内容本来就
    **顶在第 0 行**（kraken / knight / wraith 实测 base 内容区间是 0..31，
    画布 32 行全满），上移 2 行 = **头顶被画布裁掉 2 行**，而底部又长出 2 行
    重复的腿根 —— 一裁一补，读出来就是「整只怪被压扁了一截」。

    实测数据（改前）：
        kraken / knight / ghostWarrior   base 内容 (0,31) → breathe 仍 (0,31)
        dragon / vampire                 base 内容 (2,31) → breathe (0,31)
    顶到 0 的那几只每一轮呼吸都掉 2 行头顶，正是玩家说的「抖动时压缩」。

    现在素材只出静止帧，呼吸在渲染层做刚体位移（board.ts 的 `MONSTER_BOB_PX`）。
    """
    return [mon_art_base(art_id)]




def verify_mon_art(frames: dict[str, list[Image.Image]]) -> list:
    """
    程序化怪物造型断言。五条判据，全是「代码里看不出来、只有量才知道」的：

      1. **每个形状的剪影互不相同** —— 抓「画了半天结果都是同一个圆」；
      2. **同形状的变体必须有区别** —— 抓「换色没生效 / 两只一模一样」；
      3. **底行必须有像素** —— 底部锚定下帧底留白 = 怪物浮在半空；
      4. **每个形状至少有一只怪在用它** —— 抓「画了却忘了接进 PROC_MONSTERS」；
      5. **每只怪只出 1 帧 idle** —— 理由与 NPC 判据 4 同：呼吸归渲染层做刚体
         位移。手绘怪物的内容本来就顶到画布第 0 行，素材里再做「上移 + 补底」
         就是**裁头顶**（实测 kraken/knight/wraith 每轮掉 2 行），
         那正是玩家报的「抖动时压缩」。判据 1~4 全都看不见这件事。

    与 NPC 的断言刻意分开：NPC 是「六个各不相同」，怪物是「七种形状、同形状可成族换色」——
    两边的判据不一样，所以不能共用一个函数。
    """
    problems: list[str] = []
    bases = {k: v[0] for k, v in frames.items()}

    def sil(im: Image.Image):
        a = im.getchannel("A").tobytes()
        return {i for i, v in enumerate(a) if v > 8}

    for art_id, fs in frames.items():
        if len(fs) != 1:
            problems.append(
                f"怪物 {art_id} 出了 {len(fs)} 帧 idle —— 素材里只允许静止帧。"
                f"手绘怪物的内容顶满画布（顶行 0），在素材里上下错位只会裁掉头顶、"
                f"补出重复的腿根，读出来就是「压缩」。呼吸请改 board.ts 的 MONSTER_BOB_PX"
            )

    by_shape: dict[str, list[str]] = {}
    for art_id, spec in PROC_MONSTERS.items():
        by_shape.setdefault(spec["shape"], []).append(art_id)

    used = {spec["shape"] for spec in PROC_MONSTERS.values()}
    for sh in MON_SHAPES:
        if sh not in used:
            problems.append(f"形状 {sh} 画了但 PROC_MONSTERS 里没有一只怪用它")

    names = sorted(by_shape)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if sil(bases[by_shape[a][0]]) == sil(bases[by_shape[b][0]]):
                problems.append(f"形状 {a} 与 {b} 的剪影完全相同 —— 两种形状长一个样")

    for sh, ids in by_shape.items():
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                if bases[a].tobytes() == bases[b].tobytes():
                    problems.append(f"{a} 与 {b} 同形状且逐像素完全相同 —— 换色没生效")

    for art_id, im in bases.items():
        if not sil(im.crop((0, MON_H - 1, MON_W, MON_H))):
            problems.append(f"{art_id} 最后一行为空，底部锚定会让它浮在半空")
    return problems
