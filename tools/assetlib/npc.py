"""
NPC：六个职能各一套手绘造型 + 比例断言。

## 六个职能必须一眼分得开

第三方包里**只有一个** NPC 底图，六个职能共用会「长得一模一样」，
所以六套造型都是程序化手绘（见 `NPC_ART` 的参数表）。

## 比例判据的量法

`verify_npc_scale` 量的基准取自**勇者**（同一批素材、同一套量法），
所以改动勇者比例会连带影响 NPC 的判据 —— 这是有意的：两者并排出现，
它们的关系才是要保护的东西。
"""

from __future__ import annotations

from .pil import Image, ImageDraw
from .palette import INK, NPC_INK, SKIN, SKIN_DK
from .pixel import _put, add_outline
from .metrics import SOLID_ALPHA, solid_core_width, solid_rows

# NPC 素材的行带顺序与勇者不同：NPC_test.png 四行是 下/左/上/右
NPC_DIRS = ["down", "left", "up", "right"]




# ─────────────────────────────────────────────────────────────────────
# 九之二、NPC 造型（程序化手绘）
# ─────────────────────────────────────────────────────────────────────
# ## 为什么必须自己画
#
# 六家素材包里**没有一个可用的 NPC 角色集**：
#   · ArMM 的 NPC_test.png 是单角色表（64×128，全图同一个人四个方向）——
#     之前 6 个 NPC 就是用这一张图配上一对「暗→亮」颜色渐变来区分的，
#     结果是一排**剪影完全相同、只有颜色不同**的人。玩家说的「模版太差」
#     就是这个：不同职能的人分不出谁是谁。
#   · 0x72 包里有 elf_f / knight_f 之类没被怪物用掉的人形，但只有两三个，
#     而且和怪物（法师 / 骑士 / 兽人）同源 —— NPC 和怪物长得像比长得丑更糟。
#
# 所以直接手绘：**每个职能一套 16×26 的像素画**，靠剪影、帽子、手持物区分，
# 而不是靠颜色。配色与 src/render/theme.ts 的 NPC_ROLE 一一对应，
# 棋盘上的职能徽章、对话框的职能章因此和本人同色 ——
# 「看到什么颜色就知道这个人能干什么」。
#
# ## 为什么不画四向
#
# NPC 是静止实体，渲染层永远只取 `down`（board.ts: atlas.npcFrame(id, 'down', 0)）。
# 画四个方向是四倍工作量、零收益。MANIFEST 里四个方向写同一组帧，
# 只是为了让 `walk[dir]` 这个既有形状继续成立，渲染层一行都不用改。

NPC_W, NPC_H = 16, 26




# ── NPC 的纵向解剖（绝对行号，画布 26 行）────────────────────────────
#
# ⚠️ 这张表的目标不是「NPC 自己好看」，而是**和勇者一样大、一样的头身比**。
#
# 两个基准都是从勇者帧上量出来的（量法见 verify_npc_scale），不是估的：
#
# ① **可见高度 = 20 行（4..23）**。走路起伏让整张精灵上下移 1 行
#    （朝上那两帧是 3..22），但**每一帧的高度都是 20**。
# ② **头身比：头（含头发）最宽 13、躯干（含手臂）最宽 14** —— 几乎一样宽，
#    这是它看起来「敦实」的原因。
#
# 改前的 NPC 是「头 8 + 身体 15」：头是一根细高的长方形，身体鼓成钟形，
# 正是用户说的「头上的长方形太细，身体太宽」。所以横向一起重排了：
#    头（含发）10 → 躯干（含手臂）10 → 下摆 8 → 脚 4
# 头不再比身体窄，整条轮廓上下收放对称。
#
# 三件容易搞错的事：
#  ① 别用「非透明包围盒」量勇者 —— 见 SOLID_ALPHA。
#  ② `add_outline` 会往上、往下各多占 1 行。所以**画的时候顶到第 5 行**、
#     脚踩到第 22 行，产出后可见区间才是 4..23。
#  ③ 行号一律用下面这张表，**不要在 _npc_base 里写裸数字** ——
#     否则下一次「NPC 又变大了」会是六个角色各错一点，很难查。
#
# 行分配（自上而下，数字是**绘制**行号）：
#   hat     5..7   帽/冠/发（尖顶 / 宽檐 / 兜帽 / 金冠 / 皮帽 / 花冠）
#   face    8..14  脸 7 行 —— 与勇者的脸（9..15）等长
#   eyes   11..12
#   torso  15..18  躯干 4 行
#   robe   19..21  长袍下段（下摆）3 行
#   foot   22      鞋 1 行 —— 描边后踩到第 23 行 = 勇者的脚底行
NPC_HAT_TOP, NPC_HAT_BOT = 5, 7


