# 微信小游戏适配

本文记录把本项目的 PixiJS 8 游戏跑进微信小游戏环境的过程、依据与结论。

- 产物：`dist-minigame/game.js`（单文件 IIFE，约 2.11 MB / gzip 458 KB）
- 构建：`npm run build:minigame`
- 验证：`npm run verify:minigame`（无 DOM 环境实测，25 项常驻判据；用
  `npm run build:minigame:beacon` 的取证构建再跑，另得 6 项取证判据 = 31。退出码 0/1）

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
  beacon.ts       启动取证探针（无 DOM 宿主下唯一的观测口；非取证构建里是空实现）
                  ⚠️ 不含任何 import，必须由入口**第一位** import
  env/            运行时垫片（document / MouseEvent / 事件总线 / 上屏画布预订）
                  ⚠️ 子树内不许 import 子树之外的任何东西，必须由入口第二位 import
    state.ts        共享槽位（envState）+ Any / wxApi
    assign.ts       属性只读时的安全赋值 + nativeDom 判据
    system.ts       wx.getSystemInfoSync() 的唯一入口
    events.ts       三份事件总线 + hookEventTarget
    mouse-event.ts  MiniMouseEvent
    navigator.ts    Intl / navigator 补齐
    url.ts          URL 替身（RFC 3986 相对解析自实现，见 §9.15）
    canvas.ts       getContext 补丁 + 离屏 / 上屏画布
    document.ts     document 替身
    globals.ts      installGlobals 的装配顺序 + assertInstalled
    touch.ts        wx.onTouch* → 总线
    display.ts      上屏画布预订
    bare.ts         裸标识符可达性自查（**必须裸读**，见 §11）
    index.ts        门面 + 副作用（安装顺序即依赖顺序）
  pixi-adapter.ts 替换 DOMAdapter 为小游戏实现（第一个 import pixi 的模块）
  probe.ts        WebGL2 能力探针（真编译一段 #version 300 es 着色器）
  host.ts         宿主实现（尺寸 / dpr / 事件 / 启动失败弹窗）
  main.ts         入口，import 顺序即全部要害
```

### 为什么 `env/` 子树不许 `import` 子树之外的东西

**先说这条规则保护的是什么。** 拆成目录之前，这条写的是「`env.ts` 不能有任何 `import`」。
那个写法**保护的是结果，不是原因** —— 真正要保证的是下面这条链：

```
入口的第一个 import 是 ./env
  → env 子树整体先求值
    → 垫片装好、wx.createCanvas() 第一次调用被我们抢下
      → 此后才轮到 pixi 的模块体
```

ESM 的求值顺序是「依赖先于自身」。只要 `env/` 里某一层写了 `import { DOMAdapter } from 'pixi.js'`，
**整个 Pixi 就会在它之前求值** —— 而 Pixi 的模块体里已经在读全局了
（`ismobilejs` 读 `navigator`、`canvasUtils` 造画布）。垫片还没装上就先用上了。

拆成目录后，`env/` **内部**互相 import 是完全安全的：那些兄弟模块同样排在 pixi 之前
（`main.ts` 的 import 顺序没变，`env/` 子树是一个整体）。真正会打破上面那条链的只有一种情况：
**`env/` 里 import 了 `env/` 之外的东西**，尤其是 `pixi.js`。所以规则收窄成现在这句。

> 需要 `DOMAdapter` 的那部分在 `pixi-adapter.ts`，入口里排在 `env` 之后 import；
> `env/` 自己一个字节的 pixi 都不碰。

入口的 import 顺序（**不要重排**）：

```ts
import { beaconStage } from './beacon'; // ⓪ 侧效应 + 取证（比 ① 还严格，见下）
import './env';          // ① 侧效应：装垫片 + 预订上屏画布
import './pixi-adapter'; // ② 侧效应：装 DOMAdapter（它是第一个 import pixi 的模块）
```

`env/globals.ts` 里的 `assertInstalled()` 会把顺序错误变成一句人话，而不是让人去追
一串 `document is not defined`。

> **为什么 `beacon.ts` 要排在 `env/` 前面**，而且它比 `env/` 更严格（自己一个 import 都不能有）：
> 它要抓的正是「连垫片都没装上就死了」这种情况 —— 那恰恰是最可能发生的一种。
> 排在后面就等于「观测器比被观测对象晚到」。它住在 `src/minigame/beacon.ts`，
> 不在 `env/` 里，因为它需要网络 / 存储 API（要发回本机的 HTTP 端点），
> 放进 `env/` 会违反上面那条规则。

### 数据层：`src/data/` 与 `@data-source`（同一份逻辑，两套取数机制）

适配层还有一件事：**数据从哪来**。两端差异很大 —— 网页端在构建期把 json 内联进 bundle，
小游戏端要在运行期从代码包里读文件。这件事靠一个 alias 隔开，**游戏代码里没有一处 `if`**：

```
src/data/
  types.ts            纯类型（一行业务代码都没有，改字段时只看这一个文件）
  source.ts           JsonSource 契约（只有一个 read(key)，刻意不给 listDir/exists）
  source-web.ts       ← web 端：7 个显式 import + 一条收窄的 import.meta.glob（构建期内联）
  source-minigame.ts  ← 小游戏端：wx.getFileSystemManager().readFileSync（运行期读代码包）
  runtime-files.mjs   运行时需要哪些 data/ 文件 —— **跨语言共享的单一来源**
  index.ts            加载 + 索引 + 便捷查询（外部一律 import '../data'）
```

```ts
// 两个 vite 配置各自把 @data-source 指到自己的实现；tsconfig 的 paths 指 web 版做类型检查
import { jsonSource } from '@data-source';       // ← 游戏代码里只写这一行
```

`runtime-files.mjs` 之所以写成 `.mjs` 而不是 `.ts`：它有两个消费者，TS 侧与 Node ESM 拷贝脚本，
`.mjs` 是**唯一让两边都能直接 import 的形式**。写成 `.ts` 的话拷贝脚本就得去正则解析源码，
源码格式一变就静默失效（后果是「包内缺文件 → 真机白屏」）。
两边还各有一条**有穷尽断言**兜底：清单里列了但没人读 → 报错；代码要读但清单没列 → 报错。

> 拆包边界、`readFileSync` 的路径规则、以及「网页端内联 / 小游戏端读文件」的取舍理由，
> 都在 §7 里，那里是产物形态的主场。

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

**修法**：`env/navigator.ts` 的 `installNavigator()` 排在 `installGlobals()` 第一句，
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

**修法**：`env/display.ts` 的 `reserveDisplayCanvas()` 挂在模块顶层侧效应里。
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
npm run verify:minigame   # 无 DOM 宿主（Web Worker），34 项常驻判据
                          #   （取证构建 build:minigame:beacon 下另加 6 项 = 40）
npm run verify:dom        # 有原生 DOM 宿主（IDE 模拟器同类），21 项判据
npm run verify:url-shim   # URL 垫片 vs 原生对拍，2 条 —— 唯一直接测源码模块的一套
npm run verify:all        # 以上三者 + verify:sandbox + verify:visual，共 93 条
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
✅ 包内图集与 assets/atlas 逐字节一致（不是上一版美术）        ← §9.12
✅ 离屏画布确实拿到了（createCanvas ≥ 2 次）   ✅ 场景图里有精灵
✅ 宿主本来就没有 DOM（不用伪造）            ✅ project.config.json 声明 compileType=game
✅ appid 没被写成小程序游客号
✅ game.js / boot.js 语法都不高于 es2015（云端检查器的地板）  ← 逐文件查，§7
✅ 宿主本来有 Intl 且已真删（证明「无异常」不是假绿）  ✅ Intl 缺失时由垫片补上
✅ 宿主已抹掉小游戏没有的 BOM 全局（URL / location）  ← 2026-09-24 新增，§9.15
✅ URL 缺失时由垫片补上，且相对解析结果正确（行为判据）
✅ 宿主已禁 unsafe-eval（new Function 抛 EvalError）  ✅ 启动后禁令仍有效 / Function 未被替换
✅ 禁的是 eval 而非 Function 本身（真实构造器仍完好）  ← §9.8
──── 拆包与数据（2026-09-23 新增，见 §7）────
✅ 包内 js 恰好是 game.js + boot.js 两个模块
✅ 入口 game.js 明显小于 boot.js（pixi 不在入口里）
✅ 包内 data/ 与源码清单逐一对应（不多不少）
✅ 包内 data/*.json 与 data/ 源码逐字节一致（不是上一版数据）
✅ 数据是启动期真读代码包读出来的（58 次 readFileSync、路径都不带 ./ 前缀）
✅ 数据没有在构建期内联进 game.js（**反向断言，带探针**）
──── 端到端 ────
✅ 上屏画布 = wx.createCanvas() 的第一块    ✅ 触摸点击精确落到预期格子（含远距离格）
✅ 越界点击被正确忽略                      ✅ 触摸事件能驱动游戏
✅ 移动方向与点击方向一致
```

两条「有效性」判据的由来：`Intl` 在真机小游戏里**不存在**，而 Pixi 在模块求值期读它的
**裸标识符**（`typeof Intl?.Segmenter` 被 esbuild 降到 es2015 时改写成了
`Intl == null ? void 0 : Intl.Segmenter`，`typeof` 的保护被绕掉了）。
宿主里删掉它、又**要求它真的没了**（置成 undefined 会让报错消失、判据变成假绿），
才能保住上面那条「无报错」的含金量。

