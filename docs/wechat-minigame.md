# 微信小游戏适配

本文记录把本项目的 PixiJS 8 游戏跑进微信小游戏环境的过程、依据与结论。

- 产物：`dist-minigame/game.js`（单文件 IIFE，约 2.00 MB / gzip 424 KB）
- 构建：`npm run build:minigame`
- 验证：`npm run verify:minigame`（无 DOM 环境实测，26 项判据 = 21 常驻 + 5 取证，退出码 0/1）

---

## 1. 小游戏不是「浏览器少几个 API」，而是第三种环境

| | 浏览器 | Web Worker | 微信小游戏 |
|---|---|---|---|
| `document` / `window` | 有 | 无 | 无 |
| `Image` / `MouseEvent` / `PointerEvent` | 有 | 无 | 无 |
| `WorkerGlobalScope` | 无 | **有** | 无 |
| 画布 | `document.createElement` | `OffscreenCanvas` | `wx.createCanvas()` |
| 入口 | `<script>` | `importScripts` | `game.js` 自动执行 |

第三、四行是关键。Pixi 里到处是**成对**的环境探测，而小游戏恰好落在两个反例的缝里：

- Pixi 认为「没有 `WorkerGlobalScope`」= 在浏览器窗口里 → 装配 `browserAll`
  （accessibility + dom + events + spritesheet + filters + rendering）。
  **小游戏装配的确实是这一套**，所以很多 DOM 依赖反而比 Worker 里更全地被激活了。
- Pixi 为 Worker 准备的守卫（如 `testVideoFormat` 的 `inWorker`）在小游戏里
  判定为假，于是继续往下走，撞上不存在的 `document`。

因此**不能**照抄 `weapp-adapter` 那套完整虚拟 DOM —— 那是给 Pixi 5/6/7 用的。
Pixi 8 的 `DOMAdapter` 只有 **9 个方法**（`environment-browser/BrowserAdapter.mjs`
整个文件 23 行），换掉它才是正解；虚拟 DOM 只需补 Pixi 真正碰到的那些面。

---

## 2. 适配层结构

```
src/minigame/
  env.ts          运行时垫片（document / MouseEvent / 事件总线 / 上屏画布预订）
                  ⚠️ 不含任何 import，必须由入口第一个 import
  pixi-adapter.ts 替换 DOMAdapter 为小游戏实现（第一个 import pixi 的模块）
  probe.ts        WebGL2 能力探针（真编译一段 #version 300 es 着色器）
  host.ts         宿主实现（尺寸 / dpr / 事件 / 启动失败弹窗）
  main.ts         入口，import 顺序即全部要害
```

### 为什么 `env.ts` 不能有任何 `import`

ESM 的求值顺序是「依赖先于自身」。只要 `env.ts` 里写上 `import { DOMAdapter } from 'pixi.js'`，
整个 Pixi 就会在它**之前**求值 —— 而 Pixi 的模块体里已经在读全局了
（`ismobilejs` 读 `navigator`、`canvasUtils` 造画布）。垫片还没装上就先用上了。

入口的 import 顺序（**不要重排**）：

```ts
import './env';          // ① 侧效应：装垫片 + 预订上屏画布
import './pixi-adapter'; // ② 侧效应：装 DOMAdapter（它是第一个 import pixi 的模块）
```

`env.ts` 里的 `assertInstalled()` 会把顺序错误变成一句人话，而不是让人去追
一串 `document is not defined`。

---

## 3. 六个实测撞出来的坑

下面的每一条都是**跑出来的**，不是读源码推导的。它们的共同特征是
**失败形态静默**：不报错、画面还能出来、或者只错一部分。

### ① `navigator` 必须在 Pixi 模块求值前就存在

**症状**：白屏，且没有任何业务代码参与。整包在加载阶段直接抛：

```
TypeError: Cannot destructure property 'userAgent' of
'DOMAdapter.get(...).getNavigator(...)' as it is undefined
```

**成因**：`glUploadImageResource.mjs` 有 `const defaultForceAllocation = isSafari();`
—— 一个**模块级常量**。`isSafari()` 读 `DOMAdapter.get().getNavigator()`，
而那一刻适配器还是默认的 `BrowserAdapter`（`getNavigator: () => navigator`）。

**修法**：`env.ts` 的 `installNavigator()` 排在 `installGlobals()` 第一句，
`gpu: null` 是刻意的（`isWebGPUSupported()` 读 `navigator.gpu`，给 null 才干脆返回 false）。

#### ⚠️ 同一处的第二层：「有原生 DOM」≠「有可用的 `navigator`」（2026-09-21 补）

上面这条最初只在**无 DOM 宿主**上验过，于是修法被写成了「宿主有原生 DOM 就整体让路」
—— 然后在 IDE 模拟器里翻了车：**IDE 有 `window`、有 `document`，`navigator` 的值却是 undefined**。