NPC_FACE_TOP, NPC_FACE_BOT = 8, 14


NPC_EYE_TOP = 11


NPC_TORSO_TOP, NPC_TORSO_BOT = 15, 18


NPC_ROBE_TOP, NPC_ROBE_BOT = 19, 21


NPC_FOOT_ROW = 22



NPC_ART_TOP, NPC_ART_FEET = NPC_HAT_TOP, NPC_FOOT_ROW   # 绘制行区间（描边前）


NPC_CONTENT_TOP = NPC_ART_TOP - 1    # 产出后可见顶行（add_outline 往上占一行）


NPC_FEET = NPC_ART_FEET


# 注：这里曾经有 `NPC_BREATH_SPLIT`（呼吸帧的上下身分界行）。呼吸已经整体移到
# 渲染层，素材里不再有位移帧，所以那个常量连同它的两处误用一起删了 ——
# 留着一个「呼吸分界」等于给下一个人指一条已经废弃的路。

# ── 横向解剖（列号，画布 16 列）────────────────────────────────────────
#
# 安排的原则是**头不比身体窄**，而且**肩要比下摆宽**。三条一起定死了：
#
#   脸 / 头    x=4..11（8 宽）→ 可见 10
#   躯干       x=5..10（6 宽）
#   手臂       x=3..4 与 x=11..12（各 2 宽）→ 含手臂 10 宽 → 可见 12（最宽处）
#   下摆       x=5..10（6 宽）→ 可见 8 —— **与躯干同宽，不再是 A 字大摆**
#   脚         x=5..6 与 x=9..10
#
# 为什么下摆必须收窄：`add_outline` 是 **1px 八邻域膨胀**，所以「可见宽度」
# ≈ 该行及上下各一行里最宽的那一段再 +2。改前的下摆画到 12 宽（可见 15），
# 而头只有 6 宽（可见 8）—— 用户说的「头上的长方形太细，身体太宽」就是这个。
#
# 同理，想让某一段在**画面上**显出收腰，相邻两段的**绘制**宽度至少要差 2，
# 只差 1 会被描边抹平（第一版重画就踩了这个：头和肩都画 10 宽，结果整只
# 精灵在 12 宽上从头顶平到脚，变成一根柱子）。
NPC_FACE_X, NPC_FACE_W = 4, 8        # 脸 = 头的绘制宽度：x=4..11（与勇者的脸等宽）


NPC_TORSO_X, NPC_TORSO_W = 5, 6      # 躯干：x=5..10


NPC_ARM_X, NPC_ARM_W = 3, 2          # 手臂：x=3..4 与 x=11..12（各 2 宽）→ 含臂 10 宽


NPC_ROBE_X, NPC_ROBE_W = 5, 6        # 下摆：x=5..10（与躯干同宽）


NPC_FOOT_X = 5                       # 脚：x=5..6 与 x=9..10