拆包那 6 条的由来同样值得记一笔：拆包最典型的失败**不是崩溃，而是「看起来成了、其实没生效」**——
数据拷进了包却仍在构建期内联（改 json 不影响运行结果），或者改成了运行期读但读的是另一份拷贝
（改 json 还是不影响运行结果）。两种都不报错、截图照样对。
所以判据要**同时**看「读了没有」（正面，数 `readFileSync` 次数）与「有没有内联」（反面，
在入口里搜数据原文），而且反面那条**必须带探针**——本轮真踩过：一开始拿 `demonKingTrue`
当探针，它在 `game.js` 里确实存在，但来源是 `assets/MANIFEST.json`（图集清单，被 `atlas.ts`
静态 import 烘进入口）。**图集在入口里是正常的，游戏数据在入口里才是问题。**

（当前实测全部通过：非背景色像素 93.9%、5197 种颜色、151 个精灵节点、
5/5 次点击逐格命中，atlas.ready=true、readFileSync 58 次、探针词在入口里搜不到。）

### 有原生 DOM 宿主的判据

`npm run verify:dom` 用真 Chromium 页面 + wx 桩，核心是**两条方向相反的判据**：

```
✅ 宿主确实有原生 DOM（前置条件，不成立说明页面搭错了）
✅ document 让路：宿主原生实现未被替换（createElement / body.appendChild 都在）
✅ navigator 补齐：宿主不可用时垫片补上可用的 UA      ← 这一页必须先删掉 navigator
✅ 宿主本来有 Intl 且已真删 / Intl 缺失时由垫片补上
✅ 宿主已禁 unsafe-eval / 启动后仍有效 / Function 未被替换 / 真实构造器完好  ← 见 §9.8
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
  game.js               入口（229 KB）—— 全部业务代码，**能直接读**
  boot.js               启动层 + 第三方库（1 597 KB）：词法垫片 + env 适配 + pixi.js
  data/*.json           运行时数据 58 个（177 KB）：7 张顶层表 + 51 层地图（每层一个文件）
  game.json             小游戏配置
  project.config.json   开发者工具配置
  assets/*.png          4 张图集（79.3 KB），包内相对路径
```

> 拆成「入口 + 库 + 数据文件」的直接动机是**可读性**：拆之前是 2.10 MB 的单文件 IIFE，
> 想确认「第 20 层放了哪些怪」要先在两万行 pixi 里翻。现在 `data/floors/floor-19.json`
> 打开就是那一层，`game.js` 只剩业务代码。
>
> ⚠️ 这一节的顺序很讲究，别跳着读：**边界怎么切**（下一小节）决定了**后面那些坑长什么样**。

### 拆包边界由**求值顺序**决定，不能按「我们的代码 / 第三方库」切

小游戏是 **CommonJS 模块环境**（官方「基础能力 / 模块化」）：每个 `.js` 有独立作用域，
用 `module.exports` / `require` 互引，全局对象是 `GameGlobal`。所以拆成多个文件技术上可行。

**但 CJS 的求值顺序同样是「依赖先于自身」** —— 这意味着**入口天然是最后求值的那个**。
而本项目有两条「必须最先」的硬约束（§2、§3 全都在讲这两条）：

1. **词法垫片**必须早于 pixi 的模块体（否则 `Intl is not defined`，见 §9.3）；
2. **`env/` 适配层**必须早于 pixi 的模块体（否则 `navigator` / 画布预订都晚了）。

把这两条和 CJS 的求值顺序放在一起，结论只有一个：

```
boot.js = 词法垫片 + src/minigame/env/** + node_modules/pixi.js   ← 必须最先求值的那一层
game.js = 其余一切（beacon 除外，它由 intro 保证，见下）
```

**反例（值得写下来，因为它是第一直觉）**：按「我们的代码 vs 第三方库」切，
把 `env/` 留在入口、只把 pixi 拆进库文件 —— 那样入口变成最后求值，
**垫片和 env 全都晚于 pixi**，等于把 §3 那六个坑一次性踩回去。

切完之后，「同在 `boot.js` 里的垫片 / env / pixi 三者的相对顺序」仍然由 Rollup
按依赖图排 —— **与拆分前的单文件是同一个机制**，所以保证强度不变。这一点有实测旁证：
拆包前后，垫片与 pixi 模块体的行号是**同构**的（拆前 742 / 26444，拆后 `boot.js` 770 / 26574）。

另外，`output.intro`（词法垫片就是它）对**每个** chunk 都生效，
所以两个文件顶部各有一份 PRELUDE。重复执行是安全的
（垫片一律写成 `globalThis.X || (globalThis.X = …)` 的幂等形态），
而 `game.js` 那一份正好让业务代码里的裸标识符也解析到 env 装好的对象。

### 数据改走 `readFileSync`：一份逻辑，两套取数机制

官方「基础能力 / 存储 / 文件系统」的权限表里，**代码包文件是「读=有、写=无」**，
所以运行期完全可以把 json 当文件读：

```js
wx.getFileSystemManager().readFileSync('data/floors/floor-00.json', 'utf8')
```

两条容易被忽略的硬要求：

- **路径从项目根目录写起，不支持 `./` `../` 前缀**：`a/b/c` 合法，`./a/b/c` 不合法。
  所以 key 一律不带前缀，`tools/minigame-harness/worker.js` 的桩里对此**当场报红**
  （刻意不做任何「自动补前缀」的容错 —— 那种容错会让真机上必炸的写法在本地永远报绿）。
- **不用 `require('./data/x.json')`**：官方模块化文档只写了 `require` 加载 **js 模块**，
  json 走 require 属于「社区在用、文档没背书」。而且 51 个楼层要能被静态分析出来。

「网页端构建期内联 / 小游戏端运行期读」这两套机制靠 **`@data-source` alias** 分开：
`src/data/index.ts` 永远只写 `from '@data-source'`，两个 vite 配置各自把它指向
`source-web.ts`（`import.meta.glob` 构建期内联）或 `source-minigame.ts`（运行期 `readFileSync`）。
**游戏代码里没有一处 `if (isMinigame)`。**

清单是单一来源：`src/data/runtime-files.mjs`（写成 `.mjs` 让 TS 侧与 Node ESM 脚本都能直接
import），游戏代码与拷贝脚本共用，因此不可能出现「网页端能跑、小游戏端读不到」。

### ⚠️ 拆包之后才出现的坑：`__vitePreload` 的第三实参（**只有无 DOM 宿主抓得到**）

拆成 CJS 多文件后，`autoDetectRenderer` 里会抛一条看不出所以然的：

```
TypeError: Failed to construct 'URL': Invalid URL
```

根因在 `boot.js` 里由 Vite 生成的动态导入辅助：

```js
typeof document === 'undefined'
  ? require('url').pathToFileURL(__filename).href              // ← Node 分支（cjs 格式下 rollup 生成的）
  : _documentCurrentScript && … || new URL('boot.js', document.baseURI).href
```

`__vitePreload(loader, deps, importerUrl)` 的**第三实参**就是这个 `new URL(...)`。
它在这一份产物里**根本不会被用到**（`deps` 是 `void 0`，消费 `importerUrl` 的分支在
`if (false) { … }` 里被消除了）—— **但实参照样要求值**。而 `env/document.ts` 的 `document`
替身当时没有 `baseURI` → `new URL('boot.js', undefined)` 抛。

**修法是给替身补一个绝对基准**（`doc.baseURI = 'wxgame://code-package/'`）。
必须是绝对的：`new URL(x, '')` 与 `new URL(x, '/')` 都会抛。

三件事值得记住：

1. **`modulePreload: false` 拦不住它**（实测确认）：开关关掉的是 preload 提示，
   而 `__vitePreload` 这个包装本身照样生成，`require('url')` 也照样在。
2. **这个坑只有无 DOM 宿主抓得到**：有 DOM 时 `document.baseURI` 有真值，一切正常；
   单文件 IIFE 时代 `inlineDynamicImports: true` 把动态导入全内联了，Vite 压根不生成
   `__vitePreload`。
3. 它是「构建工具为**浏览器 / Node** 生成的胶水代码，在**第三种环境**里炸」的典型样本 ——
   与 §3 那六个坑同一族，只是这一族的触发条件多了「产物形态」这一维。

`vite.minigame.config.ts` 要点：

- `rollupOptions.input` + `output.format: 'cjs'`（不再是 `lib` + `iife`）：
  小游戏的模块环境是 CJS，产物因此是多文件、`require` 互引。
- `manualChunks` 按上面那条边界切出 `boot`；`entryFileNames: 'game.js'`、
  `chunkFileNames: '[name].js'` **刻意不加 hash** —— 小游戏包内的文件名要能被 `require` 静态指到。
- 入口里的 `require('./boot.js')` **带 `.js` 后缀是刻意的**：官方示例不带后缀，
  但那依赖基础库去猜后缀；本地宿主刻意不复刻这个猜测，好让「路径写错」当场暴露。
- `build.target: 'es2015'`（语法地板，见下一小节）、`minify: false`（产物要能读）。
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