要命的是，Pixi 那句模块级 `isSafari()` 跑在我们 `DOMAdapter.set(...)` **之前**，
那时用的还是默认 `BrowserAdapter` —— 所以 `document` 在不在，对这条路径毫无影响。

由此得到一条通用规则 —— **垫片要「按项」判断可用性，不能按「宿主类型」一刀切**：

| 宿主提供的这一项 | 垫片该做什么 |
|---|---|
| 有且**可用** | 让路。硬覆盖必抛：`document` / `navigator` 在 window 上是只读的 `[LegacyUnforgeable]` 属性 |
| 没有 / **不可用** | 必须补上。IDE 模拟器就是这一种：#`document` 有、`navigator` 不可用 |

判「可用」的写法同样有坑：IDE 里 `navigator` 是**存在但值为 undefined**，
所以 `'navigator' in g` 与 `typeof g.navigator !== 'undefined'` 都会判成「有」。
只有**去看值**（`getNavigator().userAgent` 是不是非空字符串）才判得准。

这也解释了为什么「本地两侧全绿」不能替代在 IDE 里跑一次：真 Chromium 的
`navigator` 完备，这一页**测不出**它 —— 必须先在宿主里**把 `navigator` 也删掉**，
才会复现出 `navigator is not defined` 与「时间线只到 `module`」这个指纹。

### ② 上屏画布必须在 Pixi 模块求值前**预订**

**症状**：游戏正常启动、画面完全正确、触摸坐标也准 —— 但渲染到了一块
**没人看的画布**上。真机表现就是**黑屏**，毫无线索。

**成因**：`wx.createCanvas()` 只有**第一次**调用返回上屏画布。而 Pixi 自己在
模块求值期就会造画布：

```
lib/rendering/renderers/canvas/utils/canvasUtils.mjs
  → canUseMultiply: canUseNewCanvasBlendModes()      ← 模块级对象字面量里就调了
  → 内部 createColoredCanvas() × 2 + createCanvas(6, 1) × 1
```

三块 6×1 的小画布诞生在 Pixi 的模块体里，**早于宿主**。
那一刻我们的适配器还没装上，于是它们走默认 `BrowserAdapter.createCanvas`
→ `document.createElement('canvas')` → 把上屏画布离屏用掉了。

**修法**：`env.ts` 的 `reserveDisplayCanvas()` 挂在模块顶层侧效应里。
本模块不含任何 import，只要入口把它排第一位，就保证先于整个模块图求值 ——
**做第一个跑起来的模块**是唯一解法。

验证后的画布台账（`npm run verify:minigame` 会打印）：

```
# 1   1170×2532  ← 渲染目标   wegl2     ← reserveDisplayCanvas
# 2      6×1    2d                     ← Pixi 模块求值期的 createColoredCanvas
# 3      6×1    2d
# 4      6×1    2d
# 5      1×1    webgl2                 ← probeWebGL2
# 6/#7   1×1    webgl                  ← isWebGLSupported
# 8     32×64   2d                     ← 字体测量
```

### ③ `document.createElement('video')` —— Worker 守卫救不了小游戏

**症状**：图集**全部**加载失败，静默回退到程序化图形（画面还在，只是变丑）。

**成因**：`assets/detections/utils/testVideoFormat.mjs` 第一行是

```js
const inWorker = "WorkerGlobalScope" in globalThis && globalThis instanceof globalThis.WorkerGlobalScope;
```

Pixi 显然考虑过「Worker 里没有 document」。但小游戏没有 DOM、**也没有
`WorkerGlobalScope`** → 守卫为假 → 继续走到 `document.createElement("video")`。
它被 `detectMp4` / `detectOgv` / `detectWebm` 调用，而 `AssetsClass._detectFormats`
**没有 try/catch**，异常直接冒泡成 `Assets.init()` reject。

**修法**：给 `video` / `audio` 一个 `canPlayType: () => ''` 的替身。
空串 = 「不支持任何格式」，于是 mp4/ogv/webm 被**正确摘掉**。

> `testImageFormat` 不需要补。它在小游戏里返回 `false` 是无害的 ——
> 本项目只发 PNG，不走 `{webp,png}` 模板路径，格式表里少两种格式无所谓。

### ④ `document.createElement('button')` —— 让渲染器初始化失败

**症状**：**整个游戏起不来**，弹「启动失败」。

**成因**：`AccessibilitySystem` 构造函数里

```js
if (_mobileInfo.tablet || _mobileInfo.phone) this._createTouchHook();
```

这跟 `enabledByDefault` **无关**，只看机型判定，而 `isMobile()` 读
`navigator.userAgent`（我们的 UA 带 MicroMessenger，必然判成手机）。
它做的是 `document.createElement("button")` + `document.body.appendChild()`。
异常位置在 `WebGLRenderer._addSystems()`，一路穿过 `autoDetectRenderer`
→ `Application.init`。

