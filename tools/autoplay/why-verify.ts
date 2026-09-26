/**
 * 决策器「**为什么不是别的**」的 headless 断言（`verify:autoplay` 的 W 段）。
 *
 * ## 这一套守的是什么
 *
 * `--scores` 只打**分数**，不打**闸门**。于是「分数 27918 的红宝石 AI 却不拿」
 * 这种事在报告里完全看不出来 —— 2026-09-26 追那条「同一局势重复 31 次」的红判据时，
 * 只能靠 `--scores` + `--reach`（ASCII 格子图）+ `--verbose` 三样手工反推，
 * 花掉的力气远大于写 `explainDecision()` 本身。
 *
 * 但「有了一份诊断」**不等于**「这份诊断可信」。诊断最典型的两种坏法：
 *
 *   ① **它是第二份实现** —— 实际决策走一条路、诊断走另一条路，两边各自都对得上
 *      自己的期望值（铁律 #23）。所以 W1 判「两者逐字节相同」。
 *   ② **它写死了话术** —— 不管什么局面都报同一句「代价超上限」，看起来很有用。
 *      所以 W2/W3 判「换一个条件，那一条必须消失」（铁律 #38 的探针）。
 */

import { loadData } from '../../src/data';
import { decideAutoAction, explainDecision, type RejectKind } from '../../src/game/autoplay';
import { makeDiagState } from './diag-state';
import type { Zone1Check } from './zone1';

/**
 * 允许出现的 `RejectKind` 全集。
 *
 * ⚠️ 写成**名单**是刻意的：`kind` 是报告里归并统计的键，随手多写一个字面量
 * （`'costs'` / `'lowHp'`）不会报错，只会让同一类病在累计表里**裂成两行**，
 * 而两行各自看起来都不高 —— 「安静地失真」比报错难查得多（铁律 #23 的老病）。
 * 这一条就是那份名单的机器检查。
 */
const ALLOWED_KINDS: RejectKind[] = [
  'unreachable',
  'keys',
  'cost',
  'profit',
  'cantwin',
  'score',
  'stale',
  'bounce',
  'nopath',
  'nowork',
  'nobacktrack',
  'none'
];

