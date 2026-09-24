/**
 * A21 BOSS 占位块：九格都走不进、撞上去即开战、击败后整块恢复通行
 *
 * A5a 量的是**画面**（精灵有没有盖住它宣称占的那几格），这一条量的是**规则**
 * —— 两侧合起来才是玩家要的那个读法：「画出来的范围 == 走不进去的范围」。
 * 出自 `footprint.ts` 文件头那句「占位块必须是规则，不是画法」。
 *
 * 为什么值得三条独立判据（而不是「跑一遍看看」）：
 *
 *   ① **撞块即开战、且一步不走。** 这是「占位块」三个字的本体。
 *      退化形态有两个，症状完全不同：
 *        · 块没生效（格子还是能走进去）→ 玩家能从魔王身上穿过去；
 *        · 开战判据绑在**坐标**上（只认 `(5,3)` 那一格）→ 从别的格子撞上去
 *          什么都不发生，看着像「点击失灵」。
 *      所以样本要**覆盖九格**，而且断言里必须同时有「kind === 'battle'」和
 *      「步数没变」—— 只判前者会放过「先走进去再开战」。
 *
 *   ② **击败后整块恢复通行**，且记账用的是**BOSS 自己那一格**的 key。
 *      这里用第 10 层的骷髅队长真杀一次（给两把圣剑，攻击 210 > 防御 15）：
 *      先迈入**非锚点**格把它打死，再迈入**锚点格**。
 *      如果 `step()` 用查询坐标记账（`10:5:4:monster:…` 而不是
 *      `10:5:3:monster:…`），第二迈会再打一次「已经死了的 BOSS」——
 *      而画面上它早就不在了。这是本判据真正的靶子。
 *
 *   ③ **领域伤害按占位块判定**。`applyAura` 原本用「到 BOSS **坐标**的曼哈顿距离」，
 *      而 BOSS 占 3×3 之后，「站在它正上方一格」到坐标的距离是 3 —— 读起来就是
 *      「站在魔王头顶不吃领域伤害」。实测**没有任何怪同时是 BOSS 又带领域**
 *      （带 aura 的只有初级/高级巫师，都是 1 格），所以这条路只能靠
 *      **临时给魔王挂一个领域**来验 —— 否则「改对了」和「改错了」跑出来一模一样。
 *
 * 数据侧一律从 `data/` 出发（`loadFloors` / `loadFloorEntities` / `bossBlock`），
 * 不 import 渲染层 —— 与其他断例同一条纪律，见 `expect.cjs` 文件头。
 */

/** 四方向，顺序固定（写死而不是遍历对象，输出才可复现） */
const DIRS = [
  { dx: 1, dy: 0, dir: 'right' },
  { dx: -1, dy: 0, dir: 'left' },
  { dx: 0, dy: 1, dir: 'down' },
  { dx: 0, dy: -1, dir: 'up' }
];

function dirFrom(fx, fy, tx, ty) {
  if (tx === fx + 1 && ty === fy) return 'right';
  if (tx === fx - 1 && ty === fy) return 'left';
  if (ty === fy + 1 && tx === fx) return 'down';
  if (ty === fy - 1 && tx === fx) return 'up';
  return null;
}