**修法**：给 `button` / `div` 等元素一个通用替身（`makeStubElement`），
`document.body` 也是一个替身。钩子在无 focus 事件的环境里是死的，收下即可。

> 这条推翻了我最初写的注释「`AccessibilitySystem` 默认关闭所以不碰」——
> 那个前提是错的，注释已改正。

### ⑤ `DOMPipe.postrender` 每帧调 `_domElement.remove()`

**症状**：每帧抛 `TypeError: this._domElement.remove is not a function`，
整个游戏渲染不了。

**成因**：`dom/DOMPipe.mjs` 的 `postrender()` 挂在 postrender runner 上，
**每渲染一帧执行一次**：

```js
if (attachedDomElements.length === 0) { this._domElement.remove(); return; }
```

`_domElement` 是它 `document.createElement("div")` 造出来的。

**修法**：元素替身补齐 `remove()` / `parentNode` / `contains`。

### ⑥ 合成事件必须有 `target`，否则 `pointertap` 全失效

**症状**：事件确实送到了 —— `pointerdown` / `pointermove` 都正常触发
（悬停高亮照常变化），**唯独点击不生效**。所有按钮和棋盘格子都点不动。

**成因**：`EventSystem._onPointerUp` 里

```js
let target = nativeEvent.target;
if (nativeEvent.composedPath && nativeEvent.composedPath().length > 0) {
  target = nativeEvent.composedPath()[0];
}
const outside = target !== this.domElement ? "outside" : "";
event.type += outside;          // ← 'pointerup' 变成 'pointerupoutside'
```

而 `EventBoundary` 只在 **`pointerup`** 上生成 `pointertap`。
`target` 为 null → 事件被改名 → 全部 `on('pointertap')` 失效。

**修法**：`MiniMouseEvent` 的 `target` / `srcElement` 默认指向当前上屏画布
（由 `patchDisplayCanvas` 登记到模块级 `displayElement`）。

> **这一条是最难查的**：它伪装成了「目标格不可走」。
> 只看「有没有事件进去」是查不出来的，必须让判据能区分
> 「事件没送到」与「送到了但游戏没动」。

---

## 4. 三个「静默降级」防御

这三处 Pixi 都不报错，只会安静地走错分支，所以适配层主动兜住。

### `getBaseUrl` 必须返回空串

Pixi 解析资源路径走 `path.toAbsolute(url, root, DOMAdapter.get().getBaseUrl())`：

- `baseUrl = '/'` → `'assets/terrain.png'` 被拼成 `'/assets/terrain.png'`
  → 小游戏里带前导斜杠不是包内相对路径 → **图集加载失败**，且是静默的
  （`atlas.ready=false`，画面退回程序化图形，肉眼看着「还行」）。
- 空串时 `path.join('', 'assets/terrain.png')` 原样返回 ✅

### `getWebGLRenderingContext` 不能返回 `undefined`

Pixi 有 3 处调用，全都是**用 `instanceof` 判版本**：

```js
isWebGLSupported():  if (!getWebGLRenderingContext()) return false   ← 只要真值
GlContextSystem:     gl instanceof getWebGLRenderingContext() ? 1 : 2  ← 要判成 2
```

返回 `undefined` → 第一处直接 false → `autoDetectRenderer` **静默降级到
CanvasRenderer**（一个能力残缺的 2D 渲染器，精灵/遮罩/滤镜全不对）。
修法是给一个空类：既满足真值，又不会把真实的 WebGL2 误判成 WebGL1。

> 顺带确认了降级链是真实的：`autoDetectRenderer` 的
> `renderPriority = ['webgl','webgpu','canvas']`，而 `canvas` 分支
> **没有任何能力检测、无条件命中**。

### `getContextAttributes()` 决定 WebGL 可用性

```js
gl = canvas.getContext('webgl', { stencil: true, ... })
success = !!gl?.getContextAttributes()?.stencil
```

整段包在 try/catch 里，**抛异常等于 false**。所以适配层包了一层 `getContext`
给所有 GL 上下文补上 `getContextAttributes`。

### 坐标映射靠 `getBoundingClientRect`

`EventSystem.mapPositionToPoint`：

```js
point.x = (x - rect.left) * (this.domElement.width / rect.width) / resolution
```

网页里 `rect.width` 是 CSS 宽度（= 物理宽 / resolution），倍率正好抵消 resolution。
小游戏没有 `getBoundingClientRect`，Pixi 退到 `{ width: canvas.width }`（**物理**宽）
→ 倍率变成 1 → clientX 被多除一次 resolution。dpr=3 时点右下角，坐标只报到 1/3 位置。

