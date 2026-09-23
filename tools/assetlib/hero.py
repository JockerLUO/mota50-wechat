"""
勇者：四向 × 走路 4 帧 + 挥剑 4 帧，全部程序化手绘。

## 造型常量必须进表，不能在绘制函数里写裸数字

否则「勇者又变了」会表现为一堆坐标各错一点，很难查。

## 挥剑帧是**真的会被渲染层消费**的

`refreshHeroTexture()` 走的是 `heroFrame(direction, kind, i)`，
所以 `kind` 里必须有 `attack` —— 这条有正面判据（`verify-visual` A14：
挥剑期间 `anim` 出现过 `'attack'`），因为「只断言尺寸不变」抓不到「没接上」。
"""

from __future__ import annotations

from .pil import Image, ImageDraw
from .palette import INK, NPC_INK
from .pixel import _put, add_outline



# ─────────────────────────────────────────────────────────────────────
# 九、角色表切分（ArMM1998 Zelda-like）
# ─────────────────────────────────────────────────────────────────────
# 这张表不是规整网格：角色比 16px 格子高，且不同行带的帧距不一样。
# 所以先按投影找出「行带」，再在每个行带里按列投影切帧，而不是硬套 16 的倍率。

# 行带顺序：character.png 的四行是 下/右/上/左。
# ⚠️ 顺序错了不会报错，只会让左右走时朝向反 —— 实测踩过（左右互换，
#    因为想当然写成下左上右）。改这里必须对着图确认，不能凭直觉。
HERO_DIRS = ["down", "right", "up", "left"]




# ─────────────────────────────────────────────────────────────────────
# 九之一·B、勇者造型（程序化手绘：铠甲 / 剑 / 盾）
# ─────────────────────────────────────────────────────────────────────
#
# ## 为什么不再切 ArMM 的 character.png
#
# 它是全套素材里**最后一个**还在用的第三方位图角色（6 个 NPC 与 35 只怪都已手绘）。
# 问题不在精细度，而在**读不出装备**：
#   · 走路 4 帧之间只差「整张图上下 1 行」，看不出在迈步；
#   · 右手没有剑、左手没有盾、身上是一件红布衫 —— 玩家的原话是
#     「优化玩家角色的模型，增加剑、盾、铠甲」；
#   · 它自带软边描边，与手绘的 NPC / 怪物并排时不像一家人。
#
# ## 画法：与 NPC / 怪物同一套语言
#
# `_put()` 填硬边像素块 + `add_outline()` 收 1px 深色描边。装备与身体一起画，
# 但**分区**：剑在画面左（右手）、盾在画面右（左手）、铠甲占躯干与双肩。
# 三件装备各用一套专属色（钢 / 靛蓝 + 金 / 银蓝），漏画一件或挪了位置都会被断言抓住。
#
# ## 三条硬约束（断言在盯，改之前先读）
#
#   ① **实心内容恰好 4..23**（20 行）。`verify_npc_scale` 拿勇者朝下第 0 帧的
#      行区间当**基准**去卡六个 NPC —— 改这里等于改 NPC 的身高。
#      做法：绘制 5..22，描边上下各外扩 1 行 → 4..23。
#   ② **最宽 ≥ 12 列**（NPC 最宽处 12；勇者比它窄，NPC 站旁边就会显得更大）。
#      现在剑到 x=1、盾到 x=14，描边后 0..15 —— 16 列画布正好用满。
#   ③ **帧画布尺寸不许变**：走路 16×26、挥剑 20×26。
#      `verify-visual` 的 A17 钉着「落屏勇者 32×52」。
#
# ## 侧面只画一次
#
# `left` 由 `right` **镜像**得到（`transpose(FLIP_LEFT_RIGHT)`）。旧素材的四行带顺序
# 踩过坑（见 HERO_DIRS 上的注释：「想当然写成下左上右」），镜像能让
# 「左右走时朝向反了」这类错在原理上不可能发生。
#
# ## 走路「迈步」的做法（不是整体上下挪）
#
# 走路 4 帧**不动绘制区间**，只改腿部相位：抬起的腿少一行、靴子跟着抬一行。
#
# ⚠️ 这里踩过一次：最初照旧素材的做法「1/3 帧整体下移 1 行」，结果帧 1 的脚
#    描边落到了第 24 行 —— 正好是影子的那一行，半透明影子把脚描边盖成半透明，
#    于是 `solid_rows` 量出的实心底行从 24 掉回 23，**各帧高度变成 19 与 20 两种**，
#    `verify_npc_scale` 判据 1（勇者各帧高度必须一致）当场红。
#    影子必须紧贴脚下、又必须半透明，所以「整体挪」这条路在 26 行的画布里走不通 ——
#    靠腿部相位表达迈步反而更接近真实走路（脚一直踩在地上）。

