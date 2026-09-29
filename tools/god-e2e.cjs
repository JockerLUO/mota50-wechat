#!/usr/bin/env node
/**
 * 界面上的**神装自动通关**长跑 —— 点「自动通关」，等它自己停下，看走到哪一层。
 *
 * ## 为什么它必须存在（与 A23 / `verify:autoplay` 分工）
 *
 * 三件事分别由三条判据守，谁也替不了谁：
 *
 *   · `verify:autoplay` 的 **D 段**：**决策器**在神装起手下能不能通关
 *     （headless，7906 步击败真魔王）。它**完全不碰界面**。
 *   · **A23**：界面上那颗按钮**点得着、真的会走、说停就停**，且点下去属性真的
 *     变成神装。它只跑 **1.5 秒**（≈13 拍）—— 「起手对不对」能判，「能不能通关」判不了。
 *   · **本条**：把上面两件事**接起来**——同样的起手、同样的决策器，但执行走的是
 *     `game.ts` 的 `performAutoAction()`（**另一份代码**）。两万步里只要有一个
 *     动作种类在界面那一侧没接上，前两条**都是绿的**，而屏幕上会停在半路。
 *     （事实上六个种类 `step/buy/useItem/trade/travel/stop` 是齐的，
 *     但「齐不齐」这件事此前只有读代码才能知道。）
 *
 * ## 为什么它不是 `verify:*` 里的一条
 *
 * 神装局要跑 **~7900 步**，而界面按 `AUTO_STEP_MS = 110ms` 出手 ⇒ **约 15 分钟**。
 * 放进任何一条门禁都会让人开始跳过门禁。所以它是**独立入口**，手动跑：
 *
 *     npm run e2e:god
 *
 * ## 它读的是产物
 *
 * 全程只读 `__probe()`（楼层 / 三围 / 自动步数 / 末条日志），不读源码、不读内部字段。
 * 判定「通关」用的是**末条日志**里那句由 `tickAuto` 自己写的
 * 「通关：真魔王已被击败」—— 而不是判据自己再算一遍 `isCleared`
 * （自己再算一遍，验的就成了判据的实现，不是游戏的）。
 */
const path = require('node:path');
const { runAll } = require('./verify/harness.cjs');

/** 长跑上限（毫秒）。神装局实测约 15 分钟，留到 25 分钟。—— 超了就是真有病 */
const LIMIT_MS = Number(process.env.GOD_E2E_LIMIT_MS || 25 * 60 * 1000);
/** 每多少毫秒采一次样 */
const POLL_MS = 5000;
/** 换层 / 大步前进才打印一行，免得 15 分钟刷出几千行 */
const LOG_MIN_STEP_DELTA = 200;

const run = async (ctx) => {
  const { page, check } = ctx;

  const snap = () =>
    page.evaluate(() => {
      const p = window.mota.game.__probe();
      return {
        floor: p.floor,
        hp: p.hp,
        atk: p.atk,
        def: p.def,
        autoSteps: p.autoSteps,
        visited: p.visitedCount,
        running: p.autoRunning,
        loadout: p.autoLoadout,
        lastLog: p.lastLog
      };
    });

  /** 与 A23 同一个「像手指那样」的点击：Pixi 的命中目标是**每帧**才刷新的 */
  const tap = async (x, y) => {
    await page.mouse.move(x, y);
    await page.waitForTimeout(60);
    await page.mouse.down();
    await page.waitForTimeout(60);
    await page.mouse.up();
  };

  // 从干净的一局起（前面的判据可能留下阵亡 / 浮层）
  await page.keyboard.press('r');
  await page.waitForTimeout(300);
  const before = await snap();
  if (before.loadout) {
    check('E2E 神装自动通关', false, '开局就带着上一局的测试起手标记（重开没清干净）');
    return;
  }

  const btn = (await page.evaluate(() => window.mota.game.__probe().toolbarButtons)).find(
    (b) => b.id === 'auto'
  );
  if (!btn) {
    check('E2E 神装自动通关', false, '找不到 id === "auto" 的按钮');
    return;
  }
  await tap(btn.x + btn.w / 2, btn.y + btn.h / 2);

  const t0 = Date.now();
  let maxFloor = 1;
  let last = before;
  for (;;) {
    await page.waitForTimeout(POLL_MS);
    const s = await snap();
    if (s.floor > maxFloor) maxFloor = s.floor;
    if (s.floor !== last.floor || s.autoSteps - last.autoSteps > LOG_MIN_STEP_DELTA) {
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(
        `   [${secs}s] F${s.floor}（最高 F${maxFloor}）hp${s.hp} 攻${s.atk} 防${s.def} ` +
          `自动 ${s.autoSteps} 步 · 到过 ${s.visited} 层`
      );
    }
    last = s;

    if (!s.running) {
      const text = JSON.stringify(s.lastLog ?? '');
      const cleared = /真魔王已被击败/.test(text);
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      check(
        `E2E 界面神装自动通关：跑到 F50 击败真魔王（${secs}s / 自动 ${s.autoSteps} 步 / 最高 F${maxFloor}）`,
        cleared,
        cleared
          ? `F${s.floor}，末条日志「${text}」`
          : `自己停下了：F${s.floor}（最高 F${maxFloor}）自动 ${s.autoSteps} 步，末条日志「${text}」`
      );
      return;
    }
    if (Date.now() - t0 > LIMIT_MS) {
      check(
        'E2E 界面神装自动通关：跑到 F50 击败真魔王',
        false,
        `${(LIMIT_MS / 60000).toFixed(0)} 分钟仍未停：F${last.floor}（最高 F${maxFloor}）自动 ${last.autoSteps} 步`
      );
      return;
    }
  }
};

runAll([
  {
    id: 'e2e-god',
    title: '界面神装自动通关（长跑，约 15 分钟）',
    run
  }
]).catch((err) => {
  console.error(err);
  process.exit(1);
});
