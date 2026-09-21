# 魔塔数据格式与数值设计 v0.2

目标平台：**微信小游戏** ｜ 渲染栈：**PixiJS v8 + TypeScript + Vite**
本文只定义**数据层**，不含渲染与 UI。

> **v0.2 变更说明：**
> v0.1 是基于手搓的 3 层草案写的。本轮把数据源换成了原版《魔塔50层》的真实数据，因此以下内容**已更正**：
> ① 删除经验值/等级系统（原版没有）；② 地形图例 5 种 → 12 种；③ 地图 13×13 → **11×11**；
> ④ 楼层 3 层 → **51 层**；⑤ 怪物 9 只 → **34 只**；⑥ 新增 `npcs.json`、`floor-notes.json`、`monster-placement.json`、`core/shop.mjs`。
>
> 配套文档：
> - `docs/mota50-numeric-system.md` —— 数值体系的权威说明（公式、商店、经济、怪物全表）
> - `docs/source-review.md` —— 参考源码调研、解析与转换对照
> - `docs/known-gaps.md` —— **参考源的数据缺口与待决策项**（做运行时之前先看这份）
> - `reference/mota50/ATTRIBUTION.md` —— 来源与**授权边界**

---

## 一、设计原则

1. **状态是纯数据，所有操作都是对它的 reducer 调用。** 这样存档就是 `JSON.stringify(state)`，回退就是压一个栈——魔塔玩家会疯狂 SL，这一条决定了后期会不会做哭。
2. **数值和表现分离。** `data/` 里的 JSON 不含任何渲染信息以外的逻辑，`core/` 不依赖 PixiJS，可以脱离画面单测。
3. **战斗预判与实际战斗共用同一个纯函数。** 永远不要写两份公式，否则「预览显示损失 30，实战掉了 47」这类 bug 一定会出现。
4. **数据必须可溯源。** 每个数据文件都带 `source` 字段说明数值来自哪里、何时核对，使「这个数字凭什么可信」永远可回答。
5. **派生数据由脚本生成，不手改。** `data/floors/*.json` 由 `tools/import-mota50.mjs` 产出，手改会在下次导入时丢失（解决方案见 `known-gaps.md` §7）。

---

## 二、文件结构

```
core/
  combat.mjs              战斗模拟唯一实现（纯函数，零依赖）
  shop.mjs                商店定价与经济模型（纯函数，零依赖）
data/
  constants.json          战斗参数、勇者初始属性、商店定价、经济上限、区域基准
  tiles.json              地形图例（12 种，字符 ↔ 原版编号双向）
  monsters.json           34 只怪物 + traitsReference
  items.json              32 项道具 / 钥匙 / 剑盾 + effectOps 词汇表
  npcs.json               6 个 NPC（智慧老人/商人/小偷/仙子/公主/商店）
  combat-cases.json       战斗黄金用例（21 条 + 领域 4 + 商店 9）
  floor-notes.json        特殊楼层机制说明（含依据来源）
  monster-placement.json  怪物出现层索引 + neverPlaced（自动生成）
  floors/
    index.json            51 层索引
    floor-00.json ~ floor-50.json
tools/
  import-mota50.mjs       参考源码 → 本项目楼层 JSON（唯一的地图数据入口）
  validate-data.mjs       8 大类校验，含连通性求解与内联副本防漂移
  build-balance-check.mjs 由 data/ 生成可交互数值校验台（消除内联副本漂移）
  balance-check.html      生成的校验台产物，双击即开，自带公式自检
```

**执行顺序（有依赖）：**

```bash
node tools/import-mota50.mjs      # 1. 导入地图数据
node tools/validate-data.mjs      # 2. 全量校验
node tools/build-balance-check.mjs # 3. 生成校验台（必须最后，H 段会比对一致性）
```

---

## 三、战斗公式（核心）

完整推导与第三方验证见 `docs/mota50-numeric-system.md` §3。此处只列结论。

魔塔的战斗是**确定性回合制**，没有随机数——这正是「伤害预判」能成立的前提。