# 每个职能的造型参数。颜色与 src/render/theme.ts 的 NPC_ROLE 对应：
#   sage 蓝 / merchant 金 / shop 绿 / thief 灰 / fairy 青 / princess 粉
NPC_ART = {
    # 智慧老人：灰白长袍、白须、尖顶软帽，手拄法杖（书卷气，不是战斗感）
    "sage": dict(
        robe=(226, 224, 214, 255), robe_dark=(148, 146, 140, 255), robe_light=(250, 250, 246, 255),
        hat="point", hat_color=(88, 92, 106, 255), hair=(238, 236, 230, 255),
        beard=(244, 242, 236, 255), beard_len=4,
        prop="staff", prop_color=(122, 86, 48, 255), prop_gem=(96, 156, 246, 255),
    ),
    # 商人：暖褐短袍、宽檐帽，腰侧挂钱袋（宽檐帽是「摆摊的」最直白的记号）
    "merchant": dict(
        robe=(178, 118, 58, 255), robe_dark=(112, 70, 30, 255), robe_light=(222, 172, 106, 255),
        hat="wide", hat_color=(206, 156, 92, 255), hair=(96, 62, 30, 255),
        prop="pouch", prop_color=(226, 176, 72, 255),
    ),
    # 商店：深绿外袍 + 皮围裙 + 皮帽，手边一摞金币（属性买卖＝柜台生意）
    "shop": dict(
        robe=(58, 132, 84, 255), robe_dark=(32, 82, 52, 255), robe_light=(120, 196, 138, 255),
        apron=(226, 208, 168, 255), hat="cap", hat_color=(168, 128, 84, 255),
        hair=(74, 52, 34, 255),
        prop="coins", prop_color=(240, 202, 84, 255),
    ),
    # 小偷：兜帽 + 蒙面，只露两条眼缝，腰间短匕（不像是能讲道理的人）
    "thief": dict(
        robe=(74, 78, 92, 255), robe_dark=(40, 42, 54, 255), robe_light=(112, 118, 136, 255),
        hat="hood", hat_color=(52, 56, 70, 255), mask=(38, 40, 54, 255),
        prop="dagger", prop_color=(198, 204, 216, 255), prop_grip=(126, 82, 42, 255),
    ),
    # 仙子：青白长裙、花冠、背后一双薄翅、手持星杖
    # （一眼看出「不是人、是来帮你的」）
    "fairy": dict(
        robe=(206, 240, 250, 255), robe_dark=(120, 190, 216, 255), robe_light=(248, 254, 255, 255),
        hat="tiara", hat_color=(246, 252, 255, 255), hair=(150, 220, 246, 255),
        wings=(178, 232, 250, 200),
        prop="wand", prop_color=(240, 246, 255, 255), prop_gem=(86, 214, 250, 255),
    ),
    # 公主：粉裙、长发、金冠（视觉上就该是「被关在这里的那个人」）
    "princess": dict(
        robe=(240, 168, 208, 255), robe_dark=(186, 96, 150, 255), robe_light=(252, 214, 234, 255),
        hat="crown", hat_color=(246, 202, 70, 255), hair=(126, 74, 40, 255), hair_len=6,
        prop="none",
    ),
}




def _npc_shadow(im: Image.Image) -> None:
    """
    脚下两行半透明落地影 —— 与勇者同一套参数（见 `_hero_shadow` 的三条注意）。

    为什么要跟着勇者一起加：勇者的影子是**技术上必需**的（它要撑住帧的包围盒，
    否则 `bottom_center()` 贴底之后可见行区间会跑偏，NPC 的比例基准会跟着错）。
    但勇者有影子、六个 NPC 没有，并排站在棋盘上就很怪 —— 上下两个人一个踩地、
    一个悬着。所以两边一起补，这才是「一起补影子才协调」那句备注的落地。
    """
    d = ImageDraw.Draw(im)
    d.ellipse([3, 24, 12, 25], fill=(58, 48, 68, 164))
    d.ellipse([5, 24, 10, 25], fill=(44, 36, 54, 206))