⚠️ 四件事必须对齐：`build.target`（打包时降级）、`tools/verify-minigame.cjs` 的
`SYNTAX_FLOOR`（断言产物）、`setting.es6: false`（不让 IDE 再降一遍）、
以及**断言要覆盖包内每一个 js 文件**。
改了 `build.target` 就要同步改 `SYNTAX_FLOOR`：判据是拿 `SYNTAX_FLOOR`
去复算产物的，地板定高了会漏判，定低了会假报。

> **为什么必须逐文件查**：云端检查器看的是包内**全部**文件，而拆包之后
> `boot.js`（1 589 KB，pixi 全在里面）才是语法最杂的那一个，入口反而是最干净的那份。
> 只查 `game.js` 的话，「pixi 带进来一段高版本语法」本地永远发现不了 ——
> 症状与上面记录的完全同构，只是报错文件名变成 `invalid file: boot.js`，
> 而且晚一步（要等上传/预览才炸）。

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

- **`compileType` 有两个来源，会打架。** `reduxPersist:projectList` 里存的是**导入时的意图**，
  `project2_<项目绝对路径>` 才是**实际生效**的那份。**别背结论，现读一遍最稳**：
  2026-09-21 之前本机用的是「小程序测试号」`wxa075fdefa9d0a322`（`gameApp: false`），
  两个键都是 `weapp`；换成**小游戏**测试号 `wxb64dbc7191c2a23e` 之后，
  两个键都变成了 `game`，记录里的 `attr.gameApp` 也变成 `true`。用
  `npm run ide:project` 一次看全（含 `project.config.json` 与磁盘上的 `app.json`/`game.json`）。
- **`miniprogramRoot` 不是线索。** 小游戏工程也用它，工具自己会把它归一成 `""`。

排错时先看日志，一眼就能定位：

```bash
grep -E "compileType changed|app.json" \
  "$HOME/Library/Application Support/微信开发者工具"/*/WeappLog/logs/*.log
```

### 真机调试报 `ENOENT .../dist-minigame/app.json`：**这是工具侧状态问题，不是工程文件问题**

换成小游戏测试号之后，再点「真机调试」会报：

```
Error: ENOENT: no such file or directory, open
       '/Users/.../dist-minigame/app.json'
```

先说结论：**小游戏不该有 `app.json`，工具找不到它才是对的 —— 错的是工具把工程当成了小程序。**
改工程文件解决不了这件事（见下），但值得把机制写清楚，因为报文和上一节那个
「未找到 app.json」**长得像、其实不是一条路径**：

| 报文 | 出处 | 含义 |
|---|---|---|
| `app.json: 在项目根目录未找到 app.json` | 小程序**编译管线** | 工具**确信**这是小程序（`compileType` 真的是 `weapp`） |
| `ENOENT: no such file or directory, open '<绝对路径>/app.json'` | **打包器裸读文件** | 工具只是**没拿到类型**，就按默认的小程序分支去读 |

第二条的完整链条（反解 `app.asar`，本机 wechatwebdevtools 36.6.0 得到）：

```js
// ① DevtoolsProject 构造函数：直接查表，没有兜底
c = { weapp:"miniProgram", plugin:"miniProgramPlugin",
      game:"miniGame",    gamePlugin:"miniGamePlugin" };
this._type = c[e.compileType];          // compileType 缺失/拼错 → _type = undefined

// ② 打包器判是不是小游戏
function isGameApp(e) { return e.type === EProjectType.miniGame || e.type === EProjectType.miniGamePlugin; }
...
const J = isGameApp(n),
      O = J ? "game.json" : "app.json",
      N = e.join(L, O);
let T = await IFileService.readFile(N, { encoding: "utf8" });   // ← 没有 try/catch
```

所以只要 `compileType` 不在那张表里（`undefined` / `""` / 拼成 `minigame`），
① 得到 `undefined` → ② 判定「不是小游戏」→ 去读 `app.json` → 文件不存在 →
**Node 的原始 ENOENT 直接冒到界面上**。

**工程侧唯一要做对的事就是 `compileType` 有那个合法值**（合法值只有
`weapp` / `game` / `plugin` / `gamePlugin`，小游戏写 `"game"`；
`compileTypeConfig={weapp:"weapp",game:"game",...}`）。本机当前状态**是对的**：

```
compileType = "game"  →  工具内部 type = miniGame  ✅ 小游戏
appid       = wxb64dbc7191c2a23e   attr.gameApp = true  attr.appType = 4（GAME）
磁盘        = app.json 不存在、game.json 在位
```

那问题在哪？**在窗口层状态**。同一个工具里，工程记录与窗口状态**可以不一致**，
而部分环节（真机调试/预览要走的那条）看的是后者：

```
工程记录 project2_<路径>      compileType = "game"        ← 对
reduxPersist:toolbar         compileType.current = "weapp"  ← 不对
reduxPersist:window          entrance.tab = "miniprogram"   ← 不对
                             selectProjectOptions.tab = "miniprogram"
```

`npm run ide:project` 就是为这件事写的：一条命令把这四份状态、派生出来的内部 `type`、
磁盘上的 `app.json`/`game.json` 和真机调试的上传情况全打出来。

**修法（按代价从小到大，改工程文件无用）：**

1. **工具 → 清缓存 → 清除全部缓存**，然后**完全重启**开发者工具；
2. 还不行就**删掉工程 → 重新导入**（导入时入口窗口的 tab 要选**小游戏**，
   AppID 用**小游戏**测试号），让四份状态一起重建；
3. 之后 `npm run ide:project` 复查：应当只剩「窗口层不是小游戏」这一条消失。

**顺带两个确认到的事实：**

- **上传其实成功了。** 通知中心里有「**上传代码完成 · 编译后代码包大小：2.0 MB**」
  （20:40:45），`previewComponent.uploadType = "remoteDebug"`、`autoUploadFailureText = ""`。
  失败的是**之后**打开远程调试窗口那一步（`remoteDebugWindow.show = false`），
  以及设备连接（`game-ios-debug` 的 `Device disconnected, reason: InternalError`）。
  所以「预览」这条路是通的，真机调试卡在窗口/设备层。
- **`game.json` 里的 `iOSHighPerformance` 别删。** 工具会警告
  `无效的 game.json ["iOSHighPerformance"]`，但这是**它的 schema 落后** ——
  该字段是微信小游戏**正式字段**，用来开 iOS 高性能模式
  （需先在公众平台「生产提效包」里开通），删了反而丢掉能力。警告不影响编译。

---

## 9. IDE 里的 `Intl is not defined`：**证据在盘上，不在控制台**

这一节记的是最难查的一次：修了三轮、改了两次垫片，报错却**一模一样**。
最后是「先别再猜，去把证据捞出来」解决的。

### 9.1 先修正观测方式：IDE 自己会把探针记录落盘

探针原本走 HTTP 回本机（`tools/wx-beacon-server.cjs`），但那是**第二个通道**，
它要求服务端此刻正监听。**第一个通道是 `wx.setStorageSync`** —— IDE 会把它写到：

```
~/Library/Application Support/微信开发者工具/<hash>/
  WeappSimulator/WeappStorage/storage_<...>.json
```

这个文件**不需要任何进程在跑**，随时可读：

```bash
S="$HOME/Library/Application Support/微信开发者工具"/*/WeappSimulator/WeappStorage
python3 -c "
import json,glob,sys
f=glob.glob(sys.argv[1]+'/*.json')[0]
d=json.load(open(f))
print(json.loads(d['0']['__motaBeacon']['data']))
" "$S"
```

**踩到的坑：异常类记录当时只走 HTTP。** 用户在 IDE 点编译的那一刻服务端没起，
于是错误信息**直接蒸发**，时间线里只剩一条 `module` —— 只知道「炸了」，
不知道炸在哪。现在 `report()` 保证每条记录**双通道**（HTTP + 存储），
`beaconInstall()` 里还多挂了一套 DOM 的 `error` / `unhandledrejection`。

### 9.2 一次编译 = **两个上下文**，且它们对同一个全局给出不同答案

捞出来的第一条真实记录（IDE 15:07）：

| 记录 | `hasDocument` | `hasPerformance` | 说明 |
|---|---|---|---|
| #1 #3 | **false** | **false** | 白名单沙箱：只有 `wx` / `GameGlobal` / `requestAnimationFrame` |
| #5 #7 #9 | true | true | 带原生 DOM 的上下文（模拟器里可见的那个） |

两个上下文**共用同一份 `WeappStorage`**（后写的覆盖前面的），所以「时间线只有一条」
既可能是「跑了一次」，也可能是「另一个上下文把它盖了」。

这就是 `Intl is not defined` 能出现的原因 —— Chromium / Node 的 V8 **永远有 `Intl`**，
而这里有一条路径没有：**宿主是白名单式的，它在给游戏代码做「真机没有的全局」的减法**。

### 9.3 真正的根因：**「宿主有 `globalThis.Intl`」≠「裸标识符 `Intl` 读得到」**

上一轮的修法是 `env/navigator.ts` 里 `globalThis.Intl = {}`。它在可扩展的全局上有效，
在白名单沙箱里**写了个寂寞**：

- `safeAssign` 返回 `true`（没抛错，看起来成功了）；
- 裸标识符 `Intl` 仍然从**宿主原来的作用域链**解析 → `ReferenceError`；
- 而 pixi 那句 `typeof Intl?.Segmenter === 'function'` 被 esbuild 降到 es2015 时
  已经退化成裸引用 `Intl == null ? void 0 : Intl.Segmenter`，`typeof` 的保护被绕掉了。