```
perHit   = hero.atk − mon.def              勇者每回合对怪造成的伤害
perRound = max(0, mon.atk − hero.def)      怪物每回合对勇者造成的伤害
rounds   = ⌈mon.hp / perHit⌉               击杀所需回合数
hpLoss   = (rounds − 1) × perRound         勇者的生命损失
```

### 为什么是 `(rounds − 1)` 而不是 `rounds`

**勇者先手。** 第 `rounds` 回合是致命一击，怪物在此之前就已经倒下，不会反击。所以怪物实际只出手 `rounds − 1` 次。

这是魔塔里最容易写错、影响也最大的一行。差了这一项，预判数值会系统性偏高。

### 打不动的判定

若 `perHit <= 0`，永远无法击杀 → 返回 `canWin: false, reason: 'unpierceable'`，损失记为 `Infinity`。

这不是 bug，而是魔塔**核心设计手段**：它创造了「数值门」——你必须先拿到足够的攻击力，才能通过某条路。
典型如**石头人 DEF 68**、**高级卫兵 DEF 360**。UI 必须提前把这个状态标出来（`grade()` 返回 `'blocked'`）。

### 特殊机制

| 机制 | trait | 语义 | 处理位置 |
|---|---|---|---|
| 十字架 | `crossVulnerable` | 持十字架时对兽人/兽人武士/吸血鬼攻击力 ×2 | 战斗结算 |
| 屠龙剑 | `dragon` | 持屠龙剑时对魔龙攻击力 ×2 | 战斗结算 |
| 神圣盾 | `immune: aura` | 免疫领域伤害 | 移动结算 |
| 领域 | `aura` | 勇者**每移动一步**若相邻则扣固定 HP | **移动 reducer，与战斗无关** |
| 夹击 | `flank` | 战斗前按概率先制攻击一次 | 战斗结算（返回期望+最坏值） |
| 斩杀 | `execute` | ATK ≥ 阈值时损失归零 | 战斗结算 |

**领域是「走路扣血」而非「战斗扣血」** —— 它与战斗完全分离，这是后期最耗血的机制，也是神圣盾的价值来源。
`core/combat.mjs` 因此导出独立的 `auraStepDamage()`。

### 唯一实现

上述逻辑在 `core/combat.mjs` 里只存在**一份**，导出：

`simulateBattle` / `auraStepDamage` / `lossRatio` / `grade` / `requiredAtk` / `oneShotAtk` / `TRAIT_INFO`

`data/combat-cases.json` 是 **21 条**黄金用例（其中 17 条的期望值取自攻略实测扣血，属独立第三方验证），
外加领域 4 条与商店 9 条。校验脚本和网页校验台跑同一批用例——任何一侧的实现改动而另一侧没跟上，会立刻报出来。

---

## 四、地图格式

### 为什么用「字符画 + 对象数组」而不是纯数字二维数组

原版用的是**扁平数字阵列**（`下标 = y × 11 + x`，隐藏的星际空间 96 格全是裸数字。
本项目转成字符画后，地形在 JSON 里**肉眼可见**，改地图就是改字符串；实体用对象数组，天然稀疏、自解释。

> 顺带避开一个坑：数字阵列里的 `10`、`11` 占两个字符宽度，打印时会让 11 格的行走样变成 12~13 个字符，
> 肉眼核对行宽时极易误判。字符画没有这个问题。

```jsonc
{
  "id": "floor-01",
  "index": 1,
  "title": "主塔 1 层",
  "size": { "cols": 11, "rows": 11 },
  "terrain": [
    "^..........",
    "##########.",
    "...y.#...#.",
    "...#.#...#.",
    "#y##.###y#.",
    "...#.y...#.",
    "...#.#####.",
    "#y##.......",
    "...##y###y#",
    "...#...#...",
    "...#...#..."
  ],
  "stairs": {
    "up":   [{ "x": 0, "y": 0, "to": 2, "arrive": { "x": 0, "y": 0 } }],
    "down": []
  },
  "doors": { "yellow": 7, "blue": 0, "red": 0 },
  "entities": [
    { "type": "monster", "id": "greenSlime", "x": 2, "y": 0 },
    { "type": "item",    "id": "redPotion", "x": 6, "y": 2 },
    { "type": "npc",     "id": "sage", "x": 6, "y": 9 }
  ]
}
```