def _npc_base(spec) -> Image.Image:
    """
    画一帧静止姿态。解剖常量都在这里，改一处六个 NPC 一起对齐。

    行号全部取自上面的纵向解剖表 —— **不要在这里写裸数字**，
    否则下一次「NPC 又变大了」会是六个角色各错一点，很难查。

    画法上有一处是这次改动的核心：**头不是「脸」本身**。
    先铺一层头发/兜帽占满 x=3..12，再把 8 宽的脸盖在中间 ——
    于是「头」是 10 宽，和含手臂的躯干（也是 10 宽）一样宽。
    改前是直接用 6 宽的脸当整颗头，于是头上顶着一根细高的长方形。
    """
    im = Image.new("RGBA", (NPC_W, NPC_H), (0, 0, 0, 0))
    robe = spec["robe"]
    dark = spec.get("robe_dark", spec["robe"])
    light = spec.get("robe_light", spec["robe"])

    # ── 下摆（x=5..10）：与躯干同宽 —— 收掉 A 字大摆，「身体太宽」就是它 ─
    rh = NPC_ROBE_BOT - NPC_ROBE_TOP + 1
    _put(im, NPC_ROBE_X, NPC_ROBE_TOP, NPC_ROBE_W, rh, robe)
    _put(im, NPC_ROBE_X, NPC_ROBE_TOP, 1, rh, light)                     # 左受光
    _put(im, NPC_ROBE_X + NPC_ROBE_W - 1, NPC_ROBE_TOP, 1, rh, dark)     # 右背光

    # ── 躯干（x=5..10）────────────────────────────────────────────────
    th = NPC_TORSO_BOT - NPC_TORSO_TOP + 1
    _put(im, NPC_TORSO_X, NPC_TORSO_TOP, NPC_TORSO_W, th, robe)
    _put(im, NPC_TORSO_X, NPC_TORSO_TOP, 1, th, light)
    _put(im, NPC_TORSO_X + NPC_TORSO_W - 1, NPC_TORSO_TOP, 1, th, dark)
    if spec.get("apron"):
        _put(im, NPC_TORSO_X + 1, NPC_TORSO_TOP + 1, NPC_TORSO_W - 2, th - 2, spec["apron"])

    # ── 手臂（x=3..4 与 x=11..12）：全帧最宽的一段（含臂 10 → 可见 12）──
    arm_top, arm_bot = NPC_TORSO_TOP + 1, NPC_TORSO_BOT
    for ax in (NPC_ARM_X, NPC_W - NPC_ARM_X - NPC_ARM_W):
        _put(im, ax, arm_top, NPC_ARM_W, arm_bot - arm_top + 1, robe)
        _put(im, ax, arm_bot, NPC_ARM_W, 1, SKIN)          # 手

    # ── 脚（第 22 行）：描边后踩到第 23 行 = 勇者的脚底行 ──────────────
    _put(im, NPC_FOOT_X, NPC_FOOT_ROW, 2, 1, dark)
    _put(im, NPC_FOOT_X + 4, NPC_FOOT_ROW, 2, 1, dark)

    # ── 翅膀（仙子）：露在手臂外侧各 1 列 ─────────────────────────────
    if spec.get("wings"):
        w = spec["wings"]
        _put(im, NPC_ARM_X - 1, NPC_TORSO_TOP, 1, th, w)                   # x=2
        _put(im, NPC_W - NPC_ARM_X - 1, NPC_TORSO_TOP, 1, th, w)           # x=13

    # ── 长发（公主）：顺着**手臂外侧那一列**垂到肩，不额外占宽度 ────────
    if spec.get("hair_len"):
        hc = spec.get("hair", dark)
        hb = min(NPC_FACE_BOT + spec["hair_len"], NPC_TORSO_BOT - 1)
        _put(im, NPC_ARM_X, NPC_FACE_BOT + 1, 1, hb - NPC_FACE_BOT, hc)
        _put(im, NPC_W - NPC_ARM_X - 1, NPC_FACE_BOT + 1, 1, hb - NPC_FACE_BOT, hc)

    # ── 头：就是那张 8 宽的脸（可见 10），发际线压一行头发/帽檐 ─────────
    # 改前这里只有 6 宽、却有 8 行高 —— 那根细高的长方形就是用户说的「太细」。
    hair = spec.get("hair", dark)
    _put(im, NPC_FACE_X, NPC_HAT_BOT, NPC_FACE_W, 1, hair)
    _put(im, NPC_FACE_X, NPC_FACE_TOP, NPC_FACE_W, NPC_FACE_BOT - NPC_FACE_TOP + 1, SKIN)
    _put(im, NPC_FACE_X, NPC_FACE_BOT, NPC_FACE_W, 1, SKIN_DK)     # 下巴压暗一行

    # 蒙面（小偷）：下半张脸盖住 —— 在眼睛之前画，眼睛正好落在面罩上变成两条眼缝
    if spec.get("mask"):
        _put(im, NPC_FACE_X, NPC_FACE_BOT - 2, NPC_FACE_W, 3, spec["mask"])

    # 眼睛：离脸的左右边各 1 列、2 行高 —— 与勇者的眼睛同一套比例
    _put(im, NPC_FACE_X + 1, NPC_EYE_TOP, 1, 2, NPC_INK)
    _put(im, NPC_FACE_X + NPC_FACE_W - 2, NPC_EYE_TOP, 1, 2, NPC_INK)

    # 胡须（老人）：从下巴往下铺，与脸同宽（窄了又会变成「细长条」）
    if spec.get("beard_len"):
        bc = spec["beard"]
        bl = min(spec["beard_len"], NPC_TORSO_BOT - NPC_FACE_BOT)
        _put(im, NPC_FACE_X, NPC_FACE_BOT + 1, NPC_FACE_W, bl, bc)

    # ── 帽子 / 头顶记号：一律落在第 5..7 行，帽檐与头同宽（8）──────────
    # 只有商人的宽檐帽刻意伸到 x=3..12（可见 12），作为「摆摊的」的记号。
    hat = spec.get("hat", "none")
    hc = spec.get("hat_color", dark)
    if hat == "point":      # 尖顶软帽：智者（2 → 4 → 8，逐行张开的锥形）
        _put(im, 7, NPC_HAT_TOP, 2, 1, hc)
        _put(im, 6, NPC_HAT_TOP + 1, 4, 1, hc)
        _put(im, NPC_FACE_X, NPC_HAT_BOT, NPC_FACE_W, 1, hc)
    elif hat == "wide":     # 宽檐帽：商人（唯一比头宽的一顶）
        _put(im, 6, NPC_HAT_TOP, 4, 1, hc)
        _put(im, NPC_TORSO_X, NPC_HAT_TOP + 1, NPC_TORSO_W, 1, hc)
        _put(im, NPC_ARM_X, NPC_HAT_BOT, NPC_FACE_W + 2, 1, hc)   # x=3..12
    elif hat == "hood":     # 兜帽：小偷 —— 罩住头顶，两侧垂布把脸夹成一条
        _put(im, NPC_FACE_X, NPC_HAT_TOP, NPC_FACE_W, 3, hc)
        _put(im, NPC_FACE_X, NPC_FACE_TOP, 1, 6, hc)
        _put(im, NPC_FACE_X + NPC_FACE_W - 1, NPC_FACE_TOP, 1, 6, hc)
    elif hat == "crown":    # 金冠：公主（一圈金带 + 三根尖）
        _put(im, NPC_FACE_X, NPC_HAT_BOT, NPC_FACE_W, 1, hc)
        for px in (NPC_FACE_X, NPC_FACE_X + 3, NPC_FACE_X + NPC_FACE_W - 1):
            _put(im, px, NPC_HAT_TOP, 2 if px == NPC_FACE_X + 3 else 1, 2, hc)
    elif hat == "cap":      # 皮帽：商店（扁顶 + 与头同宽的檐，与商人的宽檐帽分得开）
        _put(im, NPC_TORSO_X, NPC_HAT_TOP, NPC_TORSO_W, 2, hc)
        _put(im, NPC_FACE_X, NPC_HAT_BOT, NPC_FACE_W, 1, hc)
    elif hat == "tiara":    # 花冠：仙子（发箍 + 两侧各一朵）
        _put(im, NPC_FACE_X, NPC_HAT_TOP, NPC_FACE_W, 2, hair)
        _put(im, NPC_FACE_X, NPC_HAT_BOT, NPC_FACE_W, 1, hc)
        _put(im, NPC_ARM_X, NPC_HAT_BOT - 1, 1, 2, hc)                    # x=3
        _put(im, NPC_W - NPC_ARM_X - 1, NPC_HAT_BOT - 1, 1, 2, hc)        # x=12
    else:
        _put(im, NPC_FACE_X, NPC_HAT_TOP, NPC_FACE_W, 3, hair)

    # 手持物 —— 「这个人是干什么的」最直接的表达。
    # 一律放在右侧（x=13..15）且**不高于第 9 行**：抬高了会把内容顶行顶上去，
    # 又变成「NPC 比勇者高」；也一律只占 1~2 列，免得把它算进「身体有多宽」。
    # （量宽度时用的是「含中心那一列的主块」，道具是独立的一段，不会混进来。）
    prop = spec.get("prop", "none")
    pc = spec.get("prop_color", dark)
    gem = spec.get("prop_gem", pc)
    if prop == "staff":     # 法杖：杖身从腰边撑到地面，顶端一颗宝石
        _put(im, 14, NPC_TORSO_TOP - 3, 1, NPC_FOOT_ROW - NPC_TORSO_TOP + 3, pc)
        _put(im, 13, 9, 3, 3, gem)
    elif prop == "wand":    # 星杖：再短一截，顶端一颗星
        _put(im, 14, NPC_TORSO_TOP + 1, 1, NPC_FOOT_ROW - NPC_TORSO_TOP - 1, pc)
        _put(im, 13, NPC_TORSO_TOP - 2, 3, 2, gem)
        _put(im, 14, NPC_TORSO_TOP - 3, 1, 1, gem)
    elif prop == "pouch":   # 钱袋：挂在腰侧
        _put(im, 13, NPC_ROBE_TOP, 3, 4, pc)
        _put(im, 13, NPC_ROBE_TOP - 1, 3, 1, dark)
    elif prop == "coins":   # 手边一摞金币
        _put(im, 13, NPC_TORSO_BOT - 1, 3, 2, pc)
        _put(im, 13, NPC_TORSO_BOT - 2, 3, 1, gem)
    elif prop == "dagger":  # 短匕：斜插在腰侧
        _put(im, 13, NPC_TORSO_TOP, 2, 2, spec.get("prop_grip", dark))
        _put(im, 13, NPC_TORSO_TOP + 2, 2, 3, pc)
        _put(im, 14, NPC_TORSO_TOP + 5, 1, 1, pc)

    out = add_outline(im, INK)
    _npc_shadow(out)      # 影子必须在描边之后叠 —— 理由见 _npc_shadow
    return out