**修法**：补一个返回**逻辑尺寸**的 `getBoundingClientRect`，并置 `isConnected = true`。

### 渲染器类型不能只靠肉眼

`RendererType` 是**数字枚举**（WEBGL=1 / WEBGPU=2 / BOTH=3 / CANVAS=4）。
`__probe().rendererType` 已经改成返回**名字字符串** —— 因为 `1` 看起来太像
「某个简化渲染器」，实测中就被误读过一次。

---

## 5. 触摸事件链

刻意锁到**鼠标分支**，不用 PointerEvent / TouchEvent：

- Pixi 选分支靠 `supportsPointerEvents = !!globalThis.PointerEvent`
  和 `supportsTouchEvents = 'ontouchstart' in globalThis`。
- pointer 分支还要 `PointerEvent` 构造器 + `document.dispatchEvent`（`EventTicker`
  每 50ms 派发合成 pointermove），要补的面更大。
- touch 分支要 `TouchEvent`，且 `_normalizeToPointerData` 有一堆 `changedTouches` 补全。
- **鼠标分支要求的全局最少**，而且它就是本项目网页端每天在跑、已过自动化验证的那条路径。
  复用同一条路径，就不存在「两个平台走两套 Pixi 内部逻辑」的隐性分叉。

三份独立事件总线，**必须**和 Pixi 注册的位置一一对应
（这是从 `EventSystem._addEvents` 逐行核出来的）：

| `wx` 回调 | 派发到 | 对应 Pixi 注册点 |
|---|---|---|
| `onTouchStart` | 先 `documentBus` `mousemove`，再 `canvasBus` `mousedown` | `document.mousemove` / `domElement.mousedown` |
| `onTouchMove` | `documentBus` `mousemove` | `document.mousemove` |
| `onTouchEnd` | `globalBus` `mouseup` | `globalThis.mouseup` |

touchstart 时**先**补一个 `mousemove`：网页上指针本来就会先移动再按下，
小游戏没有悬停，不补的话右下的详情面板永远不会更新。

分三份（而不是合成一份）是为了忠实还原「谁注册的谁收到」，
避免重复注册导致事件被派发两次。

---

## 6. 验证：两种宿主，两套判据

```bash
npm run verify:minigame   # 无 DOM 宿主（Web Worker），26 项判据 = 21 常驻 + 5 取证
npm run verify:dom        # 有原生 DOM 宿主（IDE 模拟器同类），14 项判据
npm run verify:all        # 以上两者 + verify:visual
```

**小游戏产物要跑在两类差异极大的宿主上，两类路径都必须测。**

- **无 DOM 宿主**：用 Web Worker 模拟真机小游戏。
  第一版只测了这一种，结果在 IDE 里一点「编译」直接黑屏 —— 因为 IDE 是另一套环境。
- **有原生 DOM 宿主**：用真 Chromium 页面模拟微信开发者工具的 IDE 模拟器。
  这是 `verify:dom` 要补的那一块。

### 为什么必须两种都测

微信开发者工具的模拟器不是「无 DOM + wx」的简单叠加，而是 **「有 wx、也有原生 DOM」**
的第四种环境。`document` / `navigator` 在 `window` 上是 `[LegacyUnforgeable]` 的
只读自有属性，而产物 IIFE 顶部有 `"use strict"`。
于是一条在其它三种宿主里永远不会出现的报错把它炸黑了：

```
TypeError: Cannot set property navigator of #<Window> which has only a getter
```

`installGlobals()` 把 `navigator` 排在第一位，它一抛，后面的 document 垫片、rAF 兜底、
以及紧随其后的 `reserveDisplayCanvas()`（抢上屏画布）全部**中断**；
没有上屏画布，表现就是**纯黑屏，而且窗口里一条报错都没有**（异常进了 IDE 的控制台，
那个控制台不落盘）。

修复方式是「**能装则装，装不上就让路**」—— 但**「按项」判、不能按「宿主类型」一刀切**：
`document` / `addEventListener` / canvas 事件方法在原生宿主上确有可用实现，就别碰；
而 `navigator` 只判它**是否可用**（有非空 `userAgent` 才让路），因为 IDE 模拟器
`#document` 有、`navigator` 却是 undefined（详见 §3 ① 的「第二层」）。

第一版写成「有原生 DOM 就整体让路」，于是 `navigator` 被一并放掉，
在 IDE 里撞出下一层错误：

```
TypeError: Cannot destructure property 'userAgent' of
'DOMAdapter.get(...).getNavigator(...)' as it is undefined
```

一模一样的两难，只是换了个全局 —— **看宿主类型做决定，迟早会漏掉某一项**。

### 判据（无 DOM 宿主，全部是数据，不是「看着对」）

