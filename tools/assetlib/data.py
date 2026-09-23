"""
构建期的**真值表**：实体 → 素材来源的映射，以及几个「谁是谁」的名单。

三张表（`TERRAIN` / `MONSTERS` / `ITEM_SRC`）是「哪只怪物用哪张图」的唯一事实来源，
故意做成可 diff 的静态数据而不是藏在代码逻辑里。

`BOSS_IDS` 与 `OVERSIZE_BOSSES` **刻意都留着**，哪怕现在两者相等：
一个管「玩法上是不是 BOSS」（真值在 `data/monsters.json`），
一个管「素材画多大」。相等是此时此刻的事实，不是可以合并的理由 ——
渲染层与 A6 断言正是靠这两者的**差集**工作的。
"""

from __future__ import annotations




# 8 只玩法 BOSS 的 id。真值在 `data/monsters.json` 的 `boss` 字段，
# 构建期由 `verify_boss_art` 的判据 6 与数据表核对（少一只 = 这只 BOSS 会退回
# 32 网格的杂兵造型，而它头上还顶着渲染层画的金色圈）。
#
# 定义在这里而不是 BOSS 绘制段旁边：`OVERSIZE_BOSSES` 要引用它，
# 而模块级语句是自上而下求值的 —— 放到后面会在 import 时直接 NameError。
BOSS_IDS = (
    "skeletonCaptain", "kraken", "archmage", "dragon",
    "knightCaptain", "demonKing", "demonKingTrue", "vampire",
)



# 「画得比一格大」的怪物名单 —— 注意它**不等于**「玩法上的 BOSS」。
#
# 玩法 BOSS 的真值在 `data/monsters.json` 的 `boss` 字段（8 只，见 `BOSS_IDS`），
# 渲染层据此画金色圈。
#
# ## 2026-09-23：从 4 只扩到全部 8 只
#
# 改前只挑 4 只放大（dragon / kraken / demonKing / demonKingTrue），
# 另外 4 只（骷髅队长 / 骑士队长 / 吸血鬼 / 大法师）与杂兵同为 32px 落屏。
# 玩家这一轮的要求是「让 boss 模型更精致更大更逼真」——
# 「一半的 BOSS 和杂兵一样大」正是「不够大」的一半来源，而且是**前中期**那一半：
# 玩家在第 10 层遇到骷髅队长时，它看起来就是一只杂兵。
#
# 现在 8 只全部走 64 网格（`PROC_BOSSES`）、1:1 落屏 64px。
# 于是这里和 `BOSS_IDS` **恰好相等** —— 但两者刻意都留着：
# 一个管「素材画多大」，一个管「玩法上是不是 BOSS」，
# 相等是此时此刻的事实，不是可以合并的理由（A6 就是靠这两者的**差集**工作的）。
#
# 名字原来叫 BOSS_SCALE_EXEMPT，被 `tools/verify/checks/a05-monster-layout.cjs` 的 A6 断言
# 逼着改掉了：那个名字会让人以为「BOSS 就这 4 只」，而实际是 8 只 ——
# 一个名字让两处真值看起来矛盾，是下一个 bug 的温床。
#
# 不变量（有断言，见 tools/verify/checks/a05-monster-layout.cjs 的 A6）：
# OVERSIZE_BOSSES ⊆ 玩法 BOSS。反方向**以前**不要求（允许有 BOSS 不放大），
# 现在有 `verify_boss_art` 的判据 6 反过来钉死「8 只一个不落」。
OVERSIZE_BOSSES = set(BOSS_IDS)




