"""
地形：地板 / 墙 / 楼梯的手绘 + 变体派生 + 地形断言。

## 手绘在**出图网格**上，不走超采样

超采样对这类素材是空操作 —— 它们本来就直接画在 `RASTER_TILE` 网格上。
所以「更精细」在这里 = 真·细节翻倍，而不是把已有信息摊细。

## 变体是**配方**，不是随机

`_floor_variants` / `_wall_variants` 用固定种子重跑一批残缺位置，
而缝与倒角与底图**逐像素一致** —— 判定依据写在 `verify_terrain` 里。
"""

from __future__ import annotations

import random
from .pil import Image
from .config import RASTER_TILE, SS
from .pixel import _put, ramp
from .metrics import _col_lums, _hist, _lum, _mean_rgb, mean_hsv, mean_lum
from .sources import o72



# ─────────────────────────────────────────────────────────────────────
# 四之三、上/下楼梯 —— 两张都手绘，谁也不翻转谁
# ─────────────────────────────────────────────────────────────────────
# 0x72 只有一张 floor_ladder，所以上一版是「下楼梯原样用 + 上楼梯垂直翻转」。
# 但 floor_ladder 本身近乎上下对称，翻转之后**肉眼根本分不出来** —— 玩家站在
# 塔里分不清哪一格是往上走（用户报的第 ④ 条就是这个）。
#
# 关键决定：这一版让两张图的**结构**不同，而不是「同一张图的明暗翻转」。
#   下楼梯 = 俯视竖井：同心方环一层层往里变暗，每环上沿留一条亮线当台阶棱，
#            越往里越深 —— 视觉上是"视线掉下去"。
#   上楼梯 = 侧视阶梯：四级台阶自左下升到右上，踏面／立面成对出现、逐级变亮，
#            右上角是一片出口亮光 —— 视觉上是"视线升上去"。
#
# 为什么必须是"结构不同"而不是"明暗相反"：明暗相反在缩小到 32px 之后等价于
# 翻转，玩家学到的只是"亮的是上"这种脆弱的相对线索，换个背景就不成立；
# 而"井"和"阶梯"是两个不同的形体，任何时候都认得出。
# verify_terrain 第 ③ 条据此断言：既不逐像素相同、也不互为上下翻转，
# 且各自的亮度剖面要落在"井 = 上下左右都近对称" / "阶梯 = 自下而上单调变亮"
# 这两条结构特征上 —— 只改了明暗而没改结构的话，第一条就会挂。
#
# 说明：下面的 `_put` 定义在本文件更靠后的位置（NPC 造型那一节）。Python 的
# 函数体在**调用时**才查全局名，而 TERRAIN 里是 lambda、真正调用发生在构建
# 阶段（见 build()），所以这里的先后顺序不影响运行。

# ── 地板：手绘在**出图网格**上 ───────────────────────────────────
# 旧的地板是第三方 16×16 位图重染色再超采样。第三方位图只有 256 个像素的
# 信息，超采样只是把既有信息摊细 —— **不会多出任何细节**，只把轮廓磨圆。
# 地板是占屏面积最大的地形，所以它是最值得真手绘的一张。
FLOOR_BASE = (198, 168, 126)    # 石板面


FLOOR_HI = (216, 190, 147)      # 上 / 左受光倒角


FLOOR_SHADE = (166, 138, 100)   # 下 / 右背光倒角


FLOOR_JOINT = (132, 102, 66)    # 石板缝


FLOOR_BEAD = (146, 108, 66)     # 碎石


FLOOR_SEED = 20260922



# 上楼梯：梯段的踏面／立面，逐级变亮；最后一块是梯顶的出口亮光
STAIR_TREAD = [(178, 154, 118), (198, 174, 136), (218, 194, 158), (238, 214, 176)]


STAIR_RISER = [(122, 102, 72), (136, 114, 82), (152, 128, 92), (168, 144, 104)]


STAIR_SHAFT = (52, 42, 30)      # 梯段背后的井道暗部


STAIR_EXIT = (252, 242, 214)    # 梯顶的出口亮光


STAIR_EXIT_RIM = (232, 212, 168)


STAIR_BASE = (44, 35, 24)       # 最下面那级的落地线


# 下楼梯：越往下越暗，最后一档近乎全黑 —— 那是「看不见底的深处」，
# 也是玩家一眼区分上下的主要依据（上＝往亮处走，下＝往暗处沉）
STAIR_WELL = [(122, 102, 72), (92, 76, 54), (62, 51, 36), (34, 28, 20)]




# ── 墙：手绘在**出图网格**上 ───────────────────────────────────────
# 和地板同一个道理：0x72 的 wall_mid 只有 16×16、三个颜色，超采样只是把这三个
# 色摊细 —— 「每个 16 网格单元内的独立颜色数」实测 1.15 → 1.18，几乎没有多出
# 细节。墙是第二种满屏平铺的地形（地板之外就数它占屏最多），所以同样改成手绘。
#
# 砌法用**错缝**（running bond）：相邻两层的竖缝错开半块砖。这既是真的砌法，
# 也正好用来打散「同一张图在重复」—— 每隔一层，缝的位置就换一次。
WALL_BASE = (78, 63, 60)        # 砖身（仍在 0x72 的墙色族里，与其它地形的明暗关系不变）


WALL_HI = (118, 96, 86)         # 上 / 左受光倒角


WALL_SHADE = (56, 46, 45)       # 下 / 右背光倒角