```
✅ 无报错 / 无异常                       ✅ 启动没有弹「启动失败」
✅ 渲染器是 webgl（不是静默降级的 canvas）  ✅ 分辨率 = 设备像素比 3
✅ 帧缓冲里有实际画面（非背景色像素 > 30%） ✅ 画面不是纯色块（颜色种类 > 20）
✅ 图集走包内相对路径（无前导斜杠、无 hash） ✅ 图集真的加载成功（非静默回退程序化图形）
✅ 离屏画布确实拿到了（createCanvas ≥ 2 次）   ✅ 场景图里有精灵
✅ 宿主本来就没有 DOM（不用伪造）            ✅ project.config.json 声明 compileType=game
✅ appid 没被写成小程序游客号              ✅ 产物语法不高于 es2015（云端检查器的地板）
✅ 宿主本来有 Intl 且已真删（证明「无异常」不是假绿）  ✅ Intl 缺失时由垫片补上
✅ 上屏画布 = wx.createCanvas() 的第一块    ✅ 触摸点击精确落到预期格子（含远距离格）
✅ 越界点击被正确忽略                      ✅ 触摸事件能驱动游戏
✅ 移动方向与点击方向一致
```

两条「有效性」判据的由来：`Intl` 在真机小游戏里**不存在**，而 Pixi 在模块求值期读它的
**裸标识符**（`typeof Intl?.Segmenter` 被 esbuild 降到 es2015 时改写成了
`Intl == null ? void 0 : Intl.Segmenter`，`typeof` 的保护被绕掉了）。
宿主里删掉它、又**要求它真的没了**（置成 undefined 会让报错消失、判据变成假绿），
才能保住上面那条「无报错」的含金量。

（当前实测全部通过：非背景色像素 74.7%、6662 种颜色、150 个精灵节点、
5/5 次点击逐格命中，atlas.ready=true。）

### 有原生 DOM 宿主的判据

`npm run verify:dom` 用真 Chromium 页面 + wx 桩，核心是**两条方向相反的判据**：

```
✅ 宿主确实有原生 DOM（前置条件，不成立说明页面搭错了）
✅ document 让路：宿主原生实现未被替换（createElement / body.appendChild 都在）
✅ navigator 补齐：宿主不可用时垫片补上可用的 UA      ← 这一页必须先删掉 navigator
✅ 宿主本来有 Intl 且已真删 / Intl 缺失时由垫片补上
✅ 页面没有未捕获异常
✅ GameGlobal.mota 已暴露（游戏启动成功）
✅ 渲染器是 webgl                        ✅ 分辨率 = 设备像素比 3
✅ 上屏画布 = wx.createCanvas() 的第一块    ✅ 离屏画布 ≥ 2 次
✅ 取证时间线覆盖 module → shim → hostModule → host → probe → boot
✅ 帧缓冲里有实际画面（非背景色像素 > 30%） ✅ 画面不是纯色块（颜色种类 > 20）
```

**为什么这一页必须主动删掉 `navigator` 和 `Intl`：** 真 Chromium 两样都完备，
而 IDE 模拟器两样都没有 —— 不删就测不出那两条路径，本地会一路绿，
直到在你的 IDE 里点下「编译」才炸。它们同时是**前置条件**：只有在宿主确实缺这两样时，
「无异常 + 启动成功」才说明垫片补得对，而不是宿主本来就有。

注意第 8 条（图集）在 `verify:dom` 里**只记录、不判负**：有 DOM 时 Pixi 会走
`createImageBitmap` 分支，那条分支在一个 blob worker 里 `fetch(src)`，
blob worker 的 base URL 是 `blob:null/...`，**相对路径无法解析**，于是图集失败、
回退程序化图形；真机没有 Worker，走的是 `Image` 分支（经 DOMAdapter 落到
`wx.createImage()`），包内相对路径正常。所以这是**宿主差异**，不是产物缺陷。

### 一个必须记住的事实：**IDE 模拟器 ≠ 真机**（它有 `window` / `document`）

探针在真实 IDE 模拟器里采回来的 `module` 记录（落盘在
`assets/preview/wx-beacon/stages.json`）：

```json
{ "stage": "module", "t": 0,
  "data": { "hasWx": true, "wxKeys": 500, "hasGameGlobal": true,
            "hasWindow": true, "hasDocument": true,
            "hasWorkerGlobalScope": false, "hasRAF": true } }
```

`hasWindow` / `hasDocument` 都是 `true` —— 而**真机小游戏里这两个必须是 `false`**。
也就是说模拟器是「有 wx、也有 DOM」的第四种环境，它既不等于真机，也不等于浏览器。