def npc_art_frames(npc_id: str) -> list[Image.Image]:
    """
    一个 NPC 的 idle 帧 —— **只有 1 帧，这是刻意的，不是漏画**。

    ## 为什么素材里不再有「呼吸帧」（2026-09-23 改）

    原先这里出 4 帧「静止 / 上身抬起 / 静止 / 上身抬起」。抬起的做法是把**上半身
    整体上移 1 行**（脚不动），再用下摆首行填住腰上让出来的那条缝。玩家连着两轮
    反馈「抖动时出现压缩，像是图层层级错了」，说的就是它。

    根因不在缝填得对不对，而在**「呼吸」被做进了素材几何**：只要在素材里把精灵
    拆成「上半身 / 下半身」两层做相对位移，那条接缝就必须有补偿 ——

      · 复制一行来填 → 腰上多出一行重复像素，读出来就是「被压了一下」；
      · 留空不填     → 躯干与下摆之间透出背景，读出来是「上下分离」；
      · 干脆整图上移 → 底部锚定下脚离地 1px，读出来是「在飘」。

    三条路都是错的，因为它们都在**改像素的形状**。

    ## 现在的分工

      素材（本函数）：只出**静止帧**，几何永远正确。
      渲染层（src/render/board/bob.ts 的 `bobPx()`，由 `board/index.ts` 的 `update()` 调用）：让整只精灵做 1 个落屏像素的
      **刚体位移**，上半程抬起、下半程落回，各实体相位错开。

    刚体位移不改变任何像素的位置关系，「压缩」在原理上就不可能发生 ——
    这比「把缝填得更好看」高一个层次：前者是消除病因，后者是修饰症状。

    `verify_npc_art` 有一条判据钉死「帧数 == 1」，防止将来有人又把位移帧加回来。
    """
    return [_npc_base(NPC_ART[npc_id])]