**判据就在产物自己身上**：报错行（`game.js:32228`）在垫片代码（`game.js:706`）**之后**。
「先后顺序没问题却仍然抛错」只能有一个解释：那一笔写**没有落到裸标识符能看见的地方**。

### 9.4 解法：构建期**词法垫片**（`output.intro`，单行）

不依赖宿主配合的唯一做法，是在产物**自己的作用域**里多一个绑定：

```js
// vite.minigame.config.ts，经 rollupOptions.output.intro 注入，落在 "use strict" 之后
var Intl = (typeof globalThis === "object" && globalThis && globalThis.Intl) || { Segmenter: void 0 };
```

两条硬约束（都踩过）：

1. **必须单行、括号配平。** 第一版写成多行 IIFE，Rollup 的 iife 包装与它**错位**，
   esbuild 给 `?.` 降级生成的 `var _a, _c, _k, _l;` 掉进了另一个函数作用域 →
   产物在 `hasPerformance: !!((_a = g$2.performance) == null ? void 0 : _a.now)`
   抛 `ReferenceError: _a is not defined`。
   ⚠️ **这个错在 IDE 里不会暴露**：IDE 把自己的模块和 `game.js` 跑在同一个 realm，
   它自己那堆压缩代码里就有一个全局 `var _a`，我们的裸 `_a` 被**别人的变量**接住了；
   真机上没有这个巧合，直接黑屏。**「IDE 里能跑」在这类问题上是无效证据。**
2. **不裸写 `globalThis`。** 沙箱里它可能是 `undefined`，只有 `typeof` 是安全的。
   也不能用 `?.` / `??` —— 这段字符串在模块图之外，别指望降级规则一致。

只垫**宿主可能没有、而且我们不需要给它行为**的全局。当前是 `Intl` 与 `navigator`
两个 —— 都不是「顺手多垫的」，而是**实测各报过一次错**（§9.3 / §9.5）。
其余全局不垫，理由见上。注意垫进来的那个对象**必须与 `env/` 共用同一个引用**，
否则会在真机上悄悄退回成简陋的那一份（§9.5 的纪律）。

### 9.5 `navigator` 是同一个坑的第二例（**加垫片后立刻暴露**）

第一版只垫了 `Intl`。用户在 IDE 里再点一次编译，拿到的新错误是：

```
Uncaught TypeError: Cannot destructure property 'userAgent' of
  'DOMAdapter.get(...).getNavigator(...)' as it is undefined.
    at isSafari (game.js:34510)
    at game.js:42904            ← const defaultForceAllocation = isSafari()（模块顶层）
    at game.js:51502            ← 入口 IIFE
```

而成一**同一份产物的探针**在同一个宿主里报的是
`navigator: {present: true, hasUA: true}`。两个观测都对，因为它们看的是两条路径：

| 路径 | 这个宿主给出的答案 |
|---|---|
| `globalThis.navigator` | 有 `userAgent` 的对象（探针报的就是它） |
| **裸标识符 `navigator`** | **`undefined`** |

pixi 默认适配器写的是 `getNavigator: () => navigator`（裸标识符），
而 `isSafari()` 由 `const defaultForceAllocation = isSafari()` 在**模块顶层**调用 ——
早于我们把 `DOMAdapter` 换成小游戏实现。于是它读到 `undefined`，当场炸。

**规则因此是通用的：垫片要同时覆盖 `globalThis` 与裸标识符两条路径。**
`env/assign.ts` 的 `safeAssign` 只管前一条（按值判断，在真机/浏览器上都有效），
后一条只有词法绑定管得着。

#### 一个必须守住的纪律：**一个对象、两处引用**

`navigator` 这一条不能像 `Intl` 那样各垫各的 —— 否则 `env/` 用
`wx.getSystemInfoSync()` 合成的 UA 会被**挡在作用域外**（pixi 只看得见 intro 里
那份简陋的），拿真问题换假问题。做法：

- **intro**：宿主有就沿用宿主那份；没有就造一份 **空 UA** 的，并**同时挂到
  `globalThis.navigator`** 上（空 UA 是为了让 `env/` 仍然判「不可用」）。
- **`env/navigator.ts`**：改成**就地补字段**（`Object.assign(existing, fields)`），不再整对象替换。
  加 `try/catch` 兜底 —— 宿主对象可能是只读的（浏览器的 `navigator` 就是），
  就地补字段抛错会连坐 `installGlobals()` 后面的全部步骤（第三轮黑屏的成因）。

判据：`verify:dom` 里那条「navigator 补齐」断言 UA 是
`Mozilla/5.0 (iOS 17.0) WeChatMiniGame/3.17.3…` —— 那是**系统信息合成的那份**，
它出现在 pixi 读得到的位置，说明两个引用确实是同一个对象。

### 9.6 新增第四套判据：`verify:sandbox`

`verify:minigame`（Worker）与 `verify:dom`（Chromium）**结构性地抓不到**上面两条：
浏览器必然有 `Intl`、全局想加就加、而且总是把脚本包一层。所以补一套跑在
**干净 V8（`node:vm`）** 里的判据，共 14 条：

| 判据 | 拦的是什么 |
|---|---|
| 普通宿主：模块图完整求值到适配层（停在「未找到全局 wx」） | 产物**自身的作用域**被构建配置弄坏（`_a is not defined` 那次） |
| 普通宿主 + 缺 `Intl`：不因 Intl 倒下 | 垫片路径（全局可扩展，`env/` 够用） |
| 白名单沙箱（缺 `Intl`/`navigator`，且**两条路径分叉**）：不因这两个全局倒下 | 只有词法垫片能救的那条路径 |
| **对照**：同一沙箱里「属性路径装好值、裸读仍死」必须复现 | 证明上一类判据不是想象出来的场景（它每一次都有真实报错对应） |
| **裸标识符视图**：产物内部量出的 7 个垫片全部可用 | 「垫了却没接上」与「还有别的全局是死的」 |
| **反证 ×2**：分别摘掉 `Intl` / `navigator` 的垫片，同一宿主必须炸出对应的 `X is not defined` | 证明上一条不是空转（宿主模型有牙齿）。⚠️ 现在摘的是 **`boot.js`** 里那一行 |
| 宿主原有的 `Intl` 未被顶掉 | 词法绑定是否真的落在包装内（否则就是全局污染） |
| 垫片位置：在包装内、早于第一处 `Intl` 读取 | 位置被改坏的绊线。**每个 chunk 各查一遍**，入口那一条要容忍「本文件里没有读取点」 |
| **拆包 ×4**：包内恰好 `game.js` + `boot.js` ／ pixi 在 `boot` 里、入口里没有 ／ `boot.js` 内部**垫片先于 pixi 模块体** ／ 入口用 `require("./boot.js")` 连到 boot | 拆包边界被切错（把 `env/` 留在入口 = 踩回 §3 的坑）、路径写错、以及「以为拆了其实没拆」 |

> 这一套的**装载方式也必须与被测环境同构**：拆包之后产物不再是一个脚本，
> 所以 `verify-sandbox.cjs` 自己实现了 `require`（包进
> `function (module, exports, require, __filename, __dirname)` 再调用），
> 与浏览器侧的 `tools/minigame-harness/cjs-loader.js`、真机基础库三处语义一致。
>
> ⚠️ 为什么不直接 `run` 两段源码：那样 **`game.js` 顶部那份 PRELUDE 会替 `boot.js` 的垫片兜底**，
> 于是「摘掉 boot 的垫片必须炸」这条反证就失效了（它测不出东西却还是绿的）。

白名单沙箱是 `with(proxy)` + 影子 `globalThis` 造的：**写进去能读回来，但裸标识符不走它**
（这正是那个分叉的形式，也是实测定的 —— IDE 里 `navigator` 的 UA 能被读回来，
说明写落到了影子对象上）。不能用「沙箱对象就是 Proxy」那种写法 ——
那样裸 `Intl` 会解析成 `undefined` 而**不抛 ReferenceError**，路径跟真机对不上（试过）。

### 9.7 边界：词法垫片只解决「看得见」，不解决「有行为」

intro 的职责只有一条：**让裸标识符有个落脚点**，并且（对需要行为的那些）
**选或造出那个落脚对象**，行为仍由 `env/` 在同一个对象上补（`Object.assign` 就地补字段）。
当前八个：`Intl`、`navigator`、`document`、`performance`、
`requestAnimationFrame` / `cancelAnimationFrame`、`MouseEvent`、`URL`。

后两个（⑥ `MouseEvent`、⑦ `URL`）是**懒转发**，形态与前面几个不同：
真替身住在 `env/` 里、由运行期装到 `globalThis`，intro 只负责让裸标识符
**在调用那一刻**能取到它（不能把兜底挂到 `globalThis` 上 —— 那就自我递归了，见 §9.15）。

`document` / 事件那一套**不能**只靠 intro 的原因不是「不需要行为」，而是时机与复杂度：

- 它们需要 `env/` 里那些有行为的替身（事件总线、`getBoundingClientRect` 补丁、
  `createElement` 路由表）——intro 里造不出来，只能先占位；