export function whyVerifications(): Zone1Check[] {
  const data = loadData();
  const out: Zone1Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });

  /** 复现一个局面 —— 与 `--why` / `--scores` **同一个构造器**（见 `diag-state.ts`） */
  const at = (
    floor: number,
    keys: string,
    stats: { hp: number; atk: number; def: number }
  ) => makeDiagState(data, { floor, keys, stats });

  /** 若干「有代表性」的局面 —— 覆盖「本层能捞」「本层捞不到」「上楼缺钥匙」三类 */
  const CASES: { name: string; floor: number; keys: string; stats: { hp: number; atk: number; def: number } }[] = [
    { name: 'F1 开局', floor: 1, keys: 'y0b0r0', stats: { hp: 1000, atk: 10, def: 10 } },
    { name: 'F5 铁剑后', floor: 5, keys: 'y2b0r0', stats: { hp: 1044, atk: 14, def: 10 } },
    { name: 'F9 死局现场', floor: 9, keys: 'y5b0r0', stats: { hp: 140, atk: 24, def: 12 } },
    { name: 'F9 带 2 蓝钥匙', floor: 9, keys: 'y5b2r0', stats: { hp: 140, atk: 24, def: 12 } }
  ];

  // ── W1 诊断与决策**同源**：同一局面下逐字节相同 ──
  //
  // 为什么必须是逐字节：如果诊断只是「大致一致」，那么在某次改动把某个闸门的顺序
  // 调换之后，两边的分歧会表现为「诊断说会做的动作，AI 不做」—— 而两边都自洽。
  {
    const bad: string[] = [];
    for (const c of CASES) {
      const a = decideAutoAction(at(c.floor, c.keys, c.stats), data);
      const d = explainDecision(at(c.floor, c.keys, c.stats), data);
      if (JSON.stringify(a) !== JSON.stringify(d.action)) {
        bad.push(`${c.name}：决策 ${JSON.stringify(a)} ≠ 诊断 ${JSON.stringify(d.action)}`);
      }
    }
    add(
      'W1 诊断与实际决策同源（同一局面逐字节相同）',
      bad.length === 0,
      bad.length === 0 ? `${CASES.length} 个局面一致` : bad.join('；')
    );
  }

  // ── W2 记录必须**有内容且有分类**：不能是一堆空字符串 ──
  //
  // 探针：要求「至少一个局面报出了 ≥4 条」，否则下面那条「kind 全部合法」
  // 会在「一条都没记」时恒真 —— 那正是铁律 #16 说的假绿。
  {
    const counts = CASES.map((c) => explainDecision(at(c.floor, c.keys, c.stats), data).rejected);
    const fieldsOk = counts.every((rs) =>
      rs.every((r) => r.stage.length > 0 && r.kind.length > 0 && r.what.length > 0 && r.why.length > 0)
    );
    const maxLen = Math.max(...counts.map((r) => r.length));
    const chosenOk = CASES.every((c) => explainDecision(at(c.floor, c.keys, c.stats), data).chosen.length > 0);
    add(
      'W2 决策交代可用：字段齐全、有选中项、且真的记下了候选',
      fieldsOk && chosenOk && maxLen >= 4,
      `各局面记录条数 ${counts.map((r) => r.length).join('/')}（最多 ${maxLen}，探针要求 ≥4）`
    );
  }

  // ── W3 **探针**：换一个条件，对应的那一条必须消失（铁律 #38）──
  //
  // 光看「有没有记录」证明不了它量的是真闸门 —— 写死一句 `why` 也能过。
  // 所以要 A/B。拿第 9 层做样本是因为它的门槛**只差一把蓝钥匙**（实测）：
  //   持 0 把蓝 → 该层的道具/怪几乎全报「钥匙不够：需 蓝1」；
  //   持 2 把蓝 → 「钥匙不够」这一类**一条都不剩**（同样那些项改报「路上代价 > 上限」）。
  //
  // ⚠️ 换条件换的是**蓝钥匙数量**，不是 hp。用 hp 做 A/B 的话两条改动会同时生效
  //    （钥匙够不够、代价够不够），分不清是哪一关在动。
  {
    const poor = explainDecision(at(9, 'y5b0r0', { hp: 140, atk: 24, def: 12 }), data).rejected;
    const rich = explainDecision(at(9, 'y5b2r0', { hp: 140, atk: 24, def: 12 }), data).rejected;
    const keyBlocks = (rs: typeof poor) => rs.filter((r) => r.kind === 'keys');
    const p = keyBlocks(poor);
    const q = keyBlocks(rich);
    add(
      'W3 探针：第 9 层的「钥匙不够」挡因会随蓝钥匙补上而消失（不是写死的话术）',
      p.length > 0 && q.length === 0,
      `蓝0：${p.length} 条（例 ${p[0]?.what ?? '—'} —— ${p[0]?.why ?? '—'}）｜蓝2：${q.length} 条`
    );
  }

  // ── W4 `kind` 是闭集（归并统计的键不能随手新增）──
  {
    const seen = new Set<string>();
    let total = 0;
    for (const c of CASES) {
      for (const r of explainDecision(at(c.floor, c.keys, c.stats), data).rejected) {
        seen.add(r.kind);
        total++;
      }
    }
    const illegal = [...seen].filter((k) => !(ALLOWED_KINDS as string[]).includes(k));
    add(
      'W4 原因分类是闭集（归并统计的键不会被随手新造）',
      illegal.length === 0 && seen.size >= 3,
      illegal.length ? `越界取值：${illegal.join('、')}` : `实测出现 ${seen.size} 种：${[...seen].join('、')}（共 ${total} 条）`
    );
  }

  return out;
}