> **探针后来还加了两项**（因为上面这条记录正是漏掉那处的原因）：
> `navigator: { present, hasUA }` 与一份 `env` 快照（`Intl` / `atob` / `structuredClone` /
> `TextDecoder` / `URL` / `OffscreenCanvas` … 的 `typeof` 结果）。
> 它们都记在**垫片安装之前**，反映的是宿主**原生**能力。
> 再遇到 `xxx is not defined`，先看这份快照里那一项是不是 `"undefined"`，
> 不用再靠推断或反复让人点编译。
>
> 其中 `navigator` 特意用 `present` / `hasUA` **两态**描述：IDE 里它是
> **存在但值为 undefined**，只看 `present` 会得出「有 navigator」这个错误结论。

由此两条推论：

- 「在 IDE 里跑通了」**不能**推出「真机跑得通」，反之亦然 —— 所以无 DOM 实测
  （本节，Worker 宿主）和真机截图各有不可替代的位置。
- 排查「某段代码走了哪条分支」时，**直接看这条 `module` 记录**，比任何推断都准。
  它是探针装的第一个点，早于一切环境判断代码。

### 顶层异常怎么定位：模块求值期的埋点阶梯

入口 `main.ts` 的函数体跑不到时（六个 import 里任何一个在**求值期**抛错），
时间线会**只剩一条 `module`** —— 看不出炸在哪一段。所以另外埋了两个点，
把 import 段切成三段：

```
module →（env + pixi）→ shim →（host / probe / app 模块）→ hostModule → 入口函数体 → host → probe → boot
```

两个埋点分别在 `pixi-adapter.ts` 与 `host.ts` 的模块体末尾（都是纯副作用模块，
位置天然对得上 import 顺序）。缺哪一段，故障就在那一段里。

### 采异常时的坑：`wx.onError` 的参数形状因基础库而异

真机上是 `(msg: string, stack: string)`，而**本机 IDE 给的是一个普通对象**。
第一版探针直接写 `String(msg)`，采回来的是 `"[object Object]"` ——
等于白采一轮（只知道「13ms 处炸了」，不知道炸的是什么）。
现在统一走 `describe()` 兜底（先挑 `message`/`errMsg`/`stack` 等已知字段，
再 JSON，再退回 own keys），并把**原始形状**（`Object.prototype.toString` 与 key 列表）
一起报上来：形状本身就是事实，下次遇到新基础库可以直接照它加分支。

### 三条关于「怎么判」的经验

**① 分开判「事件送到了哪」与「游戏有没有动」。**
这两件事的症状在自动化里长得一模一样（「点了一下，人没动」），
但成因完全不同：前者是适配层的责任，后者掺进了游戏规则（那格可不可走）。
为此 `__probe()` 增加了 `lastBoardClick`（记录在**所有提前 return 之前**，
因为被守卫挡下的点击同样是有价值的证据）。
合并成一个判据就会分不清故障在哪一侧 —— 实测中就被这么误导过一轮。

**② 相邻格不够，要加远距离格。**
相邻格只能证明「偏不到一格」；而缩放类错误（漏掉 resolution）整体偏约 4 格。
本次探针点 `far-up (5,6)` 与 `far-right (9,9)`：两者都**精确命中**，
但都走不过去 —— 因为 floor 1 从起点 `(5,10)` 起连通的空地只有 6 格，
`(5,6)` 是墙、`(9,9)` 虽是空地但被第 7 列的墙隔断。
「命中但没动」在这里是**正确行为**，所以判据只对界内目标断言「命中」，
不要求「走过」。

**③ 「产物里不许有某段文本」这类判据，不能靠裸 grep。**
语法地板那条判据（见 §7）第一版写成了 `grep -c '?.' game.js`，直接假报：
`?.` / `??` 在**注释和字符串**里是合法文本 —— pixi 的 JSDoc 里就有一处
`Resolver.RETINA_PREFIX.exec(value)?.[1] ?? '1'`，worker 源码常量里还有
`async function`。而到了 IDE 那边，浏览器 / Chromium 更不会替你发现这个差别：
本地 Node 和 Chromium 都支持 ES2020，`npm test`、`npm run verify:*` 全绿，
**只有微信那台云端检查器会红灯**。
现在改用「以地板目标复算并比对 token 计数」：真有高于地板的**语法**时，
复算会把它降掉 → 计数变少 → 判负；注释/字符串里的同名字符串两边原样保留 → 不误伤。

---

## 7. 产物与发布

```
dist-minigame/
  game.js               2.00 MB（gzip 424 KB）单文件 IIFE
  game.json             小游戏配置
  project.config.json   开发者工具配置
  assets/*.png          4 张图集（39.2 KB），包内相对路径
```

`vite.minigame.config.ts` 要点：

- `lib` 模式 + `iife` + `inlineDynamicImports: true` → 必须单文件，
  小游戏的 `importScripts` 式装载没有模块解析能力。
