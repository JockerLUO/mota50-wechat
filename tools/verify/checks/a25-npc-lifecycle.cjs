/**
 * A25 NPC 生命周期：一次性 NPC 说完就走，常驻 NPC 留着；整段一句不丢地排进框里
 *
 * ## 这条判据守的是什么
 *
 * 2026-09-27 起 NPC 分两类（`data/npcs.json` 的 `lifecycle`，引擎见
 * `src/game/engine/step.ts`）：
 *
 *   `once`（智者 / 小偷 / 公主）—— 撞一次，把 `greet` + `talkByFloor[本层]`
 *       作为**一段**一次列完，然后从地图上消失（和「打死怪」「捡走道具」同一套
 *       `removed` 机制）。
 *   `persistent`（商人 / 商店 / 仙子）—— 常驻，每次搭话出一句、逐句轮换。
 *
 * 三类失败**只会在界面上出现**，headless 判据一条都抓不到：
 *
 *   ① **消失没接上**：引擎把 key 记对了、`entityAt` 也不认它了，但渲染层
 *      （`board.syncEntities`）没把它从实体视图里摘掉 —— 画面上人还站在那儿，
 *      再撞那一格却是「走上去」。所以这里读 `board.__sprites()`（**渲染树**），
 *      不是读 `state.removed`。
 *
 *   ② **消失接得太宽**：把「撞过就消失」写成了无条件，商人撞一次也没了 ——
 *      那等于把商人的 12 层货、商店的属性买卖全废掉。所以本判据**必须在同一条里
 *      同时看到「该走的走了」和「该留的还在」**（#16：反向断言要带探针）。
 *      只有一边成立时这条报红，而不是静静通过。
 *
 *   ③ **整段被截断**：一次性 NPC 的段是**多句**（小偷的越狱段 = 4 句 / 实测 8 行），
 *      对话框 `MAX_LINES` 放不下就切尾巴 —— 玩家看不到「后面还有」。
 *      所以这里把**真正画出来的那几行**（`dialogueLines`）拼起来，与数据库里的
 *      整段逐字对撞：折行只切位置、不丢字符，所以两者必须逐字相等。
 *      ⚠️ 这一条不抄 `MAX_LINES`：写死上限会在卡片改高之后变成一条假绿。
 *      ⚠️ 但 A25a 只验**最长的那一个**段（取最长的才能把①③顶到极限），
 *      所以另外有 **A25d** 把**每一段**都过一遍 —— 见那里的注释。
 *
 * ## 为什么用「最长的那一段」当靶子
 *
 * 整段长度是本判据最关心的量，取最长的那个实体才能把①③顶到极限。目标在 Node 侧
 * 从 `data/npcs.json` 选（不写死 id：台词一改，写死的靶子就悄悄不再是最长的那一个）。
 * （2026-09-27 实测：31 个一次性段里最长的就是第 2 层小偷的 4 句 / 8 行。）
 */

const fs = require('node:fs');
const path = require('node:path');
const expect = require('../expect.cjs');

/** 读 NPC 表（Node 侧独立来源：判据的期望值不从游戏运行时取） */
function loadNpcs() {
  return JSON.parse(fs.readFileSync(path.join(expect.ROOT, 'data', 'npcs.json'), 'utf8')).npcs;
}

/** 数据里的 `string | string[]` → 数组 */
const asLines = (v) =>
  typeof v === 'string' ? (v.trim() ? [v] : []) : Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()) : [];

/** 一次性 NPC 在某一层的「段」= greet + 本层 talkByFloor（与 dialogue.ts 的 npcLines 同规） */
const segmentOf = (npc, floor) => [...asLines(npc.greet), ...asLines(npc.talkByFloor?.[String(floor)])];

/**
 * 实体键 —— 与 `src/game/state.ts` 的 `entityKey()` 同格式（`楼层:x:y:类型:id`）。
 *
 * 这里**故意重写一份**（判据的期望值不从被测代码里 import，见 harness 的文件头），
 * 但它同时也是**漂移探测器**：只要格式与引擎不一致，下面读 `talked[key]` 就会拿到
 * `undefined`，A25a 立刻报红并把「框里说的话」与「talked 现有键」一起打出来。
 * 也就是说这处重复**会响**，不是那种「写错了也没人知道」的重复。
 */
