"""
BOSS 素材 —— **外部图源**那一半（2026-09-25 起是默认画法）。

## 这个模块为什么存在

`data/constants.json` 的 `boss.artSource` 有两个合法取值，各自对应一套产出：

| 取值 | 产出 | 代码位置 |
|---|---|---|
| `"imported"`（默认） | 本模块：把 `assets/raw/boss/*.png` 脚本化处理成 96 网格帧 | 这里 |
| `"drawn"` | `skeleton.py` / `knight.py` / … 八个手绘像素画模块 | `common.py` 那一侧 |

两套**都活着、都要过各自的断言**，只有被选中的那套进图集（见 `common.verify_boss_source_switch`）。

## 为什么「读外部图」不违反本项目的素材纪律

本项目的铁律是「**素材由脚本生成，禁止手工修图**」—— 它要防的是
「有人用画图软件改一张 png，然后没人知道那张图是怎么来的」。

这一层守的是同一条规矩，只是把「画的来源」从代码换成文件：

  · 源图放在 `assets/raw/boss/`，与 `raw/0x72`、`raw/kenney` 同级，**只读**；
  · 从源图到图集的**每一步都在本模块里**（去背 → 去白边 → 裁剪 → 缩放 → 底对齐）；
  · 源图的 **SHA-256 记进 `MANIFEST.json`**，于是「图集是不是由当前这批源图生成的」
    变成一条可断言的等式，而不是靠人记得重跑（见 checks/a22）。

**手工修图仍然禁止**：要改观感就改这里的常量（阈值 / 缩放策略 / 描边），或者换源图。

## 处理链（每一步都对应一个可观测的失败）

```
① 读源图          失败：源图缺失 / 打不开          → 报错里给出该放哪个路径
② 从四边泛洪去背   失败：去背没生效 → 帧是白底方块   → 判据「白底残留占比」抓
②′ 清被包住的背景  失败：触手卷曲 / 袍缝里留白斑     → 判据「剪影外缘光圈」抓不到，
                                                   这条靠 ② 的余量 + 人眼核对图
③ 边缘去白边       失败：留下 1px 浅色光圈          → 判据「剪影外缘光圈占比」抓
④ 裁剪到内容       失败：整幅 192 撑满 → 内容缩得极小 → 判据「非透明占比」抓
⑤ 等比缩放进 96    失败：拉伸变形                  → 判据「长宽比守恒」抓
⑥ 底对齐居中       失败：脚离地 / 浮空             → 判据「底行必须有像素」抓（共用）
```

## 两个「不做」的取舍（都写在这里，免得下一个人重新试一遍）

**不做硬边化（限色 / 描边像素化）。** 源图是平滑插画，落屏 96px 时抗锯齿正是
它比同一网格的像素画耐看的原因；限色会把它打回「劣质像素画」，两头不讨好。
描边**照样加**（走 `common.finish`）—— 描边是这一套素材的公共语言，
杂兵、道具、地形全有，少了它这一族会在棋盘上"飘"。

**不做逐图微调。** 八张图一律走同一套参数。任何「这张稍微挪一点」都是手工修图的
变体，会让「图集是怎么来的」重新变得不可复现。
"""

from __future__ import annotations

import hashlib
from collections import Counter, deque

from ..config import ROOT
from ..pil import Image
from .common import BOS_H, BOS_W, finish

# ════════════════════════════════════════════════════════════════════
# 一、源图登记表
# ════════════════════════════════════════════════════════════════════

SOURCE_DIR = ROOT / "assets" / "raw" / "boss"