def verify_npc_art(images: dict) -> list:
    """
    NPC 造型断言。**必须写成断言，不能靠眼看** —— 「六个 NPC 长得一样」这个问题
    在代码里完全看不出来（它们本来就都是「一个 16×26 的精灵」）。

    四条判据：
      1. 任意两个职能的静止帧不能逐像素相同；
      2. 剪影（实心像素集合）必须不同 —— 「同一张图换色」会被这条拦下；
      3. 实心底行必须正好落在**鞋下一行的描边**上（`NPC_FOOT_ROW + 1`）——
         精灵是底部锚定的（`anchor.set(0.5, 1)`），脚没有确定的落点就会出现
         「一只脚踩地、一只脚悬空」这种只在画面上看得见的错。
      4. **每个 NPC 的 idle 帧数必须是 1。** 呼吸归渲染层做刚体位移，
         素材里一旦又出现「上半身/下半身错位」的位移帧，压缩就会跟着回来 ——
         判据 1~3 全都看不见这件事（它们只看静止帧），所以必须单独钉一条。

    判据 3 的期望行数**不是帧底**（第 25 行）：勇者那套素材脚底下还带着
    2 行半透明影子，但身体本身也落在第 23 行（见 SOLID_ALPHA）。
    NPC 要和勇者站得一样高，就得落在同一行 —— 所以这里钉的是解剖表，
    不是「帧的最后一行为空就报错」那种想当然的写法。

    比较用 `tobytes()` 而不是 `getdata()`：后者在 Pillow 12 起被标记弃用
    （计划 Pillow 14 移除），而这个脚本每次构建都跑，警告会一直刷屏。
    """
    problems = []
    ids = list(images)

    def silhouette(im):
        alpha = im.getchannel("A").tobytes()
        return {i for i, a in enumerate(alpha) if a >= SOLID_ALPHA}

    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            fa, fb = images[a][0], images[b][0]
            if fa.tobytes() == fb.tobytes():
                problems.append(f"{a} 与 {b} 的静止帧逐像素完全相同")
            elif silhouette(fa) == silhouette(fb):
                problems.append(f"{a} 与 {b} 剪影完全相同（只换了颜色）")
    for npc_id, frames in images.items():
        if len(frames) != 1:
            problems.append(
                f"{npc_id} 出了 {len(frames)} 帧 idle —— 素材里只允许静止帧。"
                f"呼吸是渲染层的刚体位移（board.ts 的 NPC_BOB_PX），"
                f"在素材里做上下错位必然要在接缝处补偿，那就是「抖动时压缩」的来源"
            )
            continue
        base = frames[0]
        _, bottom = solid_rows(base)
        if bottom != NPC_FOOT_ROW + 1:
            problems.append(
                f"{npc_id} 的实心底行在 {bottom}，解剖表要求 {NPC_FOOT_ROW + 1}"
                f"（鞋画在第 {NPC_FOOT_ROW} 行，描边再往下占一行）—— "
                f"底部锚定下脚没踩在该在的位置，就会比勇者高一点或低一点"
            )
    return problems




