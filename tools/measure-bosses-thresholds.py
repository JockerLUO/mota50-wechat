#!/usr/bin/env python3
"""
BOSS 判据门槛的**可复现测量** —— 改前（64 网格基线）vs 改后（96 网格现役）。

为什么要一个脚本，而不是把数字写进注释就完事：
`tools/assetlib/bosses/common.py` 的门槛值只有在「改前必红、改后有余量」时才有意义，
而 2026-09-24 发现旧门槛（3.0 / 1.80 / 12% / 1100）**在改前一条都不红** ——
一条恒真的断言和一个没写的断言，在 CI 上长得一模一样。
所以门槛的**每一档**都必须能被这条脚本重新推翻。

跑法（必须带 venv python，托管 python 没有 Pillow）：

    /Users/jockerluo/.workbuddy/binaries/python/envs/default/bin/python \\
        tools/measure-bosses-thresholds.py

输出三段：
  ① 改前 / 改后的逐只读数（密度 / 内部细节 / 头部对称 / 剪影两两差）
  ② **探针**：把改前素材放到**现役门槛**下，逐条列出它会红在哪 —— 全绿即门槛失效
  ③ 门槛候选表：几档候选各自「改前红几只 / 改后红几只」，用来选档
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from assetlib import bosses as new  # noqa: E402
from assetlib.bosses import common as C  # noqa: E402
from assetlib.metrics import (  # noqa: E402
    _detail_density,
    _head_asym,
    _inner_detail,
    _solid_set,
)

BASELINE = ROOT / "reference" / "bosses" / "bosses-64grid-baseline.py"


def load_baseline():
    """
    把冻结的 64 网格基线装成 `assetlib._baseline64`。

    名字里带 `assetlib.` 前缀是必须的 —— 那个文件用的是相对 import
    （`from .pil import Image`），只有挂进包命名空间才解析得到。
    装完即弃，不写进包里，构建链也永远 import 不到它。
    """
    if not BASELINE.exists():
        raise SystemExit(f"缺少改前基线：{BASELINE}")
    import assetlib  # noqa: F401  （先把包本身导入，相对 import 才有落脚点）

    spec = importlib.util.spec_from_file_location("assetlib._baseline64", BASELINE)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["assetlib._baseline64"] = mod
    spec.loader.exec_module(mod)
    return mod


IDS = [
    "skeletonCaptain", "knightCaptain", "vampire", "archmage",
    "kraken", "dragon", "demonKing", "demonKingTrue",
]

THRESHOLDS = dict(
    detail=C.BOSS_DETAIL_MIN,
    inner=C.BOSS_INNER_MIN,
    head=C.BOSS_HEAD_SYM_MAX,
    sil=C.BOSS_SIL_MIN_DIFF,
)


def probe(mod, block_of, label):
    rows = {}
    for bid in IDS:
        im = mod.boss_art_base(bid)
        w, block = im.width, block_of(im.width)
        rows[bid] = dict(
            w=w,
            d=_detail_density(im, block),
            i=_inner_detail(im, w // 16, w // 32),
            asym=_head_asym(im),
            sil=_solid_set(im),
        )
    print(f"\n══ {label} ══")
    print(f"{'id':<16}{'网格':>5}{'密度':>8}{'内部':>8}{'头不对称':>10}")
    for bid in IDS:
        r = rows[bid]
        print(f"{bid:<16}{r['w']:>5}{r['d']:>8.2f}{r['i']:>8.2f}{r['asym']:>9.1%}")
    return rows


def sil_pairs(rows):
    out = []
    ids = sorted(rows)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            out.append((len(rows[a]["sil"] ^ rows[b]["sil"]), a, b))
    out.sort()
    return out


def main() -> int:
    base = load_baseline()
    old = probe(base, lambda w: w // 8, "改前（64 网格基线，reference/ 里冻结的那份）")
    new_rows = probe(new, lambda w: w // 8, "改后（96 网格现役）")

    print("\n══ 剪影两两差 ══")
    for label, rows in (("改前", old), ("改后", new_rows)):
        ps = sil_pairs(rows)
        red = sum(1 for d, _, _ in ps if d < THRESHOLDS["sil"])
        print(f"  {label}：最小 {ps[0][0]:>5}（{ps[0][1]} vs {ps[0][2]}）"
              f" / 最大 {ps[-1][0]}  → 门槛 {THRESHOLDS['sil']} 下 {red}/28 对红")

    print(f"\n══ 探针：改前素材 × 现役门槛（{THRESHOLDS}）→ 必须红 ══")
    n_red = 0
    for bid in IDS:
        r = old[bid]
        bad = []
        if r["d"] < THRESHOLDS["detail"]:
            bad.append(f"密度 {r['d']:.2f} < {THRESHOLDS['detail']}")
        if r["i"] < THRESHOLDS["inner"]:
            bad.append(f"内部 {r['i']:.2f} < {THRESHOLDS['inner']}")
        if bid in C.HEAD_FRONT and r["asym"] > THRESHOLDS["head"]:
            bad.append(f"头不对称 {r['asym']:.1%} > {THRESHOLDS['head']:.0%}")
        if bad:
            n_red += 1
            print(f"  ✗ {bid:<16} " + " / ".join(bad))
        else:
            print(f"  · {bid:<16} 通过 ← 这只在旧版就达标，本条判据对**它**无区分力")
    ps_red = sum(1 for d, _, _ in sil_pairs(old) if d < THRESHOLDS["sil"])
    print(f"\n  逐只：{n_red}/8 红；剪影：{ps_red}/28 对红")
    if n_red == 0 and ps_red == 0:
        print("  ⚠️ 门槛失效 —— 它是一条恒真的装饰性断言，请抬高后重跑！")
        return 1

    print("\n══ 门槛候选（选档用：要「改前多红、改后 0 红」）══")
    for name, key, thr_key, cands in (
        ("细节密度", "d", "detail", (3.0, 3.5, 4.0, 4.5, 5.0)),
        ("内部细节", "i", "inner", (1.8, 2.0, 2.2, 2.4, 2.6)),
    ):
        print(f"  {name}:")
        for c in cands:
            o = sum(1 for b in IDS if old[b][key] < c)
            n = sum(1 for b in IDS if new_rows[b][key] < c)
            mark = "  ← 现役" if abs(c - THRESHOLDS[thr_key]) < 1e-9 else ""
            print(f"    {c:>4}: 改前红 {o}/8，改后红 {n}/8{mark}")
    print("  剪影差:")
    for c in (900, 1100, 1300, 1500):
        o = sum(1 for d, _, _ in sil_pairs(old) if d < c)
        n = sum(1 for d, _, _ in sil_pairs(new_rows) if d < c)
        mark = "  ← 现役" if c == THRESHOLDS["sil"] else ""
        print(f"    {c:>4}: 改前红 {o}/28，改后红 {n}/28{mark}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