async function run(ctx) {
  const { page, check, bossBlock, BOSS_TILES, BOSS_IDS, loadFloors, loadFloorEntities } = ctx;

  const floors = loadFloors();
  const entityMap = loadFloorEntities();

  /** 数据里**放置**了几只 BOSS —— 三条判据的存在性探针（一只都没有时它们全是空转） */
  let placed = 0;
  for (const [, list] of entityMap) {
    for (const e of list) if (e.type === 'monster' && BOSS_IDS.includes(e.id)) placed++;
  }

  /**
   * 把勇者摆到 `(floor, x, y)`，朝 `dir` 迈一步，报出这一步的**行为**。
   *
   * `__goto` 会走 `arriveOnFloor`（记账 + 领域结算），所以基线要在它之后取 ——
   * 否则「步数没变」这条判据会把落地的那 +1 步也算进去。
   */
  const stepFrom = (floor, x, y, dir) =>
    page.evaluate(
      ({ f, px, py, d }) => {
        const g = window.mota.game;
        g.__goto(f, px, py);
        const a = g.__probe();
        const before = { steps: a.steps, hp: a.hp, x: a.pos.x, y: a.pos.y };
        const kind = g.__step(d);
        const b = g.__probe();
        return {
          kind,
          before,
          after: { steps: b.steps, hp: b.hp, x: b.pos.x, y: b.pos.y, kills: b.kills },
          lastLog: b.lastLog,
          moved: b.pos.x !== a.pos.x || b.pos.y !== a.pos.y
        };
      },
      { f: floor, px: x, py: y, d: dir }
    );

  // ⚠️ 先把游戏重开：A1~A20 走遍全塔，勇者可能带着一身道具/金币，也可能已经阵亡
  //    （死亡遮罩是满屏 hitArea）。`r` 是游戏自己的重开路径，玩家也是这么复活的。
  //    重开还保证属性回到 10/10/1000 —— 下面第①条要靠「攻击 10 < 骷髅队长防御 15」
  //    来构造「打不动但必须开战」这个局面（于是整条判据里不会夹着真正的伤害）。
  await page.keyboard.press('r');
  await page.waitForTimeout(250);

  // ══════════════════════════════════════════════════════════════════
  // ① 撞块即开战、且一步不走（第 10 层骷髅队长，九格全覆盖）
  // ══════════════════════════════════════════════════════════════════
  //
  // 挑第 10 层是因为它的占位块**贴着墙**（四角是 `#`、两侧是门 `a`），
  // 只有上下几格能站人 —— 如果判据不小心写成「占位块里的每一格都能从外面撞到」，
  // 它会在这里红，而不是在空旷的第 50 层「看起来没问题」。
  const F10 = 10, B10 = { x: 5, y: 3 };
  const block10 = bossBlock(B10.x, B10.y);
  const terr10 = floors.get(F10);
  const ents10 = new Set(
    (entityMap.get(F10) ?? [])
      .filter((e) => !(e.type === 'monster' && e.id === 'skeletonCaptain'))
      .map((e) => `${e.x},${e.y}`)
  );
  const inBlock10 = (x, y) =>
    x >= block10.x0 && x <= block10.x1 && y >= block10.y0 && y <= block10.y1;
  const free10 = (x, y) =>
    x >= 0 && y >= 0 && x <= 10 && y <= 10 && terr10[y][x] === '.' && !ents10.has(`${x},${y}`);

  // 样本怎么取：对占位块里**每一格**，优先站到它紧贴块外的邻居上朝里迈
  //（这才是玩家真能做的动作）；块里有些格（例如锚点，以及被墙围住的那种）
  // 外侧一个可站的邻居都没有 —— 那就退而站到**块内**的邻居上（`__goto` 不做
  // 合法性校验，能直接摆进去）。两种样本都只量「迈进去会不会开战」，
  // 所以退化的那种一样有效：它验的是 `entityAt` 认不认这一格。
  //
  // ⚠️ 第 10 层的块贴着墙（两侧是门 `a`、四角是 `#`），(4,3) 与 (6,3) 两格
  //    外侧一个可站的邻居都没有 —— 少了这段退化逻辑，覆盖数就只有 7/9，
  //    判据会在「看着好像修好了」的时候红。
  const samples = [];
  for (let y = block10.y0; y <= block10.y1; y++) {
    for (let x = block10.x0; x <= block10.x1; x++) {
      const outside = [];
      const inside = [];
      for (const v of DIRS) {
        const nx = x - v.dx, ny = y - v.dy; // 站在 (nx,ny) 朝格内迈
        const d = dirFrom(nx, ny, x, y);
        if (!d) continue;
        if (inBlock10(nx, ny)) inside.push({ cell: [x, y], from: [nx, ny], dir: d, where: '块内' });
        else if (free10(nx, ny)) outside.push({ cell: [x, y], from: [nx, ny], dir: d, where: '块外' });
      }
      samples.push(...(outside.length ? outside : inside));
    }
  }

  const crashBad = [];
  const covered = new Set();
  for (const s of samples) {
    const r = await stepFrom(F10, s.from[0], s.from[1], s.dir);
    covered.add(`${s.cell[0]},${s.cell[1]}`);
    if (r.kind !== 'battle') {
      crashBad.push(`从 (${s.from}${s.where}) 朝 (${s.cell}) 迈：kind=${r.kind}（不是 battle）`);
    }
    if (r.after.steps !== r.before.steps || r.moved) {
      crashBad.push(
        `从 (${s.from}${s.where}) 朝 (${s.cell}) 迈：开战时不该移动，但步数 ${r.before.steps} → ` +
          `${r.after.steps}、位置 (${r.before.x},${r.before.y}) → (${r.after.x},${r.after.y})`
      );
    }
  }
  // 探针：九格必须**全覆盖**。样本集为空或漏格时，上面那圈断言会静静地通过。
  const coveredOk = covered.size === 9;
  const a21aOk = crashBad.length === 0 && coveredOk && placed > 0;
  check(
    `A21a 撞上占位块即开战且一步不走：第 10 层骷髅队长 ${BOSS_TILES}×${BOSS_TILES} 块 ` +
      `x${block10.x0}..${block10.x1} y${block10.y0}..${block10.y1}，` +
      `${samples.length} 个样本覆盖 ${covered.size}/9 格（数据里 BOSS ${placed} 只）`,
    a21aOk,
    (crashBad.length ? `${crashBad.length} 个样本不对，前 3：${crashBad.slice(0, 3).join(' ｜ ')}` : '') +
      (placed === 0
        ? `${crashBad.length ? ' ｜ ' : ''}断言无效：data/floors 里一只 BOSS 都没放置`
        : coveredOk
          ? crashBad.length
            ? ''
            : `全部 ${samples.length} 个样本都开出战斗且原地不动`
          : `${crashBad.length ? ' ｜ ' : ''}断言无效：只覆盖了 ${covered.size}/9 格占位块 ` +
            `—— 漏格说明样本集没取全（贴着墙的块里，有些格在外侧一个可站的邻居都没有）`)
  );

  // ══════════════════════════════════════════════════════════════════
  // ② 击败后整块恢复通行（记账必须用 BOSS 自己那一格）
  // ══════════════════════════════════════════════════════════════════
  //
  // 给两把圣剑：攻击 10 → 210 > 骷髅队长防御 15，100 血一击必杀；
  // 它反击一次 65-10 = 55，远小于 1000 生命，所以这局打得赢。
  // 「真杀一次」而不是直接往 `removed` 里塞 key，是因为要验的正是
  // **引擎自己怎么写这个 key**。
  const after = await page.evaluate(
    ({ f, anchor, below }) => {
      const g = window.mota.game;
      g.__grant('sacredSword');
      g.__grant('sacredSword');
      const atk = g.__probe().atk;
      g.__goto(f, below[0], below[1]);
      const a = g.__probe();
      // 第 1 迈：从下方迈入**非锚点**格 (5,4) —— BOSS 挡在这里，打
      const k1 = g.__step('up');
      const b = g.__probe();
      // 第 2 迈：继续迈入**锚点格** (5,3)。BOSS 已经死了，这一步必须走得动
      const k2 = g.__step('up');
      const c = g.__probe();
      // 第 3 迈：再往里走一格（(5,2) 也在占位块里）
      const k3 = g.__step('up');
      const d = g.__probe();
      return {
        atk,
        anchor,
        kill: {
          kind: k1,
          steps: [a.steps, b.steps],
          hp: [a.hp, b.hp],
          kills: [a.kills, b.kills],
          log: b.lastLog
        },
        anchorStep: {
          kind: k2,
          steps: [b.steps, c.steps],
          hp: [b.hp, c.hp],
          pos: [c.pos.x, c.pos.y],
          log: c.lastLog
        },
        deepStep: { kind: k3, steps: [c.steps, d.steps], hp: [c.hp, d.hp], pos: [d.pos.x, d.pos.y] }
      };
    },
    { f: F10, anchor: [B10.x, B10.y], below: [B10.x, block10.y1 + 1] }
  );

  const passBad = [];
  if (after.kill.kind !== 'battle') {
    passBad.push(`迈入占位块非锚点格时 kind=${after.kill.kind}（应当是 battle，攻击 ${after.atk} 对 100 血）`);
  }
  if (after.kill.kills[1] !== after.kill.kills[0] + 1 || !/击败/.test(String(after.kill.log))) {
    passBad.push(
      `迈入非锚点格没有击杀记录：击杀数 ${after.kill.kills[0]} → ${after.kill.kills[1]}、` +
        `lastLog=${JSON.stringify(after.kill.log)}`
    );
  }
  if (after.anchorStep.kind !== 'move') {
    passBad.push(
      `BOSS 死后迈入**锚点格** (${after.anchor}) 的 kind=${after.anchorStep.kind} —— 不是 move。` +
        `多半是记账用了「查询坐标」而不是 BOSS 自己那一格，于是它「打死了却还在」`
    );
  }
  if (
    after.anchorStep.steps[1] !== after.anchorStep.steps[0] + 1 ||
    after.anchorStep.hp[0] !== after.anchorStep.hp[1]
  ) {
    passBad.push(
      `迈入锚点格：步数 ${after.anchorStep.steps[0]} → ${after.anchorStep.steps[1]}、` +
        `生命 ${after.anchorStep.hp[0]} → ${after.anchorStep.hp[1]}（应当刚好走一步、不再掉血）`
    );
  }
  if (after.deepStep.kind !== 'move' || after.deepStep.steps[1] !== after.deepStep.steps[0] + 1) {
    passBad.push(
      `再往里走一格（仍在占位块内）kind=${after.deepStep.kind}、步数 ` +
        `${after.deepStep.steps[0]} → ${after.deepStep.steps[1]} —— 整块没有全部恢复通行`
    );
  }
  check(
    `A21b 击败后整块恢复通行：攻击 ${after.atk} 击杀第 10 层骷髅队长后，` +
      `从非锚点格一路走进块内（步数 ${after.kill.steps[0]} → ${after.deepStep.steps[1]}、` +
      `停在 (${after.deepStep.pos})）`,
    passBad.length === 0,
    passBad.slice(0, 3).join(' | ') || `击杀日志：${after.kill.log}`
  );

  // ══════════════════════════════════════════════════════════════════
  // ③ 领域伤害按占位块判定（第 50 层魔王，临时挂一个 aura）
  // ══════════════════════════════════════════════════════════════════
  //
  // 「站在占位块正上方」= (4,3)：到占位块最近的一格 (4,4) 距离 1（贴块），
  // 到魔王**坐标** (5,5) 的距离是 1+2=3。老判据（按坐标）在这里**不扣血**，
  // 新判据（按占位块）必须扣 —— 所以这一格就是这条判据的靶心。
  // 对照格 (3,3)：到占位块距离 2，两边都不该扣血（否则判据被放得太宽）。
  const AURA_DMG = 7;
  const aura = await page.evaluate(
    ({ f, near, far, dmg }) => {
      const g = window.mota.game;
      const mon = g.data.monsters.demonKing;
      const backup = mon.traits;
      mon.traits = [{ type: 'aura', range: 1, damage: dmg }];
      // 每次先取基线再 `__goto`：`arriveOnFloor` 里就有一次领域结算，
      // 所以「掉了几血」只能拿**它前后**的差，不能拿累计的 hpLost。
      const at = (p) => {
        const a = g.__probe();
        g.__goto(f, p[0], p[1]);
        const b = g.__probe();
        return { loss: a.hp - b.hp, hpLost: b.hpLost - a.hpLost, log: b.lastLog, pos: [b.pos.x, b.pos.y] };
      };
      const n = at(near);
      const f2 = at(far);
      // 复原：这份数据是构建期烘进 bundle 的**同一个对象**，
      // 不还回去会把「魔王带领域」这件事泄漏给后面的运行
      if (backup === undefined) delete mon.traits;
      else mon.traits = backup;
      return { near: n, far: f2 };
    },
    { f: 50, near: [4, 3], far: [3, 3], dmg: AURA_DMG }
  );

  const auraBad = [];
  if (aura.near.loss !== AURA_DMG || aura.near.hpLost !== AURA_DMG) {
    auraBad.push(
      `站在占位块正上方 (4,3) 掉了 ${aura.near.loss} HP（应当 ${AURA_DMG}；账上 ${aura.near.hpLost}）` +
        `—— 领域伤害还在按 BOSS 的**坐标**算曼哈顿距离，而站在那里到坐标的距离是 3`
    );
  }
  if (!/巫师领域/.test(String(aura.near.log))) {
    auraBad.push(`(4,3) 没有领域日志（lastLog=${JSON.stringify(aura.near.log)}）`);
  }
  if (aura.far.loss !== 0) {
    auraBad.push(
      `离占位块两格的 (3,3) 也掉了 ${aura.far.loss} HP —— 判据被放得太宽` +
        `（领域只该贴到块外侧那一圈）`
    );
  }
  check(
    `A21c 领域伤害贴的是占位块：${BOSS_TILES}×${BOSS_TILES} 块正上方一格（距 BOSS 坐标 3 格）` +
      `损失 ${aura.near.loss} HP，离块两格不掉血`,
    auraBad.length === 0,
    auraBad.slice(0, 3).join(' | ') || `贴块 -${AURA_DMG}（日志：${aura.near.log}）、离块两格 -0`
  );
}

module.exports = {
  id: 'a21-boss-footprint',
  title: 'A21 BOSS 占位块：九格都走不进、撞上去即开战、击败后整块恢复通行',
  run
};