**坐标约定：零基，`x` 是列（左→右），`y` 是行（上→下），`(0,0)` 在左上角。**
数组下标 = `y × 11 + x`（与原版一致，便于对照）。

### 楼梯的落点修正

`stairs[].arrive` 是**落到目标层后的实际站位**。参考源里有楼梯落点正好在目标层的墙里
（如第 32 层的下楼梯），导入时会用 BFS 就近修正到最近的可站立格，并标注：

```jsonc
{ "x": 5, "y": 10, "to": 31, "arrive": { "x": 5, "y": 9 }, "arriveAdjusted": true }
```

`arriveAdjusted: true` 保留了「此处经过修正」这一事实，便于回溯。

### 实体类型的扩展字段

| type | 字段 | 说明 |
|---|---|---|
| `monster` | `id` | 引用 `monsters.json`，**战斗前不可穿越** |
| `item` | `id`、可选 `hidden`、`hiddenIn` | 引用 `items.json`，踩上即结算 |
| `npc` | `id` | 引用 `npcs.json`，走对话/交易分支 |
| `door` | — | 门不建实体，由 `terrain` 字符 + `doors` 计数表达 |
| `stair` | — | 楼梯不建实体，统一收在 `stairs` 字段 |

**两处特殊标记，都是原版设计而非数据错误：**

```jsonc
// ① BOSS 守道具：怪物与道具同格，击败后道具仍在原地
{ "type": "monster", "id": "kraken",  "x": 5, "y": 4 },
{ "type": "item",    "id": "shovel",  "x": 5, "y": 4 },

// ② 墙内隐藏道具：需铁锹挖开相邻墙或对该层用地震卷轴才能取得
{ "type": "item", "id": "redKey", "x": 0, "y": 2,
  "hidden": true, "hiddenIn": "wall" }
```

共 2 处 BOSS 守道具（15 层大乌贼守铁锹、35 层魔龙守雪花）、2 处墙内隐藏道具（14 层红钥匙、41 层下楼器）。

---

## 五、地形图例（`tiles.json`）

字符 ↔ 原版编号双向对应，来源为 `mota50-graph.js` 的绘制分支与 `mota50-event.js:checkFloor`。

| 字符 | 原版编号 | 名称 | 可通行 | 说明 |
|---|---|---|---|---|
| `.` | 0 | 空地 | ✅ | |
| `#` | 1 | 墙 | ❌ | |
| `D` | 2 | 牢门 | ❌ | 剧情事件开启，**不消耗钥匙** |
| `v` | 3 | 下楼梯 | ✅ | 进入 `index − 1` |
| `^` | 4 | 上楼梯 | ✅ | 进入 `index + 1` |
| `~` | 5 | 岩浆 | ❌ | 后期可由雪花等地形道具消除 |
| `*` | 6 | 星际空间 | ❌ | 第 50 层背景。⚠️ 参考实现漏判此地形为阻挡 |
| `y` | 7 | 黄门 | ❌ | 消耗 `yellowKey` |
| `b` | 8 | 蓝门 | ❌ | 消耗 `blueKey` |
| `r` | 9 | 红门 | ❌ | 消耗 `redKey` |
| `a` | 10 | 自动门 | ❌ | 击败指定怪物后自动变空地（第 8 / 30 / 44 层） |
| `w` | 11 | 假墙 | ✅ | 外观同墙，**撞一次变空地** —— 原版最重要的隐藏手法 |

> ⚠️ `w`（假墙）在数据中标记为**可通行**，但运行时语义应是「尝试进入 → 变空地 → 本次不移动」。
> 第 23 层整层由 40 格假墙构成迷宫，实现时不要漏掉这个分支。

---

## 六、怪物表

`data/monsters.json` 共 **34 只**（33 只来自参考源码 + 补入真魔王）。

```jsonc
"skeleton": {
  "roleId": 1,              // 原版编号，便于与参考源码对照
  "name": "骷髅人",
  "hp": 50, "atk": 42, "def": 6,
  "gold": 6,
  "exp": 0,                 // 原版无经验系统，恒为 0
  "traits": [],
  "sprite": "mon_skeleton"
}
```