# `boss id` → (仓库内文件名, 收到图时的原始文件名)
#
# 为什么要留原始中文名：这是**溯源信息**。仓库里统一用 ASCII 文件名（跨系统安全、
# 与 boss id 一一对应、不用在代码里写中文路径），但「哪张图是哪个角色」这件事
# 必须有个地方记着，否则下一次换图就要靠人回忆。
SOURCES: dict[str, tuple[str, str]] = {
    "skeletonCaptain": ("skeletonCaptain.png", "骷髅王.png"),
    "knightCaptain": ("knightCaptain.png", "骑士王.png"),
    "vampire": ("vampire.png", "吸血鬼.png"),
    "archmage": ("archmage.png", "大法师.png"),
    "kraken": ("kraken.png", "章鱼.png"),
    "dragon": ("dragon.png", "巨龙.png"),
    "demonKing": ("demonKing.png", "魔王.png"),
    "demonKingTrue": ("demonKingTrue.png", "魔王（二形态）.png"),
}

# ── 去背阈值 ────────────────────────────────────────────────────────
#
# 「背景」的定义：**三通道都 ≥ 本值**。源图是纯白底（实测 254~255）。
#
# 实测 236~250 之间的取值对内容包围盒**只差 1px**（都是抗锯齿那一圈），
# 也就是说在这个区间里「吃不吃进美术本体」不敏感 —— 取最小值 236 最保守。
#
# ⚠️ 不要为了「顺手把右下角水印也清掉」而往 225 以下调：水印亮度实测 222~251，
#    往下调确实能多清掉水印，但**抗锯齿圈也一起被吃掉**，白甲（骑士王）与
#    白骨（骷髅队长）的外缘会肉眼可见地缺一圈。水印留给 ③ 那一步处理。
BG_MIN = 236

# ── 去白边（③）的带宽 ──────────────────────────────────────────────
#
# 去背是**硬切**：切完的边界上还留着「原图里跟白底混过」的抗锯齿像素，它们的
# 颜色接近白（实测 235~252）。缩到 96 之后这会变成一圈浅色光圈 —— 在深色棋盘上
# 尤其明显。
#
# 做法：把「距透明区 ≤ BAND 圈」的不透明像素按**白底合成模型**反解出真实 alpha：
#     c = a·C + (1-a)·255      （c 是看到的颜色，C 是真彩，背景是白）
# 真彩至少有一个通道为 0 ⇒ m = min(r,g,b) = (1-a)·255 ⇒ a = 1 - m/255。
# 于是「接近白」的边界像素自动变成低 alpha，光圈消失；
# 而美术本体（m≈0，深色）解出 a≈255，**一个像素都不动**。
#
# 取 2 而不是 1：抗锯齿圈实测有 1~2 px 宽；取 2 顺带把细小的浅色碎屑
# （包括水印笔画的外缘）一并压掉。
FEATHER_BAND = 2

# 反解出的 alpha 低于此值就直接判为「本来就是背景」，置全透明。
# 8/255 ≈ 3% —— 低于这个的像素在深色棋盘上肉眼不可见，留着只会成为一圈杂色。
FEATHER_ALPHA_FLOOR = 8

# ── 被美术包住的那部分背景（③′）────────────────────────────────────
#
# ⚠️ **只做「从四边泛洪」是不够的** —— 实测踩到：章鱼触手卷曲处、法师法杖与袍子
# 之间、吸血鬼腋下，这些地方的背景被美术**围成一圈**，泛洪走不进去，于是留下来
# 变成一块块白斑。在深色棋盘上非常显眼。
#
# 难点在于**它和「美术本体就是白的」在颜色上完全一样**：实测白骨与背景白块都是
# 「min 通道 250~255、极差 5」—— 靠颜色统计**分不开**。
#
# 真正分得开的是**「有多像画布底色」**：底色是平的纯白，美术里的白是**画出来的**，
# 带描边与明暗，不会跟底色逐像素相等。实测全部 22 个 ≥8px 的近白块：
#
#     ≈底色(±1) 占比      判定
#     0%    (23px, 骑士王的剑刃)  美术白
#     33%   ( 9px, 骑士王)        美术白
#     ──────────────────────────── 阈值 50% 落在空档里
#     62% ~ 84%  (其余 20 块)     背景（触手卷曲 / 袍缝 / 腋下）
#
# 空档 33% → 62%，阈值取中间 50%，两侧各有约 17 个点的余量。
#
# 「宁可漏判成美术白，也不要误判成背景」：误判会在角色身上挖洞，漏判只是留一块
# 白斑。所以阈值**偏保守**，且下面还有一条判据（I5）盯着残留。
POCKET_WHITE_MIN = 245     # 算「近白」的下限（比 BG_MIN 高：这里只找**纯**白块）
POCKET_MIN_AREA = 8        # 小于这么多像素的块肉眼不可见，不动它
POCKET_BG_TOL = 1          # 「与底色相等」的逐分量容差
POCKET_BG_MATCH_MIN = 0.50 # 块内「≈底色」占比达到多少才判为背景