HERO_W, HERO_H = 16, 26


# 挥剑帧**不比走路帧宽**（曾经是 20，注释写着「旧素材也是 20」）。
# 两个理由：
#   ① 抬剑只改 y（剑在 x=1..2 固定两列），横向范围根本没变 —— 20 是白送的 4 列透明边；
#   ② 落屏 = 帧宽 ×2，20 → 40px，比 32px 的格子还宽，挥剑时人会**横向溢出格子**
#      压到邻格上。走路帧 16 → 32px 正好一格。
# 渲染层 A14 靠 `frame` 的**尺寸**判「挥剑不变小」，两套帧同尺寸也是它成立的前提。
HERO_DRAW_TOP = 5                # 绘制顶行（描边后 = 可见顶行 4）


HERO_DRAW_FEET = 22              # 绘制底行（描边后 = 可见底行 23）


HERO_SHADOW_Y0, HERO_SHADOW_Y1 = 24, 25      # 影子占的两行



# 调色板（前缀 H_ = hero）。这套色只属于勇者，别处不要再引用。
H_SKIN = (247, 214, 178, 255)


H_SKIN_DK = (206, 166, 128, 255)


H_MOUTH = (186, 118, 106, 255)


H_HAIR = (110, 68, 34, 255)


H_HAIR_DK = (68, 40, 20, 255)


H_HI = (232, 238, 248, 255)      # 铠甲高光


H_ARMOR = (166, 178, 198, 255)   # 铠甲主色（银蓝）


H_ARMOR_DK = (100, 112, 134, 255)


H_LEATHER = (120, 78, 44, 255)


H_BOOT = (74, 54, 40, 255)


H_CLOAK = (176, 52, 58, 255)     # 战袍红 —— 旧勇者的红衣记号，留在胸口


H_STEEL = (222, 230, 244, 255)


H_STEEL_HI = (250, 253, 255, 255)


H_GOLD = (236, 192, 78, 255)


H_GRIP = (104, 66, 34, 255)


H_SHIELD = (56, 94, 168, 255)


H_SHIELD_HI = (96, 142, 214, 255)


# 盾徽。⚠️ **这个色不许用白**（原来是 246,248,252）—— 见 `verify_hero_art` 的判据 5：
# 那里靠「接近某色」在帧里找剑（`H_STEEL_HI` 是近白的高光），逐分量容差 6。
# 白徽记与它的差只有 (4,5,3)，**落在容差内** → 盾徽被误认成剑像素，
# 报出「剑的像素跑到了第 13 列（帧宽 16）」这种假红（2026-09-23 实际踩到）。
# 判据色的选择因此不是美术自由，是有约束的：彼此至少隔开 2×tol。
H_SHIELD_MARK = (168, 206, 248, 255)



# ── 横向解剖（16 列画布）────────────────────────────────────────────
#    剑（右手）  剑身 x=1..2（左列更亮 = 剑刃）、护手 x=1..3、柄 x=2、剑尖朝上
#    左臂        x=3..4
#    躯干        x=5..10（肩甲压在 x=4 与 x=11）
#    右臂        x=11..12
#    盾（左手）   x=12..14（盖住右臂外侧 1 列 = 「手臂在盾后」）
# 剑与左臂各自描边后会在 x=2 处相接 —— 像素画里武器贴着身体是常态，
# 中间那条深色描边正好把它们分开，读得出是「剑」而不是「身体的一部分」。
#
# ⚠️ 剑身**必须 2 列宽**。1 列宽时描边会在它两侧各糊一列深色，整把剑读出来是
#    「一根白线套着黑框」—— 第一版就是这样，放大图上一眼像根晾衣绳。
H_SWORD_X0, H_SWORD_X1 = 1, 2


