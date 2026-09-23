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

  // ── A1 / A2 / A3 / A4：逐层比对全部 121 格 ──────────────────────
      const mismatches = [];
  const unknownCells = [];
  const fakeWallRows = [];
  // 变体使用分布由宿主建好，跑完 A1 之后 VERBOSE 汇总要读它。
  const variantUse = ctx.variantUse;
  let cellCount = 0;

  for (const floor of sorted) {
    const rows = floors.get(floor);
    const seen = await page.evaluate((f) => {
      const g = window.mota.game;
      const r = g.__goto(f);
      return { log: r, sigs: g.board.terrainKeys.slice() };
    }, floor);

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
}

module.exports = { id: "a01-terrain", title: "A1 地形键 / A2 假墙不泄漏 / A3 无空键 / A4 变体是活的", run };