- 还要配合 `wx.createCanvas()` **第一次**调用的时机（抢上屏画布，见 §2）——
  比 intro 晚得多也讲究得多。

换句话说：**intro 是「让裸标识符有个落脚点」的兜底，不是垫片的替代品。**
真机路径仍然完全由 `env/` 承担；intro 存在的唯一理由是那些
`globalThis` 与作用域链分叉的宿主。

### 9.8 第三个错：`unsafe-eval` —— 垫片修完之后**才**轮得到它

`Intl` 与 `navigator` 两条都垫上之后，IDE 落盘的时间线第一次**跑出了 `module`**：

```
module → shim → hostModule → host → probe → error
```

也就是说：模块图整条走完、`DOMAdapter` 换好、上屏画布抢到、WebGL 探针通过 ——
然后死在 `Game.create()` 里：

```
Error: Current environment does not allow unsafe-eval,
       please use pixi.js/unsafe-eval module to enable support.
```

**这正是「探针把黑盒切成段」的价值**：`module → shim → hostModule → host → probe`
五段全绿而后面才炸，一眼就能排除掉前面四轮怀疑过的一切（import 顺序、垫片、
画布预订、WebGL 可用性），把范围收到「渲染器构造」这一件事上。

#### 根因：小游戏子上下文是 CSP 禁 eval 的，而 Pixi 8 有两处依赖它

| 用到 `new Function` 的地方 | 什么时候跑 | 后果 |
|---|---|---|
| `AbstractRenderer._unsafeEvalCheck()` | 渲染器一构造就查 | 查不到直接抛（就是上面这句） |
| `GlUniformGroupSystem._generateUniformsSync` / `GlUboSystem` / `GlShaderSystem` | **每帧**同步 uniform/ubo | 动态生成同步函数，没它就没法渲染 |

同一条落盘记录里的 `bare: { Intl: "no-new-function" }` 是独立的第二个证据 ——
`bareView()` 用 `new Function` 去读裸标识符（等价于 pixi 的处境），
它返回 `no-new-function` 说明这个环境里 `new Function` **本身就抛**，
而不是「`Function` 全局不存在」。**两个通道给出同一个结论，才敢下手。**

#### 解法：`import 'pixi.js/unsafe-eval'`（纯副作用，一行）

```ts
// src/minigame/pixi-adapter.ts —— 第一个 import pixi 的模块
import { DOMAdapter } from 'pixi.js';
import 'pixi.js/unsafe-eval';
```

这个子路径导出（`lib/unsafe-eval/init.mjs`）把上面几处的实现换成免 eval 的 polyfill，
并把两个 `_unsafeEvalCheck` 覆盖成空实现。它 import 的
`../rendering/renderers/gl/GlUboSystem.mjs` 与主入口 `lib/index.mjs` 里的
`./rendering/...` **解析到同一批文件**，Vite 去重后补丁打在真实类上
（构建证据：模块数 800 → 808，体积 +30 KB）。

#### ⚠️ 这个坑怎么**验**：静态搜字符串是假判据

原实现是**死代码** —— `GlUniformGroupSystem.prototype._generateUniformsSync` 等
仍被类方法引用，polyfill 只是**在原型上覆盖**它们，Rollup tree-shake 不掉。
所以产物里**必然还能搜到 `new Function`**，「搜不到」这个判据根本不成立。

唯一有效的证法是**行为判据**：把 `new Function` 弄成执行期抛 `EvalError`，
看游戏还起不起得来。由此新增了一个**两个宿主共用的桩**：

```
tools/minigame-harness/no-unsafe-eval.js
```

- **按 CSP 的样子装**：`Function` 全局还在、`typeof` 仍是 `'function'`、
  `prototype` 指回真实原型（保证 `instanceof Function` / `fn.constructor` 语义不变），
  只让**动态构造**抛 `EvalError`。否则「禁 eval」就变成「Function 坏了」，测的不是同一件事。
- **两个宿主都要装**（Worker 用 `importScripts`，DOM 页面用 `<script src>`），顺序都在
  `game.js` **之前** —— Pixi 的 `unsafeEvalSupported()` 结果会被**记忆化**。
- **有 DOM 那一侧尤其不能省**：浏览器默认允许 eval，`unsafeEvalSupported()` 返回 true
  —— 也就是说在允许 eval 的宿主里，「漏了 `pixi.js/unsafe-eval`」这个 bug
  **永远不会暴露**，测试全绿但什么都没测到。补上禁令才把这个盲区堵住。

新增 3 条判据 × 2 个宿主（两侧都必须同时满足）：

| 判据 | 拦的是什么 |
|---|---|
| 宿主已禁 `unsafe-eval`（`new Function` 抛 `EvalError`） | **前提**：禁令没装上，后面两条都是空转 |
| 启动后禁令仍有效、且 `globalThis.Function` 没被替换 | 「启动成功」是不是靠把 eval 要回来换的 |
| 真实构造器仍完好（`new Function("return true")() === true`） | 把「禁 eval」误做成「Function 全坏」 |

补丁生效的正面证据（无 DOM 宿主，2026-09-21 16:22 构建）：

```
✅ 宿主已禁 unsafe-eval（`new Function` 抛 EvalError）—— evalBanned=true
✅ 启动后禁令仍有效                                    —— evalStillBannedAfterBoot=true
✅ 渲染器是 webgl（不是静默降级的 canvas）              —— rendererType=webgl
✅ 图集真的加载成功                                    —— atlas.ready = true
✅ 帧缓冲里有实际画面                                  —— 74.7%（6662 种颜色）
✅ 场景图里有精灵                                      —— Sprite 节点 150 个
```

**在 `new Function` 必抛的宿主里跑出 74.7% 非背景像素、6662 种颜色** ——
这就是「免 eval 的那几处 polyfill 真的在每帧干活」的证据。

#### 一条值得带走的顺序经验

`module → shim → hostModule → host → probe` 这五段是在**四轮**里一段一段加出来的：
每报一次错、就把「黑盒」切开一处，直到它只能停在唯一一个地方。
**这些错误是串行的 —— 修掉一个才会露出下一个。** 所以「报错一模一样」通常不是「没修」，
而是还有下一层：这正是 §9.1 那个「先去捞落盘证据、别猜」的前提。

### 9.9 第四例到第七例：同一分叉的**全部**成员，以及「一次把缺口列完」

`unsafe-eval` 修掉之后，IDE 里的下一次编译把时间线推到了 `probe` 之后，
新的报错仍然是同一个坑的新成员：

```
TypeError: Cannot read properties of undefined (reading 'createElement')
  at AccessibilitySystem._createTouchHook      ← const hookDiv = document.createElement("button")
  at WebGLRenderer._addSystem / _addSystems
```

而**同一条落盘记录**里 `hasDocument: true`。也就是说：

| 路径 | 这个宿主给出的答案 |
|---|---|
| `globalThis.document` | 有东西（`hasDocument: true`） |
| **裸标识符 `document`** | **`undefined`** |

与 `navigator` 一模一样。差别只在于**判据不能是「在不在」**：
intro 选对象的判据改成了「`createElement` 是不是函数」（**可用性**）——
「属性存在」既不等于「裸读得到」，也不等于「可用」。

#### 与其一轮修一个，不如先把「裸路径是死的」清单一次列完

前四例都是**等 IDE 报一次错**才知道的。这时做了一个决定性的改动：
**把测量点搬进产物自己的作用域**，让 `env/` 直接量一遍。

- 位置：`env/bare.ts` 的 `reportBareReachability()`，跑在模块作用域里，
  结果挂在 `globalThis.__motaEnvBare`，由探针在 `shim` 埋点取走。
- 为什么非要在这里量：**pixi 是产物的一部分，它读的就是产物自己的作用域链**。
  从外面（浏览器控制台、`new Function`、宿主侧注入）量到的永远是宿主那一侧。
- ⚠️ **必须直接读 `X`，不能写 `typeof X`。** `typeof 未声明标识符` 按规范返回
  `'undefined'` 而**不抛** —— 于是「未声明」和「声明了但是 undefined」会被混成一种，
  而前者才致命（pixi 读它就是 `ReferenceError`，整包起不来）。
  放进 try/catch 直接读，三态才分得开：`类型名` / `'undefined'` / `'ReferenceError'`。

> 顺带删掉了一个**假观测**：上一版探针用 `new Function('return typeof Intl')` 去量，
> 而 CSP 宿主里 `new Function` 本身必抛，它返回的 `'no-new-function'` 看起来像
> 「读不到」，其实**什么都没测到**。这个假信号在那一轮里误导过一次。
> 教训：**探针本身也要能报「我没测到」，而不是报一个像结果的字符串。**

#### 选「垫哪些」的两条判据

拿到清单之后，仍然**不是**把死掉的 32 项全垫上。判据是两条**同时成立**：

1. pixi 会**裸读**它 —— 不是 `globalThis.X`，也不是 `x.method()` 那种成员访问；
2. 那条裸读**真的会执行** —— 不是 `typeof X` 守卫里的一句，也不是被我们替换掉的分支。

搜 pixi 源码 + 对照调用时机，最终落在四项上：