# ── 源图的期望尺寸 ──────────────────────────────────────────────────
#
# 只为「源图被换成了小图」这类事故留一条能读懂的红：源图比落屏网格还小时，
# 放大只会得到一坨糊的（放大不创造信息）。这一条是**下界**，不是「必须等于」。
SRC_MIN_SIDE = BOS_W


def source_path(bid: str):
    """某只 BOSS 的源图路径。不在登记表里 = 调用方传了未知 id，直接炸。"""
    try:
        fname, _ = SOURCES[bid]
    except KeyError:  # pragma: no cover - 名单与 boss_ids() 的一致性由断言管
        raise AssertionError(
            f"BOSS {bid} 没有登记源图 —— 在 imported.SOURCES 里加一行，"
            f"并把图放进 {SOURCE_DIR.relative_to(ROOT)}/（文件名 = boss id）"
        ) from None
    return SOURCE_DIR / fname


def source_sha256(bid: str) -> str:
    """源图的内容哈希。**用哈希而不是 mtime** —— mtime 会被 checkout / 复制 /
    打包抹掉，而那正是「图集是不是这批源图生成的」这条断言要防的事。"""
    return hashlib.sha256(source_path(bid).read_bytes()).hexdigest()


def source_original_name(bid: str) -> str:
    return SOURCES[bid][1]


# ════════════════════════════════════════════════════════════════════
# 二、处理链
# ════════════════════════════════════════════════════════════════════


def load_source(bid: str) -> Image.Image:
    """① 读源图。缺失时给一条**可操作**的错，而不是 FileNotFoundError。"""
    path = source_path(bid)
    if not path.exists():
        raise SystemExit(
            f"BOSS {bid} 的源图不存在：{path}\n"
            f"  放一张同名 png 进去即可（原始文件名「{source_original_name(bid)}」）。\n"
            f"  若想改回手绘画法：把 data/constants.json 的 boss.artSource 改成 \"drawn\"。"
        )
    im = Image.open(path).convert("RGBA")
    if min(im.size) < SRC_MIN_SIDE:
        raise SystemExit(
            f"BOSS {bid} 的源图只有 {im.size[0]}×{im.size[1]}，小于落屏网格 "
            f"{BOS_W}×{BOS_H} —— 放大不创造信息，只会得到一坨糊的。换一张大图。"
        )
    return im


def clear_background(im: Image.Image) -> tuple[Image.Image, int]:
    """
    ② 从**四边**泛洪去背（4 邻域）。

    为什么是泛洪而不是「全局把接近白的一律清掉」：这张图里有大片的**白色美术本体**
    （骷髅的白骨、骑士王的银甲、法师的白须）。全局色键会把它们一起打穿。
    泛洪只清「与画布边缘连通」的白色 —— 美术本体的白色被深色描边围着，走不进去。
    """
    im = im.copy()
    w, h = im.size
    px = im.load()
    seen = [[False] * w for _ in range(h)]
    q: deque[tuple[int, int]] = deque()

    for x in range(w):
        q.append((x, 0))
        q.append((x, h - 1))
    for y in range(h):
        q.append((0, y))
        q.append((w - 1, y))

    cleared = 0
    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y][x]:
            continue
        seen[y][x] = True
        r, g, b, a = px[x, y]
        if a == 0 or (r >= BG_MIN and g >= BG_MIN and b >= BG_MIN):
            if a:
                cleared += 1
            px[x, y] = (0, 0, 0, 0)
            q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return im, cleared