**没有 `tier` 字段。** v0.1 曾用 `tier` 表示设计层级，并用它做数值曲线批量目视。改用真实数据后这个概念失去意义——
原版怪物的出现层由地图数据决定（见 `monster-placement.json`），不需要一层人工归纳。
v0.1 文档里那句「早期版本这个字段叫 `floor`，正因为和『出现层』混淆才改名」的教训仍然有效：
**永远不要用一个字段同时表达「强度档位」和「出现位置」。**

`gold` 是击杀收益，用于商店消费。`exp` 恒为 0 但保留字段，是为了让「原版没有经验系统」这件事在数据里显式可见，
而不是靠「字段不存在」来暗示。

---

## 七、道具、钥匙与门

### 效果用原子操作列表表达

```jsonc
"redGem": {
  "name": "红宝石", "sourceId": 1, "kind": "pickup",
  "sprite": "item_red_gem",
  "effects": [{ "op": "addStat", "stat": "atk", "value": 2 }]
}
```

**`op` 词汇表**（权威定义在 `data/items.json` 的 `effectOps` 字段）：

| op | 参数 | 语义 |
|---|---|---|
| `addStat` | `stat` ∈ {hp,atk,def}, `value` | 属性加值（可为负） |
| `mulStat` | `stat`, `value` | 属性倍率（圣水 HP ×2） |
| `addKey` | `key` ∈ {yellowKey,blueKey,redKey}, `value` | 钥匙增减 |
| `mulGoldGain` | `value` | 此后击杀金币倍率（大金币 ×2） |
| `traitCounter` | `trait`, `stat`, `mul` | 对具备某 trait 的怪物战斗时临时乘值（十字架/屠龙剑） |
| `immune` | `to` | 免疫某类效果（神圣盾免疫 `aura`） |
| `clearTerrain` | `terrain`, `scope` | 清除范围内某种地形（地震卷轴/雪花/金钥匙） |
| `breakWall` | `scope: "adjacent4"` | 破坏相邻可破坏墙（铁锹） |
| `bomb` | `scope: "adjacent4"` | 清除相邻非 BOSS 怪物（炸药） |
| `teleportSymmetric` | — | 中心对称传送（对称飞行器） |
| `changeFloor` | `delta` | 楼层增减（上楼器 +1 / 下楼器 −1） |
| `openFloorSelect` | `range` | 打开楼层选择面板（楼层传送器） |
| `toggleUi` | `ui` | 开关某个 UI 面板（怪物书/记事本） |
| `buyStat` | `stat` | 商店购买。**价格与增量不写死在道具表**，由 `core/shop.mjs` 按 `constants.json` 计算 |

**`traitCounter` 是特攻道具与战斗系统的唯一接缝。** `core/shop.mjs` 的 `countersFromItems()`
把勇者持有的道具转成 `simulateBattle` 需要的 `counters` 参数，战斗核心不需要知道「十字架」是什么东西。

### kind 的语义

| kind | 数量 | 行为 |
|---|---|---|
| `pickup` | 17 | 踩上立即结算并消失（宝石、药水、钥匙、剑盾） |
| `usable` | 12 | 进背包，需玩家主动使用（圣水、铁锹、地震卷轴、飞行器） |
| `passive` | 3 | 持有即生效，不消耗（大金币、十字架、屠龙剑） |

**门不建在 `items.json` 里**，而是由 `tiles.json` 的字符 `y`/`b`/`r` 加上 `constants` 的钥匙字段表达。
v0.1 曾把门做成 `kind: "door"` 的道具，改用原版数据后发现门是**地形**而非实体，遂改回。

### 事件层与道具层的词汇表尚未合并 ⚠️

`data/events.json` **目前不存在**。v0.1 里那份是 3 层草案时期的产物（引用已不存在的 `flyWing`、
写着固定价格的旧商店模型），已移入 `data/_legacy-3floors/events.json` 作为历史存档。

重建事件表时，需要把以下**事件专用 op** 并入上表，保持全项目只有一套词汇表：

`dialog` / `giveItem` / `teleport` / `generateStairs` / `setFlag` / `clearFlag`

