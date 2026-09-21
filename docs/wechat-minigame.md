# 微信小游戏适配

本文记录把本项目的 PixiJS 8 游戏跑进微信小游戏环境的过程、依据与结论。

- 产物：`dist-minigame/game.js`（单文件 IIFE，约 1.96 MB / gzip 416 KB）
- 构建：`npm run build:minigame`
- 验证：`npm run verify:minigame`（无 DOM 环境实测，15 项判据，退出码 0/1）

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

## 6. 验证：无 DOM 环境实测

```bash
npm run verify:minigame     # 15 项判据，退出码 0/1
```

**宿主用 Web Worker，不用普通页面。** 第一版是在页面上删 `document` 来伪装，
直接失败：按 HTML 规范 `document` 在 window 上是 `[LegacyUnforgeable]` 的
**自有属性** —— `delete` 无效、`defineProperty` 抛错、
`globalThis.document = xxx` 在严格模式下抛
「Cannot set property document of #<Window> which has only a getter」。

而 **Web Worker 天生就是一个没有 DOM 的 JS realm**，这正是小游戏的处境，
且**不需要伪造** —— 不用伪造的东西就没法「假装通过」。

有一个小动作很关键：用 `delete` 抹掉 `self.WorkerGlobalScope`
（**不能**赋 `undefined`，否则 `in` 依然为真，随后 `instanceof undefined` 抛
「Right-hand side of 'instanceof' is not an object」），
迫使 Pixi 加载 `browserAll` —— 也就是小游戏实际走的那条路径。

### 判据（全部是数据，不是「看着对」）

```
✅ 无报错 / 无异常                       ✅ 启动没有弹「启动失败」
✅ 渲染器是 webgl（不是静默降级的 canvas）  ✅ 分辨率 = 设备像素比 3
✅ 帧缓冲里有实际画面（非背景色像素 > 30%） ✅ 画面不是纯色块（颜色种类 > 20）
✅ 图集走包内相对路径（无前导斜杠、无 hash） ✅ 离屏画布确实拿到了（createCanvas ≥ 2 次）
✅ 场景图里有精灵                        ✅ 宿主本来就没有 DOM（不用伪造）
✅ 上屏画布 = wx.createCanvas() 的第一块   ✅ 触摸点击精确落到预期格子（含远距离格）
✅ 越界点击被正确忽略                    ✅ 触摸事件能驱动游戏
✅ 移动方向与点击方向一致
```

（当前实测全部通过：非背景色像素 74.7%、7804 种颜色、150 个精灵节点、
5/5 次点击逐格命中。）

### 两条关于「怎么判」的经验

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

---

## 7. 产物与发布

```
dist-minigame/
  game.js               1.96 MB（gzip 416 KB）单文件 IIFE
  game.json             小游戏配置
  project.config.json   开发者工具配置
  assets/*.png          4 张图集（38.5 KB），包内相对路径
```

`vite.minigame.config.ts` 要点：

- `lib` 模式 + `iife` + `inlineDynamicImports: true` → 必须单文件，
  小游戏的 `importScripts` 式装载没有模块解析能力。
- `base: ''` → 配合 `getBaseUrl: () => ''`，保证 `assets/*.png` 是包内相对路径。
- `atlasPlainUrl()` 插件把 `assets/atlas/*.png` 的 import 改写成字符串字面量，
  避免 Vite 产出带 hash 的 URL（小游戏里就是文件名）。

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

## 8. 复现命令

```bash
npm run build:minigame    # 构建产物（含 tsc --noEmit）
npm run verify:minigame  # 无 DOM 环境实测，15 项判据
```

验证截图落在 `assets/preview/minigame-board.png` —— 那是一帧从无 DOM 宿主里
`transferToImageBitmap()` 出来的真实画面，可以和判据互相印证。
