/**
 * A1 地形键 / A2 假墙不泄漏 / A3 无空键 / A4 变体是活的
 *
 * 全塔 51 层 × 121 格逐格对照：渲染树里的键 vs 本文件在 Node 侧独立重实现的规则。
 * A2 盯的是**隐藏通路设计**：`w` 格必须与「同位置真墙」走同一条规则，否则玩家能看破假墙。
 * A4 防的是「变体函数写对了但没被调用」那类假绿。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, check, MANIFEST, VARIANT_COUNT, variantIndex, terrainKeyFor, isWallChar, renderChar, floors, sorted, VERBOSE } = ctx;

  // ── A1 / A2 / A3 / A4 / A1b：逐层比对全部 121 格 ──────────────────────
      const mismatches = [];
  const unknownCells = [];
  const fakeWallRows = [];
  // 变体使用分布由宿主建好，跑完 A1 之后 VERBOSE 汇总要读它。
  const variantUse = ctx.variantUse;
  let cellCount = 0;

  // A1b 的输入：`__goto` 绕塔一圈**不许改背包**（理由见下面的断言）
  const bagAtStart = await page.evaluate(() => window.mota.game.__probe().bag.join());
  let bagPrev = bagAtStart;
  const bagLeaks = [];

  for (const floor of sorted) {
    const rows = floors.get(floor);
    const seen = await page.evaluate((f) => {
      const g = window.mota.game;
      const r = g.__goto(f);
      return { log: r, sigs: g.board.terrainKeys.slice(), bag: g.__probe().bag.join() };
    }, floor);

    if (seen.bag !== bagPrev) {
      bagLeaks.push({ floor, from: bagPrev || '（空）', to: seen.bag || '（空）' });
      bagPrev = seen.bag;
    }

    if (/^未知|^没有|失败/.test(String(seen.log))) {
      mismatches.push({ floor, why: `__goto 失败：${seen.log}` });
      continue;
    }

    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 11; x++) {
        const idx = y * 11 + x;
        const ch = rows[y]?.[x];
        if (ch === undefined) {
          mismatches.push({ floor, x, y, why: `地图缺这一格` });
          continue;
        }
        cellCount++;
        const wallAbove = y > 0 && isWallChar(rows[y - 1][x]);
        const key = terrainKeyFor(ch, wallAbove);
        const expect =
          key === null
            ? `?${renderChar(ch)}`
            : `${key}#${variantIndex(x, y, floor, VARIANT_COUNT(key))}`;
        const actual = seen.sigs[idx];

        if (actual !== expect) {
          mismatches.push({ floor, x, y, ch, expect, actual });
        }
        if (String(actual).startsWith('?')) {
          unknownCells.push({ floor, x, y, ch, actual });
        }
        if (key !== null && variantUse[key]) {
          const vi = variantIndex(x, y, floor, VARIANT_COUNT(key));
          const m = variantUse[key];
          m.set(vi, (m.get(vi) || 0) + 1);
        }
        if (ch === 'w') {
          fakeWallRows.push({ floor, x, y, aboveIsWall: y > 0 ? isWallChar(rows[y - 1][x]) : false, sig: actual, expect });
        }
      }
    }
  }

  check(
    `A1 地形键：全塔 ${cellCount} 格逐一与独立推导对照`,
    mismatches.length === 0,
    mismatches.length === 0
      ? `${sorted.length} 层 × 121 格全部一致`
      : `不一致 ${mismatches.length} 处，前 3：${JSON.stringify(mismatches.slice(0, 3))}`
  );

  // 假墙里「上方不是墙」的那批才是命门：它们必须拿到 1:top，
  // 而真墙在该位置也会拿到 1:top —— 两者一致，才挑不出来。
  const exposed = fakeWallRows.filter((r) => !r.aboveIsWall);
  const fakeBad = fakeWallRows.filter((r) => r.sig !== r.expect);
  check(
    `A2 假墙不泄漏：${fakeWallRows.length} 面假墙与同位置真墙规则一致`,
    fakeBad.length === 0,
    fakeBad.length === 0
      ? `其中 ${exposed.length} 面「上方无墙」的假墙已正确拿到 1:top 压顶（隐藏通路的关键）`
      : `有 ${fakeBad.length} 面假墙与真墙不同，前 3：${JSON.stringify(fakeBad.slice(0, 3))}`
  );

  check(
    'A3 无空键：没有任何格子落到「未映射」兜底态',
    unknownCells.length === 0,
    unknownCells.length === 0
      ? '全部格子都拿到了 MANIFEST 里的地形键'
      : `${unknownCells.length} 格未映射，例如 ${JSON.stringify(unknownCells.slice(0, 3))}`
  );

  const floorVars = variantUse['0'].size;
  const wallVars = variantUse['1'].size;
  check(
    `A4 变体是活的：地面用到 ${floorVars} 种变体、墙身 ${wallVars} 种`,
    floorVars >= 2 && wallVars >= 2,
    `MANIFEST 声明 地面 ${VARIANT_COUNT('0')} 种 / 墙身 ${VARIANT_COUNT('1')} 种；` +
      `实际各用到 ${floorVars} / ${wallVars} 种` +
      (floorVars < 2 || wallVars < 2 ? '（只用到 1 种说明变体路径没生效）' : '')
  );

  // ── A1b 调试传送不改背包 ──
  //
  // 为什么单独立一条：`__goto` 走的是 `nearestStandable()` + `arriveOnFloor()`，
  // 而 `arriveOnFloor()` 会**落地即拾取**（官方规则「走到物品上自动拾起获得」。
  // 见 travel.ts 的 pickUpAt）。两件事叠起来的时候，`__goto(37)` 正好落在放着
  // 炸弹的 (4,4) 上 —— 于是「看一眼第 37 层」就把炸弹收进了背包。
  //
  // 而这条链子是**跨文件的**：A01 弄脏背包 → 十来个判据之后 A11 的
  // 「空背包不占位」变红，报告上完全看不出是谁干的。本轮就是这么踩的：
  // 排查从「道具栏坏了」一路追到「第 37 层的落点」才找到。
  // ⇒ 调试钩子的契约是**只搬人**，这条把它钉在离事故最近的地方。
  check(
    `A1b 调试传送不改背包：逐层 __goto 走完 ${sorted.length} 层，背包始终为「${bagAtStart || '空'}」`,
    bagLeaks.length === 0,
    bagLeaks.length === 0
      ? `起点「${bagAtStart || '空'}」→ 终点「${bagPrev || '空'}」全程未变`
      : `有 ${bagLeaks.length} 层改变了背包：${JSON.stringify(bagLeaks.slice(0, 3))}` +
        '（多半是 __goto 的落点压上了道具 —— 检查 nearestStandable 的 avoidEntities 口径）'
  );
}

module.exports = { id: "a01-terrain", title: "A1 地形键 / A2 假墙不泄漏 / A3 无空键 / A4 变体是活的", run };