| 全局 | 裸读点 | 什么时候真的会跑 |
|---|---|---|
| `performance` | `Ticker.update(currentTime = performance.now())` | **每帧**（默认参数）；`AccessibilitySystem` 构造期也要 |
| `requestAnimationFrame` / `cancelAnimationFrame` | `Ticker.start()` / `ResizePlugin` | 启动时 |
| `MouseEvent` | `EventTicker` 合成 mousemove：`new MouseEvent("mousemove", …)` | 触摸/合成事件时 |

**只满足 ① 不满足 ② 的不垫。** 例：`new Image()` 只出现在
`assets/detections/utils/testImageFormat.mjs` 的探测里，外面包着 try/catch ——
垫了只是多一份没人测过的替身。（Worker 宿主的实测清单里 `Image`、`HTMLCanvasElement`、
`window`、`XMLHttpRequest` 等 12 项本来就是 `ReferenceError`，而游戏跑得好好的，
这就是「② 不成立」的实测形态。）

`MouseEvent` 这条还多一个形态上的坑：它的兜底要**转发**给 `globalThis.MouseEvent`
（也就是 `env/mouse-event.ts` 装的 `MiniMouseEvent`），所以它**不能**像 `performance` 那样
把自己挂到 `globalThis` 上 —— 会自我递归。它走**懒转发**：调用那一刻才去取。

#### 现在这句规则可以说完整了

> **垫片必须同时覆盖 `globalThis.X` 与裸标识符 `X` 两条路径。**
> 前者靠 `env/assign.ts` 的 `safeAssign`（真机/浏览器够用），后者只有**构建期词法绑定**管得着。
> 判断某个宿主里两者是否分叉，看探针的 `bare`（裸路径）与 `env`（属性路径）两栏 ——
> 不一致就是这个坑；`ReferenceError` 而属性有值，就是它的指纹。

回归判据（`verify:sandbox`，白名单沙箱模型）：把「属性路径有值、裸读死掉」**显式复现一次**
（否则后面那些判据凭什么算数），再断言产物内部量出来的八个垫片全部可用。
另外把完整的裸标识符清单打印出来 —— 它一次性回答「这个宿主还有哪些全局是死的」。

---

### 9.10 第八个错：**「模拟器里画面正常，但点不动」**（输入的唯一来源是 `wx.onTouch*`）

**现象**（用户实测）：IDE 模拟器预览跑起来了、画面完整，玩家点它没反应；
同一份产物在 PC 端微信预览里**能点**。

**根因**：`env/touch.ts` 的 `installTouchBridge()` 开头写着 `if (nativeDom) return;` ——
「宿主有原生 DOM 就让路」。这个前提在小游戏里**不成立**：

| 宿主 | 玩家在画面上点一下，事件从哪来 |
|---|---|
| 真机小游戏 | `wx.onTouch*`（唯一来源） |
| **IDE 模拟器** | **`wx.onTouch*`** —— 模拟器把鼠标/触摸转成 wx 触摸事件；上屏画布是**原生视图**，不受页面 DOM 事件系统管辖 |
| PC 端微信（无 DOM） | `wx.onTouch*` |

也就是说：**只要有 `wx`，输入就只能从 `wx.onTouch*` 来**。`nativeDom` 能说明「宿主有原生
DOM 对象」，但推不出「玩家点的东西会经过那些对象」。让路的代价是：Pixi 的监听挂在原生
`canvas` / `document` / `globalThis` 上，而 wx 的触摸被我们扔进没人听的总线里 ——
**画面、悬停都正常，只有「点击」不生效**。

**为什么这套判据以前全绿**：`verify:dom` 那一侧的 `wx.onTouch*` 桩原本是
`function () {}` —— 空实现，把整条链路（触摸 → 桥 → Pixi → `pointertap`）**挖掉了**。
无 DOM 那侧有端到端判据，有 DOM 这侧一条都没有。**判据缺一条，故障就藏一层。**

**修法：先把监听位置统一，再谈派发。**

不是「按宿主挑一条路送」，而是**在模块求值期（早于 Pixi 注册）把 Pixi 用到的
事件类型接到我们自己的总线**（`hookEventTarget`：canvas / document / globalThis 三处，
只拦 `PIXI_EVENT_TYPES` 那 14 个类型，其余原样转发，宿主自己的监听不受影响），
然后一律派发到三份 `EventBus`。有 DOM 与无 DOM 就此走同一条路径 ——
「PC 端能点、模拟器不能点」这种分叉从根上消失，而不是逐个宿主打补丁。

合成真事件（`dispatchReal`）保留为**兜底**（宿主对象不可写时的最后一条路）；
两条都发不会重复（其中一条必然是空操作）。

**IDE 落盘给出的三条事实**（`boot` 段的 `touch` 栏，本轮据此定方案）：

```
pointerBranch=false   nativeDom=true   canReal=false   realDispatch=null
canvas: { ctor: "...", isHTMLCanvasElement: false }
```

- `pointerBranch=false`：模拟器里**没有** `PointerEvent` → Pixi 走 **mouse 分支**
  （挂 `mousedown` / `mousemove` / `mouseup`）。派发类型必须与之一致。
- `nativeDom=true`：有原生 DOM、`document` 不可覆盖。
- `isHTMLCanvasElement=false`：**上屏画布不是页面里的画布元素**（原生视图）。
  所以「合成真事件派发到画布」这条路在 IDE 里走不通 —— 这是第一版修法被实测打回的原因。

> 三条都**不能靠推理得到**，只能读回宿主事实。这也是为什么 `touch` 自述要写进探针：
> 它不是装饰，是「这次修法在这个宿主里到底成不成立」的唯一判据来源。

**新判据**（`verify:dom` 从 17 → 22 项，这一侧原本 0 条触摸判据）：

| 判据 | 守的是什么 |
|---|---|
| 触摸桥装上了（`wx.onTouchStart` 监听器 > 0） | 桥有没有装。**返回 0 是诊断信息**，不是装饰 |
| Pixi 的事件坑位已接管（canvas / document / global） | 三处缺一处就有一类事件送不到：缺 canvas → 按下收不到；缺 document → 悬停/详情面板不更新；缺 global → **抬手收不到，而 `pointertap` 正是抬手时生成的** |
| 触摸送到棋盘上（`lastBoardClick` 命中点的那格） | 事件链 + 坐标映射（漏 `resolution` 会整体偏约 4 格） |
| 触摸能驱动游戏（至少一个方向让勇者移动） | 端到端。与「命中」分开判：命中对了但没移动 = 那格本来走不通（游戏规则） |

---

### 9.11 第九个错：**「PC 端预览界面简陋」**（素材加载别被宿主能力牵着走）

**现象**：PC 端微信预览里游戏能玩，但界面朴素 —— 图集没上，回退成了程序化图形。

**根因**：Pixi 的 `loadTextures` 是「宿主有什么就用什么」：

```js
if (globalThis.createImageBitmap && config.preferCreateImageBitmap) {
    src = await WorkerManager.loadImageBitmap(url, asset);   // blob worker 里 fetch(src)
    // 或 loadImageBitmap(url) → DOMAdapter.get().fetch(url) + response.blob() + createImageBitmap
} else {
    src = DOMAdapter.get().createImage();  src.src = url;    // ← 只有这条对
}
```

第一条分支的两个前提在小游戏里都站不住：blob worker 的 base URL 是 `blob:null/...`，
**相对路径解析不了**；`wx.request` 是网络请求、读不了**包内文件**，而且小游戏没有 `Blob`。
于是「素材能不能上」取决于宿主**碰巧**有没有 `createImageBitmap` ——
桌面内核（PC 端微信、本地 Chromium）有 → 走进坏支路 → 静默回退。

**修法**：`atlas.ts` 在小游戏端**显式**走 `wx.createImage()` + `ImageSource`，
不再交给 `Assets.load` 去猜。网页端（无 `wx`）保持 `Assets.load`。

两个容易漏的细节：

- **必须有超时**。`wx.createImage()` 的 `onerror` 在部分失败形态下不触发，而没有 `onerror`
  就意味着 Promise 永远 pending —— 而 `atlas.load()` 是 `await` 在 `Game.create()` 里的，
  表现成**卡在启动、既无画面也无报错**。宁可图集失败（回退程序化图形），也不能拖死启动。
- **失败要带原因**（`atlas.lastError` → 探针 `boot` 段的 `atlasError`）。
  `ready=false` 是**静默回退**：画面上只是「变朴素了」，真机上根本分不出
  「路径不对 / 宿主不给加载 / 超时」这几种完全不同的故障。

**那条判据也要跟着升级**：`verify:dom` 里原本写着「图集加载状态（宿主差异，不计入判据）」，
理由是「环境的锅」。但 PC 端预览同样退化了 —— 说明「宿主差异」这个解释是错的：
**游戏素材加载不该由宿主能力抽签决定**。现在它是硬判据（`图集加载成功`），
它守的正是「素材有没有真的用上」。

---

### 9.12 第十个错：**「新的素材在模拟器中没有生效」**（包内图集是**副本**）

**现象**：美术改完、图集重建了、网页版也对，但**微信开发者工具里画的是旧画**。
最坑的是它**看起来完全正常** —— 无报错、无弹窗、`atlas.ready = true`、棋盘完整，
只是每一帧都是上一版的美术。

**根因**：不在素材，在**流水线顺序**。

```
assets/atlas/*.png        ← 唯一源头（npm run assets 写这里）
        │
        │  tools/copy-minigame-assets.mjs  copyFileSync
        ▼
dist-minigame/assets/*.png   ← 只是一份副本
```

