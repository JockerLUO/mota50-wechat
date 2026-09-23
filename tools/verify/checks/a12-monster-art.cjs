/**
 * A12 手绘怪物：落屏确实是图集帧
 *
 * 防的是「素材画好了但渲染层退回程序化图形」——那种情况下画面还过得去，
 * 只有比对帧矩形与 MANIFEST 才能发现用的是另一套东西。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, check, MANIFEST, floors, ROOT, fs, path } = ctx;

  // ── A12 手绘怪物：落屏的确实是图集，不是退回的程序化图形 ──
  //
  // 两代手绘共 35 只（MANIFEST 里 src 含「手绘」，清单是**动态**读的，不写死）：
  //   第一代 13 只「名字与素材对不上」：史莱姆族 4、蝙蝠族 3、石人 / 乌贼 / 龙 / 吸血鬼 / 魔王 2；
  //   第二代 22 只人形怪「读不出职业与等级」：守卫 3、骑士 5、法师 6、兽人 3、骷髅 3、幽魂 2。
  // 它们存在的意义就是**换掉**原来那张不符的素材。而渲染层是「有图集用图集，
  // 没有就退回 icons.ts 的程序化图形」—— 一旦退回，这一轮就等于白做，
  // 而画面看上去「还好」，肉眼比对不可靠。`source.uid` 是同一性，一比就知道。
  //
  // 两个独立来源对撞：
  //   期望值：Node 侧读 assets/MANIFEST.json 的 idle[0] + data/floors/*.json 的实体表；
  //   实测值：浏览器里 `board.__sprites()` 报出的落屏纹理 uid 与帧矩形。
  // 判据：
  //   ① 棋盘上没有**任何**怪物走到程序化兜底（uid === null）；
  //   ② 全部怪物共用同一个 source（怪物只有一张 monsters.png）；
  //   ③ 落屏帧矩形与 MANIFEST 里的 idle[0] 一致（图集与运行时同一份坐标）；
  //   ④ 这 6 层里该出现的手绘怪物一只不少地被看见过（抓「改完忘了接进 PROC_MONSTERS」）。
  //
  // 注：`vampire` 与 `demonKingTrue` 在 50 层里没有出场点，只在图集里备着，
  // 所以下面按「这几层实际出现的」来算，不硬要求 13 只全见过。
  const handDrawn = Object.entries(MANIFEST.monsters)
    .filter(([, m]) => String(m.src ?? '').includes('手绘'))
    .map(([id]) => id);
  const SHOWCASE = [1, 14, 15, 35, 45, 50];
  const perFloor = new Map(); // 楼层 → 该层出现的手绘怪物 id
  for (const f of SHOWCASE) {
    const p = path.join(ROOT, 'data/floors', `floor-${String(f).padStart(2, '0')}.json`);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    perFloor.set(
      f,
      (j.entities ?? [])
        .filter((e) => e.type === 'monster' && handDrawn.includes(e.id))
        .map((e) => e.id)
    );
  }
  const seenMon = new Map(); // 手绘怪物 id → uid
  const monUids = new Set(); // 棋盘上出现过的**全部**怪物 uid
  const fellBack = [];
  const frameBad = [];
  for (const f of SHOWCASE) {
    if (perFloor.get(f).length === 0) continue;
    const sprites = await page.evaluate((floor) => {
      window.mota.game.__goto(floor);
      return window.mota.game.board.__sprites();
    }, f);
    const want = new Set(perFloor.get(f));
    for (const s of sprites) {
      if (s.kind !== 'monster') continue;
      monUids.add(s.uid);
      if (s.uid === null) fellBack.push(`第 ${f} 层 ${s.id}`);
      if (!want.has(s.id)) continue;
      // 落屏的必须是 MANIFEST 里 **idle 四帧中的某一帧** —— 不能只对 idle[0]：
      // 渲染层按相位错开取帧，所以拍到哪一帧取决于相位，但对 idle[0]
      // 会得到「明明对却报错」的假红（这条断言第一版就是这么红的）。
      const idle = MANIFEST.monsters[s.id]?.idle ?? [];
      const fw = MANIFEST.monsters[s.id]?.frame;
      const hit = idle.findIndex((fr) => s.frame && fr.x === s.frame.x && fr.y === s.frame.y);
      const sizeOk = s.frame && s.frame.w === (fw?.w ?? 16) && s.frame.h === (fw?.h ?? 16);
      if (hit < 0 || !sizeOk) {
        frameBad.push(
          `第 ${f} 层 ${s.id} 落屏 ${JSON.stringify(s.frame)} / 该怪的 idle ${JSON.stringify(idle)}`
        );
      } else if (!seenMon.has(s.id)) {
        seenMon.set(s.id, { uid: s.uid, frameIdx: hit });
      }
    }
  }
  const shouldSee = [...new Set(SHOWCASE.flatMap((f) => perFloor.get(f)))];
  const notSeen = shouldSee.filter((id) => !seenMon.has(id));
  const uids = [...monUids].filter((u) => u !== null);
  check(
    `A12 手绘怪物：${shouldSee.length} 只全部落在一张图集上（帧 ${MANIFEST.meta.rasterTile}×${MANIFEST.meta.rasterTile} 与 MANIFEST 一致）`,
    handDrawn.length >= 10 &&
      fellBack.length === 0 &&
      frameBad.length === 0 &&
      notSeen.length === 0 &&
      uids.length === 1,
    handDrawn.length < 10
      ? `MANIFEST 里标了「手绘」的怪物只有 ${handDrawn.length} 只，前提不成立`
      : fellBack.length
        ? `这些怪物走了程序化兜底（uid=null）：${fellBack.slice(0, 4).join(' ')}`
        : frameBad.length
          ? `落屏帧与 MANIFEST 不符：${frameBad.slice(0, 3).join(' | ')}`
          : notSeen.length
            ? `这几层里该出现却没在棋子上看见：${notSeen.join(' ')}`
            : uids.length !== 1
              ? `怪物用到了 ${uids.length} 个不同的 source：${uids.join(',')}`
              : `手绘 ${handDrawn.length} 只 / 本组实见 ${shouldSee.length} 只，全部落在 source=${uids[0]}，` +
                `拍到 idle 第 ${[...new Set([...seenMon.values()].map((v) => v.frameIdx))].sort().join('/')} 帧`
  );

}

module.exports = { id: "a12-monster-art", title: "A12 手绘怪物：落屏确实是图集帧", run };