# ── 勇者身上量出来的基准值（用上面的**实心**量法，别用包围盒）──────────
#
#   · 每一帧的实心内容都占 **20 行**：朝下 / 左 / 右是 4..23，朝上的两帧是 3..22
#     —— walk 的起伏让整张精灵上下移 1 行，**高度始终是 20**。
#     （帧高 26，脚底下那 2 行是半透明影子，不算内容。见 SOLID_ALPHA 的说明。）
#   · 头（帽子 + 脸）那一段最宽 15，躯干（含手臂）14 —— **头不比身体窄**。
#   · 全图最宽 15（朝下那帧的帽子两侧）。
HERO_VISIBLE_H = 20


HERO_MAX_W = 15



# NPC 的头（发际线到下巴）主块宽度下限。
# 脸 8 宽 + 左右各 1 描边 = 10。改前是「6 宽的脸 + 描边」= 8，
# 那根又细又高的长方形就是用户说的「头上的长方形太细」。
NPC_HEAD_MIN_W = 10


# 下摆主块相对头允许超出多少。改前下摆量到 15（A 字大摆 + 手臂描边连成一片），
# 头只有 8 —— 差 7。留 2 是给「肩比头略宽」这点正常结构。
NPC_HEM_OVER_HEAD = 2




def verify_npc_scale(npc_images: dict, hero_frames: list) -> list:
    """
    NPC 必须和勇者**一样高、头身比也一样**。

    这条断言来自两次真实反馈：
      · 第一次「NPC 模型改小一点，比例适中」—— 当时 NPC 内容高 26，是勇者的 1.13 倍；
      · 第二次「NPC 的模型应该和玩家角色类似，头上的长方形太细、身体太宽」
        —— 高度对上了，**形状没对上**：头只有 6+2 宽，下摆却宽到 15。

    两次都栽在同一件事上：**「内容占几行」的量法**。
    第一版用「非透明包围盒」量勇者，把素材自带的 alpha=7 极淡边缘算了进去，
    量出 22~23，于是把 NPC 也画成 23 —— 肉眼上看还是大了一圈。
    现在一律走 `SOLID_ALPHA`（见那个常量的说明）。

    判据：
      1. 勇者自己各帧的可见高度必须一致（基准要靠它，不一致说明素材切帧变了）；
      2. 静止帧的可见行区间 == 勇者朝下那帧的行区间（4..23），高度 == 20；
      3. 若将来又出现额外的 idle 帧：脚不走（底行不变）、顶行不越过勇者的最顶行。
         ⚠️ 现在素材只有静止帧，这条一次都不进循环 —— 呼吸已经挪到渲染层
         （见 `npc_art_frames`），所以「帧数 == 1」由 `verify_npc_art` 判据 4 钉。
         留着这段是为了万一有人加回第二帧时，至少能拦住「脚离地」这一种；
      4. 头（发际线..下巴）主块宽度 ≥ `NPC_HEAD_MIN_W`；
      5. 下摆主块宽度 ≤ 头 + `NPC_HEM_OVER_HEAD`；
      6. 任意一行的可见跨度 ≤ 勇者的最宽行。

    宽度用 `solid_core_width`（含中心的那一段），理由见那个函数。
    """
    problems: list[str] = []
    if not hero_frames:
        return ["verify_npc_scale 拿不到勇者帧，无法比较比例"]

    hero_spans = [solid_rows(f) for f in hero_frames]
    hero_heights = {b - a + 1 for a, b in hero_spans}
    if len(hero_heights) != 1:
        problems.append(
            f"勇者各帧的可见高度不一致：{sorted(hero_heights)} —— 基准值要靠它，"
            f"先查切帧（真正的走起伏只挪位置、不改高度）"
        )

    def core(im, y):
        return solid_core_width(im, y)

    # 帧序是 HERO_DIRS = 朝下/右/上/左 各 4 帧，第 0 帧就是朝下（最常看到的姿态）
    ref_top, ref_bottom = hero_spans[0]
    hero_top = min(a for a, _ in hero_spans)
    hero_max_w = max(core(f, y) for f in hero_frames for y in range(f.height))

    for npc_id, frames in npc_images.items():
        base = frames[0]
        top, bottom = solid_rows(base)
        h = bottom - top + 1
        if (top, bottom) != (ref_top, ref_bottom):
            problems.append(
                f"NPC {npc_id} 静止帧可见行 {top}..{bottom}，勇者朝下那帧是 "
                f"{ref_top}..{ref_bottom} —— 同帧尺寸同倍数下这就是「谁更大」。"
                f"绘制区间应为 {NPC_ART_TOP}..{NPC_ART_FEET}（描边后即 {ref_top}..{ref_bottom}）"
            )
        elif h != HERO_VISIBLE_H:
            problems.append(f"NPC {npc_id} 可见高 {h}，勇者是 {HERO_VISIBLE_H}")

        head_w = max(core(base, y) for y in range(NPC_FACE_TOP, NPC_FACE_BOT))
        hem_w = max(core(base, y) for y in range(NPC_ROBE_TOP + 1, NPC_ROBE_BOT + 1))
        if head_w < NPC_HEAD_MIN_W:
            problems.append(
                f"NPC {npc_id} 的头只有 {head_w} 列宽（要求 ≥ {NPC_HEAD_MIN_W}）—— "
                f"脸是 {NPC_FACE_W} 宽 + 左右各 1 描边，再窄就回到「头上的长方形太细」"
            )
        if hem_w > head_w + NPC_HEM_OVER_HEAD:
            problems.append(
                f"NPC {npc_id} 下摆 {hem_w} 列宽、头才 {head_w} 列 —— 差 {hem_w - head_w}。"
                f"这就是「身体太宽」：下摆别做成 A 字大摆，与躯干同宽即可"
            )

        widest = max((core(base, y) for y in range(base.height)), default=0)
        if widest > hero_max_w:
            problems.append(
                f"NPC {npc_id} 最宽的一行 {widest} 列，勇者最宽 {hero_max_w} 列 —— 站一起会显得更大"
            )

        # 若真有额外的 idle 帧：脚不能走，头顶也不能越界（现在帧数恒为 1，不会进这里）
        for i, fr in enumerate(frames[1:], start=1):
            b_top, b_bottom = solid_rows(fr)
            if b_bottom != ref_bottom:
                problems.append(
                    f"NPC {npc_id} 第 {i} 帧底行到了 {b_bottom} —— "
                    f"底部锚定下脚离地会变成「在飘」。素材里不该有第二帧："
                    f"呼吸是渲染层的刚体位移，请改 board.ts 而不是再加素材帧"
                )
            if b_top < hero_top:
                problems.append(
                    f"NPC {npc_id} 第 {i} 帧（呼吸）顶行到了 {b_top}，超过勇者最高的 {hero_top} 行"
                )
    return problems