# 灰缝。比 0x72 的 (34,34,34) 略偏暖 —— 那个值正好等于史莱姆身体的深色，
# 怪物会「粘」在墙上（这条是当年给地板重染色时才量出来的）。
WALL_JOINT = (38, 32, 31)


WALL_STAIN = (92, 70, 54)       # 锈斑 / 苔痕：比砖身暖一点，不是单纯的暗


WALL_SEED = 20260923



WALL_COURSE = 4 * SS            # 一层砌层 16 行 = 砖身 14 + 横缝 2


WALL_BOND = 8 * SS              # 竖缝间距 32（半块砖 16）→ 砖身恒为 30 宽


WALL_JW = max(2, SS) // 2 + SS // 2   # 缝宽 2px


# 残缺的**数量**（不是位置）写死 —— 变体只换位置，配色多重集才守恒。
# 破损（缺角 / 裂纹）一律用缝色：崩掉一块露出来的本来就是灰缝，不新增颜色。
WALL_CHIPS = 6                  # 缺角：2×2


WALL_CRACKS = 3                 # 裂纹：斜向 5px


WALL_CRACK_LEN = 5


WALL_STAINS = 3                 # 锈斑：3×2


WALL_BEADS = 24                 # 麻点：单像素（用受光色，是亮点不是脏点）



# 墙顶压顶：顶面 2 行 / 立面 11 行 / 下沿 1 行 / 投影 4 行。
# 前三项之和 = 14 = 砖身上沿（含第一道横缝的上半），投影那 4 行正好吃掉第一层
# 与第二层之间的整道横缝 —— 否则压顶底下会留下 2px 孤零零的缝，看着像画歪了。
WALL_CAP_ROWS = (2, 11, 1, 4)


WALL_CAP_HI = (206, 186, 164)   # 顶面（受光）


WALL_CAP_FACE = (166, 138, 120) # 立面


WALL_CAP_EDGE = (126, 104, 88)  # 下沿


WALL_CAP_SHADOW = (44, 36, 33)  # 投影（压顶压在墙身上的那道影）




