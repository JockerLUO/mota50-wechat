/**
 * A20 待机呼吸是渲染层的刚体位移
 *
 * 素材只出**静止帧**（有构建期断言），位移在渲染层做刚体位移。
 * 素材里做上下错位必然要补偿接缝，而三种补偿全在改像素形状 ——
 * 那正是玩家说的「抖动时出现压缩」。所以这里守的是「呼吸期间贴图 uid、帧矩形、
 * 落屏高度全程恒定，且只上抬 1px」。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, check, floors, ROOT, fs, path } = ctx;

  /**
   * A20 的采样窗口（ms）。
   *
   * 必须**盖住一个完整呼吸周期**，否则会拍到「一直在原位」的实体，假红成
   * 「呼吸没生效」。渲染层的周期见 board.ts：怪物 1300ms、NPC 2100ms ——
   * 取 2800 是为了给 NPC 留出余量（它的相位可能刚好从「刚落回」开始，
   * 窗口只比周期大一点点时余量会被相位吃掉；这里是 2100 的 1.33 倍）。
   *
   * ⚠️ board.ts 里那两个周期**一改就要回来同步这个值**。漏同步的后果是一条
   * 很难看的假红：A20 报「某个实体一次都没动」，而实现其实完全正常。
   */
  const BOB_WINDOW_MS = 2800;

  // ── A20 待机呼吸 = 渲染层的刚体位移，素材不参与 ──
  //
  // 玩家连着两轮报「抖动时出现压缩，应该是图层层级造成的」。根因确实在图层 ——
  // 但在**素材**那一层：idle 曾被做成 4 帧「上半身整体上移 1 行 + 用下摆首行
  // 填住腰上的缝」，补的那一行读出来就是压缩；手绘怪物更糟，它们的内容顶满画布
  // （kraken/knight/wraith 实测 0..31），上移 2 行 = 直接裁掉头顶 2 行。
  //
  // 现在素材每只怪 / 每个 NPC 的 idle 只有 **1 帧静止图**
  // （tools/assetlib/monsters.py + npc.py 的
  // `mon_art_frames` / `npc_art_frames` 各有一条「帧数必须为 1」的断言），
  // 呼吸由 board.ts 把整只精灵抬起 0/1 个落屏像素 —— 刚体位移不改任何像素的形状。
  //
  // 这条断言只读屏幕上的精灵，不看代码：
  //   ① 贴图 uid 与帧矩形全程不变 —— 素材真的没参与动画（回到多帧会立刻红）；
  //   ② 落屏高度全程不变 —— 没有压缩/拉伸（**正是玩家报的那个症状**）；
  //   ③ spriteY 至多两档、且相差恰好 1px —— 是位移，不是缩放；
  //   ④ 两档都出现过 —— 否则「呼吸压根没动」也会假绿；
  //   ⑤ 怪物与 NPC 两种实体都要采到 —— 只验一种等于只修了一半。
  //
  // ⚠️ 采样按 `key` 分组而不是 `id`：同一层可能有好几只同 id 的怪（相位不同），
  //    按 id 合并会把不同实体的 y 混在一起，误判成「位移有 N 档」。
  // ⚠️ 窗口必须盖住一个完整周期（NPC 2400ms），否则会拍到「一直在原位」的假红。
  const floorsDir = path.join(ROOT, 'data/floors');
  let monFloor = null;
  let npcFloor = null;
  if (fs.existsSync(floorsDir)) {
    for (const f of fs.readdirSync(floorsDir).sort()) {
      const j = JSON.parse(fs.readFileSync(path.join(floorsDir, f), 'utf8'));
      const es = j.entities ?? [];
      const n = Number((f.match(/floor-(\d+)/) ?? [])[1]);
      if (!Number.isFinite(n)) continue;
      if (monFloor === null && es.some((e) => e.type === 'monster')) monFloor = n;
      if (npcFloor === null && es.some((e) => e.type === 'npc')) npcFloor = n;
      if (monFloor !== null && npcFloor !== null) break;
    }
  }
  const bobProbe =
    monFloor !== null && npcFloor !== null
      ? await page.evaluate(
          async ({ mon, npc, ms }) => {
            const b = window.mota.game.board;
            const run = async (floor) => {
              window.mota.game.__goto(floor);
              const acc = new Map();
              const t0 = performance.now();
              await new Promise((res) => {
                const tick = () => {
                  for (const s of b.__sprites()) {
                    if (s.kind === 'item' || !s.id) continue;
                    if (s.spriteY === null || s.spriteH === null) continue; // 隐藏实体没有精灵
                    let a = acc.get(s.key);
                    if (!a) {
                      a = { id: s.id, kind: s.kind, uids: new Set(), frames: new Set(), hs: new Set(), ys: new Set() };
                      acc.set(s.key, a);
                    }
                    a.uids.add(String(s.uid));
                    a.frames.add(
                      s.frame ? `${s.frame.x},${s.frame.y},${s.frame.w},${s.frame.h}` : 'null'
                    );
                    a.hs.add(Math.round(s.spriteH * 100) / 100);
                    a.ys.add(Math.round(s.spriteY * 100) / 100);
                  }
                  if (performance.now() - t0 < ms) requestAnimationFrame(tick);
                  else res();
                };
                requestAnimationFrame(tick);
              });
              return [...acc.values()].map((a) => ({
                id: a.id,
                kind: a.kind,
                uids: [...a.uids],
                frames: [...a.frames],
                hs: [...a.hs],
                ys: [...a.ys].sort((x, y) => x - y)
              }));
            };
            return [...(await run(mon)), ...(await run(npc))];
          },
          { mon: monFloor, npc: npcFloor, ms: BOB_WINDOW_MS }
        )
      : null;

  const bobBad = [];
  if (!bobProbe) {
    bobBad.push('找不到「有怪物」与「有 NPC」的楼层，无法采样呼吸');
  } else {
    const kinds = new Set();
    for (const s of bobProbe) {
      kinds.add(s.kind);
      if (s.uids.length !== 1) {
        bobBad.push(`${s.id} 呼吸期间换了贴图（uid ${s.uids.length} 种）—— 素材又参与动画了`);
      }
      if (s.frames.length !== 1) {
        bobBad.push(`${s.id} 呼吸期间帧矩形变了：${s.frames.join(' / ')}`);
      }
      if (s.hs.length !== 1) {
        bobBad.push(`${s.id} 呼吸期间落屏高度变了 ${s.hs.join(' / ')} —— 这就是「压缩」`);
      }
      if (s.ys.length > 2) {
        bobBad.push(`${s.id} 呼吸位移出现 ${s.ys.length} 档：${s.ys.join(' / ')}`);
      } else if (s.ys.length === 2 && Math.abs(s.ys[1] - s.ys[0]) !== 1) {
        bobBad.push(`${s.id} 呼吸位移幅度 ${Math.abs(s.ys[1] - s.ys[0])}px，应为 1px`);
      } else if (s.ys.length < 2) {
        bobBad.push(`${s.id} 在 ${BOB_WINDOW_MS}ms 里一次都没动 —— 呼吸没生效`);
      }
    }
    if (!kinds.has('monster') || !kinds.has('npc')) {
      bobBad.push(`只采到 ${[...kinds].join('/')} —— 怪物与 NPC 两种都要验`);
    }
  }
  const bobN = bobProbe ? bobProbe.length : 0;
  check(
    `A20 待机呼吸：${bobN} 个实体全程贴图/帧高不变，只在原位上抬 1px（怪物 + NPC 都验）`,
    bobBad.length === 0,
    bobBad.slice(0, 3).join(' | ') ||
      `采到 ${bobN} 个实体（第 ${monFloor} 层怪物 / 第 ${npcFloor} 层 NPC），` +
        `一整个周期内贴图 uid、帧矩形、落屏高度恒定`
  );

}

module.exports = { id: "a20-idle-bob", title: "A20 待机呼吸是渲染层的刚体位移", run };
