#!/usr/bin/env python3
"""
**断言元测试**：把每条 BOSS 判据的「病根」种回去，确认它真的会红。

## 为什么需要这个东西

本项目反复出现同一类事故：**判据写完了、一直是绿的，而它其实根本不可能红**
（阈值定错、按一个恒空的集合筛、分支没被走到……）。这类判据比没有判据更糟 ——
它给人一种"这块有人守着"的错觉。

所以「新判据的验收 = 逐个探针证明会红」是一条硬规矩。这个脚本把那句话变成
**一条可执行的命令**，而不是文档里的一段回忆：

    PYTHON=<venv>/bin/python tools/probe-boss-judgments.py

对每条判据，它把对应的病根**种回实现里**（monkey-patch 真正被调用的那个函数，
所以走的是**真实的判定代码路径**），跑一遍 `verify_boss_art`，然后：

  · 判据**报红**了 ⇒ 这条判据有区分力（PROBE OK）
  · 判据**没报红** ⇒ 它是装饰品，脚本以非零退出码结束（FAIL）

跑完自动还原（都在进程内改，不落盘 —— 这也是为什么它敢直接 patch 模块属性）。

## 覆盖边界

这里只覆盖**构建期**那一半（Python）。渲染层那几条（A5a/A17/A21/A22）在
`tools/verify/checks/` 下，它们的探针实验记在 `docs/assets.md` §13.15 与
`docs/ui-prototype.md` §24 —— 那几条要动产物/浏览器，不适合塞进这个进程内脚本。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from assetlib.bosses import boss_ids  # noqa: E402
from assetlib.bosses import common  # noqa: E402
from assetlib.bosses import imported  # noqa: E402
from assetlib.pil import Image  # noqa: E402


def _frames(source: str) -> dict:
    return {bid: common.boss_art_frames(bid, source) for bid in boss_ids()}


def _baseline() -> list:
    """先确认「不改任何东西时是绿的」—— 否则下面的红说明不了任何问题。"""
    return common.verify_boss_art(_frames("imported"), "imported")


# ════════════════════════════════════════════════════════════════════
# 探针：每一个都返回 (说明, 打完补丁之后 verify 报出来的问题列表)
# ════════════════════════════════════════════════════════════════════


def probe_no_matte() -> tuple[str, list]:
    """① 不去背：把整条去背/清口袋/去白边都跳过（只做裁剪+缩放+底对齐）。"""
    orig = imported.build

    def broken(bid):
        return imported.fit_into_grid(imported.load_source(bid))

    imported.build = broken
    try:
        return ("跳过 clear_background / clear_pockets / feather_edges",
                common.verify_boss_art(_frames("imported"), "imported"))
    finally:
        imported.build = orig


def probe_no_feather() -> tuple[str, list]:
    """② 去了背但不去白边：删掉 feather_edges 这一步。"""
    orig = imported.build

    def broken(bid):
        src = imported.load_source(bid)
        bg = imported.backdrop_color(src)
        im, _ = imported.clear_background(src)
        im, _ = imported.clear_pockets(im, bg)
        return imported.fit_into_grid(im)

    imported.build = broken
    try:
        return ("删掉 feather_edges（去背但不处理抗锯齿光圈）",
                common.verify_boss_art(_frames("imported"), "imported"))
    finally:
        imported.build = orig


def probe_stretch() -> tuple[str, list]:
    """③ 拉伸到满格：缩放倍数从 min(...) 改成写死两个方向各拉各的。"""
    orig = imported.fit_into_grid

    def broken(im):
        bbox = im.getchannel("A").getbbox()
        im2 = im.crop(bbox)
        small = im2.convert("RGBa").resize((imported.BOS_FRAME, imported.BOS_FRAME),
                                           Image.LANCZOS).convert("RGBA")
        out = Image.new("RGBA", (imported.BOS_FRAME, imported.BOS_FRAME), (0, 0, 0, 0))
        out.alpha_composite(small, (0, 0))
        return out

    imported.fit_into_grid = broken
    try:
        return ("把等比缩放改成拉伸到满格",
                common.verify_boss_art(_frames("imported"), "imported"))
    finally:
        imported.fit_into_grid = orig


def probe_top_align() -> tuple[str, list]:
    """④ 顶对齐：`realign` 的底对齐改成顶对齐（脚离地，浮在半空）。

    2026-09-25 起对齐职责从 `fit_into_grid` 搬到了 `realign`（二值化削掉一圈
    轮廓之后要按**新**轮廓重新底对齐），病根也跟着搬家 —— patch
    `fit_into_grid` 产出什么对齐都会被 `realign` 修正，探针会假阴。
    """
    orig = imported.realign

    def broken(im):
        bb = im.getchannel("A").getbbox()
        c = im.crop(bb)
        out = Image.new("RGBA", (imported.BOS_FRAME, imported.BOS_FRAME), (0, 0, 0, 0))
        out.alpha_composite(c, ((imported.BOS_FRAME - c.width) // 2, 0))  # 顶，不是底
        return out

    imported.realign = broken
    try:
        return ("realign 底对齐改成顶对齐",
                common.verify_boss_art(_frames("imported"), "imported"))
    finally:
        imported.realign = orig


def probe_source_switch_ignored() -> tuple[str, list]:
    """⑤ 开关不分派：`boss_art_base` 忽略 `source` 参数（永远用 artSource）。

    这条病根**不会**被任何「尺寸/网格/剪影」类判据抓到 —— 两套本来就都合规。
    只有 `verify_boss_source_switch` 能发现「改 data 什么都不会变」。
    """
    orig = common.boss_art_base

    def broken(bid, source=None):
        return orig(bid, "drawn")  # 无论要哪一套都给 drawn

    common.boss_art_base = broken
    try:
        both = {s: {bid: common.boss_art_frames(bid, s) for bid in boss_ids()}
                for s in ("imported", "drawn")}
        return ("boss_art_base 忽略 source 参数（两套产出变成同一张）",
                common.verify_boss_source_switch(both))
    finally:
        common.boss_art_base = orig


def probe_no_harden() -> tuple[str, list]:
    """⑥ 不做 alpha 二值化：删掉 harden_alpha 这一步（本轮玩家报的「周边线条模糊」）。

    注意返回值做了**定向过滤**：只保留含「半透明」的红。若 I7（TRANSLUCENT_MAX=0）
    没有被这条病根打红，列表为空 → FAIL。不做过滤的话，其它判据（覆盖率等）
    的误伤红会把「I7 没有区分力」这件事盖住。
    """
    orig = imported.build

    def broken(bid):
        # 真链：realign(harden_alpha(fit_into_grid(_clean(bid))))
        return imported.realign(imported.fit_into_grid(imported._clean(bid)))

    imported.build = broken
    try:
        problems = common.verify_boss_art(_frames("imported"), "imported")
        return ("删掉 harden_alpha（边缘 alpha 保持渐变）",
                [p for p in problems if "半透明" in p])
    finally:
        imported.build = orig


def probe_harden_before_scale() -> tuple[str, list]:
    """⑦ 顺序反了：先二值化再缩放（LANCZOS 会把硬边重新抹成渐变）。"""
    orig = imported.build

    def broken(bid):
        return imported.realign(
            imported.fit_into_grid(imported.harden_alpha(imported._clean(bid)))
        )

    imported.build = broken
    try:
        problems = common.verify_boss_art(_frames("imported"), "imported")
        return ("harden_alpha 排到 fit_into_grid 之前",
                [p for p in problems if "半透明" in p])
    finally:
        imported.build = orig


PROBES = (
    probe_no_matte,
    probe_no_feather,
    probe_stretch,
    probe_top_align,
    probe_source_switch_ignored,
    probe_no_harden,
    probe_harden_before_scale,
)


def main() -> int:
    base = _baseline()
    if base:
        print("❌ 基线就不绿，探针没有意义。先修好：")
        for p in base[:5]:
            print("   ·", p)
        return 2
    print(f"✅ 基线绿（{len(boss_ids())} 只 BOSS，画法 imported）\n")

    failed = []
    for probe in PROBES:
        desc, problems = probe()
        ok = len(problems) > 0
        mark = "✅ PROBE OK" if ok else "❌ PROBE FAILED"
        print(f"{mark}  {probe.__name__}")
        print(f"           病根：{desc}")
        if ok:
            for p in problems[:3]:
                print(f"           红了：{p}")
            if len(problems) > 3:
                print(f"           …另有 {len(problems) - 3} 条")
        else:
            print("           **一条都没红** —— 这条判据是装饰品，必须换一个量")
            failed.append(probe.__name__)
        print()

    if failed:
        print(f"❌ {len(failed)} 条探针没能让判据变红：{failed}")
        return 1
    print(f"✅ 全部 {len(PROBES)} 条探针都让对应判据变红了 —— 这些判据有区分力")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