# ─────────────────────────────────────────────────────────────────────
# 六、怪物映射（36 只，其中 35 只手绘）
# ─────────────────────────────────────────────────────────────────────
# 格式： id -> (0x72 源名, 变换函数, 绘制倍数, 变换说明)
#
# **源名写 `"gen"` 表示这只不取 0x72，改由本仓库按名称手绘** ——
# 形状与配色见 `PROC_MONSTERS`。手绘的原因有两代：
#   第一代：0x72 包里**没有**蝙蝠/龙/乌贼/石头人/史莱姆，只能自己画；
#   第二代（本轮）：0x72 仅有的人形底图也**读不出职业与等级** ——
#     `knight_m/f` 源图是像素机器人（浅蓝方壳 + 独眼），守卫/骑士 8 只全顶着它；
#     同族等级只靠换色（ramp 铁→银→金），16px 下阶差几乎不可读。
#   于是人形怪也搬进 32 网格手绘（守卫/骑士/法师/兽人/骷髅/幽魂六形），
#   设计语言是「职业 = 装备剪影 × 等级 = 材质与覆盖度」，见 PROC_MONSTERS。
# 两边必须严格一一对应，有断言拦（见 verify_mon_art）。
# 现在唯一还取自 0x72 的是 ice_zombie（备用图，本作暂未用，名字与形象相符）。
#
# ⚠️ **第三列（绘制倍数）对 8 只 BOSS 已不再生效**：它们全部搬到 64 网格的
# 独立体系（见 PROC_BOSSES / boss_art_frames），落屏规则只有一条 —— 64 网格
# 1:1，即 drawScale 恒为 1.0（BOSS_DRAW_SCALE）。这一列对它们统一写 1，
# 是**故意留着误导不了的写法**：写 3 会让人以为改这里能放大 BOSS。
# 这条也有断言兜底（verify_monster_fit 会核对 BOSS 的 drawScale 必须是 1.0）。
#
# ⚠️ 对**非 BOSS**，倍数一律 2 —— 这条有断言（见 verify_monster_fit）。
# 教训：曾经有 5 只非 BOSS（bigBat / vampireBat / bigSlime / slimeKing / stoneGolem）
# 也取了 ×3，落屏 36–39px，**越出 32px 的格子 4–7px**。全塔 479 只怪物里有 145 只
# 属于这 5 种，于是「它到底占哪一格」在画面上变得不确定 ——
# 而魔塔是靠「走进哪一格」来打怪的，格子边界不是审美问题。
# BOSS 超出格子是刻意的（大块头本身是层级信号），而且实测 BOSS 都落在 y≥3，
# 越出的是自己头顶那一格，不会捅出棋盘外框。