其中 `generateStairs` 是**必须的**——第 10 层的上楼梯由剧情事件生成（参考源 `floor[10][115]=4`），
第 49 → 50 层的通路也依赖同类机制（见 `docs/known-gaps.md` §1）。

---

## 八、事件系统（设计约定，待 `events.json` 重建）

```jsonc
"f10-boss-cleared": {
  "trigger": "onBattleEnd",
  "once": true,
  "conditions": [{ "op": "defeated", "id": "skeletonCaptain" }],
  "effects": [
    { "op": "dialog", "text": "骷髅队长倒下了，通往上层的路显现出来。" },
    { "op": "generateStairs", "kind": "up", "at": { "x": 5, "y": 10 } }
  ]
}
```

### 触发器

| trigger | 触发时机 |
|---|---|
| `onEnter` | 踩到挂载该事件的格子 |
| `onFloorEnter` | 进入指定楼层 |
| `onPickup` | 拾取指定道具 |
| `onBattleEnd` | 战斗结束 |
| `onShopBuy` | 商店购买 |
| `onUseItem` | 使用道具 |

### 条件

条件用递归的 `{ op, ... }` 结构，支持逻辑组合：

```jsonc
{
  "op": "and",
  "args": [
    { "op": "gte", "stat": "atk", "value": 20 },
    { "op": "not", "args": [{ "op": "hasItem", "id": "holyWater" }] }
  ]
}
```

可用条件：`gte` `lte` `gt` `lt` `eq` `hasItem` `defeated` `flag` `and` `or` `not`

**同一套结构也用于门的解锁判定和商店的显示条件**——不要另起一套。

---

## 九、运行时状态与存档

```ts
interface GameState {
  seed: number;
  floorIndex: number;                        // 0~50（原版用数字，不用字符串 id）
  hero: {
    x: number; y: number;
    facing: 'up' | 'down' | 'left' | 'right';
    hp: number; atk: number; def: number;
    gold: number;                            // 注意：没有 exp / level
    keys: { yellowKey: number; blueKey: number; redKey: number };
  };
  inventory: Record<string, number>;         // itemId -> 数量
  flags: Record<string, number | boolean>;   // 事件触发标记
  defeated: Record<string, number>;          // monsterId -> 击杀数
  taken: string[];                           // 已消失实体，形如 "20:5:5"
  buyTimes: number;                          // 商店购买次数，初值 1（见下）
  wentFloor: number[];                       // 到过的楼层 —— 楼层传送器的列表来源
  history: GameState[];                      // 回退栈
}
```

- **`buyTimes` 初值必须是 1。** 定价公式 `10n(n−1)+20` 在 n=0 与 n=1 时都是 20，
  参考源码为此显式写下 `buyTimes: 1`。`core/shop.mjs` 对 `n < 1` 直接抛 `RangeError`。
- **`wentFloor` 决定传送器的可达列表。** 这解释了为什么第 44 层被称作「隐藏层」——
  它不在传送面板里（见 `known-gaps.md` §6.3）。
- **存档**：`JSON.stringify(state)` → 存 `wx.setStorageSync`。
- **回退（撤销一步）**：`history` 弹出上一个快照。因为状态是纯数据、每次操作产生新对象，
  回退不需要任何「反向操作」逻辑——这是分层带来的直接收益。

### 移动 reducer 必须处理的三件事

1. **领域伤害**：每移动一步，先算 `auraStepDamage(相邻怪物)` 并从 HP 扣除（持神圣盾则为 0）。
2. **假墙**：撞上 `w` 时把该格地形改为 `.`，**本次不移动**。
3. **战斗拦截**：目标格有怪物时进入战斗预判/结算，而非直接移动。

---

## 十、微信小游戏适配注意点（数据层相关）

1. **无 DOM**，对话、状态栏、背包全部要用 PixiJS 画。这不影响数据结构，但影响一件事：
   **文本要预先按像素宽度换行**。建议给每个 `dialog.text` 定一个软上限（比如 60 个汉字），
   超出的在数据里就拆成多条 `dialog` 效果，而不是留给运行时自动折行。
