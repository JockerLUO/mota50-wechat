#!/usr/bin/env python3
"""
把 `imported.py` 里那几条判据的阈值**复现出来** —— 「先量、再定」的入口。

## 为什么要有这个脚本

`tools/assetlib/bosses/imported.py` 里每个阈值旁边都写了一段「实测三档」的表。
表是结论，这个脚本是**结论的来源**。没有它，下一个人改阈值时只能靠猜，
或者把整条处理链改坏几次才知道原来那个数字是怎么来的。

与 `tools/measure-bosses-thresholds.py`（那个是给手绘像素画那一路量的）同一套思路：

  · **三档对照** —— 「改前 / 改一半 / 改后」都要量。只量改后，阈值定在哪都显得合理。
  · **必须存在「会红」的那一档** —— 若三档的读数贴在一起，说明这个量没有区分力，
    那条判据是装饰品，该换一个量。
  · 报出**空档**（会红档的最大值 ↔ 该通过档的最小值），阈值应当落在空档里。

用法（**必须用带 Pillow 的解释器**）：
    PYTHON=/Users/jockerluo/.workbuddy/binaries/python/envs/default/bin/python \\
        npm run assets          # 顺带跑一遍，确认现在的实现不报红
    tools/measure-boss-import-thresholds.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from assetlib.bosses import boss_ids  # noqa: E402
from assetlib.bosses.imported import (  # noqa: E402
    ASPECT_TOL,
    COVER_MAX,
    COVER_MIN,
    RIM_WHITE_MAX,
    WHITE_RESIDUE_MAX,
    backdrop_color,
    clear_background,
    clear_pockets,
    feather_edges,
    fit_into_grid,
    frame_stats,
    load_source,
    rim_stats,
)


def stages(bid: str):
    """三档：① 什么也不做 ② 只泛洪去背 ③ 走完整条链。"""
    src = load_source(bid)
    bg = backdrop_color(src)
    cleared, _ = clear_background(src)
    pocketed, _ = clear_pockets(cleared, bg)
    return {
        "①不去背": fit_into_grid(src),
        "②只去背+清口袋": fit_into_grid(pocketed),
        "③完整（含去白边）": fit_into_grid(feather_edges(pocketed)),
    }


def main() -> int:
    ids = boss_ids()
    print(f"BOSS {len(ids)} 只 · 三档对照\n")

    # ── 白底残留 & 内容占比 ─────────────────────────────────────────
    print("【白底残留占比】阈值 %.2f（超了报红：去背整个没跑）" % WHITE_RESIDUE_MAX)
    print(f"  {'id':18s} {'①不去背':>10s} {'②去背':>10s} {'③完整':>10s}")
    rows = {}
    for bid in ids:
        st = stages(bid)
        vals = {k: frame_stats(v)["whiteRatio"] for k, v in st.items()}
        rows[bid] = vals
        print(f"  {bid:18s} {vals['①不去背']:>9.1%} "
              f"{vals['②只去背+清口袋']:>9.1%} {vals['③完整（含去白边）']:>9.1%}")
    a = max(r["①不去背"] for r in rows.values())
    c = max(r["③完整（含去白边）"] for r in rows.values())
    print(f"  → ①最小 {min(r['①不去背'] for r in rows.values()):.1%}（必须 > 阈值才抓得住）"
          f"；③最大 {c:.1%}，余量 {WHITE_RESIDUE_MAX / c:.1f}×\n")

    # ── 外缘光圈 ───────────────────────────────────────────────────
    print("【剪影外缘的浅色占比】阈值 %.2f（超了报红：去了背没去白边）" % RIM_WHITE_MAX)
    print(f"  {'id':18s} {'②去背':>10s} {'③完整':>10s}")
    rim = {}
    for bid in ids:
        st = stages(bid)
        v = {k: rim_stats(x)["ratio"] for k, x in st.items() if k != "①不去背"}
        rim[bid] = v
        print(f"  {bid:18s} {v['②只去背+清口袋']:>9.1%} {v['③完整（含去白边）']:>9.1%}")
    bmin = min(r["②只去背+清口袋"] for r in rim.values())
    cmax = max(r["③完整（含去白边）"] for r in rim.values())
    print(f"  → ②最小 {bmin:.1%}（必须 > 阈值）→ ③最大 {cmax:.1%}，余量 {RIM_WHITE_MAX / max(cmax, 1e-6):.1f}×")
    print(f"  → **空档 {cmax:.1%} ~ {bmin:.1%}**，阈值 {RIM_WHITE_MAX:.0%} 落在空档里\n")

    # ── 内容占比（区间）────────────────────────────────────────────
    print("【非透明像素占比】区间 %.2f ~ %.2f" % (COVER_MIN, COVER_MAX))
    cov = {bid: frame_stats(stages(bid)["③完整（含去白边）"])["cover"] for bid in ids}
    for bid in ids:
        print(f"  {bid:18s} {cov[bid]:>7.1%}")
    lo, hi = min(cov.values()), max(cov.values())
    print(f"  → 实测 {lo:.1%} ~ {hi:.1%}；下界余量 {lo / COVER_MIN:.1f}×、"
          f"上界余量 {COVER_MAX / hi:.1f}×\n")

    # ── 长宽比守恒 ─────────────────────────────────────────────────
    print("【长宽比守恒】容差 %.1fpx（超了报红：缩放被改成拉伸）" % ASPECT_TOL)
    worst = 0.0
    for bid in ids:
        src = clear_background(load_source(bid))[0]
        bb = src.getchannel("A").getbbox()
        want = (bb[2] - bb[0]) / (bb[3] - bb[1])
        st = frame_stats(stages(bid)["③完整（含去白边）"])
        got = st["bw"] / st["bh"]
        dev = abs(got - want) * min(st["bw"], st["bh"])
        worst = max(worst, dev)
        print(f"  {bid:18s} 源 {want:.4f} → 帧 {got:.4f}  偏差 {dev:.2f}px")
    print(f"  → 最坏 {worst:.2f}px，容差 {ASPECT_TOL}px（余量 {ASPECT_TOL / max(worst, 1e-9):.1f}×）")
    print("  ⚠️ 「拉伸」那条反例要**跑一次才知道它真的会红**：把 fit_into_grid 的倍数")
    print("     从 min(...) 改成写死 BOS_W/BOS_H，上面这一列会变成 10~30px 的偏差。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