`copyFileSync` 是在 `npm run build:minigame` 里跑的，所以：

| 只跑了这些 | 网页版 | 小游戏包 |
|---|---|---|
| `npm run assets` | ✅ 新 | ❌ **旧** |
| `npm run assets` + `npm run build` | ✅ 新 | ❌ **旧** |
| `npm run assets` + `npm run build:minigame` | ✅ 新 | ✅ 新 |

**实测证据**（本轮就是这么确认的）：

```
dist-minigame/assets/actors.png   mtime 00:31
assets/atlas/actors.png           mtime 01:25
SHA-256(前12): 源=c3e574dc83fb  包=c21d72d2a698   ← 不是同一份文件
```

**修法**：重跑一次 `npm run build:minigame`。之后包内 4 张图集与源**逐字节一致**。

**为什么必须写成断言**：这条链路没有任何「自己会响」的地方 ——
旧素材加载成功时，`atlas.ready` 一样是 `true`，
上面那条「图集真的加载成功 ≠ 静默回退」**完全管不到它**。
两条判据管的是两件不同的事：

| 判据 | 守的是什么 |
|---|---|
| `图集真的加载成功`（已有） | **有没有**用上素材（不是回退成程序化图形） |
| `包内图集与 assets/atlas 逐字节一致`（本轮新增） | 用的是**哪一版**素材 |

新增的这条逐张比 `assets/atlas/*.png` 与 `dist-minigame/assets/*.png` 的
SHA-256（取前 12 位），不一致就报出具体文件名与两个哈希：

```
❌ 包内图集与 assets/atlas 逐字节一致（不是上一版美术）
   —— actors.png 源=c3e574dc83fb 包=c21d72d2a698 | monsters.png 源=22692e201d91 包=d3c38adc81b4
      —— 重建过图集就要跑一次 npm run build:minigame
```

> **先拿它证明了一次红**（用当时的旧包），再修 —— 不然这条断言是「写完就绿」的
> 假货，永远不会有人知道它到底能不能抓。
>
> **判据用内容哈希，不用时间戳**：mtime 会被 `git checkout` / 复制 / 打包抹掉，
> 而「字节一致」才是「模拟器里看到的就是我刚画的那份」的准确表述。

**顺带记一条纪律**：

```bash
npm run assets          # 改完美术：先重建图集（+ MANIFEST）
npm run build:minigame  # 再刷新小游戏包 —— 这一步不能省
npm run verify:all      # 四套回归
```

`docs/assets.md` §14 有同一件事的另一份表述（从「改美术的人」视角写的）。

### 9.13 第十一个错：**「点了按钮没反应」（用真 Chromium 驱动 UI 时）** ★假绿比不测更危险

这一条**不属于小游戏适配层** —— 它出在「拿真 Chromium 页面当宿主」那条**验证链路**上。
但放在这里，是因为它和上面十条共用一个失败模式：**静默**。
症状是「点了一下，什么也没发生」，看起来像适配挂了，实际是**测试自己写错了**。

**根因不在适配层，在 Pixi 的命中测试。**
Pixi v8 的 `EventBoundary` **每帧**才刷新一次命中目标；而 Playwright 的
`page.mouse.click(x, y)` 把 `move` 与 `down/up` 塞进**同一个 tick**，
于是 `down` 用到的还是**上一帧**的 hit target（通常是全屏 root）。→ 点空。

```js
// ✗ 会点空
await page.mouse.click(x, y);

// ✅ 模拟真实鼠标节奏，每步之间留一帧
async function tap(page, x, y) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(60);   // ← 让 EventBoundary 更新 hit target
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
}
```

**同源的第二坑：游戏自己的全屏遮罩会吃掉所有点击。**
浮层（死亡层 / 模态面板）通常在舞台最顶层铺一张满屏 `hitArea` 的 `Graphics`。
前一条断言如果让游戏停在那种状态，后面每一次点击都落在遮罩上 ——
看着像「适配挂了」，其实是**测试没回到干净状态**：

```js
await page.keyboard.press('r');    // 走游戏自己的重开路径，比手写重置可靠
await page.waitForTimeout(120);
```

排查时直接问命中测试它认了谁，比盯着截图猜快得多：

```js
g.app.renderer.events.rootBoundary.hitTest(x, y);   // 真正吃到这一点的对象
```

**第三个坑：断言读 UI 文案时读了 `Container.label`。** ★这一条造成的是**假绿**

`Container.label` 是 Pixi v8 给渲染树打标记用的字符串 —— 我们自己还拿它做
「面板 / 标题落点」的版式断言标记。于是很容易顺手写成：

```ts
// ✗ 看着像「读按钮文字」，其实是读渲染树标签
get browseLabel() { return this.browsePill.label; }
```

断言的**期望值**来自源码常量、**实测值**读的却是另一个字段 —— 两边**错得自洽**，
于是断言恒绿。本项目真漏过一次：工具栏那颗「返回第 N 层」按钮文案是错的，
断言照样通过（因为两边都不是按钮文字）。**若没有那条「返回后真的能走一格」的
行为断言兜底，这个 bug 会直接混进提交。**

→ 要读文案就另起一个语义单一的 getter（`labelText`），**不要复用 `label`**。

> 三条合起来是一条通用结论：**在三套宿主、没有 DOM 可 inspect 的链路上，
> 最危险的不是「测不出来」，而是「测出来是绿的」。**
> 与 ⑨ 的「must 真删，不能置 undefined」、⑫ 的「副本没刷新」是同一类问题 ——
> 判据本身也要有判据（缺一条行为断言，UI 断言就是自证循环）。

### 9.14 「画面变精细」必须同时钉住「密」和「不变」 ★A17 的由来

把素材网格从 16 翻到 64（超采样）时，「落屏的**设计**像素数」必须一个都不变
（16 × 2 = 64 × 0.5 = 32）。而这两件事**在画面上分不出来**：64 网格按 0.5 画、
和 16 网格按 2× 画，落屏一模一样。也就是说，网格翻倍做错了（比如忘了把
`drawScale` 一起缩小，版面集体放大一倍），**看起来是好的、版面却是错的**。

所以 A17 同时钉四件事：

1. `rasterTile = baseTile × supersample`（网格真的翻了）；
2. 逐条地形帧 `w = rasterTile` 且 `drawScale = cell / rasterTile`（落屏仍是一格）；
3. **拿发布出去的图集帧和第三方原始素材比边长**（`wall_goo` 16 → 64）——
   只看 MANIFEST 的数字等于只信构建脚本的自述；
   （地板、墙先后都改成了手绘、不再来自第三方位图，参照物换成仍在走
   超采样的岩浆 —— **参照物本身也会过期**，素材每手绘一张就要换一次。）
4. 落屏的勇者仍是 32×52（翻倍若把落屏一起放大，这里会变成 64×104）。

> 后来又踩到一条同源的：**「大家伙」的判定别用 `drawScale > 2` 这种中间量。**
> 倍数变小数（0.5 / 0.75）之后，它**静默变成「0 只大家伙」**，于是
> 「非 BOSS 必须装进一格」那条去卡 BOSS，红得莫名其妙。改成按**落屏尺寸**
> 判定（`frame.w × drawScale > cell`）才算落在语义上 ——
> 判据要绑在**不会随实现变化的东西**上。

同类问题也出现在文字光栅化（A18）：把 `resolution` 从写死 2 改成跟随屏幕，
**只在 dsf=2 的页面断言会恒绿** —— 写死 2 也能过。所以测试要**另开一个
dsf=3 的页面**再验一遍，期望值必须是 3。

→ **「改了分辨率 / 网格」这类改动的断言，必须有第二个像素比（或第二份真实
素材）当对照，否则等于没测。** 墙改手绘后新增的 A19 是这条的延续：
判据绑在**砌法语义**上（调色板 ≥5 色、每层有缝列、0/2 层同相且 0/1 层错开），
而不是绑在「颜色值等于多少」上 —— 前者描述的是「这是不是错缝砌法」，
后者只会跟着调色板一起改。

---

### 9.15 第十二个错：**「真机启动即失败：`URL is not defined`」** ★同一行代码，两次不同的病因

**症状**：拆包（单文件 `game.js` → `game.js` + `boot.js`）之后，产物在开发者工具 / 真机上
**启动即挂**，`ReferenceError: URL is not defined`。本地四套判据**全绿**。

**根因**：拆包之后 Vite 会给每个 `await import()` 生成一个预载包装：

```js
__vitePreload(loader, deps, importerUrl)
```

第三实参是 Vite 在**构建期**拼出来的一段「这个 chunk 的绝对地址」表达式：

```js
typeof document === "undefined"
  ? require("url").pathToFileURL(__filename).href                    // ← Node 分支
  : _documentCurrentScript && … && _documentCurrentScript.src
    || new URL("boot.js", document.baseURI).href                      // ← 浏览器分支
```

三个事实叠在一起就炸了：

1. 它是**实参**，不是函数体 —— **实参照样求值**，哪怕 `__vitePreload` 内部根本没用到它
   （这份产物里 `deps` 恒为 `void 0`，消费 `importerUrl` 的分支已在 `if (false) {}` 里被消除）。