H_GUARD_X0 = 1


H_GRIP_X = 2


H_ARM_L, H_ARM_R = 3, 11


H_TORSO_X0, H_TORSO_X1 = 5, 10


H_LEG_L, H_LEG_R = 5, 9


H_SHIELD_X0, H_SHIELD_X1 = 11, 14


# 剑盾换到另一侧时的落点（背面 / 侧面用）：
#   正面 —— 剑在画面左（x=1）、盾在画面右（x=11）
#   背面 —— 背对时右手在画面**右**，所以剑在 x=13、盾在 x=1
#   侧面 —— 剑在身前（画面右 x=13）、盾垂在身后侧（x=1）
H_SWORD_X0_OTHER = 13


H_SHIELD_X0_OTHER = 1



# ── 纵向解剖（绘制行号，画布 26 行）─────────────────────────────────
#    发顶 5..7 / 脸 8..13 / 眼 9..10
#    躯干 14..18（腰带在 18）/ 腿 19..21 / 靴 22
# 头（9 行）比躯干（5 行）+ 腿（4 行）还高一点 —— Q 版头身比，与旧素材一致。
H_HAIR_TOP = 5


H_FACE_TOP, H_FACE_BOT = 8, 13


H_EYE_ROW = 9


H_TORSO_TOP, H_TORSO_BOT = 14, 18


H_LEG_TOP = 19


H_BOOT_ROW = 22




def _hero_shadow(im: Image.Image, cx: int) -> None:
    """
    脚下的落地影（两行、半透明）。三个必须记住的点：

      · **alpha 必须 < `SOLID_ALPHA`(250)。** 否则 `solid_rows()` 会把影子算进
        「可见内容」，勇者的基准行区间就从 4..23 变成 4..25 —— 六个 NPC 的比例
        断言会集体误报。这不是审美问题，是量法的前提。
      · **必须在 `add_outline()` 之后叠。** 描边把 alpha>120 的像素当内容，
        影子先画就会被描一圈深色，看起来像地上挖了个坑。
      · **直接写像素，不要 `paste(im, pos, im)`。** 后者拿自己当 mask 会把 alpha
        平方（102 → 41）—— 旧素材的影子被平方两次后只剩 alpha≈7，等于没有影子，
        这正是「勇者看不出站在哪」的根因。

    内圈比外圈深一档：两行的高度差做不出「扁椭圆」的读感时，靠深浅分层补。
    """
    d = ImageDraw.Draw(im)
    d.ellipse([cx - 5, HERO_SHADOW_Y0, cx + 4, HERO_SHADOW_Y1], fill=(58, 48, 68, 164))
    d.ellipse([cx - 3, HERO_SHADOW_Y0, cx + 2, HERO_SHADOW_Y1], fill=(44, 36, 54, 206))




def _hero_legs(p, step: int) -> None:
    """
    两条腿 + 靴。`step` = 0 并拢 / 1 抬右腿 / -1 抬左腿。

    16 网格上「迈步」只能靠**腿的长短**读出来：抬起的那条腿少两行、靴子跟着抬两行。
    差 1 行在 8× 放大图上还看得出来，落到 32px 的格子上就完全没了 ——
    第一版就是只差 1 行，走路读起来像「两条腿在抖」而不是在迈。
    """
    for x0, raised in ((H_LEG_L, step == -1), (H_LEG_R, step == 1)):
        if raised:
            p(x0, H_LEG_TOP, 2, 1, H_LEATHER)
            p(x0, H_LEG_TOP + 1, 2, 1, H_BOOT)
        else:
            p(x0, H_LEG_TOP, 2, 3, H_LEATHER)
            p(x0, H_BOOT_ROW, 2, 1, H_BOOT)