def backdrop_color(im: Image.Image) -> tuple[int, int, int]:
    """
    画布底色 = **四边一像素**里出现最多的那个颜色。

    从边框取而不是「全图出现最多的颜色」：后者会被美术里大面积的暗色抢走。

    ⚠️ **必须在「泛洪去背之前」调用。** 泛洪按定义会清掉**整个边框环**，
    之后再问四边是什么颜色就只剩透明像素了。踩过两次、都是静默或误导的形态：
      ① 只取 `[:3]` 不看 alpha ⇒ 底色被算成**黑色** ⇒「这个白块有多像底色」恒为 0
         ⇒ `clear_pockets` 一个像素都不清、**不报任何错**（白斑照旧留在帧里）；
      ② 加上 alpha 判断之后，四边全透明 ⇒ 直接炸掉。
    所以这个值由调用方在去背**之前**取好、当参数传下去（见 `clear_pockets`）。
    """
    w, h = im.size
    px = im.load()
    tally: Counter[tuple[int, int, int]] = Counter()
    for x in range(w):
        for p in (px[x, 0], px[x, h - 1]):
            if p[3]:
                tally[p[:3]] += 1
    for y in range(h):
        for p in (px[0, y], px[w - 1, y]):
            if p[3]:
                tally[p[:3]] += 1
    if not tally:
        raise SystemExit(
            "取不到画布底色：四边全是透明像素。这个值要在**泛洪去背之前**取 —— "
            "去背会清掉整个边框环，之后就没有边框可问了。"
        )
    return tally.most_common(1)[0][0]


def clear_pockets(im: Image.Image, bg: tuple[int, int, int]) -> tuple[Image.Image, int]:
    """
    ③′ 清掉**被美术包住**的那部分背景（泛洪到不了的地方）。

    判据见 `POCKET_BG_MATCH_MIN` 那段注释 —— 核心是「有多像画布底色」，
    而不是「有多白」。返回 (清理后的图, 清掉的像素数)。

    `bg` 由调用方传入，且必须在**泛洪去背之前**取（见 `backdrop_color` 的警告）。
    """
    im = im.copy()
    w, h = im.size
    px = im.load()

    seen = [[False] * w for _ in range(h)]
    cleared = 0
    for y0 in range(h):
        for x0 in range(w):
            if seen[y0][x0] or px[x0, y0][3] == 0:
                continue
            if min(px[x0, y0][:3]) < POCKET_WHITE_MIN:
                continue
            # 收集这块「近白」的连通块（只走不透明像素；透明区是上一步清出来的背景）
            q: deque[tuple[int, int]] = deque([(x0, y0)])
            seen[y0][x0] = True
            cells: list[tuple[int, int]] = []
            while q:
                x, y = q.popleft()
                cells.append((x, y))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if not (0 <= nx < w and 0 <= ny < h) or seen[ny][nx]:
                        continue
                    p = px[nx, ny]
                    if p[3] > 0 and min(p[:3]) >= POCKET_WHITE_MIN:
                        seen[ny][nx] = True
                        q.append((nx, ny))
            if len(cells) < POCKET_MIN_AREA:
                continue
            match = sum(
                1 for x, y in cells
                if max(abs(px[x, y][i] - bg[i]) for i in range(3)) <= POCKET_BG_TOL
            ) / len(cells)
            if match < POCKET_BG_MATCH_MIN:
                continue  # 是美术本体的白（例如骑士王的剑刃：实测 0%）
            for x, y in cells:
                px[x, y] = (0, 0, 0, 0)
                cleared += 1
    return im, cleared