MONSTERS = {
    # ── 骷髅三阶：骨 → 铁甲 → 金甲（等级 = 护甲覆盖度，剪影骨架不变）──
    "skeleton":        ("gen",           None,                              2, "手绘·骷髅：裸骨 + 锈剑"),
    "skeletonSoldier": ("gen",           None,                              2, "手绘·骷髅兵：铁盔铁甲 + 铁剑"),
    "skeletonCaptain": ("gen",           None,                              1, "手绘·骷髅队长（64 网格 BOSS）：金盔金甲 + 圆盾 + 骨剑"),

    # ── 亡灵族 ──────────────────────────────────────────────────
    "ghostWarrior":    ("gen",           None,                              2, "手绘·幽魂武士：兜帽飘尾 + 幽光剑，青白"),
    "phantom":         ("gen",           None,                              2, "手绘·幻影：同幽魂换紫 + 半透明"),
    "vampire":         ("gen",           None,                              1, "手绘·吸血鬼伯爵（64 网格 BOSS）：高领斗篷 + 尖牙 + 红眼"),
    "ice_zombie":      ("ice_zombie",    None,                              2, "原样（备用图，本作暂未用）"),

    # ── 蝙蝠族：手绘（0x72 没有蝙蝠，旧版用 imp 小恶魔顶替）──────
    # ⚠️ 只有 OVERSIZE_BOSSES 里的那 4 只允许乘 3。其余一律乘 2 —— 见该常量的说明。
    "bat":             ("gen",           None,                              2, "手绘：德拉基式圆球身 + 呆毛，棕"),
    "bigBat":          ("gen",           None,                              2, "手绘：长翅，深褐"),
    "vampireBat":      ("gen",           None,                              2, "手绘：长翅 + 獠牙，血红"),

    # ── 史莱姆族：手绘（0x72 没有史莱姆，旧版用 swampy 绿衣人顶替）─
    "greenSlime":      ("gen",           None,                              2, "手绘：绿圆顶果冻"),
    "redSlime":        ("gen",           None,                              2, "手绘：红圆顶果冻"),
    "bigSlime":        ("gen",           None,                              2, "手绘：更高的圆顶（用体量而不是换色表达「大」）"),
    "slimeKing":       ("gen",           None,                              2, "手绘：金 + 三尖冠"),

    # ── 法师族：学徒 → 资深 → 大法师（袍色蓝→紫→金 + 帽高 + 宝珠）──
    "juniorMage":      ("gen",           None,                              2, "手绘·法师学徒：蓝袍短帽 + 木杖，白须"),
    "seniorMage":      ("gen",           None,                              2, "手绘·法师：紫袍高帽 + 紫宝珠，白须"),
    "juniorWizard":    ("gen",           None,                              2, "手绘·女法师学徒：蓝袍短帽 + 长发"),
    "seniorWizard":    ("gen",           None,                              2, "手绘·女法师：紫袍高帽 + 长发"),
    "archmage":        ("gen",           None,                              1, "手绘·大法师（64 网格 BOSS）：金袍高帽 + 金宝珠 + 长白须"),
    "magicGuard":      ("gen",           None,                              2, "手绘·魔卫：青袍兜帽（无檐）+ 绿宝珠杖"),

    # ── 兽人族：木棒 → 铁肩甲战斧 → 矮身短匕 ────────────────────
    "orc":             ("gen",           None,                              2, "手绘·兽人：绿皮獠牙 + 木棒"),
    "orcWarrior":      ("gen",           None,                              2, "手绘·兽人武士：深绿 + 铁肩甲 + 战斧"),
    "goblin":          ("gen",           None,                              2, "手绘·哥布林：矮身大耳 + 短匕"),

    # ── 守卫族：青铜 → 白银 → 黄金（甲色三阶 + 盔羽无→短→高）─────
    "juniorGuard":     ("gen",           None,                              2, "手绘·守卫：青铜甲 + 长枪圆盾（无盔羽）"),
    "midGuard":        ("gen",           None,                              2, "手绘·守卫：白银甲 + 短盔羽"),
    "seniorGuard":     ("gen",           None,                              2, "手绘·守卫：黄金甲 + 高盔羽 + 金饰金盾钉"),

    # ── 剑士 / 骑士族：露脸轻装 → 铁甲 → 蓝钢红羽 → 白银金饰披风 → 暗黑 ─
    "swordsman":       ("gen",           None,                              2, "手绘·剑士：露脸红发带 + 细剑（轻装）"),
    "warrior":         ("gen",           None,                              2, "手绘·战士：铁全盔 + 鸢盾"),
    "knight":          ("gen",           None,                              2, "手绘·骑士：蓝钢甲 + 红盔羽 + 鸢盾"),
    "knightCaptain":   ("gen",           None,                              1, "手绘·骑士长（64 网格 BOSS）：白银甲金饰 + 红披风金羽"),
    "darkKnight":      ("gen",           None,                              2, "手绘·暗黑骑士：黑甲红目缝 + 黑披风"),
    "stoneGolem":      ("gen",           None,                              2, "手绘：方块躯干 + 砖缝 + 发光眼（旧为 ogre 食人魔）"),

    # ── BOSS：允许 ×3（48px）。层级信号靠尺寸，但**只有 BOSS 有这个特权** ──────
    "dragon":          ("gen",           None,                              1, "手绘·魔龙（64 网格 BOSS）：巨角 + 长吻 + 展翼 + 卷尾"),
    "kraken":          ("gen",           None,                              1, "手绘·巨型乌贼（64 网格 BOSS）：圆头 + 侧鳍 + 六条腕"),
    "demonKing":       ("gen",           None,                              1, "手绘·魔王（64 网格 BOSS）：巨角 + 膜翼 + 发光眼"),
    "demonKingTrue":   ("gen",           None,                              1, "手绘·魔王真身（64 网格 BOSS）：高举巨翼 + 三段长角 + 金冠"),
}



# ─────────────────────────────────────────────────────────────────────
# 七、道具映射（32 项）
# ─────────────────────────────────────────────────────────────────────

# 匙身横带的色相区间。
# 实测 Kenney #126 只有 10 个像素落在这个区间 —— 就是那截识别色横带；
# 匙柄（橙，15–45°）和匙体（深，260–345°）都在区间外，所以重染不会碰到它们。
KEY_ACCENT = (70, 165)