def _hero_torso(p, back: bool = False) -> None:
    """
    铠甲躯干：胸甲（正面）/ 背板（背面）+ 双肩甲 + 腰带。

    三样东西一起才读得出「铠甲」：
      · 肩甲（x=4 / x=11，两行）—— 比胸甲亮一阶，是铠甲最显眼的记号；
      · 胸甲中缝（一条暗竖线）—— 只涂一整块灰会读成「穿了件灰衣服」；
      · 腰带 —— 把躯干和下摆分开，不然上下连成一根柱子。
    """
    th = H_TORSO_BOT - H_TORSO_TOP + 1
    p(H_TORSO_X0, H_TORSO_TOP, 6, th, H_ARMOR)
    p(H_TORSO_X0, H_TORSO_TOP, 1, th, H_HI)              # 左受光列
    p(H_TORSO_X1, H_TORSO_TOP, 1, th, H_ARMOR_DK)        # 右背光列
    for x in (H_TORSO_X0 - 1, H_TORSO_X1 + 1):           # 肩甲：x=4 与 x=11
        p(x, H_TORSO_TOP, 1, 2, H_HI)
    if back:
        p(7, H_TORSO_TOP + 1, 2, th - 2, H_LEATHER)      # 背带
    else:
        p(7, H_TORSO_TOP + 1, 2, 2, H_CLOAK)             # 胸口露出的战袍红
        p(7, H_TORSO_TOP, 1, th, H_ARMOR_DK)             # 胸甲中缝
    p(H_TORSO_X0, H_TORSO_BOT, 6, 1, H_LEATHER)          # 腰带




# 剑的「举到哪一档」。三档都只是**整体上抬**：剑身、护手、柄、以及持剑臂
# 全部按同一个 lift 平移 —— 分开处理就会出现「手在腰上、剑飘在头顶」。
#   0 = 竖握在身侧（走路 / 收势）
#   2 = 提到胸口（挥砍的中段）
#   4 = 高举过顶（再高一行剑尖就会被画布裁掉，见下）
#
# ⚠️ `up` 不能取 5 以上：剑尖在绘制行 `5 - lift`，描边再往上占一行，
#    lift=5 时描边落到 -1 行、**被画布裁掉** —— 整把剑会短一截而且没有尖。
#    4 是「剑尖到第 1 行、描边正好落在第 0 行」的上限。
HERO_SWORD_LIFT = {"rest": 0, "mid": 2, "up": 4}




def _hero_sword(p, x0: int, lift: int) -> None:
    """
    剑：剑身 2 列（**左列更亮 = 刃**）+ 3 列护手 + 1 列柄 + 收成三角的剑尖。

    ⚠️ 剑身必须 2 列宽。1 列宽时描边会在两侧各糊一列深色，整把剑读出来是
    「一根白线套着黑框」—— 第一版就是这样，放大图上一眼像根晾衣绳。
    """
    p(x0, 6 - lift, 2, 1, H_STEEL_HI)                # 剑尖：2 列
    p(x0 + 1, 5 - lift, 1, 1, H_STEEL_HI)            # 再收 1 列 → 三角
    p(x0, 7 - lift, 2, 10, H_STEEL)                  # 剑身 7..16
    p(x0, 7 - lift, 1, 10, H_STEEL_HI)               # 左列 = 刃
    p(x0 - 1, 17 - lift, 3, 1, H_GOLD)               # 护手
    p(x0, 18 - lift, 2, 2, H_GRIP)                   # 柄 18..19（2 列宽，手正好握在这里）




def _hero_sword_arm(p, x0: int, lift: int) -> None:
    """持剑臂 + 手。`lift` 必须与 `_hero_sword` 用同一个值，否则剑会「脱手」。"""
    p(x0, H_TORSO_TOP + 1 - lift, 2, 3, H_ARMOR)
    p(x0 - 1, H_TORSO_TOP + 4 - lift, 3, 1, H_SKIN)      # 手伸向柄