def feather_edges(im: Image.Image) -> Image.Image:
    """
    ③ 把边界上的「白底混色」反解成低 alpha（见 `FEATHER_BAND` 的推导）。

    只动**距透明区 ≤ FEATHER_BAND 圈**的不透明像素 —— 这是它与「全局色键」的关键
    差别：美术本体的白色离透明区很远，永远不在这个集合里，所以打不穿。
    """
    im = im.copy()
    w, h = im.size
    px = im.load()

    band: set[tuple[int, int]] = set()
    for y in range(h):
        for x in range(w):
            if px[x, y][3] == 0:
                for dy in range(-FEATHER_BAND, FEATHER_BAND + 1):
                    for dx in range(-FEATHER_BAND, FEATHER_BAND + 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3] > 0:
                            band.add((nx, ny))

    for x, y in band:
        r, g, b, _ = px[x, y]
        m = min(r, g, b)
        na = 255 - m
        if na < FEATHER_ALPHA_FLOOR:
            px[x, y] = (0, 0, 0, 0)
            continue
        if na >= 255:
            continue
        # 反预乘：C = (c - (1-a)·255) / a，而 (1-a)·255 = m
        k = m
        px[x, y] = (
            max(0, min(255, round((r - k) * 255 / na))),
            max(0, min(255, round((g - k) * 255 / na))),
            max(0, min(255, round((b - k) * 255 / na))),
            na,
        )
    return im