2. **主包 4MB 限制**。`data/` 是纯文本且压缩率极高——**全部 JSON 合计约 170 KB，gzip 后仅约 27 KB**，
   打进主包完全没问题（距 4MB 上限有 150 倍余量）。但**图片资源**要放远程或分包。
   注意 12 种地形 + 34 只怪物 + 32 项道具的精灵图数量比 v0.1 的 3 层草案大一个量级，
   这才是真正会撑爆主包的部分。
3. **字体**。小游戏没有系统字体兜底，中文必须用位图字体或子集化字体。
   数据里的所有中文文案建议集中管理，方便后续生成字体子集。
4. **存档**用 `wx.setStorageSync`，单 key 上限 1MB。`history` 回退栈要限制深度（建议 50 步），
   否则长局游戏会写爆。

---

## 十一、下一步

| 优先级 | 事项 |
|---|---|
| **最高** | 决策 `docs/known-gaps.md` 中 3 个 🔴 阻塞项（49→50 通路、二区 BOSS、商人出售）——**不解决则游戏不可通关** |
| **最高** | 验证 PixiJS 能否在微信开发者工具里跑起来（`document`/`window` shim），这是选型结论的唯一风险点 |
| 高 | 按 §7 的 overlay 机制落地 `data/overrides.json`，让「忠实于源」与「修正缺口」不再冲突 |
| 高 | 重建 `data/events.json`，并借此把 §7 的事件专用 op 并入统一词汇表 |
| 高 | 实现 `GameState` 与各 reducer（移动/拾取/开门/战斗/事件），把 `core/` 补齐 |
| 中 | 为 `core/` 加单测，直接复用 `data/combat-cases.json` 的黄金用例 |
| 中 | 确定美术风格与瓦片/精灵尺寸规范（11×11 格，建议瓦片 32×32 或 48×48） |
| 中 | 评估三区（21–30 层）内容密度是否需要主动改造（属设计变更，非修错） |
| 低 | 接入 Tiled 或自研地图编辑器，替掉字符画流程 |
| 低 | 把 `tools/validate-data.mjs` 挂进 CI，`--strict` 模式作为合并门禁 |

---

## 附：当前交付内容

| 文件 | 实际内容 |
|---|---|
| `core/combat.mjs` | 战斗模拟唯一实现，导出 7 个纯函数 + trait 说明表 |
| `core/shop.mjs` | 商店定价/收益/累计/性价比/特攻道具提取，8 个纯函数 |
| `data/constants.json` | 战斗参数、初始属性、商店分档、经济上限、区域基准（含基准帖原文） |
| `data/tiles.json` | 12 种地形，含原版编号双向映射与通行性依据 |
| `data/monsters.json` | 34 只怪物 + 6 类 trait 说明 |
| `data/items.json` | 32 项道具 + 14 个 effect op 词汇表 |
| `data/npcs.json` | 6 个 NPC（含 `sourceId` 与行为依据）；商人含**分楼层商品清单**（12 层） |
| `data/combat-cases.json` | 21 条战斗 + 4 条领域 + 9 条商店黄金用例 |
| `data/floor-notes.json` | 15 条特殊楼层机制 + 4 条机制汇总 |
| `data/monster-placement.json` | 怪物出现层索引 + `neverPlaced` |
| `data/floors/` | **51 层**完整地图（11×11）+ 索引 |
| `tools/import-mota50.mjs` | 参考源码 → 楼层 JSON，含结构自检与落点修正 |
| `tools/validate-data.mjs` | 9 大类校验（A~I），含连通性求解、防漂移比对、参考源缺口检测 |
| `tools/build-balance-check.mjs` | 由数据源生成校验台，消除内联副本漂移 |
| `tools/balance-check.html` | 生成产物，双击即开 |

**当前状态：30 项检查通过，1 项警告（黄钥匙口径差异，成因已确认），0 项失败。**
21 条战斗用例 + 4 条领域用例 + 9 条商店用例全过，其中 17 条为攻略实测的第三方验证值。
数据层已可用于驱动渲染与逻辑开发——**但请先处理 `known-gaps.md` 的 3 个 🔴 阻塞项**。