def _hero_arm(p, x0: int) -> None:
    """**非持剑**那只手臂的臂甲。持剑那只走 `_hero_sword_arm`（它要跟着剑上抬）。"""
    p(x0, H_TORSO_TOP + 1, 2, 3, H_ARMOR)




def _hero_shield(p, x0: int) -> None:
    """
    鸢盾（4 列宽）：上 3 行满宽 → 收 2 行 → 下尖 1 行。金边 + 白色徽记。

    2 列宽时描边会把它糊成一枚「蓝色小方块」，读不出是盾。4 列宽正好盖住
    持盾那条手臂（x=11..12）—— 「手臂在盾后」本身就是「举盾」这个动作的读法。
    """
    p(x0, H_TORSO_TOP, 4, 3, H_SHIELD)                   # 14..16
    p(x0, H_TORSO_TOP, 4, 1, H_GOLD)                     # 顶边金饰
    p(x0, H_TORSO_TOP + 1, 1, 2, H_SHIELD_HI)            # 左受光列
    p(x0 + 1, H_TORSO_TOP + 1, 2, 1, H_SHIELD_MARK)      # 徽记
    p(x0 + 1, H_TORSO_TOP + 3, 2, 2, H_SHIELD)           # 17..18 收窄
    p(x0 + 2, H_TORSO_TOP + 5, 1, 1, H_SHIELD)           # 19 下尖




def _hero_head_front(p) -> None:
    """
    正面头部：头发 5..7、脸 8..13、眼 9..10。

    脸和头发**同宽**（x=4..11，8 列），只有鬓角两列压在脸的两侧。
    改前头发占了 4 行、脸只剩 6 列被包在中间，放大图上看是一颗大棕方块 +
    中间一小条脸 —— 这正是 NPC 那轮踩过的「头上的长方形太细」，同一种错不犯第二次。
    """
    p(6, H_HAIR_TOP, 4, 1, H_HAIR)                       # 行 5 发顶收口
    p(4, H_HAIR_TOP + 1, 8, 2, H_HAIR)                   # 行 6..7 头发
    p(4, H_FACE_TOP, 8, H_FACE_BOT - H_FACE_TOP + 1, H_SKIN)
    p(4, H_FACE_BOT, 8, 1, H_SKIN_DK)                    # 下巴压暗
    p(4, H_FACE_TOP, 1, 3, H_HAIR)                       # 行 8..10 左鬓
    p(H_TORSO_X1 + 1, H_FACE_TOP, 1, 3, H_HAIR)          # 右鬓
    p(5, H_EYE_ROW, 1, 2, NPC_INK)
    p(10, H_EYE_ROW, 1, 2, NPC_INK)
    p(7, H_FACE_BOT - 1, 2, 1, H_MOUTH)




def _hero_head_back(p) -> None:
    """背面头部：整颗后脑都是头发（无脸），两侧压暗读出圆颅。"""
    p(6, H_HAIR_TOP, 4, 1, H_HAIR)
    p(4, H_HAIR_TOP + 1, 8, 2, H_HAIR)                   # 行 6..7
    p(4, H_HAIR_TOP + 3, 8, 6, H_HAIR)                   # 行 8..13 后脑
    p(4, H_FACE_TOP, 1, 6, H_HAIR_DK)
    p(H_TORSO_X1 + 1, H_FACE_TOP, 1, 6, H_HAIR_DK)




def _hero_head_side(p) -> None:
    """侧面头部：后脑在左（x=4..5）、脸朝右（x=5..11）、鼻尖凸出到 x=12。"""
    p(5, H_HAIR_TOP, 4, 1, H_HAIR)                       # 行 5
    p(4, H_HAIR_TOP + 1, 5, 2, H_HAIR)                   # 行 6..7（x=4..8）
    p(5, H_FACE_TOP, 7, H_FACE_BOT - H_FACE_TOP + 1, H_SKIN)   # 脸 x=5..11
    p(4, H_FACE_TOP, 2, 6, H_HAIR)                       # 行 8..13 后脑
    p(4, H_FACE_TOP, 1, 6, H_HAIR_DK)                    # 后脑外缘压暗
    p(5, H_FACE_BOT, 7, 1, H_SKIN_DK)                    # 下巴
    p(10, H_EYE_ROW, 1, 2, NPC_INK)                      # 眼（靠脸的前缘）
    p(12, H_EYE_ROW + 1, 1, 1, H_SKIN)                   # 鼻尖凸出一列 —— 侧面朝哪边全靠它