def fit_into_grid(im: Image.Image) -> Image.Image:
    """
    ④⑤⑥ 裁剪到内容 → 等比缩放到 96 内 → 底对齐居中。

    **等比**而不是拉伸到满格：八个角色的体型本来就该不一样（魔龙横宽、法师瘦高），
    拉满会把「一条龙」和「一个人」都压成同一个方框。底对齐是因为精灵的落点由
    `common.finish` 之后由渲染层按「脚踩占位块下沿」摆 —— 帧内底留白会让它浮空
    （这正是 `verify_boss_art` 判据 2 守的东西）。
    """
    bbox = im.getchannel("A").getbbox()
    if not bbox:
        raise SystemExit("去背之后整幅都是透明的 —— 这张源图要么全白，要么还没画")
    im = im.crop(bbox)

    cw, ch = im.size
    scale = min(BOS_W / cw, BOS_H / ch)
    nw = max(1, round(cw * scale))
    nh = max(1, round(ch * scale))

    # ⚠️ 必须走预乘 alpha（`RGBa`）再缩。
    # Pillow 对 RGBA 是**逐通道**缩放：透明像素的 (0,0,0,0) 会以权重混进边缘的
    # 颜色里，于是整圈描边被拉黑。预乘之后透明区是「0 权重」，混不进去。
    # 实测（4×4 两像素往返）：不预乘得到 (128,0,0,128)，预乘得到 (233,21,0,60)
    # —— 后者才是真的把那两点红色平均下来。
    small = im.convert("RGBa").resize((nw, nh), Image.LANCZOS).convert("RGBA")

    out = Image.new("RGBA", (BOS_W, BOS_H), (0, 0, 0, 0))
    # `alpha_composite` 而不是 `paste(im, pos, im)` —— 后者是「用 mask 覆盖」，
    # 会把 alpha 平方（本项目已知缺陷，见 docs）。这里对源图 alpha 只过一次。
    out.alpha_composite(small, ((BOS_W - nw) // 2, BOS_H - nh))
    return out


def build(bid: str) -> Image.Image:
    """一只 BOSS 的 96 网格帧（**描边之前** —— 描边由 `common.finish` 统一加）。"""
    src = load_source(bid)
    bg = backdrop_color(src)          # ⚠️ 必须在去背之前取（去背会清掉整个边框环）
    im, _ = clear_background(src)
    im, _ = clear_pockets(im, bg)
    im = feather_edges(im)
    return fit_into_grid(im)


# ════════════════════════════════════════════════════════════════════
# 三、为外部图源设计的判据
# ════════════════════════════════════════════════════════════════════
#
# ## 为什么不沿用 `verify_boss_art` 里那三条
#
# 「8×8 中位独立颜色数 ≥ 3.5」「内部 4×4 均价 ≥ 2.40」这两条是为**像素画**设计的：
# 它们问的是「画师有没有在每一块里压出明暗阶」。平滑插画天然有几万种颜色，
# 这两条对它**恒真** —— 留着它们不是"多条保险"，而是两条**空转**的装饰。
#
# 「头部左右对称 ≤ 2%」更糟：它是给程序化镜像画的判据，插画里骑士王左手举剑、
# 右手持盾，量的就是**刻意的**不对称 —— 留着会把八只全部误杀。
#
# 换成四条**对外部图源才有意义**的判据（见 `verify_imported`）。
# 这是铁律 #13 那次教训的直接应用：换画法时必须同步问「判据现在保护的是什么」。

# 白底残留上限：帧内「不透明且接近白」的像素占比。
#
# 这条守的是**去背整个没跑**。三档实测（复现入口：
# `tools/measure-boss-import-thresholds.py`，别手抄这张表 —— 它会随源图变）：
#
#   id               (a)不去背   (b)去背+清口袋  (c)完整
#   skeletonCaptain    72.0%        9.4%        0.5%
#   knightCaptain      67.0%        6.6%        0.5%
#   vampire            71.5%        9.7%        0.0%
#   archmage           60.9%        9.2%        0.2%
#   kraken             47.0%        7.8%        0.0%
#   dragon             64.1%        8.3%        0.0%
#   demonKing          64.7%        8.9%        0.1%
#   demonKingTrue      58.0%        9.8%        0.1%
#
# 阈值 0.22：抓得住 (a)（最小 47.0%，余量 2.1 倍），**抓不住 (b)** ——
# (b) 由下面那条「外缘光圈」判据专门负责。两档差 5 倍左右，是两种不同的失效模式，
# 用两把尺子量，别指望一个阈值同时管两件事。
#
# 不贴着 (c) 的最大值（0.5%）取：白色美术本体是**合法**的，这条判据只该抓
# 「整幅白底」。宁可少一点区分力，也不要一条会让下次换图（比如换成一只白衣角色）
# 误红、然后被人当成噪声关掉的判据。
WHITE_RESIDUE_MAX = 0.22

# 「接近白」的判据阈值。与 BG_MIN 分开写：BG_MIN 管去背（要保守，宁少勿多），
# 这条只管**事后量残留**（要宽松，只抓整幅）。两者各自的取值理由不同。
WHITE_TEST_MIN = 225

# 剪影**外缘**那一圈里「接近白的不透明像素」占比的上限。
#
# 这条守的是**去了背但没去白边** —— 硬切完的边界上留着原图里跟白底混过的
# 抗锯齿像素，缩到 96 之后是一圈浅色光圈，在深色棋盘上很显眼。
#
# 实测（同一次测量，量「距透明区 ≤FEATHER_BAND 圈的不透明像素」里的近白占比）：
#   (b) 去背+清口袋、不去白边：17.1% ~ 20.4%（八只全部）
#   (c) 完整（走过 feather_edges）：0.0% ~ 0.7%
# **空档 0.7% ~ 17.1%**，阈值取 0.05 落在空档里，两侧余量 6.7 倍 / 3.4 倍。
#
# ⚠️ 这条**只能量描边之前**的帧：`finish()` 加的那圈 MON_INK 描边正好落在
# 最外缘，会把「贴着透明区的那一圈」变成深色 —— 于是本判据恒真。
# 所以 `verify_imported` 量的是 `build()` 的输出，不是 `boss_art_base()` 的输出。
RIM_WHITE_MAX = 0.05

# 非透明像素占 96² 的比例区间。
#   下界：防「去背把美术本体也吃掉了」或「缩小到几乎看不见」；
#   上界：防「去背整个没跑」（那时非透明占比接近 1.0）。
# 实测（同一次测量）处理完整后落在 **37.9% ~ 70.1%**：
#   下界 0.20 → 余量 1.9×；上界 0.92 → 余量 1.3×。
# 上界余量比下界小，是有意的：上界要抓的是「整幅白底还在」（≥0.92 才成立），
# 而「画得满」本身是合法的（乌贼 70.1%），不该被卡。
COVER_MIN = 0.20
COVER_MAX = 0.92

# 长宽比守恒的容差（像素）。缩放是**等比**的，所以「帧内容包围盒的长宽比」
# 必须与「源图内容包围盒的长宽比」相等（各自 round 掉不到 1px）。
# 这条守的是「有人把缩放改成拉伸到满格」——那会让龙和人一样宽，而任何
# 只看尺寸的判据都不会红。
ASPECT_TOL = 2


def frame_stats(im: Image.Image) -> dict:
    """量一帧：内容包围盒、非透明占比、白底残留占比。判据与文档共用同一把尺。"""
    w, h = im.size
    px = im.load()
    opaque = 0
    white = 0
    xs: list[int] = []
    ys: list[int] = []
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            opaque += 1
            xs.append(x)
            ys.append(y)
            if r >= WHITE_TEST_MIN and g >= WHITE_TEST_MIN and b >= WHITE_TEST_MIN:
                white += 1
    if not xs:
        return {"empty": True, "opaque": 0, "cover": 0.0, "whiteRatio": 1.0,
                "bw": 0, "bh": 0}
    return {
        "empty": False,
        "opaque": opaque,
        "cover": opaque / (w * h),
        "whiteRatio": white / opaque,
        "bw": max(xs) - min(xs) + 1,
        "bh": max(ys) - min(ys) + 1,
    }


def rim_stats(im: Image.Image) -> dict:
    """
    量「剪影外缘那一圈」：距透明区 ≤ `FEATHER_BAND` 圈的不透明像素里，有多少接近白。

    这就是**光圈**的量化口径：走过 `feather_edges` 之后，那些像素的 alpha 被反解
    成很低（甚至归零），于是它们要么不再是「不透明」、要么颜色被反预乘成真彩，
    两种情形都不会再计入「接近白」。
    """
    w, h = im.size
    px = im.load()
    rim = 0
    white = 0
    for y in range(h):
        for x in range(w):
            if px[x, y][3] == 0:
                continue
            near_clear = False
            for dy in range(-FEATHER_BAND, FEATHER_BAND + 1):
                for dx in range(-FEATHER_BAND, FEATHER_BAND + 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3] == 0:
                        near_clear = True
            if not near_clear:
                continue
            rim += 1
            p = px[x, y]
            if p[0] >= WHITE_TEST_MIN and p[1] >= WHITE_TEST_MIN and p[2] >= WHITE_TEST_MIN:
                white += 1
    return {"rim": rim, "white": white, "ratio": (white / rim) if rim else 0.0}


def verify_imported(bid: str, raw: Image.Image, finished: Image.Image) -> list[str]:
    """
    外部图源的判据。**每一条都有对应的探针实验**（见 docs/assets.md §13.15 的表）。

    ## 两个入参：为什么既收 `raw` 又收 `finished`

    · `raw`      = `build(bid)` 的输出（**描边之前**）—— 观感类判据（白底残留 /
                   内容占比 / 长宽比 / 底对齐 / 外缘光圈）必须量它。
                   ⚠️ 外缘光圈那条**只能**量 raw：`finish()` 那圈 MON_INK 描边
                   正好落在最外缘，量 finished 会把「贴着透明区的那一圈」变成深色，
                   判据于是**恒真**。
    · `finished` = `boss_art_base(bid)` 输出的那一帧 —— 真正进图集的东西。
                   用来做**闭环**：它必须逐像素等于 `finish(raw)`，否则上面那些
                   判据说的就是另一张图。

    ## 与 `verify_boss_art` 的分工

    那条管**两族共有**的东西（网格 / 画布 / 底行 / 单帧 / 剪影互异 / 与数据对账），
    这条只管**外部图源特有**的东西。重复的判据不写两遍 —— 写两遍就会有一次忘了
    跟着改。
    """
    problems: list[str] = []
    st = frame_stats(raw)

    # 判据 I6 —— 闭环：进图集的那一帧必须就是「raw 过一遍 finish」
    if list(finished.getdata()) != list(finish(raw).getdata()):
        problems.append(
            f"BOSS {bid} 进图集的帧与 build() 的输出不一致 —— "
            f"两部分判据量的是两张不同的图，先把这个接上再看别的"
        )

    if st["empty"]:
        return problems + [
            f"BOSS {bid} 的帧整个是透明的 —— 去背把美术本体也吃掉了（BG_MIN={BG_MIN} "
            f"太高？），或者源图本身就是一张白纸"
        ]

    # 判据 I1 —— 去背真的生效了（整幅白底）
    if st["whiteRatio"] > WHITE_RESIDUE_MAX:
        problems.append(
            f"BOSS {bid} 的帧里「不透明的接近白」像素占 {st['whiteRatio']:.1%}"
            f"（上限 {WHITE_RESIDUE_MAX:.0%}）—— 去背整个没跑。实测不去背是 "
            f"47%~72%，图集里会是一块带白底的方块，在深色棋盘上非常显眼"
        )

    # 判据 I2 —— 内容占比在区间内（下界防缩没了 / 上界防没去背）
    if not (COVER_MIN <= st["cover"] <= COVER_MAX):
        problems.append(
            f"BOSS {bid} 的非透明像素只占 {st['cover']:.1%}"
            f"（应在 {COVER_MIN:.0%}~{COVER_MAX:.0%} 之间）—— "
            + ("太小：去背吃掉了美术本体，或者内容被缩没了"
               if st["cover"] < COVER_MIN else
               "太大：去背整个没跑（这一帧还是整幅白底）")
        )

    # 判据 I5 —— 去了背但没去白边（剪影外缘的浅色光圈）
    rs = rim_stats(raw)
    if rs["rim"] == 0:
        problems.append(
            f"BOSS {bid} 量不到剪影外缘（外缘像素数为 0）—— 本判据会因此永远通过。"
            f"多半是帧整个不透明（去背没跑），先看 I1"
        )
    elif rs["ratio"] > RIM_WHITE_MAX:
        problems.append(
            f"BOSS {bid} 的剪影外缘有 {rs['ratio']:.1%} 的浅色像素（{rs['white']}/"
            f"{rs['rim']}，上限 {RIM_WHITE_MAX:.0%}）—— 走了去背但没走 "
            f"`feather_edges`。实测不去白边是 17%~21%，缩到 96 之后是一圈浅色光圈，"
            f"在深色棋盘上像贴纸边"
        )

    # 判据 I3 —— 等比缩放没被改成拉伸
    src = clear_background(load_source(bid))[0]
    bb = src.getchannel("A").getbbox()
    cw, ch = bb[2] - bb[0], bb[3] - bb[1]
    want = cw / ch
    got = st["bw"] / st["bh"]
    if abs(got - want) > ASPECT_TOL / min(st["bw"], st["bh"]):
        problems.append(
            f"BOSS {bid} 的帧内容长宽比是 {got:.3f}（{st['bw']}×{st['bh']}），"
            f"而源图内容的长宽比是 {want:.3f}（{cw}×{ch}）—— 缩放被改成拉伸了。"
            f"`fit_into_grid` 必须走 `min(BOS_W/cw, BOS_H/ch)` 这一个倍数，"
            f"否则龙和人会被压成同一个方框"
        )

    # 判据 I4 —— 帧底必须踩到占位块下沿。**量 raw**：描边会把空的底行填掉
    # （下面第 94 行有 alpha>120 的像素时，outline 正好写进第 95 行），
    # 于是量 finished 会恒真。
    bottom = raw.getchannel("A").crop((0, BOS_H - 1, BOS_W, BOS_H)).getbbox()
    if not bottom:
        problems.append(
            f"BOSS {bid} 的最后一行为空 —— 源图裁完之后没做底对齐，"
            f"精灵会浮在占位块上方。`fit_into_grid` 的 y 必须是 BOS_H - 缩放后高度"
        )
    return problems
