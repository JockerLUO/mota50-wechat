/**
 * 环境垫片的**共享状态** —— 拆分前它是 `env.ts` 里的几个模块级 `let`。
 *
 * ## 为什么收进一个对象，而不是散着 `export let`
 *
 * 拆成目录后 `displayElement` 由 `canvas.ts` 写、被 `mouse-event.ts` 读；
 * `hooked*` / `installed` 也各有两个模块读写。跨模块的**可变绑定**要依赖
 * 「ESM 实时绑定」这条语义 —— 它在规范里是明确的，但落到具体打包器上
 * （本项目是 Rollup 拼接 + esbuild 降级到 ES2015）就成了实现细节。
 *
 * 收进一个 `const` 对象、只改属性，语义在任何打包器下都一样：
 * 读到的永远是「此刻的值」，不存在「读到了导入时的快照」这种可能。
 * 这是拆分时唯一需要额外小心的地方，用最保守的写法绕过去。
 *
 * ⚠️ **本文件（以及本目录下所有文件）都不允许声明名为 `Intl` / `navigator` /
 * `document` / `performance` / `MouseEvent` / `requestAnimationFrame` / `window`
 * 的局部绑定。** `bare.ts` 要在模块作用域里**裸读**这些标识符，任何同名局部绑定
 * 都会把那次裸读变成读局部量，于是「宿主给不给这个全局」这件事就量不出来了。
 * （`g.xxx` 那种属性访问不受影响 —— 那是另一条路径，两者本来就要分开量。）
 */

/** 小游戏侧的宿主对象没有稳定类型声明（`wx` 也没有官方 `.d.ts` 挂进来），统一用它。 */
export type Any = any;

/**
 * 宿主全局对象。
 *
 * 小游戏侧它既不是 `window` 也不是标准的 `globalThis` 形态（微信开发者工具里
 * `globalThis` 甚至可能是白名单沙箱的影子对象），所以全项目只从这里拿。
 */
export const g = globalThis as Any;

/** `wx` 运行时 API。宿主没给就是 `undefined` —— 所有用到它的地方都必须容忍这一点。 */
export const wxApi: Any = g.wx;

/**
 * 全部可变的共享槽位。
 *
 * 每个字段的详细理由（为什么是 `null` 而不是 undefined、谁在什么时候写它）
 * 见各自的赋值处 —— 这里只列清单，避免注释放两个地方后各自漂移。
 */
export const envState = {
  /**
   * 当前的上屏画布。
   *
   * 存在的唯一理由是给合成事件填 `target`（见 `mouse-event.ts` 的 `target` 说明）。
   * 由 `patchDisplayCanvas` 赋值 —— 那时宿主才刚拿到画布。
   * 在宿主取画布之前它是 `null`，而那个时间窗里不会有触摸事件，所以是安全的。
   */
  displayElement: null as Any,

  /**
   * 宿主对象上的事件坑位接管成功了吗（见 `hookEventTarget`）。
   *
   * 供 `installTouchBridge()` 决定「还要不要合成真事件兜底」：
   * 全接管成功 → 总线一条路就够；有对象没接管上 → 它的监听还在原生实现上，得补真事件。
   */
  hookedDocument: false,
  hookedGlobal: false,
  hookedCanvas: false,

  /**
   * `installGlobals()` 跑过了吗 —— `assertInstalled()` 读它。
   *
   * ⚠️ 「让路」（原生 DOM 宿主）也算就绪：这条问的是**环境有没有就绪**，
   * 而不是「垫片有没有装上」。语义见 `globals.ts`。
   */
  installed: false,

  /** 预订下来的上屏画布（见 `display.ts`）。 */
  reservedCanvas: null as Any
};
