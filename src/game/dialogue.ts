/**
 * NPC 台词解析 —— 「这个 NPC 现在该说哪一段」的**唯一**判断处。
 *
 * ## 为什么必须集中在一处
 *
 * 这件事同时被两个界面消费：地图上悬停时的详情卡、以及撞上去弹出来的对话框。
 * 上一版的写法是在两处各写一遍取值链（`talkByFloor → talk → note`），
 * 于是「改了一处、另一处还是老台词」是迟早的事。这里只留一个入口。
 *
 * ## 两种生命周期（2026-09-27 起）
 *
 * NPC 撞过之后**还在不在**，由数据里的 `lifecycle` 决定（见 `data/npcs.json`
 * 与 `types.ts` 的 `NpcDef.lifecycle`）。两种的台词取值**不是同一件事**：
 *
 *   `once`（说走就走）—— 撞一次，把 `greet`（若有）+ `talkByFloor[本层]` 的
 *       全部句子作为**一段**一次列完，然后他从地图上消失（引擎侧见 `step.ts`）。
 *       所以这里返回的是**数组**，长度可以 > 1。
 *
 *   `persistent`（常驻）—— 每次搭话只出一句，按**已搭话次数**在池子里取模：
 *         有本层特供台词 → [本层台词, ...repeat]
 *         没有           → [greet, ...repeat]
 *       于是第 1 次一定是「本层特供 / 首次见面」那句，第 2 次起逐句轮换，
 *       **不会连着说同一句**。这里返回的数组长度恒为 1。
 *
 * ## 计数键为什么是「实体」而不是「NPC id」
 *
 * 上一版按 `npcId` 计数，于是**全塔同类 NPC 共用一个计数器**：12 个商人共用
 * `talked['merchant']`，从第二个商人起 `n % 池长` 已经不是 0，他那一层的特供
 * 台词（「我有一把蓝钥匙，你出50个金币就卖给你」）就被跳过了 —— 玩家永远看不到。
 * 改成按实体（`floor:x:y:npc:id`，与 `state.removed` **同一套 key**）之后，
 * 每个 NPC 各自从第 1 句开始，而「反复撞同一个 NPC 会逐句换」这件事仍然成立。
 */

import type { GameData, NpcDef } from '../data';
import { entityKey, type GameState } from './state';

export interface NpcLine {
  text: string;
  /**
   * 这一句是从哪一层含义里取出来的 —— 调试与校验时用来确认轮换真的发生了。
   *
   * `story` 是**唯一的例外**：它不是从 `npcs.json` 的台词池里取出来的，
   * 而是事件剧本（`say` 算子）写死的一整段，不参与轮换、也不计搭话次数。
   * 放在同一个字段里是因为「这句话是谁说的、算哪一类」对界面来说只有一个问题：
   * 标题下面那行小字该写什么。
   */
  from: 'floor' | 'greet' | 'repeat' | 'note' | 'fallback' | 'story';
}

/** 把数据里的 `string | string[]` 归一成数组 */
function asLines(v: string | string[] | undefined): string[] {
  if (typeof v === 'string') return v.trim() ? [v] : [];
  if (Array.isArray(v)) return v.filter((s) => typeof s === 'string' && s.trim());
  return [];
}

/**
 * 这个 NPC 撞过之后还在不在（取值的唯一合法来源是 `data/npcs.json`）。
 *
 * ⚠️ **这里不认「默认值」**。数据里缺字段或把取值拼错（`persistant`）时一律按
 *    常驻处理 —— 那是**不会丢内容**的一侧（一次性 NPC 误判成常驻只是多说一句，
 *    反过来则是那几句永远读不到）。但这不等于「允许写错」：
 *    `tools/validate-data.mjs` 的 J 段会先把这种情况判 FAIL，runtime 的宽松
 *    只是不想在真机上崩给玩家看。
 */
export function npcLifecycle(data: GameData, npcId: string): 'once' | 'persistent' {
  return data.npcs[npcId]?.lifecycle === 'once' ? 'once' : 'persistent';
}

/**
 * 拼一个 NPC 的**轮换池**。
 *
 * 顺序即优先级：本层特供在最前（它承载「这一层要做什么」的引导），
 * 之后是通用的 repeat；`greet` 只在没有本层特供时打头，
 * 否则玩家在特供层永远听不到首次问候。
 *
 * ⚠️ 只对 `persistent` 有意义。`once` 的池子由 `npcLines()` 直接拼成一段，
 *    不经这里 —— 一次性 NPC 没有「第二次搭话」，取模这件事根本不存在。
 */
export function npcPool(data: GameData, npcId: string, floor: number): NpcLine[] {
  const npc: NpcDef | undefined = data.npcs[npcId];
  if (!npc) return [{ text: `${npcId} 站在这里。`, from: 'fallback' }];

  const floorLines = asLines(npc.talkByFloor?.[String(floor)]).map<NpcLine>((text) => ({
    text,
    from: 'floor'
  }));
  const repeat = asLines(npc.repeat).map<NpcLine>((text) => ({ text, from: 'repeat' }));
  const pool = floorLines.length
    ? [...floorLines, ...repeat]
    : [...asLines(npc.greet).map<NpcLine>((text) => ({ text, from: 'greet' })), ...repeat];

  if (pool.length) return pool;
  if (npc.note) return [{ text: String(npc.note), from: 'note' }];
  return [{ text: `${npc.name} 站在这里。`, from: 'fallback' }];
}

/**
 * 这一次搭话会看到的**整段**台词。
 *
 * `key` 是实体键（`entityKey(floor, x, y, 'npc', id)`）—— 见文件头「计数键」那段。
 * 一次性 NPC 不看它（只说一次，没有第二句），常驻 NPC 用它取模。
 */
export function npcLines(state: GameState, data: GameData, npcId: string, floor: number, key: string): NpcLine[] {
  const npc: NpcDef | undefined = data.npcs[npcId];
  if (!npc) return [{ text: `${npcId} 站在这里。`, from: 'fallback' }];

  if (npcLifecycle(data, npcId) === 'once') {
    // 初次见面句在最前：对一次性 NPC 来说「这一次」就是初次见面
    const seg: NpcLine[] = [
      ...asLines(npc.greet).map<NpcLine>((text) => ({ text, from: 'greet' })),
      ...asLines(npc.talkByFloor?.[String(floor)]).map<NpcLine>((text) => ({ text, from: 'floor' }))
    ];
    // 某个落点楼层既没写 greet 也没写本层台词 ⇒ 退回池子（note / fallback），
    // 至少让玩家看见「有这么个人」。校验器 J 段会把这种数据判红。
    return seg.length ? seg : npcPool(data, npcId, floor);
  }

  const pool = npcPool(data, npcId, floor);
  const n = Math.max(0, state.talked[key] ?? 0);
  return [pool[n % pool.length]];
}

/** 该 NPC 此刻该说的**第一句**（悬停预览用；只读，不改 state） */
export function npcLine(state: GameState, data: GameData, npcId: string, floor: number, key: string): NpcLine {
  return npcLines(state, data, npcId, floor, key)[0];
}

/** 实体键 —— 台词计数与「已移除」共用同一套 key（`step.ts` 也用它记账） */
export function npcKey(floor: number, x: number, y: number, npcId: string): string {
  return entityKey(floor, x, y, 'npc', npcId);
}

/** 记一次搭话。撞到 NPC 时由引擎调用；常驻 NPC 的下一次 `npcLines` 就会是另一句 */
export function bumpTalk(state: GameState, key: string): void {
  state.talked[key] = (state.talked[key] ?? 0) + 1;
}