- `base: ''` → 配合 `getBaseUrl: () => ''`，保证 `assets/*.png` 是包内相对路径。
- `atlasPlainUrl()` 插件把 `assets/atlas/*.png` 的 import 改写成字符串字面量，
  避免 Vite 产出带 hash 的 URL（小游戏里就是文件名）。

### 语法地板：产物不能高于 ES2015（**镜像云端检查器实测**）

**这不是保守偏好，是被一次失败钉出来的。**

产物原本按 `target: 'es2020'` 打，理由是「小游戏侧 WebGL2 本身要求 iOS≥14 /
基础库≥2.15，运行时门槛已经高于 ES2020 的语法门槛」。这个推理漏掉了关键一环：
**代码在上传/预览时会先过一遍微信云端的语法检查**，而那个检查器不接受 ES2020 语法。
在 IDE 里点「编译」后立刻失败：

```
task type:upload exec error Error: invalid file: game.js, 13:9
SyntaxError: Unexpected token .          ← 指向 `wx?.request?.(` 里的 `?`
```

- `invalid file: <文件>, <行>:<列>` 是**服务端**返回的 errmsg（错误码
  `DEV_COMPILE_INVALID_FILE` = -80057）；DevTools 的 `upload.parseError` 收到后
  用 sourcemap 把它渲染成 code frame 再给人看。rollup 的 `target` 只影响**本地**
  打包产物，管不到这一步 —— 所以「本地全绿」和「IDE 能跑」之间差着这一环。
- 一个很有用的旁证：报错停在文件里**第一个** ES2020 token 上（第 13 行），
  而它前面 12 行的箭头函数与 `const` 都过了。所以检查器的地板落在
  **ES2015 与 ES2020 之间**，而 ES2015 是它明确能吃下的 —— 于是 `build.target`
  取 `es2015`：任何能接受 ES2015 的检查器都必然接受本产物。
- 代价：async/await 降级成「生成器 + `__async` 辅助」，对象展开变成
  `Object.assign`，可选链/空合并变成三元。包体 1.95 → 2.00 MB（+2.5%），语义不变。

**`setting.es6` 为什么保持 `false`。** 开发者工具里那个「ES6 转 ES5」开关
（`project.config.json` 的 `setting.es6`）同样能把代码降到 ES5，但那意味着
**IDE 里跑的是 babel 的输出、不是你验证过的那份产物**。语法地板放在构建期更可控：
一份产物、一处断言、`npm run verify:minigame` 里就会红。

⚠️ 三处必须对齐：`build.target`（打包时降级）、`tools/verify-minigame.cjs` 的
`SYNTAX_FLOOR`（断言产物）、`setting.es6: false`（不让 IDE 再降一遍）。
改了 `build.target` 就要同步改 `SYNTAX_FLOOR`：判据是拿 `SYNTAX_FLOOR`
去复算产物的，地板定高了会漏判，定低了会假报。

### `game.json`

```json
{
  "deviceOrientation": "portrait",
  "showStatusBar": false,
  "networkTimeout": { "request": 10000 },
  "iOSHighPerformance": true
}
```

### 关于 WebGL2（**上架前必须确认**）

Pixi 8 的着色器全是 `#version 300 es`（GLSL ES 3.00），渲染器**只有 WebGL2/WebGPU，
没有 WebGL1 回退路径**。所以小游戏端 WebGL2 是硬前提：

- **Android**：8.0.24+ 支持 WebGL2。
- **iOS**：必须开**「高性能+」模式**（客户端 8.0.45+，iOS ≥ 14，推荐 15.5+），
  且需先在 MP 平台为该项目开启。`iOSHighPerformance: true` 就是这个开关。
- 官方文档提示 iOS 高性能普通模式下「WebGL2 会存在较多问题」，
  且 `getContext('webgl2')` 可能返回**看似有效但实际损坏的上下文而非 null**。

**因此 `probe.ts` 不只判 null，而是真编译一段 `#version 300 es` 着色器**，
并检查 `createVertexArray` / `texStorage2D` 是否存在 —— 用来识破那种
「非 null 但不可用」的假上下文。探针不过就弹人话提示，不白屏。

---

## 8. 在微信开发者工具里打开：项目类型由 **appid** 决定，不由 `compileType` 决定

导入 `dist-minigame` 后一编译就报：

```
Error: app.json: 在项目根目录未找到 app.json
File: app.json
```

小游戏明明只要 `game.json`，为什么要找 `app.json`？因为**工具压根没把这个工程当小游戏**。

（把类型改对之后紧接着会撞上的下一个坑是**语法地板**：产物里若有 ES2020 语法，
云端编译服务会以 `invalid file: game.js` 拦下 —— 见 §7「语法地板」那节。）

### 判定链路（本机 wechatwebdevtools 36.6.0 / IDE 界面版本 2.02.2608070 实测）

`project.config.json` 的 `compileType` 有四个取值，小游戏是 `game` —— 我们写的一直是 `game`。
但导入时的类型校验根本不看它，看的是 **appid 在服务端返回的 `gameApp` 属性**：

```js
// 导入对话框 project-creation 组件
async checkAppIdTypeVaild(t) {          // t = 该 appid 的 attr
  const e = t.gameApp;
  return this.props.type !== ProjectType.MiniGame || e
    ? (this.props.type !== ProjectType.MiniProgram || !e || (this.hintError(...), !1))
    : (this.hintError(...), !1);        // ← 选小游戏但 gameApp=false：直接拦下
}
```

拦下之后的回退动作写在 `refreshMenuSelectedWithCorrectAppID()` 里：

```js
if (!t.gameApp && d /* d = 当前选的是小游戏 */) {
  this.props.entranceActions.selectMenu('miniprogram');   // ← 自动切回小程序
}
```

于是编译端记下一行日志，这就是本坑的指纹：

```
[BuilderFactory] shouldCreate=true requestId=14 reason=compileType changed old=game new=weapp
```

`old=game` 是我们文件里写的（工具读到了），`new=weapp` 是它自己改的。
之后管线按小程序跑 → 找 `app.json` → 报错。

### 关键：**测试号（沙箱）是分类型的**

取号接口是 `fetchSandboxAccount(tab)`，`tab` 只取 `miniprogram` / `minigame` 两个值 ——
「小程序测试号」和「小游戏测试号」是**两个不同的 appid**。

本机上那个容易被顺手拿来用的 `wxa075fdefa9d0a322` 是**小程序**测试号，证据就在工具自己的缓存里：

```bash
# 工具把 appid 属性缓存在 WeappLocalData 下，直接数一遍就知道有没有小游戏账号
cd "$HOME/Library/Application Support/微信开发者工具"/*/WeappLocalData
grep -o '"gameApp":true' *.json | wc -l    # → 0
grep -o '"gameApp":false' *.json | wc -l   # → 2
# appid=wxa075fdefa9d0a322  appName=xxx的接口测试号  gameApp=false  isSandbox=true
```

`gameApp: true` 的出现次数是 **0** —— 也就是说该账号名下**一个小游戏类型的 appid 都没有**，
所以它无论怎么导入都会被判成小程序。

### 正确的导入方式

1. 在开发者工具的**项目列表**窗口选**小游戏**，再「导入项目」；
2. 目录选 `dist-minigame`；类型必须是**小游戏**（这一点在导入对话框里就要选对，
   项目窗口里的「更换开发模式」只有「公众号网页调试 / 小程序调试」，改不了这个）；
3. **AppID 别填 `touristappid`** —— 那是小程序的游客号（小游戏的游客号是
   `wx6ac3f5090a6b99c5`），同样 `gameApp: false`。用输入框旁的
   **「或使用测试账号：小程序 / 小游戏」**，点**小游戏**，工具会去
   `fetchSandboxAccount('minigame')` 取一个小游戏测试号；也可以填自己申请的小游戏 AppID。
4. 这样 `compileType` 才会真的停在 `game`，编译走 `game.json`，不再找 `app.json`。

模板里 `appid` 因此**故意留空**：导入时 `onDetectionChange()` 会拿
`project.config.json` 里的 appid 去校验，预填一个错的只会被回退，不如空着让对话框自己取号。

### 两个顺带的反直觉点

- **别信存储里的 `compileType`。** `reduxPersist:projectList` 里存的是**导入时的意图**（可能是
  `game`），`project2_<项目绝对路径>` 才是**实际生效**的那份（已被服务端属性改写成 `weapp`）。
  两个键会打架，看日志比看存储直接。
- **`miniprogramRoot` 不是线索。** 小游戏工程也用它，工具自己会把它归一成 `""`。

排错时先看日志，一眼就能定位：

```bash
grep -E "compileType changed|app.json" \
  "$HOME/Library/Application Support/微信开发者工具"/*/WeappLog/logs/*.log
```

---

## 9. 复现命令

```bash
npm run build:minigame    # 构建产物（含 tsc --noEmit）
npm run verify:minigame   # 无 DOM 环境实测，26 项判据
npm run verify:dom        # 有原生 DOM 宿主实测，14 项判据
npm run verify:all        # 以上两套 + verify:visual
```

- `assets/preview/minigame-board.png`：无 DOM 宿主里 `transferToImageBitmap()` 出来的画面。
- `assets/preview/dom-host.png`：有原生 DOM 宿主（IDE 模拟器同类）里的页面截图。
- `assets/preview/wx-beacon/dom-host-frame.png`：有 DOM 宿主里探针自采的首帧像素网格。

三套画面用途不同：无 DOM 那套保证真机路径，有 DOM 那套保证 IDE 路径，
网格那套把「画面是不是纯黑 / 纯色块」变成可离线重建的数据。
