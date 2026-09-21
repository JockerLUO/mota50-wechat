/**
 * 商店与经济模型 —— 原版《魔塔50层》
 *
 * 价格公式：10·n·(n−1) + 20，n 为已购买次数（从 1 起）
 * 收益公式：增量 × tierMul，tierMul = floor(层数 / 10) + 1
 *
 * 关键设计洞察：增量随楼层放大，价格却只与总购买次数有关，与楼层无关。
 * 于是「同样的钱，在高楼层买收益是低楼层的数倍」——这就是原版最优策略
 * 「前期别买、把钱留到后面」的数学来源，也解释了攻略里那句
 * 「1-10层不需进商店买攻防，省钱以后可多买」。
 *
 * 依赖 data/constants.json 的 shop 段。
 */

/** 第 n 次购买的价格（n 从 1 起） */
export function shopCost(n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`购买次数必须是 ≥1 的整数，收到 ${n}`);
  return 10 * n * (n - 1) + 20;
}

/** 累计购买 n 次的总花费。闭式解，避免循环累加。 */
export function cumulativeCost(n) {
  if (n <= 0) return 0;
  return (10 * n * (n + 1) * (n - 1)) / 3 + 20 * n;
}

/** 某楼层商店的收益倍率 */
export function tierMul(floorIndex) {
  return Math.floor(floorIndex / 10) + 1;
}

/**
 * 单次购买的收益。
 * @param {number} floorIndex 所在楼层
 * @param {'hp'|'atk'|'def'} stat
 */
export function shopGain(floorIndex, stat) {
  const base = { hp: 100, atk: 2, def: 4 }[stat];
  if (base === undefined) throw new RangeError(`未知属性 "${stat}"，可选 hp / atk / def`);
  return base * tierMul(floorIndex);
}

/** 给定金币能买到的最大次数（从「一次都没买」起算） */
export function maxPurchases(gold) {
  let n = 0;
  while (cumulativeCost(n + 1) <= gold) n++;
  return n;
}

/**
 * 从「已经买过 n0 次」出发，还能再买几次。
 *
 * 为什么不能直接用 maxPurchases：价格是全局递增的（constants.json 的 globalCounter），
 * buyTimes 又是跨楼层共享的常量，所以「还能买几次」必须减掉已经花掉的那部分钱。
 * 拿 maxPurchases(gold) 当答案会在中后期高估得很离谱。
 */
export function maxPurchasesFrom(gold, n0) {
  const spent = cumulativeCost(n0);
  let n = n0;
  while (cumulativeCost(n + 1) - spent <= gold) n++;
  return n - n0;
}

/** 生成商店价目表，用于文档与校验台展示 */
export function shopTable(floorIndex, upTo = 10) {
  const rows = [];
  for (let n = 1; n <= upTo; n++) {
    rows.push({
      n,
      cost: shopCost(n),
      cumulative: cumulativeCost(n),
      hp: shopGain(floorIndex, 'hp'),
      atk: shopGain(floorIndex, 'atk'),
      def: shopGain(floorIndex, 'def')
    });
  }
  return rows;
}

/**
 * 性价比：每点属性花多少金币。
 * 这是判断「该不该现在买」的直接指标 —— 数值越小越划算。
 */
export function goldPerPoint(floorIndex, stat, n = 1) {
  return shopCost(n) / shopGain(floorIndex, stat);
}

/** 从道具定义中提取勇者持有的特攻道具，转成 simulateBattle 需要的 counters */
export function countersFromItems(heldItemIds, itemsTable) {
  const out = [];
  for (const id of heldItemIds) {
    for (const eff of itemsTable[id]?.effects ?? []) {
      if (eff.op === 'traitCounter') {
        out.push({ trait: eff.trait, stat: eff.stat, mul: eff.mul });
      }
    }
  }
  return out;
}

/** 勇者是否免疫领域伤害（持神圣盾） */
export function hasAuraImmunity(heldItemIds, itemsTable) {
  return heldItemIds.some((id) =>
    (itemsTable[id]?.effects ?? []).some((e) => e.op === 'immune' && e.to === 'aura')
  );
}
