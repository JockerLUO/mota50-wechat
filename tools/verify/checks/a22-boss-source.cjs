/**
 * A22 BOSS 图集来自**当前**这批源图
 *
 * ## 这条判据守的是什么
 *
 * BOSS 素材的画法由 `data/constants.json` 的 `boss.artSource` 决定。取
 * `"imported"` 时，源图住在 `assets/raw/boss/*.png`，构建期把它们的
 * **SHA-256 记进 `assets/MANIFEST.json`**（每只一条 `monsters[id].source.sha256`）。
 *
 * 于是「图集是不是由现在这批源图生成的」是一条**可计算的等式**：
 *
 *     现算的 assets/raw/boss/<file> 的 sha256  ==  MANIFEST 里记的那个
 *
 * 不相等 = 中间有一次「改了源图但没重跑 npm run assets」。
 *
 * ## 为什么这条必须存在（不相等时的症状极具欺骗性）
 *
 * 这一族事故本项目已经踩过一次（见 铁律 #2 与坑「图集只是 copyFileSync 的副本」）：
 * **无报错、`atlas.ready === true`、棋盘完整、只是画的是上一版素材**。
 * 用眼睛看是「改了没生效」，用这套等式看是一行红字。
 *
 * ⚠️ **必须用内容哈希，不能用 mtime**：checkout / `cp` / 打包都会把 mtime 抹平成
 * 「都是刚才」，而内容没变。反过来 mtime 也会骗人（`touch` 一下就当改过）。
 *
 * ## 与 A5a / A17 / A21 的分工
 *
 * 那三条管「帧摆在哪、多大、占几格」；这条管「帧是**哪来的**」。
 * 帧的来源换掉而尺寸不变时，只有这条会红 —— 上一版 BOSS 从 64 网格换成 96 网格
 * 时，`src` 那一栏仍然写着「本仓库手绘」，正是这条要变成硬断言的理由。
 */

const crypto = require('node:crypto');
const nodeFs = require('node:fs');

/** 与 tools/assetlib/bosses/imported.py 的 SOURCES 表同源（数量由探针兜底）。 */
const SOURCE_DIR_REL = 'assets/raw/boss';

function sha256(file) {
  return crypto.createHash('sha256').update(nodeFs.readFileSync(file)).digest('hex');
}

async function run(ctx) {
  const { check, MANIFEST, ROOT, fs, path, BOSS_IDS } = ctx;

  const monsters = MANIFEST.monsters ?? {};
  const kinds = new Set();
  const missingField = [];
  const missingFile = [];
  const hashBad = [];
  const hashes = [];
  const names = [];

  for (const bid of BOSS_IDS) {
    const node = monsters[bid];
    const src = node && node.source;
    if (!src || typeof src.kind !== 'string') {
      missingField.push(bid);
      continue;
    }
    kinds.add(src.kind);
    if (src.kind !== 'imported') continue;

    const abs = path.join(ROOT, 'assets', src.file ?? '');
    if (!src.file || !fs.existsSync(abs)) {
      missingFile.push(`${bid} → ${src.file}`);
      continue;
    }
    const live = sha256(abs);
    hashes.push(live);
    names.push(src.originalName ?? bid);
    if (live !== src.sha256) hashBad.push(`${bid}（MANIFEST ${String(src.sha256).slice(0, 12)}… 现算 ${live.slice(0, 12)}…）`);
  }

  // ── 探针（铁律 #17）──────────────────────────────────────────────
  //
  // 这条判据最典型的假绿是「字段改了名」：`monsters[id].source` 找不到 →
  // 循环里每只都 `continue` → 一条不等都没比 → 判据恒真。
  // 所以先数一遍**到底比对了几只**，不够就报红而不是跳过。
  // 本判据实际比对了几只（探针用；`imported` 分支下应为 8）
  const importedCount = hashes.length + hashBad.length + missingFile.length;
  check(
    'A22a BOSS 来源字段齐备（8 只都要有 source，且 kind 一致）',
    missingField.length === 0 && kinds.size === 1,
    missingField.length
      ? `缺 source 字段：${missingField.join(', ')} —— 字段改名会让本判据整条空转`
      : `kind = ${[...kinds].join(',')}，8 只齐备`
  );

  if (kinds.size === 1 && kinds.has('imported')) {
    check(
      'A22b 源图文件都在（MANIFEST 记的路径能打开）',
      missingFile.length === 0,
      missingFile.length ? missingFile.slice(0, 3).join(' | ') : `${importedCount} 个源图文件全部存在（${SOURCE_DIR_REL}/）`
    );

    check(
      'A22c 图集由**当前**源图生成（内容哈希逐只相等）',
      hashBad.length === 0 && hashes.length === BOSS_IDS.length,
      hashBad.length
        ? `${hashBad.slice(0, 3).join(' | ')} —— 源图改过但没重跑 npm run assets（症状：画的是上一版素材）`
        : `${hashes.length} 只逐只相等（sha256）`
    );

    // 八只必须来自**八张不同的图**：全都指向同一张时，上面那条照样全绿
    const uniq = new Set(hashes);
    check(
      'A22d 八只 BOSS 来自八张不同的源图（探针：哈希去重后仍是 8）',
      uniq.size === BOSS_IDS.length,
      uniq.size === BOSS_IDS.length
        ? `${uniq.size} 张互不相同`
        : `只用到 ${uniq.size} 张源图（${names.join(' / ')}）—— 登记表串了`
    );
  } else if (kinds.size === 1) {
    check(
      'A22b/c/d 当前画法是 drawn，不适用（但要有人真的看到这句话）',
      true,
      `artSource=drawn：BOSS 帧由 tools/assetlib/bosses/ 的手绘模块产出，没有外部源图可对拍 —— ` +
        `这条不是跳过，而是「换了画法之后本判据自动退场」的显式记录`
    );
  }
}

module.exports = { id: 'A22', title: 'BOSS 图集来自当前源图', run };
