/**
 * 魔塔战斗模拟 —— 全项目唯一的战斗实现。
 *
 * 公式来源：标准引擎 motajs/mota-js libs/enemys.js:calDamage（BSD-3）
 *   turn = parseInt((mon_hp - 1) / (hero_atk - mon_def))   // = ⌈HP/(ATK−DEF)⌉ − 1
 *   ans  = initDamage + turn * per_damage                  // per_damage = 怪ATK − 勇者DEF
 *
 * 即：勇者先手，怪物只完整出手 (N − 1) 次，第 N 回合怪物已被击杀。
 * 写成 N × D2 会让预判系统性偏高。
 *
 * 注意：参考实现 reference/mota50/source/mota50-fight.js 只扣一回合伤害，
 * 未计算回合数，属错误实现 —— 不可作为数值依据。
 *
 * 纯函数，零依赖，可脱离渲染层单测。
 */

export const TRAIT_INFO = {
  crossVulnerable: '十字架克制。持十字架时对其攻击力翻倍。成员：兽人、兽人武士、吸血鬼。',
  undead: '亡灵系，crossVulnerable 的子集。',
  dragon: '龙系。持屠龙剑时对其攻击力翻倍。',
  aura: '领域。勇者每次移动后若相邻则扣固定 HP，不进战斗结算；持神圣盾免疫。',
  flank: '夹击。战斗开始前怪物先制攻击一次。chance 为触发概率。',
  execute: '斩杀。勇者属性达到阈值时战斗损失归零。'
};

/**
 * traits 既可能是字符串（无参标记）也可能带参数的数组对象；
 * 统一成「标记集合 + 按类型分组的参数表」。
 */
function normalizeTraits(raw) {
  const flags = new Set();
  const auras = [];
  const flanks = [];
  const executes = [];
  for (const t of raw ?? []) {
    if (typeof t === 'string') { flags.add(t); continue; }
    if (t && typeof t === 'object') {
      if (t.type === 'aura') auras.push(t);
      else if (t.type === 'flank') flanks.push(t);
      else if (t.type === 'execute') executes.push(t);
    }
  }
  return { flags, auras, flanks, executes };
}

/**
 * 计算对某只怪物的战斗结果。
 *
 * @param {{hp:number, atk:number, def:number}} hero
 * @param {{hp:number, atk:number, def:number, traits?:any[]}} mon
 * @param {{counters?: Array<{trait:string, stat:string, mul:number}>}} [options]
 *        counters 来自勇者持有的被动道具（十字架 / 屠龙剑）
 */
export function simulateBattle(hero, mon, options = {}) {
  const counters = options.counters ?? [];
  const traits = normalizeTraits(mon.traits);

  // ── 斩杀：属性达标直接零损失 ──────────────────────────────
  for (const e of traits.executes) {
    const value = hero[e.stat];
    if (typeof value === 'number' && value >= e.threshold) {
      return {
        canWin: true,
        reason: null,
        execute: true,
        effectiveAtk: hero.atk,
        perHit: null,
        perRound: Math.max(0, mon.atk - hero.def),
        rounds: 1,
        enemyAttacks: 0,
        hpLoss: 0,
        hpLossMin: 0,
        hpLossMax: 0,
        remainingHp: hero.hp
      };
    }
  }

  // ── 特攻道具：仅对具备匹配 trait 的怪物生效 ──────────────
  let effectiveAtk = hero.atk;
  const appliedCounters = [];
  for (const c of counters) {
    if (traits.flags.has(c.trait) && c.stat === 'atk') {
      effectiveAtk = Math.floor(effectiveAtk * c.mul);
      appliedCounters.push(c.trait);
    }
  }

  const perHit = effectiveAtk - mon.def;
  if (perHit <= 0) {
    return {
      canWin: false,
      reason: 'unpierceable',
      execute: false,
      effectiveAtk,
      appliedCounters,
      perHit,
      perRound: Math.max(0, mon.atk - hero.def),
      rounds: null,
      enemyAttacks: null,
      hpLoss: Infinity,
      hpLossMin: Infinity,
      hpLossMax: Infinity,
      remainingHp: -Infinity
    };
  }

  const rounds = Math.ceil(mon.hp / perHit);
  const perRound = Math.max(0, mon.atk - hero.def);

  // 夹击：可能多挨一次。期望值与最好/最坏都给出，不做「假装确定」的简化。
  const flankMax = traits.flanks.length
    ? traits.flanks.reduce((m, f) => Math.max(m, f.chance ?? 1), 0)
    : 0;
  const baseAttacks = rounds - 1;
  const hpLossMin = baseAttacks * perRound;
  const hpLossMax = (baseAttacks + (flankMax > 0 ? 1 : 0)) * perRound;
  const hpLoss = perRound === 0
    ? 0
    : Math.round(hpLossMin * (1 - flankMax) + hpLossMax * flankMax);

  const dead = hpLoss >= hero.hp;

  return {
    canWin: !dead,
    reason: dead ? 'heroDies' : null,
    execute: false,
    effectiveAtk,
    appliedCounters,
    perHit,
    perRound,
    rounds,
    enemyAttacks: baseAttacks,
    flanked: flankMax > 0,
    flankChance: flankMax,
    hpLoss,
    hpLossMin,
    hpLossMax,
    remainingHp: hero.hp - hpLoss
  };
}

/**
 * 领域伤害：勇者每走动一步、若与带 aura 的怪物相邻则扣血。
 * 返回该步的扣血量；持神圣盾（immune.to 含 'aura'）时为 0。
 *
 * @param {Array<{traits?:any[]}>} adjacentMonsters 与勇者上下左右相邻的怪物
 * @param {{auraImmune?: boolean}} [opts]
 */
export function auraStepDamage(adjacentMonsters, opts = {}) {
  if (opts.auraImmune) return 0;
  let total = 0;
  for (const mon of adjacentMonsters) {
    const traits = normalizeTraits(mon.traits);
    for (const a of traits.auras) total += a.damage ?? 0;
  }
  return total;
}

/** 损失占当前生命的比例，无法战胜时为 Infinity */
export function lossRatio(hero, preview) {
  return preview.hpLoss === Infinity ? Infinity : preview.hpLoss / hero.hp;
}

/** 按设计目标区间给出难度判定 */
export function grade(hero, preview, targets = [0.05, 0.15], dangerAt = 0.3) {
  if (preview.reason === 'unpierceable') return 'blocked';
  if (preview.reason === 'heroDies') return 'fatal';
  if (preview.execute) return 'execute';
  const r = lossRatio(hero, preview);
  if (r > dangerAt) return 'danger';
  if (r > targets[1]) return 'high';
  if (r >= targets[0]) return 'ok';
  return 'easy';
}

/**
 * 击破某只怪物所需的最低攻击力（怪物生效防御 + 1）。
 * 低于此值完全打不动 —— 原版用这类「攻击力门槛」控制节奏，石头人 def 68 是典型。
 */
export function requiredAtk(mon) {
  return mon.def + 1;
}

/**
 * 零损失击杀所需的攻击力：使回合数降为 1，即 ATK − DEF ≥ 怪物HP。
 * 双手剑士有 execute 特性，阈值 150 比这个通用值低得多，是特殊设计。
 */
export function oneShotAtk(mon) {
  return mon.def + mon.hp;
}
