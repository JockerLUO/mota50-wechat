# 素材来源与授权（ATTRIBUTION）

本文件记录 `assets/` 下**每一个像素的来源**。所有素材均来自公开的免费素材包，
**全部为 CC0（Creative Commons Zero，公有领域）** —— 可商用、可修改、可再分发，
**不强制署名**。此处署名是出于对作者的尊重与可追溯性，不是许可证要求。

> ⚠️ **重要说明**：本项目的风格目标是「贴近马里奥 / 塞尔达织梦岛」，
> 但**没有使用任何任天堂素材**。马里奥与塞尔达是任天堂的注册商标与著作权作品，
> 直接取用其美术资源会构成侵权，尤其在微信小游戏这类需要软著登记的商用时。
> 下面这些 CC0 素材是「同类型 16×16 俯视像素风」的合法替代，观感同源但权属干净。

---

## 一、授权汇总

| # | 素材包 | 作者 | 授权 | 原始文件 | 归入位置 |
|---|---|---|---|---|---|
| 1 | **16×16 DungeonTileset II** | Robert Norenberg（0x72） | **CC0** | `assets/raw/0x72/` | 怪物、道具、地形主体 |
| 2 | **Zelda-like tilesets and sprites** | ArMM1998（Armando Montero） | **CC0** | `assets/raw/armm-zeldalike/` | **勇者 4 向走路/挥剑、NPC 4 向**、地表/洞窟/室内图块、物件与特效 |
| 3 | **Tiny Dungeon** | Kenney Vleugels（[kenney.nl](https://kenney.nl)） | **CC0** | `assets/raw/kenney/tiny-dungeon/` | 钥匙（三色）、盾牌、地牢局部图块 |
| 4 | **Tiny Town** | Kenney Vleugels | **CC0** | `assets/raw/kenney/tiny-town/` | 村镇图块（备用） |
| 5 | **Roguelike Characters** | Kenney Vleugels | **CC0** | `assets/raw/kenney/roguelike-characters/` | 人形素材（备用） |
| 6 | **Roguelike RPG Pack** | Kenney Vleugels，协作 Lynn Evers | **CC0** | `assets/raw/kenney/roguelike-rpg-pack/` | 环境/建筑图块（备用） |
| 7 | **UI Pack: Pixel Adventure** | Kenney Vleugels | **CC0** | `assets/raw/kenney/ui-pack-pixel-adventure/` | 界面（待接入） |
| 8 | **Mobile Controls** | Kenney Vleugels | **CC0** | `assets/raw/kenney/mobile-controls/` | 虚拟摇杆/按键（待接入） |
| 9 | **Tiny Zelder Clone Topdown Pack** | wareya | **CC0** | `assets/raw/tiny-zelder-clone/` | 备用：4 向 × 3 帧玩家、4 向 × 2 帧敌人 |

各包内的原作者 `License.txt` 已一并归档，可直接查阅核对。

---

## 二、逐包详情

### 1. 16×16 DungeonTileset II — CC0

- **作者**：Robert Norenberg（署名 0x72）
- **授权原文**：*"As always: You can use this tileset for whatever you like (CC-0)."*
- **权威出处**：<https://0x72.itch.io/dungeontileset-ii>
- **本项目的取用路径**：该包在 itch.io 主站体积较大，本项目改从其
  **v1.3 逐帧目录**取用（该目录把每个动作拆成了带语义命名的独立 PNG，
  无需再目测切图）。取用镜像：`benc-uk/super-dungeon-delve`
  的 `etc/0x72_DungeonTilesetII_v1.3/`，同时保留了完整图集
  `0x72_DungeonTilesetII_v1.3.png`。
- **本项目用到的内容**：
  - **25 种生物**，每种含 `idle` 4 帧 + `run` 4 帧
    （skelet / wogol / zombie / imp / swampy / muddy / wizzard_m / wizzard_f /
    orc_shaman / orc_warrior / masked_orc / necromancer / goblin / knight_m /
    knight_f / elf_m / ogre / chort / big_demon / big_zombie / ice_zombie /
    tiny_zombie / lizard_m / lizard_f / elf_f）
  - 22 把武器、4 色药水（flask）、3 态宝箱、金币动画、UI 心形
  - 全套墙体（转角/侧边/顶边）、地面 8 变体、门、旗帜、喷泉、柱子、
    尖刺、梯子、木箱、骷髅、洞口、黏液
- **注意**：该包**未附 `LICENSE` 文件**，授权声明仅见于其 itch.io 页面。
  已在 `docs/assets.md` 记录核实过程。

### 2. Zelda-like tilesets and sprites — CC0

- **作者**：ArMM1998（Armando Montero）
- **授权原文**：页面 license 字段标注为 **CC0**；作者在评论区进一步明确
  *"ArMM1998 ha licenciado este arte como CC0. Eso significa que puedes usar
  esta obra de arte en tu juego. Úselo como lo desee."*
- **出处**：<https://opengameart.org/content/zelda-like-tilesets-and-sprites>
- **本项目用到的内容**：
  - `character.png` —— **勇者 4 方向 × 4 帧走路 + 4 方向 × 4 帧挥剑**
    （这是全项目唯一真正的「角色多角度」来源）
  - `NPC_test.png` —— NPC **4 方向 × 4 帧**
  - `Overworld.png` / `cave.png` / `Inner.png` —— 地表/洞窟/室内图块（备用）
  - `objects.png`、`font.png` —— 物件、特效与位图字体（备用）

### 3–8. Kenney 系列 — 全部 CC0

- **作者**：Kenney Vleugels for [Kenney](https://kenney.nl)（Roguelike RPG Pack
  另标注 "with help by Lynn Evers"）
- **授权原文**（摘自各包 `License.txt`）：
  > License (Creative Commons Zero, CC0)
  > http://creativecommons.org/publicdomain/zero/1.0/
  > You may use these graphics in personal and commercial projects.
  > Credit (Kenney or www.kenney.nl) would be nice but is not mandatory.

### 9. Tiny Zelder Clone Topdown Pack — CC0

- **作者**：wareya
- **授权原文**：*"Can be used for anything without permission or credit or restriction."*
  （CC0）
- **出处**：<https://opengameart.org/content/tiny-zelder-clone-topdown-pack>
- **本项目用到的内容**：暂无（作为「4 向 + 帧数更少」的备用方案保留）

---

## 三、建议的署名文案

CC0 不强制署名，但如果你愿意在游戏内「关于」页加一行，可用：

```
本游戏使用了以下 CC0 素材：
  16×16 DungeonTileset II      © 0x72 (Robert Norenberg)
  Zelda-like tilesets/sprites  © ArMM1998
  Tiny Dungeon / Tiny Town     © Kenney (kenney.nl)
  Tiny Zelder Clone            © wareya
以上素材均以 CC0 公有领域许可发布。
```

---

## 四、需要留意的事项

1. **`0x72` 包缺 `LICENSE` 文件**。授权仅见于 itch.io 页面正文。若本项目
   进入正式的商业发行流程，建议**留存一份页面截图或存档链接**作为尽调凭据。
2. **CC0 不涉及商标**。素材本身可用，但**不要**在游戏标题、图标里使用
   「马里奥」「塞尔达」「Mario」「Zelda」等任天堂商标，也不要用
   与其高度近似的角色造型 —— 那是另一层风险，且与素材授权无关。
3. **素材是本项目二次加工的产物**。图集里的怪物经过调色板变换
   （见 `tools/build-assets.py` 的 `MONSTERS` 表），11 项道具为程序化生成。
   这些派生物同样落在 CC0 之下，不引入新的授权约束。
4. 所有变换均由 `tools/build-assets.py` 可重跑生成。**不要手工修改
   `assets/atlas/` 下的文件** —— 重跑会覆盖。