def _hero_front(layer, pose: dict) -> None:
    """正面（朝下）：看得见脸；剑在画面左（右手），盾在画面右（左手）。"""

    def p(x, y, w, h, c):
        _put(layer, x, y, w, h, c)

    lift = HERO_SWORD_LIFT[pose["sword"]]
    _hero_legs(p, pose["leg"])
    _hero_torso(p)
    _hero_head_front(p)
    _hero_sword_arm(p, H_ARM_L, lift)
    _hero_arm(p, H_ARM_R)
    p(H_ARM_R, H_TORSO_TOP + 4, 2, 1, H_SKIN)            # 左手持盾
    _hero_sword(p, H_SWORD_X0, lift)
    _hero_shield(p, H_SHIELD_X0)




def _hero_back(layer, pose: dict) -> None:
    """背面（朝上）：后脑 + 背板 + 背带。背对时右手在画面**右** —— 剑盾跟着换边。"""

    def p(x, y, w, h, c):
        _put(layer, x, y, w, h, c)

    lift = HERO_SWORD_LIFT[pose["sword"]]
    _hero_legs(p, pose["leg"])
    _hero_torso(p, back=True)
    _hero_head_back(p)
    _hero_arm(p, H_ARM_L)
    p(H_ARM_L, H_TORSO_TOP + 4, 2, 1, H_SKIN)            # 左手（画面左）持盾
    _hero_sword_arm(p, H_ARM_R, lift)
    _hero_sword(p, H_SWORD_X0_OTHER, lift)               # 剑换到画面右
    _hero_shield(p, H_SHIELD_X0_OTHER)                   # 盾换到画面左




def _hero_side(layer, pose: dict) -> None:
    """侧面（朝右）：脸朝右；剑在身前（画面右），盾在身侧（画面左）。`left` 是它的镜像。"""

    def p(x, y, w, h, c):
        _put(layer, x, y, w, h, c)

    lift = HERO_SWORD_LIFT[pose["sword"]]
    _hero_legs(p, pose["leg"])
    _hero_torso(p)
    _hero_head_side(p)
    _hero_arm(p, H_ARM_L)                                # 后手（持盾）
    p(H_ARM_L, H_TORSO_TOP + 4, 2, 1, H_SKIN)
    _hero_sword_arm(p, H_ARM_R, lift)                    # 前手（持剑）
    _hero_sword(p, H_SWORD_X0_OTHER, lift)               # 剑在身前
    _hero_shield(p, H_SHIELD_X0_OTHER)                   # 盾垂在身后侧




def _hero_pose(kind: str, i: int) -> dict:
    """
    这一帧的姿态参数。

      走路：`leg` 在 0 / 1 / 0 / -1 之间交替（并拢 / 抬右 / 并拢 / 抬左），
            剑始终竖握 —— 走路时保持持剑，玩家一眼知道「这是带装备的勇者」。
      挥剑：`sword` 走 竖握 → 提到胸前 → 高举过顶 → 收势。
            三档之间是**整体上抬**（见 `HERO_SWORD_LIFT`），配渲染层的刀光演出挥砍，
            所以这一侧不需要画出真实的挥剑轨迹 —— 画了也会被刀光盖住。
    """
    if kind == "walk":
        return {"leg": (0, 1, 0, -1)[i % 4], "sword": "rest"}
    return {"leg": 0, "sword": ("rest", "mid", "up", "rest")[i % 4]}