const ekey = (floor, x, y, type, id) => `${floor}:${x}:${y}:${type}:${id}`;

async function run(ctx) {
  const { page, check } = ctx;
  const npcs = loadNpcs();

  // 从地图数据里列出全部 NPC 实体，按段长挑靶子
  // （用 `loadFloorEntities()` 而不是 `loadFloors()` —— 后者给的是地形行，没有实体）
  const placed = [];
  for (const [floor, entities] of expect.loadFloorEntities()) {
    for (const e of entities ?? []) {
      if (e.type !== 'npc') continue;
      const npc = npcs[e.id];
      if (!npc) continue;
      const seg = npc.lifecycle === 'once' ? segmentOf(npc, floor) : asLines(npc.talkByFloor?.[String(floor)]);
      placed.push({
        floor,
        id: e.id,
        x: e.x,
        y: e.y,
        lifecycle: npc.lifecycle,
        chars: seg.join('').length,
        seg
      });
    }
  }
  const onceList = placed.filter((p) => p.lifecycle === 'once');
  const persistList = placed.filter((p) => p.lifecycle === 'persistent');
  const onceTarget = [...onceList].sort((a, b) => b.chars - a.chars)[0] ?? null;
  const persistTarget = [...persistList].sort((a, b) => b.chars - a.chars)[0] ?? null;

  if (!onceTarget || !persistTarget) {
    check(
      `A25 NPC 生命周期：地图上要有一次性与常驻两类 NPC 才谈得上验证`,
      false,
      `一次性实体 ${onceList.length} 个、常驻实体 ${persistList.length} 个 —— ` +
        `任何一边为 0 都说明 data/npcs.json 或楼层数据变了，先核对再验`
    );
    return;
  }

  await page.keyboard.press('r'); // 与其它断例同规：先复位（前面的断例会走遍全塔）

  // 键在 Node 侧算好再传进去（`page.evaluate` 里跑的是浏览器上下文，拿不到上面的函数）
  const onceKey = ekey(onceTarget.floor, onceTarget.x, onceTarget.y, 'npc', onceTarget.id);
  const persistKey = ekey(persistTarget.floor, persistTarget.x, persistTarget.y, 'npc', persistTarget.id);

  // ══════════════════════════════════════════════════════════════════
  // ① 一次性 NPC：整段排进框里 → 从渲染树上消失 → 那一格变成可走的空地
  // ══════════════════════════════════════════════════════════════════
  const onceRes = await page.evaluate((t) => {
    const g = window.mota.game;
    const key = t.key;
    const spriteThere = () => g.board.__sprites().some((s) => s.key === key);

    g.__goto(t.floor);
    const spriteBefore = spriteThere();

    const ret = g.__talk(t.id);
    const opened = g.dialogue.isOpen;
    const lines = g.__probe().dialogueLines;
    const bodyRows = g.dialogue.body.children.length;
    const cardH = g.dialogue.cardRect.h;
    const talked = g.__probe().talked[key] ?? 0;
    const spriteAfterTalk = spriteThere();
    g.dialogue.close();

    // 朝它站的那一格迈一步：人走了，这一格就该是「走上去」
    const p = g.__probe().pos;
    const dx = t.x - p.x;
    const dy = t.y - p.y;
    const dir = dx === 1 ? 'right' : dx === -1 ? 'left' : dy === 1 ? 'down' : dy === -1 ? 'up' : null;
    const before = g.__probe();
    const kind = dir ? g.__step(dir) : `站在 ${p.x},${p.y} 而不是 NPC 旁边`;
    const after = g.__probe();

    // 离开这一层再回来：`removed` 是按 `floor:x,y` 记的，换层不该让它复活
    g.__goto(t.floor + 1);
    g.__goto(t.floor);
    const spriteAfterReturn = spriteThere();

    return {
      key,
      ret,
      opened,
      lines,
      bodyRows,
      cardH,
      talked,
      talkedKeys: Object.keys(g.__probe().talked),
      spriteBefore,
      spriteAfterTalk,
      dir,
      kind,
      steps: [before.steps, after.steps],
      pos: [after.pos.x, after.pos.y],
      spriteAfterReturn
    };
  }, { ...onceTarget, key: onceKey });

  const onceBad = [];
  const wantSeg = onceTarget.seg.join('');
  const gotSeg = onceRes.lines.join('');
  if (!onceRes.opened) onceBad.push(`撞上去没开对话框（__talk 返回「${onceRes.ret}」）`);
  if (gotSeg !== wantSeg) {
    // 只差尾巴 = 截断；完全不同 = 台词取值链走错了。
    // ⚠️ 这里**不**下「就是截断」的结论：本条读不到容量（它有意不抄 `MAX_LINES`），
    //    而**数据不同步**（改了 data 忘了 build，铁律 #60）也会长成「旧数据是前缀」的样子。
    //    所以措辞只说事实 + 指向能分辨的那一条（A25d 带容量对照）。
    onceBad.push(
      gotSeg.startsWith(wantSeg)
        ? `框里比数据库多出内容（${gotSeg.length} > ${wantSeg.length} 字）`
        : !gotSeg.length
          ? `框里一行都没有`
          : `整段对不上：应 ${wantSeg.length} 字，画出 ${gotSeg.length} 字 —— 差的是「` +
            `${wantSeg.startsWith(gotSeg) ? wantSeg.slice(gotSeg.length, gotSeg.length + 40) : gotSeg.slice(0, 40)}…」` +
            `（是「装不下被切了尾巴」还是「取错了数据」看 A25d，它带容量对照）`
    );
  }
  if (!onceRes.spriteBefore) onceBad.push(`搭话之前渲染树里就没有这个 NPC（key=${onceRes.key}）—— 前提取错了，断言无效`);
  if (onceRes.talked !== 1) {
    onceBad.push(
      `搭话计数 ${onceRes.talked}（应为 1）—— 键 ${onceRes.key}；` +
        `talked 现在存的键：[${onceRes.talkedKeys.join(' ') || '空'}]`
    );
  }
  if (onceRes.spriteAfterTalk) onceBad.push(`搭话之后 NPC 还画在棋盘上 —— 渲染层没跟上「已移除」`);
  if (onceRes.kind !== 'move') onceBad.push(`人走了之后迈入那一格的 kind=${onceRes.kind}（应为 move）`);
  if (onceRes.steps[1] !== onceRes.steps[0] + 1) onceBad.push(`迈入那一格没有位移：步数 ${onceRes.steps[0]} → ${onceRes.steps[1]}`);
  if (onceRes.pos[0] !== onceTarget.x || onceRes.pos[1] !== onceTarget.y) {
    onceBad.push(`迈入之后停在 (${onceRes.pos})，不是那一格 (${onceTarget.x},${onceTarget.y})`);
  }
  if (onceRes.spriteAfterReturn) onceBad.push(`离开这一层再回来，NPC 又画出来了 —— removed 没有按「楼层:格」记`);
  check(
    `A25a 一次性 NPC 说完就走：第 ${onceTarget.floor} 层 ${onceTarget.id}(${onceTarget.x},${onceTarget.y}) ` +
      `一次列完 ${onceTarget.seg.length} 句 = 框里 ${onceRes.bodyRows} 行（卡片高 ${onceRes.cardH}px）、` +
      `随后从渲染树消失且那一格走得动（步数 ${onceRes.steps[0]} → ${onceRes.steps[1]}）`,
    onceBad.length === 0,
    onceBad.slice(0, 3).join(' ｜ ') || `框里那几行：${onceRes.lines.join(' / ')}`
  );

  // ══════════════════════════════════════════════════════════════════
  // ② 探针：常驻 NPC 撞两次都还在（「消失」没有写成无条件）
  // ══════════════════════════════════════════════════════════════════
  //
  // 与 ① 是同一件事的两面：只有这两半都在，才说明「按 lifecycle 分流」真的做到了。
  // 所以 ① 报红时这一条**必须仍然是绿的**（两份实现各自能跑通，正是它们要分辨的东西）。
  const persistRes = await page.evaluate((t) => {
    const g = window.mota.game;
    const key = t.key;
    const spriteThere = () => g.board.__sprites().some((s) => s.key === key);

    g.__goto(t.floor);
    const first = g.__talk(t.id);
    const line1 = g.__probe().dialogueLines.join('');
    const aliveAfter1 = spriteThere();
    g.dialogue.close();

    const second = g.__talk(t.id);
    const line2 = g.__probe().dialogueLines.join('');
    const aliveAfter2 = spriteThere();
    g.dialogue.close();

    return {
      key,
      first,
      second,
      line1,
      line2,
      aliveAfter1,
      aliveAfter2,
      talked: g.__probe().talked[key] ?? 0
    };
  }, { ...persistTarget, key: persistKey });

  const persistBad = [];
  if (!persistRes.aliveAfter1 || !persistRes.aliveAfter2) {
    persistBad.push(
      `常驻 NPC 在搭话后从棋盘上消失了（第 1 次后 ${persistRes.aliveAfter1 ? '在' : '没了'}、` +
        `第 2 次后 ${persistRes.aliveAfter2 ? '在' : '没了'}）—— 「撞过就消失」被写成了无条件`
    );
  }
  if (persistRes.talked !== 2) persistBad.push(`搭话计数 ${persistRes.talked}（应为 2）`);
  if (!persistRes.line1 || !persistRes.line2) persistBad.push(`台词为空：1=「${persistRes.line1}」2=「${persistRes.line2}」`);
  if (persistRes.line1 === persistRes.line2) {
    persistBad.push(`两次搭话说的是同一句「${persistRes.line1}」—— 常驻 NPC 的轮换没在跑`);
  }
  check(
    `A25b 常驻 NPC 说完还在：第 ${persistTarget.floor} 层 ${persistTarget.id}(${persistTarget.x},${persistTarget.y}) ` +
      `连撞两次都在场，且两次台词不同（「${persistRes.line1.slice(0, 10)}…」→「${persistRes.line2.slice(0, 10)}…」）`,
    persistBad.length === 0,
    persistBad.slice(0, 3).join(' ｜ ')
  );

  // ══════════════════════════════════════════════════════════════════
  // ③ 样本量：两类都要够多（否则 ① ② 是在一两个样本上通过的）
  // ══════════════════════════════════════════════════════════════════
  check(
    `A25c 两类 NPC 都有足够样本：一次性 ${onceList.length} 个实体（${[...new Set(onceList.map((p) => p.id))].join('、')}）｜` +
      `常驻 ${persistList.length} 个实体（${[...new Set(persistList.map((p) => p.id))].join('、')}）`,
    onceList.length >= 20 && persistList.length >= 10,
    `一次性 ${onceList.length} / 常驻 ${persistList.length} —— 任一边太少都说明地图或 NPC 表变了：` +
      `本判据只在「足够多」时才谈得上有代表性`
  );

  // ══════════════════════════════════════════════════════════════════
  // ④ 每一段都塞得进卡片（不只是最长的那一个）
  // ══════════════════════════════════════════════════════════════════
  //
  // 为什么单独一条：① 只验**最长**的那一个段，而面板是 `rows.slice(0, MAX_LINES)`
  // —— 超出的部分**静默丢掉**（玩家看不到「后面还有」）。日后把卡片改矮一点，
  // 最先捅破上限的**不一定**是当时最长的那个段，而 ① 的靶子是按长度自动选的，
  // 只会跟着「最长」跑。
  //
  // 做法上有意避开两件容易腐坏的事：
  //   · **容量不硬编码** —— 拿 40 行长台词喂给真面板，数它画出几行；上限
  //     从此由系统自己报出。写死 9 会在卡片改高之后变成一条**假绿**。
  //   · **折行不重写** —— 把每一段原样交给面板 `open()`，再读它真正画出来的
  //     行（`dialogue.lines`）。在判据里再写一份 wrap 就是同一件事的第二份实现
  //     （#66：动态判据看不见「以后又写了第二份」，而两份各自都能跑通）。
  //
  // ⚠️ 这一条**不用** `__talk`、也不经过 `__goto`：它只碰面板，不碰棋盘与背包，
  //    所以不会污染后面任何判据的状态（对照 #63：调试钩子搬人会弄脏背包）。
  const allSegs = onceList.map((p) => ({
    at: `${p.floor} 层 ${p.id}(${p.x},${p.y})`,
    sentences: p.seg
  }));
  const fitRes = await page.evaluate((segs) => {
    const g = window.mota.game;
    const synthetic = { role: { label: '—', color: 0x888888 } };
    // ① 让面板自己报出容量
    g.dialogue.open({
      ...synthetic,
      name: '容量探针',
      lines: Array.from({ length: 40 }, (_, i) => `容量探针第 ${i + 1} 行`)
    });
    const cap = g.dialogue.body.children.length;
    g.dialogue.close();
    // ② 每一段原样过一遍，逐字对撞
    const over = [];
    let maxRows = 0;
    let maxAt = '';
    for (const s of segs) {
      g.dialogue.open({ ...synthetic, name: '整段探针', lines: s.sentences });
      const rows = g.dialogue.lines;
      const drawn = rows.join('');
      const want = s.sentences.join('');
      g.dialogue.close();
      if (rows.length > maxRows) {
        maxRows = rows.length;
        maxAt = s.at;
      }
      if (drawn !== want) {
        over.push({
          at: s.at,
          rows: rows.length,
          got: drawn.length,
          want: want.length,
          missingTail: want.startsWith(drawn)
        });
      }
    }
    return { cap, over, n: segs.length, maxRows, maxAt };
  }, allSegs);

  check(
    `A25d 每一段都塞得进对话框：${fitRes.n} 个一次性段全部逐字画出（容量 ${fitRes.cap} 行由面板自己报出；` +
      `最长 ${fitRes.maxRows} 行 —— ${fitRes.maxAt}）`,
    fitRes.over.length === 0,
    fitRes.over
      .slice(0, 3)
      .map(
        (o) =>
          `${o.at}：画了 ${o.rows} 行 ${o.got}/${o.want} 字` +
          (o.missingTail ? '（**尾巴被截断**，玩家看不到「后面还有」）' : '（取错了，不是截断）')
      )
      .join(' ｜ ') || `容量 ${fitRes.cap}、最长 ${fitRes.maxRows}`
  );

  // ── 探针验收（2026-09-27，铁律 #38/#59：新判据必须证明它会红）──────────────
  //
  // 造法 —— 把**两段**同时加长到超过容量：`thief.talkByFloor["2"]` 8 → 10 行、
  // `princess.talkByFloor["26"]` 2 → ≥10 行。⚠️ 改 data 之后**必须 rebuild**：
  // 期望值在 Node 侧读 `data/npcs.json`，而 A25a 让**浏览器里**的人说话、读的是
  // `dist/` 里打包的那份副本（#30）—— 不 rebuild 只会量到「数据不同步」这个假红。
  // 探针脚本 `tools/probe-a25d-dialogue-fit.mjs`（`npm run probe:dialogue-fit`；
  // 快照 + 多重还原 + 逐字节复查，铁律 #64）—— 它会写 `data/npcs.json`，
  // 所以**刻意不进 `verify:all`**（同 `probe:prison` / `probe:score-unify`）。
  //
  // 实测：
  //
  //   ❌ A25a 只报 **1** 条 —— 第 26 层 princess(5,5)（靶子按长度**自动换到它**了）
  //   ❌ A25d 报 **2** 条 —— 2 层 thief(3,4)：画 9 行 203/220 字 ｜
  //                          26 层 princess(5,5)：画 9 行 153/221 字
  //                          两条都点出「**尾巴被截断**，玩家看不到『后面还有』」
  //
  // ⇒ 这就是 A25d 不可替代的证据：A25a 的靶子只有**一个**（当下最长的那段），
  //   超限的有两条时它也只说得出第一条；而「**哪几段**装不下」正是修的时候要的清单。
  //   反过来说：若探针下两条报的是**同一条**，那 A25d 就该删掉（#38）。
  //   （同一次探针顺带证明 A25a 的措辞原本把「切了尾巴」与「取错数据」混成一句，已分开。）
}

module.exports = { id: 'a25-npc-lifecycle', title: 'A25 NPC 生命周期：一次性说完就走，常驻留着', run };
