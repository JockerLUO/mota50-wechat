/**
 * 运行宿主抽象 —— 网页与小游戏之间**唯一**的平台差异出口。
 *
 * 为什么要有这一层：
 *   项目里有 5 处直接碰浏览器 API（`document.getElementById`、`window.devicePixelRatio`、
 *   `window.addEventListener`），小游戏三者全都没有。散落在 `src/app/game.ts` / `src/main.ts` 里做
 *   `if (isMiniGame)` 判断，会让「哪些是真实依赖」变得看不清；收进一个接口后，
 *   `grep -rn "document\|window\." src/` 只要看这个文件就够了。
 *
 * 用法：
 *   网页端 —— 什么都不用做，`host()` 会惰性创建 `createWebHost()`。
 *   小游戏 —— 入口在 `Game.create()` 之前调 `setHost(createMiniGameHost())`。
 *             惰性默认很关键：它保证本模块被 import 时**不碰 DOM**。
 */

/** 渲染画布。网页是 HTMLCanvasElement，小游戏是 `wx.createCanvas()` 的返回值。 */
export interface RenderCanvas {
  width: number;
  height: number;
}

export interface Host {
  readonly name: 'web' | 'minigame';
  /** 设备像素比。已夹到 ≤3 —— 超高 dpr 机型按 1:1 像素比渲染会把填充率吃干。 */
  readonly dpr: number;
  /** 逻辑尺寸。网页是 innerWidth/Height，小游戏是 windowWidth/Height。 */
  size(): { w: number; h: number };
  /** 拿渲染画布。小游戏端必须返回「第一次 wx.createCanvas()」的上屏画布。 */
  canvas(): RenderCanvas;
  /** 把画布挂到宿主上。小游戏没有 DOM，是空操作。 */
  attach(canvas: RenderCanvas): void;
  onResize(cb: () => void): void;
  /** 键盘回调。小游戏端是空实现 —— 触摸走 Pixi 的联邦事件，不经过这里。 */
  onKey(cb: (key: string) => void): void;
  /** 启动成功 / 失败。网页端操作 #boot 元素，小游戏端弹窗提示。 */
  bootSettled(err?: unknown): void;
  /** 暴露调试句柄。网页端挂 window，小游戏端挂 GameGlobal。 */
  expose(name: string, value: unknown): void;
}

let current: Host | null = null;

/** 小游戏入口用。必须在 `Game.create()` 之前调用。 */
export function setHost(h: Host): void {
  current = h;
}

export function host(): Host {
  if (!current) current = createWebHost();
  return current;
}

/** 这些键要吃掉默认行为：方向键否则整页跟着滚，Tab 会跑焦点。 */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Tab']);

function createWebHost(): Host {
  return {
    name: 'web',
    dpr: Math.min(window.devicePixelRatio || 1, 3),
    size: () => ({ w: window.innerWidth, h: window.innerHeight }),
    canvas: () => document.createElement('canvas'),
    attach: (canvas) => {
      const stage = document.getElementById('stage');
      if (!stage) throw new Error('找不到 #stage 容器');
      stage.appendChild(canvas as unknown as HTMLCanvasElement);
    },
    onResize: (cb) => {
      window.addEventListener('resize', cb);
    },
    onKey: (cb) => {
      window.addEventListener('keydown', (e) => {
        if (SCROLL_KEYS.has(e.key)) e.preventDefault();
        cb(e.key);
      });
    },
    bootSettled: (err) => {
      const boot = document.getElementById('boot');
      if (!boot) return;
      if (err === undefined) {
        boot.remove();
        return;
      }
      boot.textContent = `启动失败：${err instanceof Error ? err.message : String(err)}`;
      boot.classList.add('boot-error');
    },
    expose: (name, value) => {
      (window as unknown as Record<string, unknown>)[name] = value;
    }
  };
}
