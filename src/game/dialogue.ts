/**
 * NPC 台词解析 —— 「这个 NPC 现在该说哪一句」的**唯一**判断处。
 *
 * ## 为什么必须集中在一处
 *
 * 这句话同时被两个界面消费：地图上悬停时的详情卡、以及撞上去弹出来的对话框。
 * 上一版的写法是在两处各写一遍取值链（`talkByFloor → talk → note`），
 * 于是「改了一处、另一处还是老台词」是迟早的事。这里只留一个入口。
 *
 * ## 轮换规则
 *
 * 台词池按上下文拼出来，然后按**已搭话次数**取模：
 *
 *   有本层特供台词 → [本层台词, ...repeat]
 *   没有           → [greet, ...repeat]
 *
 * 于是：
 *   · 第 1 次搭话一定是「首次见面 / 本层特供」那句；
 *   · 第 2 次起逐句轮换，**不会连着说同一句**；
 *   · 玩家在同一层反复撞同一个 NPC 也不会只看到一句话。
 *
 * 上一版 `talk: string` 是单句，无论搭话多少次都返回它 ——
 * 玩家撞两下就发现「对话是假的」。这就是那个问题的最小修法：
 * 不需要对话树 / 好感度这种系统，只要**有池子且能轮换**。
 */

import type { GameData, NpcDef } from '../data';
import type { GameState } from './state';

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
 * 拼一个 NPC 的台词池。
 *
 * 顺序即优先级：本层特供在最前（它承载「这一层要做什么」的引导），
 * 之后是通用的 repeat；`greet` 只在没有本层特供时打头，
 * 否则玩家在特供层永远听不到首次问候。
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

/** 该 NPC 此刻该说的那一句（只读，不改 state） */
export function npcLine(state: GameState, data: GameData, npcId: string, floor: number): NpcLine {
  const pool = npcPool(data, npcId, floor);
  const n = Math.max(0, state.talked[npcId] ?? 0);
  return pool[n % pool.length];
}

/** 记一次搭话。撞到 NPC 时由引擎调用；下一次 `npcLine` 就会是另一句 */
export function bumpTalk(state: GameState, npcId: string): void {
  state.talked[npcId] = (state.talked[npcId] ?? 0) + 1;
}