def hero_frame(direction: str, kind: str, i: int) -> Image.Image:
    """
    勇者的一帧（含描边与落地影），返回**完整画布**。

    画布尺寸**两套动画一致**：走路与挥剑都是 16×26。曾经挥剑帧是 20×26
    （「留给以后真的要把剑抡出去」），实测图集里就是 **80×104 的帧** ——
    而 `bottom_center()` 并不裁宽度，于是落屏 40px，比 32px 的格子还宽，
    挥剑时人会横向压到邻格上。抬剑只改 y，横向范围压根没变，那 4 列是白送的。

    两套同尺寸还有个直接好处：`verify-visual` 的 A14 靠 `frame` 的**尺寸**判
    「挥剑不变小」，尺寸一致时这条判据只需要关心「有没有换成挥剑帧」，
    不必再为两种尺寸单独写一套期望值。
    """
    base = "right" if direction == "left" else direction
    im = Image.new("RGBA", (HERO_W, HERO_H), (0, 0, 0, 0))
    pose = _hero_pose(kind, i)
    if base == "down":
        _hero_front(im, pose)
    elif base == "up":
        _hero_back(im, pose)
    else:
        _hero_side(im, pose)
    im = add_outline(im, INK)
    # 影子跟着**解剖表的中心**（x=8），不是画布中心 —— 挥剑帧画布更宽，
    # 用 w//2 会让影子整体偏右两列、与脚对不上。
    _hero_shadow(im, HERO_W // 2)
    if direction == "left":
        # 镜像放在最后：连影子和描边一起翻，不需要为「左」再画一套像素
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    return im




def build_actor_sheet():
    """
    产出勇者的走路 / 挥剑帧 —— 4 向 × 4 帧各一套，按 `HERO_DIRS` 顺序排列。

    返回 (walk, attack)：`walk[di][fi]` / `attack[di][fi]`。
    NPC 不在这里 —— 它们由 `npc_art_frames()` 单独产出（见九之二）。
    """
    walk = [[hero_frame(d, "walk", i) for i in range(4)] for d in HERO_DIRS]
    attack = [[hero_frame(d, "attack", i) for i in range(4)] for d in HERO_DIRS]
    return walk, attack




# 判据色匹配的逐分量容差。
# 为什么不是 0：`add_outline` 不碰原像素，但将来微调调色板时不该因为 ±2 的
# 微调就把判据打红。代价是判据色之间必须**隔开至少 2×这个值** ——
# 那条约束由 verify_hero_art 的判据 5 强制（写成断言，不靠注释提醒）。
HERO_COLOR_TOL = 6




def verify_hero_art(walk: list, attack: list) -> list:
    """
    勇者造型断言：**三件装备必须在位、在正确的一侧**。
    用户的诉求是「增加剑、盾、铠甲」。而「画了但没画上」「剑盾左右画反」
    「挥剑四帧一模一样」这三件事**在代码里都看不出来**（写的是三次调用，长得也对），
    所以判据全部落在像素上 —— 颜色 + 位置：

      1. 朝下第 0 帧必须同时出现钢色（剑）、靛蓝（盾）、银灰（铠甲）；
      2. 剑的像素都在帧的**左侧**、盾的都在**右侧** —— 抓左右画反；
      3. 四个方向的静止帧都要有剑和盾 —— 抓「只画了正面」；
      4. 挥剑的举剑帧里剑的最上沿要比静止帧高 ≥3 行 —— 抓「四帧一样」；
      5. **判据色彼此远离**（自检，见下）。

    ⚠️ 颜色比较用「接近」而不是相等：`add_outline` 不碰原像素，取 ±6 的容差
    是为了将来微调调色板时不误报。

    ⚠️⚠️ 但「容差」是一把双刃的刀，判据 5 就是为它配的保险 —— 见下面那段注释。
    """
    problems: list[str] = []

    def where(im: Image.Image, color, tol: int = HERO_COLOR_TOL):
        """该颜色的像素落在哪些列、最上行是第几行（都没有则 cols 为空、top 为 None）。"""
        px = im.load()
        cols, top = set(), None
        for y in range(im.height):
            for x in range(im.width):
                r, g, b, a = px[x, y]
                if a < 200:
                    continue
                if abs(r - color[0]) <= tol and abs(g - color[1]) <= tol and abs(b - color[2]) <= tol:
                    cols.add(x)
                    top = y if top is None else min(top, y)
        return cols, top

    front = walk[0][0]
    w = front.width
    for name, color in (("剑（钢）", H_STEEL_HI), ("盾（靛蓝）", H_SHIELD), ("铠甲（银灰）", H_ARMOR)):
        if not where(front, color)[0]:
            problems.append(f"勇者朝下帧里找不到{name}色 rgba{color} —— 三件装备必须都在")
    sword_cols = where(front, H_STEEL_HI)[0]
    shield_cols = where(front, H_SHIELD)[0]
    if sword_cols and max(sword_cols) > w * 0.45:
        problems.append(
            f"剑的像素跑到了第 {max(sword_cols)} 列（帧宽 {w}）—— 剑该在画面左（右手）"
        )
    if shield_cols and min(shield_cols) < w * 0.5:
        problems.append(
            f"盾的像素跑到了第 {min(shield_cols)} 列（帧宽 {w}）—— 盾该在画面右（左手）"
        )

    for d, frames in zip(HERO_DIRS, walk):
        f = frames[0]
        if not where(f, H_STEEL_HI)[0] or not where(f, H_SHIELD)[0]:
            problems.append(f"勇者的 {d} 向静止帧缺剑或缺盾 —— 四个方向都要能看出装备")

    # 挥剑：举剑帧的剑尖必须真的比静止帧高（`attack[i][2]` 是 up 档）
    rest_top = where(walk[0][0], H_STEEL_HI)[1]
    up_top = where(attack[0][2], H_STEEL_HI)[1]
    if rest_top is None or up_top is None:
        problems.append("挥剑帧里量不到剑的最上沿，无法确认「举起来了」")
    elif rest_top - up_top < 3:
        problems.append(
            f"挥剑的举剑帧剑尖在第 {up_top} 行、静止帧在第 {rest_top} 行 —— "
            f"只高了 {rest_top - up_top} 行，读不出「举起来」"
        )

    # ── 判据 5：判据色必须彼此远离（自检） ───────────────────────────
    #
    # 为什么需要这条：判据 1/2 是**按近似色在整帧里找像素**。只要调色板里还有
    # 第二个颜色落在容差内，它就会被算成「剑」或「盾」—— 于是「装备跑错边」
    # 立刻报出来。**报错信息指向绘制，实际病因在调色板**，
    # 下一个人会先去改画法（改错地方），这是最昂贵的一类假红。
    #
    # 2026-09-23 实际踩到：盾徽原本是近白 (246,248,252)，与剑刃 (250,253,255)
    # 逐分量只差 (4,5,3)，全在 tol=6 内 → 报「剑的像素跑到了第 13 列」，
    # 而剑明明在 1..2 列。把「谁可能撞上谁」做成构建时就红的检查，
    # 比写一句「注意别用近似色」的注释可靠 —— 注释不会拦人。
    palette = {
        k: v
        for k, v in globals().items()
        if k.startswith("H_") and isinstance(v, tuple) and len(v) == 4
    }
    for pname, pc in (("剑（钢）", H_STEEL_HI), ("盾（靛蓝）", H_SHIELD), ("铠甲（银灰）", H_ARMOR)):
        for k, c in palette.items():
            if c == pc:
                continue   # 判据色自己（含同值别名）
            if all(abs(c[i] - pc[i]) <= HERO_COLOR_TOL for i in range(3)):
                problems.append(
                    f"调色板里的 {k} rgba{c} 与判据色「{pname}」rgba{pc} 逐分量差都 ≤ "
                    f"{HERO_COLOR_TOL} —— 判据 1/2 会把 {k} 的像素当成{pname}，"
                    f"报出「装备跑错边」的假红（改画法改不掉，得改颜色）。"
                    f"两者至少要让一个分量差 > {HERO_COLOR_TOL}"
                )
    return problems
