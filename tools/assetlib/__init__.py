"""
素材构建包 —— 由 `tools/build-assets.py` 拆分而来（入口仍是那个文件，`npm run assets` 不变）。

## 分层（import 箭头**只能**从上往下）

```
config    路径 + 网格常量（唯一一处定义坐标系的地方）
palette   跨模块共用的调色板（各造型自己的配色不在这里）
pixel     像素原语：调色板变换 / 描边 / 写像素
metrics   量像素的统计量（只服务断言）
shapes    手绘形状原语（怪物与 BOSS 共用）
raster    出图归一化 + 放大 + 架子排布
sources   第三方素材包读取
data      构建期真值表（哪只怪用哪张图 / 谁是 BOSS）
terrain   地形     ← 含地形断言
items     道具     ← 含道具断言
hero      勇者     ← 含勇者断言
npc       NPC      ← 含 NPC 比例断言
monsters  手绘怪物 ← 含怪物断言
bosses    BOSS     ← 含 BOSS 断言
main      编排 + 写文件（唯一有副作用的模块）
```

## 两条不变量

1. **`raw/` 只读**：任何变换都在代码里表达，绝不手工修图（否则重跑就冲掉了）。
2. **除 `main` 外全为纯函数**：同样的输入必然画出同样的像素 ——
   素材可重跑、可 diff 的前提就在这里（`meta.generatedAt` 之外的字段必须逐字节稳定）。

断言跟着**它的对象**走：`verify_terrain` 在 `terrain.py`、`verify_hero_art` 在 `hero.py`，
而不是集中到一个 `checks.py`。理由是这些断言要引用各自造型的常量表
（比如 `verify_hero_art` 要扫全部 `H_*` 常量防撞色），
拆开会凭空多出一堆「常量在 A、判据在 B」的跨文件跳转。
"""