def _floor(seed: int = FLOOR_SEED) -> Image.Image:
    """
    地板：错缝石板，直接画在 RASTER_TILE 网格上。

    结构：上下两行石板，第一行从中间断一次、第二行断两次 —— **错缝砌法**，
    平铺时才不会连成十字网格。缝宽 2px；每块石板贴着缝的那 1px 压倒角
    （上 / 左受光、下 / 右背光），内部再撒极稀疏的碎石。

    ⚠️ `seed` 只影响最后一步的杂质：缝与倒角必须用**固定的** FLOOR_SEED 生成。
    变体就是靠「同一个配方、换个杂质种子」派生的 —— 缝一旦跟着变，平铺就会
    连不上，而颜色多重集也不再守恒，配色断言（verify_terrain ⑤）会立刻红。

    石子用**离散几档色**而不是连续噪声，同样是为了多重集守恒：
    变体只挪位置、不引入新颜色。
    """
    n = RASTER_TILE
    im = Image.new("RGBA", (n, n), FLOOR_BASE + (255,))
    p = im.load()
    rng = random.Random(FLOOR_SEED)      # 缝 / 倒角：固定种子
    jw = max(2, SS) // 2 + SS // 2        # 缝宽：64 网格上 2px

    def vjoint(cx: int, y0: int, y1: int):
        for y in range(y0, y1):
            for dx in range(-jw // 2, jw - jw // 2):
                x = cx + dx
                if 0 <= x < n:
                    p[(x, y)] = FLOOR_JOINT + (255,)

    for ri in range(2):
        y0, y1 = ri * (n // 2), (ri + 1) * (n // 2)
        for cx in ([n // 2] if ri == 0 else [n // 4, 3 * n // 4]):
            vjoint(cx, y0, y1)
    # 横缝：只在两行之间（上下边缘不画，否则平铺时会连成加粗的十字）
    for y in range(n // 2 - jw // 2, n // 2 + jw - jw // 2):
        if 0 <= y < n:
            for x in range(n):
                p[(x, y)] = FLOOR_JOINT + (255,)

    # 倒角：贴着缝的那一圈。上/左提亮、下/右压暗 —— 石板因此读得出厚度。
    base = FLOOR_BASE + (255,)
    joint = FLOOR_JOINT + (255,)
    for y in range(n):
        for x in range(n):
            if p[(x, y)] != base:
                continue
            up = p[(x, y - 1)] == joint if y > 0 else False
            lf = p[(x - 1, y)] == joint if x > 0 else False
            dn = p[(x, y + 1)] == joint if y < n - 1 else False
            rt = p[(x + 1, y)] == joint if x < n - 1 else False
            if up or lf:
                p[(x, y)] = FLOOR_HI + (255,)
            elif dn or rt:
                p[(x, y)] = FLOOR_SHADE + (255,)

    # 杂质：碎石（暗）与磨痕（亮）。密度刻意很低 —— 撒多了就是麻点，
    # 比重复更难看；而且变体是「整批挪位置」，数量越多越容易顶穿 drift 上限。
    rng = random.Random(seed)             # ← 只有这一步随变体变化
    inner = [(x, y) for y in range(1, n - 1) for x in range(1, n - 1) if p[(x, y)] == base]
    for _ in range(int(n * n * 0.008)):
        if not inner:
            break
        x, y = inner[rng.randrange(len(inner))]
        p[(x, y)] = FLOOR_BEAD + (255,)
    for _ in range(int(n * n * 0.004)):
        if not inner:
            break
        x, y = inner[rng.randrange(len(inner))]
        p[(x, y)] = FLOOR_HI + (255,)
    return im




def _wall(seed: int = WALL_SEED) -> Image.Image:
    """
    墙：错缝砌法（running bond），直接画在 RASTER_TILE 网格上。

    为什么手绘：见上面「墙」那一节的注释 —— 第三方位图超采样不产生新细节。

    结构：一层砌层 16 行（砖身 14 + 横缝 2）；竖缝间距 32，相邻层错开半块（16）。
    于是砖身恒为 30×14 —— 平铺时跨格也接得上：横缝在格子上下沿各出 1px、
    竖缝在左右沿各出 1px，拼起来仍是 2px，不会在格子接缝处细一条。
    ⚠️ 缝宽与缝距都必须**整除** RASTER_TILE，否则接缝会在每格边界露出来
    （整片墙每隔 32px 多一条细线，缩略图上根本看不出，真机上一眼可见）。

    ⚠️ `seed` 只影响最后一步的残缺：缝与倒角必须用**固定**的 WALL_SEED。
    变体就是「同一配方、换一批残缺位置」派生出来的 —— 缝一变，平铺就连不上。
    残缺全是**离散色 + 固定数量**，所以变体的配色多重集与底图完全相同。
    """
    n = RASTER_TILE
    im = Image.new("RGBA", (n, n), WALL_BASE + (255,))
    p = im.load()
    base = WALL_BASE + (255,)
    joint = WALL_JOINT + (255,)
    jw = WALL_JW

    def vjoint(cx: int, y0: int, y1: int):
        """一道竖缝，占 [cx-1, cx]（与地板同一套约定：缝偏在 cx 的左上侧）。"""
        for y in range(y0, y1):
            for dx in range(-jw // 2, jw - jw // 2):
                x = cx + dx
                if 0 <= x < n:
                    p[(x, y)] = joint

    # 横缝：每层的上沿，宽 jw（与竖缝同宽）。第 0 层的 y=0 与最后一层的 y=n-1
    # 各只画到半道 —— 另一半由相邻那张瓦片补上，拼起来正好是完整的一道缝。
    # ⚠️ 缝宽必须与竖缝一致：只差一点的话，横竖缝会在满屏铺开时粗细不一。
    for ci in range(n // WALL_COURSE + 1):
        cy = ci * WALL_COURSE
        for dy in range(-jw // 2, jw - jw // 2):
            y = cy + dy
            if 0 <= y < n:
                for x in range(n):
                    p[(x, y)] = joint

    # 竖缝：错缝 —— 相邻层错开半块砖
    for ci in range(n // WALL_COURSE):
        y0, y1 = ci * WALL_COURSE, (ci + 1) * WALL_COURSE
        phase = (ci % 2) * (WALL_BOND // 2)
        for k in range(n // WALL_BOND + 1):
            vjoint(phase + k * WALL_BOND, y0, y1)

    # 倒角：贴着缝的那一圈。上/左提亮、下/右压暗 —— 砖因此读得出厚度
    for y in range(n):
        for x in range(n):
            if p[(x, y)] != base:
                continue
            up = y > 0 and p[(x, y - 1)] == joint
            lf = x > 0 and p[(x - 1, y)] == joint
            dn = y < n - 1 and p[(x, y + 1)] == joint
            rt = x < n - 1 and p[(x + 1, y)] == joint
            if up or lf:
                p[(x, y)] = WALL_HI + (255,)
            elif dn or rt:
                p[(x, y)] = WALL_SHADE + (255,)

    # 残缺：缺角 / 裂纹 / 锈斑 / 麻点。数量写死，只换位置。
    rng = random.Random(seed)
    free = {(x, y) for y in range(n) for x in range(n) if p[(x, y)] == base}
    order = sorted(free)
    rng.shuffle(order)

    def stamp(cells_of, color: tuple, what: str) -> None:
        """从打乱后的候选点里找一个整块都空着的位置落笔。"""
        while order:
            x, y = order.pop()
            if (x, y) not in free:
                continue
            cells = cells_of(x, y)
            if cells is None or any(c not in free for c in cells):
                continue
            for c in cells:
                free.discard(c)
                p[c] = color
            return
        raise RuntimeError(f"墙的{what}放不下 —— 砖身像素不够，或网格参数冲突")

    def rect(w: int, h: int):
        return lambda x, y: [(x + dx, y + dy) for dy in range(h) for dx in range(w)]

    def crack(x: int, y: int):
        return [(x + i, y + i) for i in range(WALL_CRACK_LEN)]

    for _ in range(WALL_CHIPS):
        stamp(rect(2, 2), joint, "缺角")
    for _ in range(WALL_CRACKS):
        stamp(crack, joint, "裂纹")
    for _ in range(WALL_STAINS):
        stamp(rect(3, 2), WALL_STAIN + (255,), "锈斑")
    for _ in range(WALL_BEADS):
        stamp(rect(1, 1), WALL_HI + (255,), "麻点")
    return im




def _wall_cap(body: Image.Image) -> Image.Image:
    """
    墙顶：在本格上沿压一道**石质压顶**（手绘，不再是 0x72 的 wall_top_mid）。

    为什么不再超采样第三方压顶：wall_top_mid 在 16 网格上只有最下面 4 行有内容，
    放大到 64 网格后是一条糊掉的色带 —— 压在一张**手绘**的墙身上会明显比墙身
    粗，正是这一轮要消灭的那种不一致。所以在出图网格上直接画：
    顶面受光 → 立面 → 下沿 → 投影，让压顶「浮」在墙身上。

    ⚠️ 投影那几行必须吃掉第一层砌层的横缝，否则压顶底下会留下 1px 孤零零的缝。
    """
    n = body.width
    out = body.copy()
    p = out.load()
    joint = WALL_JOINT + (255,)
    hi_r, face_r, edge_r, shadow_r = WALL_CAP_ROWS
    face_end = hi_r + face_r
    edge_end = face_end + edge_r
    shadow_end = edge_end + shadow_r
    for y in range(shadow_end):
        if y < hi_r:
            c = WALL_CAP_HI
        elif y < face_end:
            c = WALL_CAP_FACE
        elif y < edge_end:
            c = WALL_CAP_EDGE
        else:
            c = WALL_CAP_SHADOW
        for x in range(n):
            p[(x, y)] = c + (255,)
    # 压顶的竖缝：与偶数层同相位（0 / 32）—— 横向平铺时块宽与墙身一致（都是 30）。
    # 投影那几行是阴影不是石头，所以不断开。
    for y in range(edge_end):
        for k in range(n // WALL_BOND + 1):
            for dx in range(-WALL_JW // 2, WALL_JW - WALL_JW // 2):
                x = k * WALL_BOND + dx
                if 0 <= x < n:
                    p[(x, y)] = joint
    return out




def _stairs_down() -> Image.Image:
    """
    下楼梯：**侧视下沉阶梯**（与上楼梯同一族画法，方向相反）。

    上一版是「俯视竖井」—— 8 个同心方环向内变暗。用户反馈那圈方形读不出
    楼梯，反而像个坑／漏斗，而且和侧视的上楼梯**不像一套**。所以这里改成
    同一个画法的反向版本：四级台阶，踏面自左上向右下一级级沉下去，越深越暗，
    最后一档近乎全黑（看不见底的深处）。

    与上楼梯的区分点因此是**两个方向同时相反**：
      上 —— 从左下升到右上，越往上越亮，顶端有出口亮光；
      下 —— 从左上沉到右下，越往下越暗，底端是深渊。
    只改其中一个（比如把一张图调暗）不够，两个一起才是「读得出方向」。
    """
    n = RASTER_TILE
    steps = 4
    sw = n // steps                 # 16
    tread = SS                      # 踏面厚度：16 网格 1px × SS
    im = Image.new("RGBA", (n, n), STAIR_SHAFT + (255,))
    for i in range(steps):
        x = i * sw
        ty = 2 * SS + i * 3 * SS    # 8 / 20 / 32 / 44：逐级下沉
        # 越往下越暗 —— 踏面用 TREAD 的倒序，井壁用 WELL 的正序
        _put(im, x, ty, sw, tread, STAIR_TREAD[steps - 1 - i] + (255,))
        _put(im, x, ty + tread, sw, n - (ty + tread), STAIR_WELL[i] + (255,))
    # 井底：最深处再压一层近黑，让「深不见底」有一个落点
    _put(im, n - sw, n - 2 * SS, sw, 2 * SS, STAIR_WELL[-1] + (255,))
    return im




def _stairs_up() -> Image.Image:
    """
    上楼梯：侧视阶梯。

    四级台阶，每级是一根**实心立柱**（1px 踏面 + 直到地面的立面），
    高度自左向右递增 —— 合起来就是一条上升的梯段剖面。背后的井道填暗色，
    梯顶右上角留一小块出口亮光。因为高度是单调递增的，"往上是哪边"这件事
    在轮廓上就能读出来，不依赖颜色。

    坐标全部写在 RASTER_TILE 网格上（16 网格的 ×SS）：手绘素材不走超采样，
    高网格上直接画 = 真多出来的细节；超采样只会把既有信息摊细。
    """
    n = RASTER_TILE
    steps = 4
    sw = n // steps
    tread = SS
    im = Image.new("RGBA", (n, n), STAIR_SHAFT + (255,))
    _put(im, 0, n - SS, n, SS, STAIR_BASE + (255,))   # 落地线，把梯段"放"在地上
    for i in range(steps):
        x = i * sw
        ty = n - 3 * SS - i * 3 * SS            # 52 / 40 / 28 / 16：逐级升高
        # 踏面整条即高光，不再单独给左端压一格更亮的像素 —— 那样会在横剖面上
        # 造成 1px 的局部回退，把「自左向右单调变亮」这条结构特征弄脏。
        _put(im, x, ty, sw, tread, STAIR_TREAD[i] + (255,))
        _put(im, x, ty + tread, sw, n - (ty + tread) - SS, STAIR_RISER[i] + (255,))
    # 梯顶：最高一级踏面（y=16）正上方就是出口。先铺一层"边框色"再压亮光，
    # 让出口是"一段亮着的梯口"而不是"一块贴在墙上的白斑"。
    _put(im, 3 * sw, 0, sw, 4 * SS, STAIR_EXIT_RIM + (255,))
    _put(im, 3 * sw, 0, sw, 2 * SS, STAIR_EXIT + (255,))
    return im




# ─────────────────────────────────────────────────────────────────────
# 五、地形映射
# ─────────────────────────────────────────────────────────────────────
# 键 = data/tiles.json 里的地形编码（0..11）。
# 「假墙」必须和真墙长得一模一样 —— 这就是它的全部玩法意义，所以共用同一张图。

TERRAIN = {
    # 地面必须**又暖又亮**。这条约束的来历看数据：
    # 0x72 的 floor_1 与 wall_mid 用的是**完全相同的三个颜色**
    # (72,59,58) / (119,92,85) / (34,34,34)，只是排列不同（地面＝平坦底＋缝，
    # 墙＝砖纹）。也就是说源素材本身**没打算让两者靠颜色区分**。
    # 只给地面提亮 ×1.5 的结果是实测平均亮度 0.364 vs 墙 0.232，比值 1.57 ——
    # 亮度差不够、色相还完全一样，整屏糊成一坨褐色，迷宫读不出来。
    # 而且墙的砖缝 (34,34,34) 正好等于史莱姆身体的深色，怪物会「粘」在墙上。
    #
    # 曾经的解法是 ramp_norm 重染第三方位图（比值提到 2.77）。现在改成**手绘**：
    # 地板占屏面积最大，而第三方位图只有 16×16 的信息，超采样摊细它并不会
    # 多出细节（只会把轮廓磨圆）。要真的更精细，只能在高网格上重画 ——
    # 见 `_floor()`。配色仍压在暖砂石族里，明度比断言见 verify_terrain 第 ④ 条。
    0: ("floor", _floor, "手绘 · 错缝石板（直接画在出图网格上，非第三方位图重染）"),
    # 墙：**手绘**错缝砌法。改动理由与地板完全相同（第三方位图超采样不产生新细节），
    # 唯一差别是墙还多挂一条约束 —— 假墙必须和它逐像素一致，所以两者共用同一个
    # 函数而不是「同一张源图」。
    1: ("wall",       _wall,                                          "手绘 · 错缝砌法（直接画在出图网格上）"),
    2: ("prisonDoor", lambda: o72("doors_leaf_closed"),                "0x72/doors_leaf_closed（原色木门，区别于三色钥匙门）"),
    # 上/下楼梯：**同一族画法的两个方向**（侧视梯段），不是同一张图翻转。
    # 理由见上面「四之三」那一节：floor_ladder 近乎上下对称，翻转后肉眼分不出
    # 等于没有区分；而同族反向 + 明暗反向，玩家一眼就能读出「往哪边走」。
    3: ("stairsDown", _stairs_down, "手绘 · 侧视下沉阶梯（越往下越暗，底端近黑）"),
    4: ("stairsUp",   _stairs_up,   "手绘 · 侧视上升阶梯（越往上越亮，顶端出口光）"),

    # 三色门用「渐变」而不是「转色相」。原因看数据：门原本是暖木色（色相约 12°），
    # 想转到红（~355°）只能移 -17°，结果还是褐色，一眼认不出是红门；
    # 而 +250° 会直接跑到蓝紫（实测 250.8°）。渐变能把门压进明确而饱和的色族，
    # 代价是丢掉一点木纹层次 —— 对「颜色即玩法」的钥匙门来说，这个交换值得。
    5: ("lava",       lambda: ramp(o72("wall_goo"), (46, 8, 4), (255, 176, 36)),
       "0x72/wall_goo @ 岩浆渐变（原素材是绿色黏液）"),
    6: ("void",       lambda: ramp(o72("wall_goo_base"), (24, 16, 52), (150, 110, 220)), "0x72/wall_goo_base @ 星际渐变"),
    7: ("doorYellow", lambda: ramp(o72("doors_leaf_closed"), (54, 36, 6), (252, 214, 96)), "0x72/doors_leaf_closed @ 黄渐变"),
    8: ("doorBlue",   lambda: ramp(o72("doors_leaf_closed"), (14, 24, 58), (150, 194, 246)), "0x72/doors_leaf_closed @ 蓝渐变"),
    9: ("doorRed",    lambda: ramp(o72("doors_leaf_closed"), (58, 10, 16), (250, 138, 138)), "0x72/doors_leaf_closed @ 红渐变"),
    10: ("autoDoor",  lambda: o72("doors_leaf_open"),                  "0x72/doors_leaf_open"),
    11: ("fakeWall",  _wall,                                          "手绘 · 错缝砌法（与真墙同图，这是玩法本身）"),
}



# 墙的「顶边」变体：上方没有墙时用这张，地牢立刻有了立体感。
# 渲染层按邻域挑，挑不到就退回普通墙。
#
# ⚠️ 这里必须**预合成**，不能直接把 wall_top_mid 摆进去：
# wall_top_mid 只有最下面 4 行有内容（石头压顶），上面 12 行是全透明的 ——
# 它是给「贴到墙体上面那一格的下沿」这种用法画的。原样贴在本格会让整格
# 四分之三透明，露出底色（白色面板），看起来像墙缺了一块。
# 翻转过来让压顶落在本格的**上沿**，再和墙身合成为一张不透明图，本格就完整了。
# 压顶同样改成手绘（见 `_wall_cap`）：第三方 wall_top_mid 只有 4 行内容，
# 超采样后压在手绘墙身上会明显比墙身粗 —— 那是「只换了一半素材」的典型症状。
def _wall_top_baked(body: Image.Image | None = None) -> Image.Image:
    body = _wall() if body is None else body
    return _wall_cap(body)




TERRAIN_TOP = {
    1: ("wallTop", _wall_top_baked, "手绘 · 墙身 + 石质压顶预合成（压顶落在本格上沿）"),
}



# ─────────────────────────────────────────────────────────────────────
# 五之二、地形变体 —— 打散「同一块砖反复平铺」的视觉锁定
# ─────────────────────────────────────────────────────────────────────
# 为什么必须做：
#   11×11 的棋盘上地面要铺 121 次、墙也动辄几十块。只有一张瓦片时，地砖的倒角
#   缺口与墙的砖缝会连成一张**规则网格**，眼睛一眼读出的不是「一片地牢」而是
#   「同一张图在重复」。这是放大到真机尺寸后最刺眼的问题。
#
# 唯一的硬约束：**色调必须几乎不变**。
#   变体一旦平均色有差，棋盘就会变成深浅不一的补丁 —— 比原来的重复感更难看，
#   而且这种「补丁感」在缩略图上不明显、在真机上很明显。所以变体一律只做
#   **同一调色板内的像素重排**：用哪几个颜色、各用多少个，与底图完全相同。
#   这不是靠自觉，verify_terrain 里有直方图断言。
#
# 两种地形同一套做法，理由也相同：
#   地面：缝与倒角是石板能连成一片的关键，**不动**；只换碎石 / 磨痕的位置。
#   墙  ：砌层与错缝是砌法，**不动**（缝一变，平铺就连不上）；只换残缺的位置。
#
# 曾经给墙用过另一套做法 —— 在超采样后的成品图上把竖缝**整段平移**。那条路
# 是「第三方位图没有配方、只能挪像素」逼出来的；墙改成手绘之后就有了配方，
# 于是和地面一样退回「同一配方、换个种子」，配色多重集**天然守恒**。
#
# 门 / 楼梯 / 岩浆 / 虚空都是一格一格出现的，没有被平铺锁定，做了只是白占体积。

VARIANT_SEED = 20260921  # 固定种子：变体必须可重跑，不能每次构建都换一批


FLOOR_VARIANTS = 6       # 含底图本身（键 `0`；其余是 `0:1` … `0:5`）


WALL_VARIANTS = 5        # 含底图本身（键 `1`；其余是 `1:1` … `1:4`）



SPECKLE = SS * SS        # 面积变 4 倍，杂质数量同步 ×4 才维持同样的疏密




def _floor_palette(base: Image.Image) -> tuple[tuple, tuple, tuple]:
    """从底图**推出**三档色，而不是写死常量。
    这样将来调地面配色（TERRAIN[0] 的 ramp_norm 参数）不需要同步改变体生成器。"""
    colors = list(_hist(base))
    fill = base.getpixel((base.width // 2, base.height // 2))
    rest = sorted((c for c in colors if c != fill), key=_lum)
    if len(rest) < 2:
        raise RuntimeError("地面底图不足三色，无法推出倒角配色")
    return fill, rest[0], rest[-1]




def _floor_variants() -> list[Image.Image]:
    """
    地板变体：缝与倒角逐像素一致，只有碎石 / 磨痕换一批位置。

    底图是**手绘**的（不再是第三方位图），所以变体不必「从成品图上挪像素」——
    直接同一配方换个种子重画更干净：**颜色多重集天然守恒**，drift 断言因此量的
    是「杂质挪了多少」，而不是「两种画法差多少」。
    缝一旦跟着变，平铺就会连不上 —— 所以 `_floor()` 内部只有杂质那一步吃 seed。
    """
    return [_floor(FLOOR_SEED + vi * 977) for vi in range(FLOOR_VARIANTS)]




def _wall_variants() -> list[Image.Image]:
    """
    墙变体：砌层与错缝逐像素一致，只有残缺（缺角 / 裂纹 / 锈斑 / 麻点）换一批位置。

    和地面同一个做法：`_wall()` 内部只有残缺那一步吃 seed。缝一旦跟着变，
    平铺就会连不上（相邻两张瓦片的缝对不齐，整片墙会出现错位的长砖）。
    """
    return [_wall(WALL_SEED + vi * 977) for vi in range(WALL_VARIANTS)]




def _variant_key(base_key: str, vi: int) -> str:
    """变体键：索引 0 就是底图本身，不另存一份，也不改名。"""
    return base_key if vi == 0 else f"{base_key}:{vi}"




def verify_terrain(cells: dict) -> list[str]:
    """
    对地形做色彩断言。

    这些断言是有代价的教训：一开始红门用 hue_shift(+250°) 做，看着「转了色」就
    通过了肉眼检查，实际上色相落在 250°（蓝紫）—— 门是紫的。而岩浆被转到 201°
    （青色）。肉眼在缩略图上很难发现，用色相区间一键就抓出来了。
    """
    problems: list[str] = []

    EXPECT = {
        # 键: (名称, 色相下界, 色相上界, 明度下界)
        # 地面放宽到 48°：暖砂石本色就落在 30~42°，这里卡的是「必须是暖色」，
        # 不是「必须精确等于某个橙色」—— 过窄的区间只会变成维护负担。
        "0": ("地面", 0, 48, 0.55),          # ramp_norm 后应远亮于墙（墙约 0.23）
        "5": ("岩浆", 8, 48, 0.30),          # 橙红
        "7": ("黄门", 32, 62, 0.35),
        "8": ("蓝门", 190, 250, 0.35),
        "9": ("红门", 335, 360, 0.35),       # 红跨 0°，循环里单独补判 0–22°
    }

    for key, (name, lo, hi, vmin) in EXPECT.items():
        cell = cells.get(key)
        if cell is None:
            problems.append(f"地形 {key}（{name}）缺失")
            continue
        got = mean_hsv(cell)
        if got is None:
            problems.append(f"地形 {key}（{name}）没有任何彩色像素")
            continue
        h, s, v = got
        ok_h = lo <= h <= hi
        if key == "9":  # 红色跨 360°
            ok_h = (335 <= h <= 360) or (0 <= h <= 22)
        if not ok_h:
            problems.append(f"地形 {key}（{name}）色相 {h:.1f}° 不在 [{lo}, {hi}] —— 颜色不对")
        if v < vmin:
            problems.append(f"地形 {key}（{name}）明度 {v:.2f} < {vmin} —— 偏暗")

    # 假墙必须与真墙逐像素一致。这不是审美问题：假墙一旦看得出来，玩法就废了。
    w, fw = cells.get("1"), cells.get("11")
    if w is not None and fw is not None:
        if list(w.get_flattened_data()) != list(fw.get_flattened_data()):
            problems.append("假墙(11) 与真墙(1) 图像不一致 —— 玩家会一眼看穿，玩法失效")
    else:
        problems.append("真墙或假墙缺失，无法校验一致性")

    # ── 下面两条是「静默变丑」类的 bug，肉眼在缩略图上很难发现，只能靠断言 ──

    # ① 墙族必须完全不透明。
    # 踩过的坑：wall_top_mid 原样用的时候整格 75% 是透明的（它是给「贴到上面
    # 那一格下沿」用的），贴上去直接露出白色面板，像墙缺了一块。缩略图上看着
    # 「有花纹」就通过了肉眼检查，实际是破的。
    # 只对墙族断言「必须全不透明」—— 门是有意留透明的（开门后本来就该看穿，
    # 三色门四角也是圆角），对它们要求全不透明反而会把正确的东西判错。
    for key in sorted(cells):
        if key != "1" and key != "11" and not key.startswith("1:"):
            continue
        im = cells.get(key)
        if im is None:
            problems.append(f"墙族瓦片 {key} 缺失，无法校验不透明性")
            continue
        clear = sum(1 for a in im.getchannel("A").get_flattened_data() if a == 0)
        if clear:
            problems.append(
                f"墙族瓦片 {key} 有 {clear} 个透明像素 —— 墙是实心的，透出来会露出"
                f"底色（多半是忘了把 wall_top_mid 和墙身预合成，或忘了翻转）"
            )

    # ② 任何地形瓦片都不该「近乎全空」——那说明源图找错了。
    # 阈值定在 90%：自动门是 50% 透明（门洞就该是空的），留足余量。
    for key, im in sorted(cells.items()):
        frac = sum(1 for a in im.getchannel("A").get_flattened_data() if a == 0) / (im.width * im.height)
        if frac >= 0.9:
            problems.append(f"地形 {key} 有 {frac:.0%} 的像素是全透明的 —— 这张图几乎是空的，多半取错了源")

    # ③ 上楼梯与下楼梯必须**结构不同**，不能只是同一张图的翻转。
    #
    # 这一条的前身只判「两张是否逐像素相同」，于是「下=floor_ladder、
    # 上=floor_ladder 垂直翻转」这种写法轻松通过 —— 而 floor_ladder 近乎上下
    # 对称，翻转后肉眼读不出区别，等于没区分（这正是用户报的第 ④ 条）。
    # 现在判四件事：完全相同的图、互为垂直翻转、**以及两者的形体走向**：
    #   下楼梯（侧视下沉）→ 横剖面自左向右**变暗**（越往下越深）；
    #   上楼梯（侧视上升）→ 横剖面自左向右**变亮**（越往上越接近出口）。
    # 只改明暗不改形体（比如简单地把一张图调亮调暗）会让第 4 条挂掉；
    # 反过来，只改走向不改明暗也一样 —— 两条一起才是「同一族画法的两个方向」。
    up, down = cells.get("4"), cells.get("3")
    if up is None or down is None:
        problems.append("上/下楼梯瓦片缺失，无法校验可区分性")
    else:
        if list(up.get_flattened_data()) == list(down.get_flattened_data()):
            problems.append("上楼梯(4) 与下楼梯(3) 图像完全相同 —— 玩家分不清方向")
        flipped = down.transpose(Image.FLIP_TOP_BOTTOM)
        if list(up.get_flattened_data()) == list(flipped.get_flattened_data()):
            problems.append(
                "上楼梯(4) 恰好等于下楼梯(3) 的垂直翻转 —— 翻转在 32px 上等价于"
                "同一张图，玩家读不出方向。两者必须是不同**形体**（下＝同心方井、"
                "上＝上升梯段），而不是同一形体的明暗颠倒"
            )

        dc, uc = _col_lums(down), _col_lums(up)
        n = len(dc)
        if n >= 8:
            # 下沉梯段：自左向右必须单调变暗，且落差够大 —— 越往右下越深
            fall = dc[0] - dc[-1]
            bumps = [(dc[i + 1] - dc[i]) for i in range(n - 1)]
            worst_down = max(bumps)
            if fall < 0.15 or worst_down > 0.02:
                problems.append(
                    f"下楼梯(3) 的横剖面不是自左向右单调变暗（左端 {dc[0]:.3f} → "
                    f"右端 {dc[-1]:.3f}，总落差 {fall:.3f}，最大回弹 {worst_down:.3f}）—— "
                    f"下沉梯段靠「越往右下越深」来表明方向，回弹或落差不足就读不出来"
                )
            # 梯段：自左向右必须单调变亮，且总落差够大
            rise = uc[-1] - uc[0]
            drops = [(uc[i] - uc[i + 1]) for i in range(n - 1)]
            worst = max(drops)
            if rise < 0.15 or worst > 0.02:
                problems.append(
                    f"上楼梯(4) 的横剖面不是自左向右单调变亮（左端 {uc[0]:.3f} → "
                    f"右端 {uc[-1]:.3f}，总落差 {rise:.3f}，最大回退 {worst:.3f}）—— "
                    f"上升梯段靠「越往右上越亮」来表明方向，回退或落差不足就读不出来"
                )

    # ④ 地面与墙必须有足够的明度差。
    # 踩过的坑（这条是本次才发现的）：floor_1 与 wall_mid 在 0x72 里共用同一套
    # 三色 (72,59,58)/(119,92,85)/(34,34,34)，源素材根本没打算靠颜色区分它们。
    # 只给地面提亮 ×1.5 时，实测平均亮度 0.364 vs 墙 0.232 —— 比值 1.57，
    # 亮度差不够、色相又完全一样，整屏糊成一片褐色，迷宫的地面/墙读不出来。
    # 这种事在缩略图上非常容易「看着还行」地蒙混过关，只有数值能抓住。
    # （顺带：墙砖缝 (34,34,34) 也等于史莱姆身体的深色，怪物会「粘」在墙上。）
    # 改用 ramp_norm 重染后实测 0.643 vs 0.232，比值 2.77。
    fl, wl = cells.get("0"), cells.get("1")
    if fl is not None and wl is not None:
        lf, lw = mean_lum(fl), mean_lum(wl)
        if lw <= 0 or lf / lw < 2.0:
            problems.append(
                f"地面/墙平均亮度比只有 {lf / lw:.2f}（地面 {lf:.3f} vs 墙 {lw:.3f}）"
                f" —— 低于 2.0 迷宫会读不出来。0x72 的 floor_1 与 wall_mid 同色板，"
                f"地面必须显式重染（TERRAIN[0] 应使用 ramp_norm 而非单纯提亮）"
            )
    else:
        problems.append("地面或墙缺失，无法校验对比度")

    # ⑤ 变体必须与底图**色调一致**。
    # 变体的全部意义是「打散平铺锁定」，不是「换一种地砖」。一旦某个变体的平均色
    # 偏了一点，11×11 的棋盘就会变成深浅不一的补丁 —— 比原来的重复感更难看，
    # 而且缩略图上根本看不出来，只有真机满屏铺开后才发现。
    #
    # 判据分三层，一层比一层严，各抓一种失败：
    #   ① 调色板必须一模一样：变体只允许在底图已有的颜色里挪像素。
    #      抓的是「有人顺手给变体加了个高光/阴影色」。
    #   ② 改动像素量有上限：变体应当**基本是**像素重排，只允许少量新增内容
    #      （地面撒几粒石子、墙补一条短竖缝）。
    #      抓的是「有人把变体当成第二套地砖来画」。
    #   ③ 逐通道平均色差 ≤ 1/255。抓的是满屏铺开后的补丁感 —— 这条才是真正
    #      对应「难看」的那一条，①② 是它的两道护栏。
    # 墙顶(1:top) 的上限放宽：它是把压顶 alpha 合成到换过砖身的底上，
    # 而压顶有半透明像素，合成结果天然会比纯重排多动一些像素。
    # 上限按 SS² 放大：瓦片像素数变 4 倍，同样「相对幅度」的重排/杂质绝对量
    # 也是 4 倍 —— 不跟着放，这条断言就会只因为换了网格而红。
    for family, drift_cap in (("0", 8 * SPECKLE), ("1", 8 * SPECKLE), ("1:top", 24 * SPECKLE)):
        keys = [k for k in cells if k == family or k.startswith(family + ":")]
        if family == "1":  # `1:top` 自成一族，别混进来
            keys = [k for k in keys if not k.startswith("1:top")]
        keys.sort()
        if len(keys) < 2:
            problems.append(f"地形族 {family} 只有 {len(keys)} 张瓦片，变体没有生成")
            continue
        base_hist = _hist(cells[keys[0]])
        base_mean = _mean_rgb(cells[keys[0]])
        for k in keys[1:]:
            im = cells[k]
            h = _hist(im)
            extra = sorted(set(h) - set(base_hist))
            if extra:
                problems.append(
                    f"地形变体 {k} 引入了底图 {keys[0]} 没有的颜色 {extra} —— "
                    f"变体只能在底图已有的调色板里挪像素"
                )
            drift = sum(abs(h.get(c, 0) - base_hist.get(c, 0)) for c in set(h) | set(base_hist))
            if drift > drift_cap:
                problems.append(
                    f"地形变体 {k} 有 {drift} 个像素偏离底图配色（上限 {drift_cap}）—— "
                    f"变体应当基本是像素重排，而不是另画一套地砖"
                )
            m = _mean_rgb(im)
            if max(abs(a - b) for a, b in zip(m, base_mean)) > 1.0:
                problems.append(
                    f"地形变体 {k} 平均色 {tuple(round(v, 2) for v in m)} 偏离底图 {keys[0]} "
                    f"{tuple(round(v, 2) for v in base_mean)} 超过 1/255 —— "
                    f"满屏平铺后会变成深浅不一的补丁"
                )

    return problems
