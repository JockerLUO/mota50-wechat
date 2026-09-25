"""
编排：按顺序把各段素材排进图集，写出 `MANIFEST.json`。

这是唯一有副作用的模块（写文件），其余模块都是纯函数：
给同样的输入必然画出同样的像素 —— 素材可重跑、可 diff 的前提就在这里。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from .pil import Image
from .config import ATLAS_DIR, BASE_TILE, CELL, DRAW_SCALE, PREVIEW_DIR, RASTER_TILE, ROOT, SS
from .pixel import ramp, recolor_hue
from .metrics import _art_rows
from .raster import Shelf, _mon_out, _out_scale, bottom_center, supersample, terrain_raster
from .sources import O72, O72_SHEET, ken, o72
from .data import BOSS_IDS, ITEM_SRC, MONSTERS
from .terrain import (
    FLOOR_VARIANTS,
    TERRAIN,
    TERRAIN_TOP,
    WALL_VARIANTS,
    _floor_variants,
    _variant_key,
    _wall_top_baked,
    _wall_variants,
    verify_terrain,
)
from .items import gen_icon, verify_items
from .hero import HERO_DIRS, build_actor_sheet, verify_hero_art
from .npc import NPC_ART, NPC_DIRS, npc_art_frames, verify_npc_art, verify_npc_scale
from .monsters import MON_SHAPES, PROC_MONSTERS, mon_art_frames, verify_mon_art, verify_monster_fit
from .bosses import (
    ART_SOURCE,
    ART_SOURCES,
    BOS_FRAME,
    BOS_W,
    BOSS_DRAW_SCALE,
    BOSS_SS,
    BOSS_TILES,
    boss_art_frames,
    boss_art_source_of,
    verify_boss_art,
    verify_boss_source_switch,
)



def _boss_src_note(mid: str) -> str:
    """
    MANIFEST 里 BOSS 帧的 `src` 文案 —— 必须说清**是哪一套画法**。

    图集是提交进仓库的二进制，光看图分不出「这张是手绘像素画还是外部插画处理来的」。
    而这两件事的维护方式完全不同（改前者动 python，改后者换 png + 重跑），
    所以来源必须写在能被读到的地方。
    """
    info = boss_art_source_of(mid)
    if info["kind"] == "imported":
        return (
            f"外部图源 {info['file']}（原文件名「{info['originalName']}」）"
            f"→ 脚本化去背 / 反预乘去白边 / alpha 二值化 / 等比缩进 {BOS_FRAME} 帧网格"
            f"（落屏 {CELL * BOSS_TILES}px）"
            f"（sha256 {info['sha256'][:16]}…）"
        )
    return (
        f"本仓库手绘（tools/assetlib/bosses/ 包，{BOS_W} 设计网格 = "
        f"{CELL} × 占位 {BOSS_TILES} 格，{BOS_FRAME} 帧网格 = 设计网格 × {BOSS_SS}）"
    )


def monster_frames(src_name: str, anim: str) -> tuple[list[str], str]:
    """
    取某个 0x72 生物的 4 帧文件名，不足则循环补齐。

    为什么需要兜底：并不是每只生物都画满了 idle4 + run4。`swampy` 只有
    run 的第 0 帧 —— 如果直接判「缺帧」，绿史莱姆/红史莱姆/海妖三只就全
    掉进程序化兜底，画风当场破掉。循环补齐至少保住素材本身。

    返回 (4 个文件名, 实际用到的动作名)。
    """
    for cand in (anim, "idle" if anim == "run" else "run"):
        names = [f"{src_name}_{cand}_anim_f{i}" for i in range(4)]
        have = [n for n in names if (O72 / f"{n}.png").exists()]
        if have:
            return [have[i % len(have)] for i in range(4)], cand
    return [], anim




def main() -> int:
    ATLAS_DIR.mkdir(parents=True, exist_ok=True)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)

    manifest: dict = {
        "meta": {
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "generator": "tools/build-assets.py",
            "baseTile": BASE_TILE,
            "rasterTile": RASTER_TILE,
            "supersample": SS,
            "cell": CELL,
            "drawScale": DRAW_SCALE,
            # BOSS 自己那条超采样：帧边长 = 落屏(格子×占位格数) × 本值。
            # 自述进 MANIFEST 是因为**保护它的判据在运行时那一侧**（A17）：
            # 那里不该硬编码 2，而该问构建期「你说的 SS 是多少」再检查它够不够。
            "bossSupersample": BOSS_SS,
            "note": "实体 → 图集坐标的唯一事实来源。改映射请改 tools/assetlib/data.py 后重跑，"
                    "不要直接编辑本文件。",
        },
        "terrain": {},
        "monsters": {},
        "items": {},
        "actors": {},
        "atlases": {},
    }

    missing: list[str] = []

    # ── 1. 地形 ──────────────────────────────────────────────────
    terr_shelf = Shelf(512)
    terr_cells: list[tuple[str, Image.Image, dict]] = []

    def push_terrain(key: str, name: str, im: Image.Image, src: str):
        terr_cells.append((key, im, {"name": name, "src": src}))

    for code, (name, fn, src) in TERRAIN.items():
        push_terrain(str(code), name, fn(), src)
    for code, (name, fn, src) in TERRAIN_TOP.items():
        push_terrain(f"{code}:top", name, fn(), src)

    # 变体由**配方**直接生成（缝不动、只换残缺），不经过 terrain_raster ——
    # 地板与墙都是手绘的，本来就在出图网格上。
    _wall_bodies = _wall_variants()
    for vi, im in enumerate(_floor_variants()):
        if vi:
            push_terrain(_variant_key("0", vi), f"floor#{vi}", im,
                         f"由 TERRAIN[0] 派生：缝与倒角一致，碎石/磨痕换一批位置（第 {vi} 号变体）")
    for vi, im in enumerate(_wall_bodies):
        if vi:
            push_terrain(_variant_key("1", vi), f"wall#{vi}", im,
                         f"由 TERRAIN[1] 派生：砌层与错缝一致，残缺换一批位置（第 {vi} 号变体）")
    for vi, body in enumerate(_wall_bodies):
        if vi:
            push_terrain(f"1:top:{vi}", f"wallTop#{vi}", _wall_top_baked(body),
                         f"由 TERRAIN_TOP[1] 派生：墙身换变体后重新压顶（第 {vi} 号变体）")

    # 变体数量写进 MANIFEST —— 渲染层据此决定哈希取模，不写死常量
    manifest["meta"]["terrainVariants"] = {
        "0": FLOOR_VARIANTS,
        "1": WALL_VARIANTS,
        "1:top": WALL_VARIANTS,
    }

    # 出图这一步才升到出图网格（RASTER_TILE）。手绘的地板/楼梯本就画在这个网格上，
    # terrain_raster 会对它们空转；第三方位图与门则按各自起点放大到齐平。
    terr_cells = [(k, terrain_raster(im), info) for k, im, info in terr_cells]

    # 断言跑在**出图网格**（RASTER_TILE）上：变体是在出图网格上生成的，底图必须
    # 同网格，否则「像素偏离数」会被尺寸差直接顶穿（实测恒差 = 两张图面积之差），
    # 那条断言就变成了在量网格而不是量配色。
    terr_by_key = {k: im for k, im, _ in terr_cells}

    for _, im, _ in terr_cells:
        terr_shelf.add(im)
    terr_sheet, terr_entries = terr_shelf.render()
    for (key, im, info), e in zip(terr_cells, terr_entries):
        terr_sheet.paste(im, (e["x"], e["y"]), im)
        manifest["terrain"][key] = {
            "atlas": "terrain", "x": e["x"], "y": e["y"],
            "w": im.width, "h": im.height, "drawScale": DRAW_SCALE,
            "name": info["name"], "src": info["src"],
        }
    terr_sheet.save(ATLAS_DIR / "terrain.png")

    # 地形配色是「颜色即玩法」（三色钥匙门 / 假墙伪装），必须断言而不是靠眼看
    problems = verify_terrain(terr_by_key)
    for p in problems:
        missing.append("地形断言失败：" + p)

    # ── 2. 勇者 + NPC ───────────────────────────────────────────
    walk, attack = build_actor_sheet()
    # 「剑、盾、铠甲都画上了吗、有没有画反」只有量像素才知道（见 verify_hero_art）
    for p in verify_hero_art(walk, attack):
        missing.append("勇者造型断言失败：" + p)
    actor_cells: list[tuple[str, Image.Image]] = []
    actor_meta: list[dict] = []

    def push_actor(key: str, im: Image.Image, meta: dict):
        actor_cells.append((key, im))
        actor_meta.append(meta)

    hero_w, hero_h = 0, 0
    # 攒一份勇者的走路帧，给 verify_npc_scale 量「NPC 有没有比勇者大」。
    # 必须用**产出后的真实帧**（bottom_center 补过底对齐），不能用源图 ——
    # 否则量的是源素材而不是玩家看到的那一帧。
    hero_walk_frames: list = []
    for di, d in enumerate(HERO_DIRS):
        for fi, fr in enumerate(walk[di]):
            im = bottom_center(fr, 16, 26)
            hero_w, hero_h = im.size
            hero_walk_frames.append(im)
            push_actor(f"hero.walk.{d}.{fi}", im, {"group": "hero", "anim": "walk", "dir": d, "frame": fi})
    for di, d in enumerate(HERO_DIRS):
        for fi, fr in enumerate(attack[di]):
            # ⚠️ 这里的 16 必须与上面走路帧的 16 一致。曾经这里是 **20**
            # （配合 `HERO_ATK_W`），结果是图集里出现 80×104 的挥剑帧、落屏 40px，
            # 比 32px 的格子还宽 —— 挥剑时勇者会横向压到邻格上。
            # 两套帧同尺寸还是 A14 判「挥剑不变小」的前提（它比的是帧尺寸）。
            im = bottom_center(fr, 16, 26)
            push_actor(f"hero.attack.{d}.{fi}", im, {"group": "hero", "anim": "attack", "dir": d, "frame": fi})

    # NPC：程序化手绘，四个方向写同一组帧（NPC 是静止实体，只取 down —— 见 NPC_ART 说明）
    npc_rendered: dict[str, list] = {}
    for npc_id in NPC_ART:
        frames = npc_art_frames(npc_id)
        npc_rendered[npc_id] = frames
        for d in NPC_DIRS:
            for fi, fr in enumerate(frames):
                push_actor(f"npc.{npc_id}.{d}.{fi}", fr, {"group": "npc", "npc": npc_id, "dir": d, "frame": fi})
    # 「六个 NPC 长得一样」只能靠断言发现 —— 画面上看是六个精灵，代码里看是六次调用
    for p in verify_npc_art(npc_rendered):
        missing.append("NPC 造型断言失败：" + p)
    # 「NPC 比勇者大」同理 —— 两边都是 16×26 的帧，只有量内容包围盒才知道差了 4px
    for p in verify_npc_scale(npc_rendered, hero_walk_frames):
        missing.append("NPC 比例断言失败：" + p)

    # NPC 比例断言跑完（它按 16×26 判），才把角色帧升到 32 网格
    actor_cells = [(k, supersample(im)) for k, im in actor_cells]

    actor_shelf = Shelf(512)
    actor_place = []
    for key, im in actor_cells:
        actor_shelf.add(im)
    actor_sheet, actor_entries = actor_shelf.render()
    for (key, im), e, meta in zip(actor_cells, actor_entries, actor_meta):
        actor_sheet.paste(im, (e["x"], e["y"]), im)
        meta.update({"atlas": "actors", "x": e["x"], "y": e["y"], "w": im.width, "h": im.height,
                     "drawScale": DRAW_SCALE, "key": key})
        actor_place.append(meta)
    actor_sheet.save(ATLAS_DIR / "actors.png")

    # 组装 actors 结构。atlas / drawScale 提到角色级，帧只留 x,y,w,h。
    # 注意：角色的帧宽高不是常量 —— 勇者是 16×26，而 NPC 帧是 26 行高、
    # 宽度按各自造型；所以 w/h 必须留在帧上，不能像怪物那样提到组级。
    # （2026-09-23 起勇者的走路与挥剑**同为 16×26**，但「不必留 w/h」依然不成立：
    #  NPC 那一组仍然不是同一个尺寸。）
    actors = manifest["actors"]
    for m in actor_place:
        if m["group"] == "hero":
            hero = actors.setdefault("hero", {})
            hero["atlas"], hero["drawScale"] = m["atlas"], m["drawScale"]
            hero.setdefault(m["anim"], {}).setdefault(m["dir"], []).append(
                {k: m[k] for k in ("x", "y", "w", "h")})
        elif m["group"] == "npc":
            npc = actors.setdefault("npcs", {}).setdefault(m["npc"], {})
            npc["atlas"], npc["drawScale"] = m["atlas"], m["drawScale"]
            npc.setdefault("walk", {}).setdefault(m["dir"], []).append(
                {k: m[k] for k in ("x", "y", "w", "h")})
    # 来源必须写实：这批不再是 ArMM 的 character.png（那张表已经不再被切）。
    # 写成 ArMM 会让人去那张图集里找一个根本不存在的「带剑盾铠甲的勇者」。
    actors.setdefault("hero", {})["src"] = (
        "本仓库手绘（tools/assetlib/hero.py: _hero_* 系列）—— 16×26 程序化像素画，"
        "铠甲 / 剑 / 盾三件装备分区绘制，left 由 right 镜像"
    )
    actors.setdefault("hero", {})["dirOrder"] = HERO_DIRS
    for npc_id in NPC_ART:
        if npc_id in actors.get("npcs", {}):
            # 来源必须写实：这批不是任何第三方素材，是本仓库手绘的程序化像素画。
            # 写成 ArMM 会让人去那张单角色图集里找一个根本不存在的角色。
            actors["npcs"][npc_id]["src"] = (
                "本仓库手绘（tools/assetlib/npc.py: NPC_ART）— 16×26 程序化像素画，"
                "每个职能一套剪影"
            )

    # ── 3. 怪物 ─────────────────────────────────────────────────
    mon_cells: list[tuple[str, Image.Image]] = []
    mon_meta: list[dict] = []
    proc_used: set[str] = set()
    # id -> idle 帧列表。现在恒为 1 帧（见 mon_art_frames），
    # 但断言仍按「列表」收 —— 判据「帧数必须为 1」要有东西可量。
    proc_frames: dict[str, list[Image.Image]] = {}
    # BOSS 单独收（见 bosses/ 包）：网格是**格子 × 占位格数**（当前 32 × 3 = 96），
    # 与杂兵的 32 不同。混进 proc_frames 会让所有按 MON_H 量的判据在 BOSS 上
    # 静默量错网格。
    boss_frames: dict[str, list[Image.Image]] = {}

    # ── BOSS 的两套画法**都建一遍** ────────────────────────────────
    #
    # 为什么不是「只建 `artSource` 选中的那套」：
    #
    #   · 未选中的那套是 `artSource` 的**后备**。如果它长期没人跑，它就会烂掉 ——
    #     而"烂掉"这件事在需要它的那一刻才会被发现（本项目对「产出素材 /
    #     消费素材 / 保护素材三方必须对齐」的态度见铁律 #15）。
    #   · 两套都过各自的断言，于是「判据跟着画法走」这件事每次构建都被验证，
    #     而不是等谁来手动切一次开关。
    #   · 顺带白拿一条正面守卫：`verify_boss_source_switch` 断言两套产出**逐只不同**，
    #     于是「开关加了但没人读它」当场红（那种情况下所有既有判据照样全绿）。
    #
    # 代价：八只 BOSS 各多算一遍（96² 像素级操作，实测可忽略）。
    boss_by_source: dict[str, dict[str, list[Image.Image]]] = {}
    for _src in ART_SOURCES:
        boss_by_source[_src] = {bid: boss_art_frames(bid, _src) for bid in BOSS_IDS}

    for mid, (src_name, xf, scale, note) in MONSTERS.items():
        # BOSS 走自己的网格体系：**两条换算都不能用** ——
        # `_mon_out` 是「把 32 网格抬到出图 64」，对已经出好帧的 BOSS 是空操作但语义错；
        # `_out_scale` 是给「绘制网格 16 → 出图 64」换算倍数的。
        #
        # BOSS 的落屏规则只有一条：**帧边长 × BOSS_DRAW_SCALE = 格子 × 占位格数**
        # （帧 192 × 0.5 = 96px，正好占 3 格）。`BOSS_DRAW_SCALE` 里那个 1/SS
        # 是「帧比落屏大 SS 倍」的抵消，**不是可以拿去放大 BOSS 的旋钮** ——
        # 真值仍是 `boss.footprintTiles`，由 `verify_boss_art` 判据 0 钉住。
        if mid in BOSS_IDS:
            frames = boss_by_source[ART_SOURCE][mid]
            boss_frames[mid] = frames
            for anim in ("idle", "run"):
                for fi, im in enumerate(frames):
                    top, bot = _art_rows(im)
                    mon_cells.append((f"{mid}.{anim}.{fi}", im))
                    mon_meta.append({
                        "monster": mid, "anim": anim, "frame": fi,
                        # `src` 要**说清是哪一套画法**：图集是提交进仓库的，
                        # 光看图分不出「这张是手绘还是外部图源处理来的」。
                        "src": _boss_src_note(mid),
                        "note": note, "drawScale": BOSS_DRAW_SCALE,
                        "artH": bot - top + 1, "artPadBottom": im.height - 1 - bot,
                    })
            continue

        # 源名 "gen" = 本仓库按名称手绘（蝙蝠/史莱姆/龙/乌贼/石头人/吸血鬼/魔王）。
        # 形状与配色在 PROC_MONSTERS，这里只负责出帧 + 记 meta。
        if src_name == "gen":
            if mid not in PROC_MONSTERS:
                missing.append(f"{mid}: MONSTERS 标了 gen，但 PROC_MONSTERS 里没有它的造型")
                continue
            proc_used.add(mid)
            frames = mon_art_frames(mid)
            proc_frames[mid] = frames
            for anim in ("idle", "run"):
                for fi, im in enumerate(frames):
                    im = _mon_out(im, scale)          # 出图网格；artH 必须按出图后量
                    top, bot = _art_rows(im)
                    mon_cells.append((f"{mid}.{anim}.{fi}", im))
                    mon_meta.append({
                        "monster": mid, "anim": anim, "frame": fi,
                        "src": "本仓库手绘（tools/assetlib/monsters.py: MON_SHAPES）",
                        "note": note, "drawScale": _out_scale(scale),
                        "artH": bot - top + 1, "artPadBottom": im.height - 1 - bot,
                    })
            continue

        for anim in ("idle", "run"):
            names, actual = monster_frames(src_name, anim)
            if not names:
                missing.append(f"{mid}: 0x72 里没有 {src_name} 的任何动画帧")
                continue
            eff_note = note if actual == anim else f"{note}（{src_name} 缺完整 {anim} 帧，回退用 {actual}）"
            for fi, fname in enumerate(names):
                im = Image.open(O72 / f"{fname}.png").convert("RGBA")
                if xf:
                    im = xf(im)
                # 不变量：图集里的怪物帧一律 16×16，落屏尺寸只由 drawScale 决定。
                # 0x72 里 ogre / big_demon / big_zombie 是 32×32，混进来会让
                # 「大家伙 ×3」算成 96px（整整 3 格）—— 石巨人和魔王都踩过这个坑。
                # 它们的像素密度本来就是别家的两倍，按原尺寸画反而显小，归一化才是对的。
                if im.size != (BASE_TILE, BASE_TILE):
                    im = im.resize((BASE_TILE, BASE_TILE), Image.NEAREST)
                im = _mon_out(im, scale)
                top, bot = _art_rows(im)
                art_bbox = (bot - top + 1, im.height - 1 - bot)
                mon_cells.append((f"{mid}.{anim}.{fi}", im))
                mon_meta.append({"monster": mid, "anim": anim, "frame": fi,
                                 "src": f"0x72/{src_name}", "note": eff_note,
                                 "drawScale": _out_scale(scale),
                                 "artH": art_bbox[0], "artPadBottom": art_bbox[1]})

    mon_shelf = Shelf(512)
    for key, im in mon_cells:
        mon_shelf.add(im)
    mon_sheet, mon_entries = mon_shelf.render()
    for (key, im), e, meta in zip(mon_cells, mon_entries, mon_meta):
        mon_sheet.paste(im, (e["x"], e["y"]), im)
        meta.update({"atlas": "monsters", "x": e["x"], "y": e["y"], "w": im.width, "h": im.height})
    mon_sheet.save(ATLAS_DIR / "monsters.png")

    # 布局断言：逐帧取最坏值（同一只怪的各帧内容高度可能差 1px）。
    # 注意 padIdle 只统计 idle 帧 —— run 帧的底留白是源动画自身的起伏，而棋盘不用 run 帧。
    _fit: dict[str, dict] = {}
    for m in mon_meta:
        prev = _fit.get(m["monster"], {"h": 0, "scale": m["drawScale"], "padIdle": 0})
        prev["h"] = max(prev["h"], m["artH"])
        prev["scale"] = m["drawScale"]
        if m["anim"] == "idle":
            prev["padIdle"] = max(prev["padIdle"], m["artPadBottom"])
        _fit[m["monster"]] = prev
    for p in verify_monster_fit(_fit):
        missing.append(p)

    # 手绘杂兵的造型断言：形状互不相同、同形状的变体确有区别、帧底不留白、
    # 且每只怪只有 1 帧 idle（呼吸在渲染层，见 mon_art_frames）。
    # ⚠️ BOSS **不在** proc_frames 里 —— 它们是 96 网格，判据全都不一样。
    for p in verify_mon_art(proc_frames):
        missing.append("怪物造型断言失败：" + p)
    # BOSS 的造型断言：网格 == 格子 × 占位格数、底行有像素、单帧、八只剪影互不相同、
    # 细节密度与内部细节达标、正面朝向的头部对称，且与 data/monsters.json 的 boss 字段一一对应
    # BOSS 的造型断言，**两套画法各跑一遍各自的判据**：
    # 共有的（网格 == 格子 × 占位格数、画布、底行、单帧、剪影互异、与数据对账）
    # 两边都跑；为像素画设计的密度 / 内部细节 / 头部对称只跑 drawn，
    # 为外部图源设计的（白底残留 / 内容占比 / 长宽比守恒 / 底对齐）只跑 imported。
    # 分族的理由（以及为什么不是"留着也不碍事"）见 bosses/common.py 的 docstring。
    for _src, _frames in boss_by_source.items():
        for p in verify_boss_art(_frames, _src):
            missing.append(f"BOSS 造型断言失败（{_src}）：" + p)
    # 画法开关必须真的在起作用 —— 两套产出逐只不同（否则它就是接了个寂寞）
    for p in verify_boss_source_switch(boss_by_source):
        missing.append("BOSS 画法开关断言失败：" + p)
    monsters_json_boss = {
        mid for mid, v in
        json.loads((ROOT / "data" / "monsters.json").read_text(encoding="utf-8"))["monsters"].items()
        if v.get("boss")
    }
    if monsters_json_boss != set(BOSS_IDS):
        missing.append(
            f"BOSS 名单与 data/monsters.json 对不上："
            f"数据里是 {sorted(monsters_json_boss)}，代码里是 {sorted(BOSS_IDS)}"
        )
    # 三张表必须严格一一对应 —— 「在 MONSTERS 里标了 gen 却忘了画」会静默少一只怪
    declared = {mid for mid, (s, _, _, _) in MONSTERS.items() if s == "gen"}
    for mid in sorted(declared - proc_used - set(boss_frames)):
        missing.append(f"{mid}: MONSTERS 标了 gen，但没有产出任何帧")
    for mid in sorted(set(PROC_MONSTERS) - declared - proc_used):
        missing.append(f"{mid}: PROC_MONSTERS 里有造型，但 MONSTERS 没标 gen，接不上")
    hand = len(proc_used)
    print(f"  手绘怪物 {hand} 只 / {len(MON_SHAPES)} 种形状"
          f"；BOSS {len(boss_frames)} 只 / 设计网格 {CELL * BOSS_TILES} = {CELL} × 占位 {BOSS_TILES} 格，"
          f"帧网格 {BOS_FRAME}（× SS {BOSS_SS} 超采样）、落屏 {CELL * BOSS_TILES}px"
          f"（画法 {ART_SOURCE}，两套都过断言）"
          f"（其余 {len(MONSTERS) - hand} 只取自 0x72）")

    for m in mon_meta:
        node = manifest["monsters"].setdefault(m["monster"], {
            "src": m["src"], "note": m["note"], "drawScale": m["drawScale"],
            # atlas / 帧尺寸提到组级，帧数组里只留 x,y ——
            # 36 只 × 8 帧会让「每帧重复一遍 atlas/w/h」撑出十几 KB 的冗余
            "atlas": m["atlas"],
            "frame": {"w": m["w"], "h": m["h"]},
            "idle": [], "run": [],
        })
        node[m["anim"]].append({"x": m["x"], "y": m["y"]})

    # BOSS 的来源信息（外部图源时含**内容哈希**）。
    #
    # 这条哈希是「图集是不是由当前这批源图生成的」那条断言（checks/a22）的另一半：
    # 源图改了但没重跑 `npm run assets` 时，两边对不上 —— 而症状与铁律 #2 记的那次
    # 完全同族：无报错、图集完整、只是画的是上一版素材。
    for _bid in BOSS_IDS:
        _node = manifest["monsters"].get(_bid)
        if _node:
            _node["source"] = boss_art_source_of(_bid)

    # 补齐未映射到的怪物（数据里有、映射表漏了）→ 明确标 null，让渲染层走兜底
    monsters_json = json.loads((ROOT / "data" / "monsters.json").read_text(encoding="utf-8"))["monsters"]
    for mid in monsters_json:
        if mid not in manifest["monsters"]:
            manifest["monsters"][mid] = None
            missing.append(f"怪物 {mid} 未映射 → 渲染层将回退程序化图形")

    # 尺寸层级检查：凡**落屏画得比一格大**的怪，落屏尺寸必须彼此一致 ——
    # 一个大块头比另一个矮，读起来就是「体型层级倒挂」。
    #
    # 这条断言来自一个真实的翻车：0x72 的 big_demon 是 32×32，若按 1:1 绘制
    # 屏幕上只有 32px，而 16×16 放大 3 倍的巨龙有 48px —— 结果魔王比小龙还小。
    #
    # ⚠️ 判据原本写的是「`drawScale == BIG_SCALE`（3）」。2026-09-24 BOSS 改成
    #    96 网格之后 drawScale 变成 1.0，**没有任何怪还等于 3** ——
    #    集合恒为空，这条断言当场退化成空转（而且怎么改都绿）。
    #    所以现在按**落屏尺寸**筛（语义），并补一条「至少得有一个大家伙」
    #    的存在性探针 —— 否则它还能再退化一次，而且照样看不出来。
    #
    #    2026-09-25 加超采样（帧 192 / drawScale 0.5）时这条**一个字都没改**就
    #    继续成立 —— 正是「绑语义不绑中间量」（铁律 #12）那次改动的回报。
    big_sizes: dict[int, list[str]] = {}
    for mid, node in manifest["monsters"].items():
        if not node:
            continue
        eff = node["frame"]["w"] * node["drawScale"]
        if eff <= CELL + 1e-6:
            continue
        big_sizes.setdefault(round(eff), []).append(mid)
    if not big_sizes:
        missing.append(
            f"没有任何怪物画得比一格（{CELL}px）大 —— 「体型层级」这条断言失去意义。"
            f"BOSS 应当占 {CELL} × {BOSS_TILES} 格 = {CELL * BOSS_TILES}px，"
            f"请检查 BOSS 的**落屏尺寸**（帧 {BOS_FRAME} × drawScale {BOSS_DRAW_SCALE:g}）"
        )
    elif len(big_sizes) > 1:
        detail = "；".join(f"{k}px → {', '.join(sorted(v))}" for k, v in sorted(big_sizes.items()))
        missing.append(f"画得比一格大的怪落屏尺寸不一致，体型层级会倒挂：{detail}")

    # ── 4. 道具 ─────────────────────────────────────────────────
    item_shelf = Shelf(512)
    item_cells: list[tuple[str, Image.Image]] = []
    item_meta: list[dict] = []

    sheet_img = Image.open(O72_SHEET).convert("RGBA")
    SHIELD_STYLE = {
        "shield_iron":   ((58, 56, 66), (188, 190, 200)),
        "shield_silver": ((96, 98, 112), (244, 246, 252)),
        "shield_knight": ((28, 46, 96), (150, 186, 240)),
        "shield_holy":   ((92, 62, 12), (250, 214, 96)),
        "shield_sacred": ((92, 16, 32), (248, 158, 158)),
    }

    for iid, spec in ITEM_SRC.items():
        kind = spec[0]
        if kind == "o72":
            im, src = o72(spec[1]), spec[2]
        elif kind == "sheet":
            im, src = sheet_img.crop(spec[1]), spec[2]
        elif kind == "ken":
            im, src = ken(spec[1]), spec[3]
            tag = spec[2]
            if isinstance(tag, tuple):
                # 钥匙：只重染匙身横带 (lo, hi, dark, light)
                lo, hi, kdark, klight = tag
                im = recolor_hue(im, lo, hi, kdark, klight)
            elif tag == "gold":
                im = ramp(im, (92, 62, 12), (250, 214, 96))
            elif isinstance(tag, str) and tag.startswith("shield_"):
                im = ramp(im, *SHIELD_STYLE[tag])
        elif kind == "gen":
            im, src = gen_icon(spec[1]), spec[2]
        else:
            raise KeyError(kind)
        im = im.convert("RGBA")
        item_cells.append((iid, im))
        item_meta.append({"item": iid, "src": src})

    # 三色钥匙是「颜色即玩法」，而黄钥匙是构建期造出来的（原素材没有），
    # 最容易在换素材时悄悄跑偏 —— 断言而不是靠眼看。
    # 顺序要紧：先按 16 网格判（判据就是照 16 写的），再升网格出图。
    for p in verify_items(dict(item_cells), ken(126)):
        missing.append("道具断言失败：" + p)

    item_cells = [(k, supersample(im)) for k, im in item_cells]

    for key, im in item_cells:
        item_shelf.add(im)
    item_sheet, item_entries = item_shelf.render()
    for (key, im), e, meta in zip(item_cells, item_entries, item_meta):
        item_sheet.paste(im, (e["x"], e["y"]), im)
        meta.update({"atlas": "items", "x": e["x"], "y": e["y"], "w": im.width, "h": im.height})
    item_sheet.save(ATLAS_DIR / "items.png")

    for m in item_meta:
        manifest["items"][m["item"]] = {
            "atlas": "items", "x": m["x"], "y": m["y"], "w": m["w"], "h": m["h"],
            "drawScale": DRAW_SCALE, "src": m["src"],
        }

    items_json = json.loads((ROOT / "data" / "items.json").read_text(encoding="utf-8"))["items"]
    for iid in items_json:
        if iid not in manifest["items"]:
            manifest["items"][iid] = None
            missing.append(f"道具 {iid} 未映射 → 渲染层将回退程序化图形")

    manifest["meta"]["atlases"] = {
        "terrain":  {"file": "terrain.png",  "w": terr_sheet.width,  "h": terr_sheet.height},
        "actors":   {"file": "actors.png",   "w": actor_sheet.width, "h": actor_sheet.height},
        "monsters": {"file": "monsters.png", "w": mon_sheet.width,  "h": mon_sheet.height},
        "items":    {"file": "items.png",    "w": item_sheet.width, "h": item_sheet.height},
    }

    (ROOT / "assets" / "MANIFEST.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # ── 5. 目视核对图 ───────────────────────────────────────────
    for nm, sheet in (("terrain", terr_sheet), ("actors", actor_sheet),
                      ("monsters", mon_sheet), ("items", item_sheet)):
        bg = Image.new("RGBA", sheet.size, (250, 250, 252, 255))
        bg.alpha_composite(sheet)
        s = max(1, min(4, 1400 // max(sheet.width, 1)))
        bg.resize((bg.width * s, bg.height * s), Image.NEAREST).convert("RGB").save(
            PREVIEW_DIR / f"atlas-{nm}.png")

    # ── 6. 汇报 ─────────────────────────────────────────────────
    print("=== 图集 ===")
    for nm, meta in manifest["meta"]["atlases"].items():
        p = ATLAS_DIR / meta["file"]
        print(f"  {nm:<9} {meta['w']:>4}×{meta['h']:<4}  {p.stat().st_size/1024:>7.1f} KB")
    print(f"\n=== 覆盖 ===")
    print(f"  地形   {len(manifest['terrain'])} 项（含墙顶边变体）")
    print(f"  怪物   {sum(1 for v in manifest['monsters'].values() if v)}/{len(manifest['monsters'])} 只有素材")
    print(f"  道具   {sum(1 for v in manifest['items'].values() if v)}/{len(manifest['items'])} 项有素材")
    print(f"  勇者   {len(HERO_DIRS)} 向 × 4 帧走路 + {len(HERO_DIRS)} 向 × 4 帧挥剑（手绘：铠甲 / 剑 / 盾）")
    print(f"  NPC    {len(NPC_ART)} 人（程序化手绘）× {len(NPC_DIRS)} 向 × 1 帧静止 —— 呼吸在渲染层")
    total = sum((ATLAS_DIR / m["file"]).stat().st_size for m in manifest["meta"]["atlases"].values())
    print(f"\n  图集总大小 {total/1024:.1f} KB")
    if missing:
        print(f"\n=== 需注意（{len(missing)} 条）===")
        for m in missing[:20]:
            print("  -", m)
    return 0