2. 真机上 `document` **是存在的**（我们自己垫的），所以走**右支**，也就是 `new URL(...)`。
3. 真机**没有 `URL`** —— 它是 BOM，小游戏的宿主是 JavaScriptCore / V8 + 一层 `wx` API。

而这段代码在 `autoDetectRenderer` → `getWebGLRenderer()` 的调用链上，是**启动必经之路**。

**⚠️ 为什么四套判据都测不出来 —— 这次的假绿是「两个宿主恰好都有」**

| 宿主 | 有 `URL` 吗 |
|---|---|
| Web Worker（`verify:minigame`） | **有**（`WorkerGlobalScope` 自带标准实现） |
| 真 Chromium（`verify:dom`） | **有** |
| 真机小游戏 | **没有** ← 只有这一侧会炸 |

⚠️ 单文件 iife 时代 `inlineDynamicImports` 把动态导入全量内联，**这段实参压根不存在** ——
所以这个问题**是拆包带来的**，不是一直有的。这也解释了为什么「上一轮拆完包、
本地全绿、看起来没问题」。

**与 §9.12 / 铁律 #28 的关系：同一行代码，两次不同的病因。**

| | 病因 | 报错 |
|---|---|---|
| 第一次（单文件 → 拆包当天） | `document` 替身**没有 `baseURI`** | `TypeError: Failed to construct 'URL': Invalid URL` |
| 这一次 | **`URL` 构造器根本不存在** | `ReferenceError: URL is not defined` |

⇒ **修完一个不等于修了另一个。修完一处要接着问「这条路还依赖什么」。**
（当时补 `baseURI` 时，判据给出的红是「`Invalid URL`」—— 那是在说「参数不对」，
它不可能告诉你「构造器不存在」。）

**修法**：

1. `src/minigame/env/url.ts` —— **自实现** RFC 3986 的相对引用解析
   （`merge` + `remove_dot_segments` + `recompose` + authority 三段拆解）。
   宿主有原生就**让路**；没有就补上，并**当场自检**（跑一条带 `..` 的用例，算错就抛）。
   未实现的成员（`searchParams` / `createObjectURL`）**显式报错**，不静默给错值。
2. **⚠️ 还得在构建期词法垫片里铺一条 `var URL`（懒转发）—— 只做第 1 条，
   在开发者工具那条路径上等于没修。**

   沙箱里的 `globalThis` 是**作用域链之外的影子对象**，`safeAssign` 装上去的键
   **裸标识符读不到**（§9.3 那个坑，`Intl` / `navigator` / `document` 都栽过）。
   这次有实测证据：把 `URL` 加进 `verify-sandbox.cjs` 的裸标识符名单，白名单沙箱里
   当场给出 `URL=ReferenceError` —— 也就是**第一版修复在这条路径上完全无效**，
   而那条路径恰恰是用户在开发者工具里跑游戏时走的。

   写法与 `MouseEvent` 那一项同理（`vite.minigame.config.ts` 的 PRELUDE ⑥）：
   **懒转发**，不能把兜底挂到 `globalThis` 上 —— 挂上去就自我递归。
   真实现仍只有一份（`env/url.ts`），转发器在调用那一刻才去取 `globalThis.URL`。

   ⇒ `verify-sandbox` 的裸标识符判据由「七个词法垫片」改成「八个」。
   ⇒ **纪律**：这个项目里每加一个「运行期装到 `globalThis` 的全局」，都要同时问
   「白名单沙箱里它的**裸路径**通不通」。**两份名单必须一起改** ——
   PRELUDE 里那个数组，与 `verify-sandbox.cjs` 的 `must` 数组。
   漏一边的后果不对称：漏改 `must` ⇒ 新成员没人守（白绿）；
   漏改 PRELUDE ⇒ 判据立刻红（真问题）。所以**先加 `must`、再让判据说话**。
3. 把 `URL` / `location` 加进宿主的**抹除清单**，让这条路径本地每次都被走到。
   （`location` 同源：pixi 的 `determineCrossOrigin` 读 `globalThis.location`。
   Worker 里删得掉；**真 Chromium 里它是 `[LegacyUnforgeable]`，删不掉也遮不住** ——
   如实打印覆盖边界，不要假装测过。）
4. `safeStr` 一类日志序列化**必须单独认 Error** —— `JSON.stringify(err)` 得到 `{}`，
   报出来是「启动失败： {}」。**判据红了却读不出原因 = 白白多一轮来回。**

**⚠️ 自实现解析器必须对拍 —— 「能跑」不等于「算得对」。**

另外四套验的都是「**装上了、能跑**」，它们**证明不了算得对**：一个把 `a/../b` 解成
`a/b` 的垫片照样能让游戏跑起来，只是资源路径会歪、或跨域判定走错分支，
然后表现为某种莫名其妙的画面问题（正是本项目最怕的静默降级）。

所以新增 `npm run verify:url-shim` —— 留住原生引用 → 删掉全局 → 装垫片 →
同一批用例喂两边比 9 个字段。**唯一直接测源码模块的一套**（不加载产物）。
它上线第一次运行就抓到两处偏差：

| 用例 | 原生 | 垫片（修前） | 病根 |
|---|---|---|---|
| `new URL('//g', 'http://a/b/c/d;p?q')` | `http://g/` | `http://g` | special scheme 的空 path 要补 `/` |
| `new URL('file:///tmp/a/b')` | origin `"null"` | origin `file://` | `file:` 的 origin 是**不透明**的 |

修法：`normalize()` 放在**解析出口**（`href` / `pathname` / `toString()` 三个出口
因此天然一致，不用各补一遍）；`origin` 单独处理 `file:`。修后 25 个用例 × 9 个字段全一致。

**新增判据**：`verify:minigame` +2（宿主已抹掉 `URL`/`location`；垫片补上且
**相对解析结果正确** —— 行为判据，不只看「存不存在」）、`verify:dom` +2（同上）、
`verify:url-shim` 2 条。

---

## 10. 复现命令

```bash
npm run build:minigame    # 构建产物（含 tsc --noEmit）；产物 = game.js + boot.js + data/*.json
npm run verify:sandbox    # 干净 V8（node:vm）宿主实测，14 条判据（含裸标识符视图 ×8、拆包边界 ×4）
npm run verify:visual     # 渲染层回归，22 条判据（A1–A20，含版面/位面/道具栏/手绘怪物、
                          #   脚下无标记 / 浏览出口 / 攻击动画 / 对话折行 / 上下楼梯 /
                          #   像素密度 / 文字分辨率 / 手绘墙 / 待机呼吸）
npm run verify:minigame   # 无 DOM 环境实测，34 条常驻判据（含禁 unsafe-eval ×3、图集逐字节一致、
                          #   包结构 ×6、语法地板 ×2、宿主缺失全局 URL/location ×2、触摸端到端）
                          #   取证构建（build:minigame:beacon）下另加 6 条 = 40
npm run verify:dom        # 有原生 DOM 宿主实测，21 条判据（含触摸端到端 ×4、图集 ×1、
                          #   宿主缺 URL ×2）
                          #   注：驱动 UI 的点击必须模拟真实节奏，见 §9.13
npm run verify:url-shim   # URL 垫片 vs 原生 URL 对拍，2 条判据（25 用例 × 9 字段）
                          #   唯一**直接测源码模块**的一套（不加载产物），见 §9.14
npm run verify:all        # 以上五套，共 93 条判据（14 + 22 + 34 + 21 + 2）
```

另有两个不在四套之列的取证工具 —— 它们读的都是**工具自己落盘的状态**，
不需要任何服务进程在跑（IDE 只在点「编译」时重载游戏，那一刻服务端在不在取决于时序）：

```bash
npm run ide:storage             # 探针记录：构建号 / 宿主事实 / 裸标识符视图 / 错误时间线
npm run ide:storage -- --list   # 列出所有候选（带各自的构建号）
npm run ide:storage -- --png    # 把落盘的像素记录解成 assets/preview/ide-frame.png

npm run ide:project             # 工程被判成什么类型：compileType → 内部 type、appid 属性、
                                # 窗口层状态（工具栏/入口 tab）、磁盘上的 app.json/game.json、
                                # 以及真机调试的上传到底成没成
npm run ide:project -- --all    # 工具里登记的所有工程
```

- `assets/preview/minigame-board.png`：无 DOM 宿主里 `transferToImageBitmap()` 出来的画面。
- `assets/preview/dom-host.png`：有原生 DOM 宿主（IDE 模拟器同类）里的页面截图。
- `assets/preview/wx-beacon/dom-host-frame.png`：有 DOM 宿主里探针自采的首帧像素网格。
- `assets/preview/wx-beacon/stages-ide-1507.json`：IDE 真机记录（含两个上下文的对比）。

四套画面/判据用途不同：`verify:sandbox` 管「宿主不配合时产物自己撑不撑得住」，
无 DOM 那套保证真机路径，有 DOM 那套保证 IDE 路径，
网格那套把「画面是不是纯黑 / 纯色块」变成可离线重建的数据。

> 取证构建里带**构建号**（`const BUILD = "2026-09-21 15:52:03"`，本机时区）。
> 它由探针的 `module` 阶段报回来，用来回答「IDE 到底在跑哪一份产物」——
> 没有它就没法区分「修了没用」和「跑的还是旧包」。**每次让用户点编译前先记下构建号。**