ITEM_SRC = {
    # 宝石：六个源包里都没有 —— 程序化生成（见 gen_icon 的 gem_red/gem_blue）。
    # 曾经从 0x72 图集 r12c1/r12c3 切，但那两格是纯色矩形，棋盘上就是两个方块。
    "redGem":   ("gen", "gem_red",  "程序化生成（0x72/Kenney 均无宝石）"),
    "blueGem":  ("gen", "gem_blue", "程序化生成（0x72/Kenney 均无宝石）"),

    "redPotion":  ("o72", "flask_red",   "0x72/flask_red"),
    "bluePotion": ("o72", "flask_blue",  "0x72/flask_blue"),
    "holyWater":  ("o72", "flask_big_blue", "0x72/flask_big_blue"),

    # 钥匙：Kenney tiny-dungeon 的钥匙是「深色匙体 + 橙色匙柄 + 一截彩色横带」，
    # 识别颜色**只在那截横带上**（绿/红/蓝各约 10 像素）。
    # 所以三色钥匙统一取同一张底图（#126），只把横带重染成金/蓝/红 ——
    # 这样它们天然是一套，颜色也各自纯粹，还顺手补上了原素材没有的黄色。
    # （试过用整体 hue_shift 把绿钥匙转成黄：匙柄会跟着转，得到一把「绿头蓝身」的
    #   钥匙，既不像黄钥匙又和蓝钥匙撞色。整体转色相在这个素材包里基本都不可靠。）
    "yellowKey": ("ken", 126, KEY_ACCENT + ((92, 62, 12), (252, 214, 96)), "Kenney #126 @ 匙身重染为金"),
    "blueKey":   ("ken", 126, KEY_ACCENT + ((14, 24, 58), (150, 194, 246)), "Kenney #126 @ 匙身重染为蓝"),
    "redKey":    ("ken", 126, KEY_ACCENT + ((58, 10, 16), (250, 138, 138)),  "Kenney #126 @ 匙身重染为红"),
    # 万能钥匙：整把压成黄金渐变，保留 #129 不同的匙柄造型 —— 与黄钥匙（橙色匙柄）区分
    "goldenKey": ("ken", 129, "gold", "Kenney #129 @ 整把黄金渐变"),

    # 剑：0x72 的 22 把武器里挑 6 把，按威力从朴素到华丽
    "ironSword":   ("o72", "weapon_rusty_sword",  "0x72/weapon_rusty_sword"),
    "silverSword": ("o72", "weapon_regular_sword", "0x72/weapon_regular_sword"),
    "knightSword": ("o72", "weapon_knight_sword", "0x72/weapon_knight_sword"),
    "holySword":   ("o72", "weapon_golden_sword", "0x72/weapon_golden_sword"),
    "sacredSword": ("o72", "weapon_lavish_sword", "0x72/weapon_lavish_sword"),
    "dragonSlayer": ("o72", "weapon_red_gem_sword", "0x72/weapon_red_gem_sword"),

    # 盾：Kenney #102，五级用渐变区分材质
    "ironShield":   ("ken", 102, "shield_iron",   "Kenney #102 @ 铁渐变"),
    "silverShield": ("ken", 102, "shield_silver", "Kenney #102 @ 银渐变"),
    "knightShield": ("ken", 102, "shield_knight", "Kenney #102 @ 蓝钢渐变"),
    "holyShield":   ("ken", 102, "shield_holy",   "Kenney #102 @ 黄金渐变"),
    "sacredShield": ("ken", 102, "shield_sacred", "Kenney #102 @ 圣红渐变"),

    # 工具
    "shovel":  ("sheet", (5 * 16, 192, 6 * 16, 208), "0x72 图集 r12c5（镐）"),
    "bomb":    ("gen", "bomb",        "程序化生成"),
    "cross":   ("gen", "cross",       "程序化生成"),
    "snowflake": ("gen", "snowflake", "程序化生成"),
    "quakeScroll": ("gen", "scroll",  "程序化生成"),
    "monsterBook": ("gen", "book_monster", "程序化生成"),
    "notebook": ("gen", "book_note",  "程序化生成"),
    "mirrorFlyer": ("gen", "mirror",  "程序化生成"),
    "upFlyer":   ("gen", "wing_up",   "程序化生成"),
    "downFlyer": ("gen", "wing_down", "程序化生成"),
    "floorTeleporter": ("gen", "portal", "程序化生成"),

    # 金币堆：用 0x72 的金币首帧放大（保持与 bigGold「大堆」的观感差）
    "bigGold": ("o72", "coin_anim_f0", "0x72/coin_anim_f0"),
}




# 钥匙的识别色应该落在哪个色相区间。三把钥匙的横带都必须明确落在自己那一段里。
KEY_HUE_EXPECT = {
    "yellowKey": ("黄钥匙", 32, 62),
    "blueKey": ("蓝钥匙", 190, 250),
    "redKey": ("红钥匙", 335, 360),
}
