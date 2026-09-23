/**
 * A14 攻击动画：换成挥剑帧，而形体与尺寸不变
 *
 * **正面判据**的样板：只断言「尺寸不变」抓不到「没接上」（不换帧的实现同样尺寸恒定），
 * 所以必须真的观测到 `anim` 出现过 `attack`。这条是「产出素材 / 消费素材」对齐的守卫 ——
 * 挥剑帧曾经画齐了、也有构建期断言，却因为 `refreshHeroTexture()` 只调 `walk` 而从没被消费过。
 *
 * 代码逐字符取自拆分前的 tools/verify-visual.cjs（只做了缩进平移），
 * 所以这里的行号/注释都与那版同源，改断言时不必再回头对旧文件。
 */

async function run(ctx) {
  const { page, check } = ctx;

  // ── A14 攻击动画：换挥剑帧 + 前冲 + 刀光，全程形体与尺寸不变 ──
  //
  // 「攻击时角色会变小」是观感问题，但它有可量的代理量：**精灵的贴图矩形与
  // 落屏宽高**。当年切到挥剑帧之所以出问题，是因为那组 ArMM 帧本身
  // 弓身只剩 17 行、剑尖又顶到底边（bottom_center 锚点下把人抬离地面）。
  //
  // 2026-09-23 勇者改成手绘后，那两条都不成立了（见 board.ts 的
  // `refreshHeroTexture`：四向都是底行恒为 23，行数的变化全来自向上伸的剑），
  // 所以挥剑帧接回来了。判据相应改成：
  //   · `anim` 全程**必须出现过 'attack'** —— 否则就是「帧画了没接上」，
  //     而这正是本次要防的退化（接回来之前，16 帧挥剑素材一直是死的）；
  //   · `size` / `frame` 的**尺寸**仍必须全程只有一个取值 —— 挥剑帧与走路帧
  //     同为 16×26（图集里 64×104），所以「不变小」依然成立；
  //     这里量的是尺寸而不是帧的身份，接帧不会让它红，尺寸变宽才会。
  //   · 过程中 attackFx 的实测包围盒面积 > 0（刀光真的落屏），结束后归零。
  const atk = await page.evaluate(async () => {
    const b = window.mota.game.board;
    const idle = b.__hero();
    const sizes = new Set();
    const frames = new Set();
    const anims = new Set();
    const turn = {};
    let maxLunge = 0;
    let maxFx = 0;
    const key = (o) => (o ? `${o.w}x${o.h}` : 'null');
    for (const dir of ['right', 'left', 'up', 'down']) {
      b.playHeroAttack(dir);
      const t0 = performance.now();
      while (performance.now() - t0 < 340) {
        const h = b.__hero();
        sizes.add(key(h.size));
        frames.add(key(h.frame));
        anims.add(h.anim);
        turn[dir] = turn[dir] ?? h.dir;
        maxLunge = Math.max(maxLunge, Math.abs(h.lunge.x), Math.abs(h.lunge.y));
        maxFx = Math.max(maxFx, h.fxBounds.w * h.fxBounds.h);
        await new Promise((r) => requestAnimationFrame(r));
      }
    }
    const after = b.__hero();
    return {
      idleSize: key(idle.size),
      idleFrame: key(idle.frame),
      sizes: [...sizes],
      frames: [...frames],
      anims: [...anims],
      turn,
      maxLunge,
      maxFx,
      afterAnim: after.anim,
      afterAttacking: after.attacking,
      afterFx: after.fxBounds.w * after.fxBounds.h
    };
  });
  const atkBad = [];
  if (atk.sizes.length !== 1 || atk.sizes[0] !== atk.idleSize) {
    atkBad.push(`挥剑全程落屏尺寸出现 ${atk.sizes.length} 种：${atk.sizes.join(' / ')}（待机是 ${atk.idleSize}）`);
  }
  if (atk.frames.length !== 1 || atk.frames[0] !== atk.idleFrame) {
    atkBad.push(`挥剑全程贴图帧出现 ${atk.frames.length} 种尺寸：${atk.frames.join(' / ')}（待机是 ${atk.idleFrame}）`);
  }
  if (!atk.anims.includes('attack')) {
    atkBad.push(
      `挥剑全程贴的都是走路帧（anim 只出现过 ${atk.anims.join(' / ')}）—— ` +
        `图集里的挥剑帧没被接上，画了就白画`
    );
  }
  if (atk.maxFx <= 0) atkBad.push('挥剑全程 attackFx 的包围盒一直是 0 —— 刀光根本没画出来');
  if (atk.maxLunge <= 1) atkBad.push(`前冲位移最大只有 ${atk.maxLunge.toFixed(2)}px —— 没看出有挥剑动作`);
  if (atk.afterAttacking || atk.afterFx !== 0) {
    atkBad.push(`挥剑结束后没有收干净：attacking=${atk.afterAttacking} fxArea=${atk.afterFx}`);
  }
  if (atk.afterAnim !== 'walk') {
    atkBad.push(`挥剑结束后贴的还是 ${atk.afterAnim} 帧 —— 勇者会定格在举剑造型上`);
  }
  for (const dir of ['right', 'left', 'up', 'down']) {
    if (atk.turn[dir] !== dir) atkBad.push(`朝 ${dir} 挥剑时朝向是 ${atk.turn[dir]}`);
  }
  check(
    `A14 攻击动画：四向挥剑换成挥剑帧（anim=${atk.anims.join('/')}）而形体恒为 ${atk.idleSize}，刀光面积峰值 ${atk.maxFx}px²`,
    atkBad.length === 0,
    atkBad.slice(0, 3).join(' | ') || `尺寸/帧各只有 1 种取值，前冲峰值 ${atk.maxLunge.toFixed(1)}px`
  );

}

module.exports = { id: "a14-attack-anim", title: "A14 攻击动画：换成挥剑帧，而形体与尺寸不变", run };
