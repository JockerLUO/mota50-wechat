/**
 * 阵亡遮罩 —— 勇者倒下时盖住整屏的那张卡。
 *
 * 从 `app.ts` 拆出来的。它是编排层里**唯一一块纯渲染构建**：画满屏遮罩、
 * 画卡片、写结算文字、放一颗「重新开始」。原先它以 `showDeath()` 的形式
 * 埋在 `Game` 类的最后，读者要翻过输入 / 动作 / 对话 / 交易 / 浏览状态机
 * 才能看到「死的时候是什么样」。
 *
 * ⚠️ 遮罩有一个**必须保住**的性质：它的 `hitArea` 是满屏矩形且
 *    `eventMode = 'static'` —— 阵亡后它会吃掉所有点击（这是有意的）。
 *    自动化脚本因此在每个用例开头都要先按 `r` 回到干净状态，
 *    否则后续所有点击都会点空。这条约束随代码一起搬过来了。
 */

import { Container, Graphics, Rectangle } from 'pixi.js';
import { LAYOUT, label } from '../render/hud';
import { T } from '../render/theme';

export interface DeathInfo {
  floor: number;
  steps: number;
  kills: number;
}

/**
 * 往 `layer` 里画一张阵亡卡。
 *
 * @param onRestart 点「重新开始」时回调 —— 由编排层决定怎么重开
 *                  （这里不持有 `Game`，所以它也不知道重开要做哪些同步）。
 */
export function buildDeathOverlay(layer: Container, info: DeathInfo, onRestart: () => void): void {
  const g = new Graphics();
  g.rect(0, 0, LAYOUT.W, LAYOUT.H).fill({ color: 0x0f172a, alpha: 0.55 });
  g.eventMode = 'static';
  g.hitArea = new Rectangle(0, 0, LAYOUT.W, LAYOUT.H);
  layer.addChild(g);

  const px = 60;
  const py = Math.round((LAYOUT.H - 186) / 2);
  const pw = LAYOUT.W - 120;
  const ph = 186;
  // 局部名不叫 `panel` —— 那是 `render/hud` 里「统一卡片底板」的函数名，
  // 同名会让读者以为这里走了统一版式（这里其实是手画的，因为它要盖在**所有**面板之上）
  const card = new Graphics();
  card.roundRect(px, py, pw, ph, 16).fill(T.panel);
  card.roundRect(px, py, pw, ph, 16).stroke({ width: 1, color: T.panelBorder });
  layer.addChild(card);

  const title = label('勇者阵亡', 22, T.danger, '800');
  title.anchor.set(0.5, 0);
  title.x = LAYOUT.W / 2;
  title.y = py + 26;
  layer.addChild(title);

  const sub = label(
    `在第 ${info.floor} 层倒下　步数 ${info.steps}　击杀 ${info.kills}`,
    12,
    T.inkMuted
  );
  sub.anchor.set(0.5, 0);
  sub.x = LAYOUT.W / 2;
  sub.y = py + 64;
  layer.addChild(sub);

  const tip = label('巫师领域是唯一致死途径，战斗前会先被拦下。', 11, T.inkFaint);
  tip.anchor.set(0.5, 0);
  tip.x = LAYOUT.W / 2;
  tip.y = py + 88;
  layer.addChild(tip);

  const btn = new Container();
  btn.x = LAYOUT.W / 2 - 60;
  btn.y = py + 122;
  const bg = new Graphics();
  bg.roundRect(0, 0, 120, 38, 19).fill(T.hero);
  const bt = label('重新开始', 14, T.onDark, '700');
  bt.anchor.set(0.5);
  bt.x = 60;
  bt.y = 19;
  btn.addChild(bg, bt);
  btn.eventMode = 'static';
  btn.cursor = 'pointer';
  btn.hitArea = new Rectangle(0, 0, 120, 38);
  btn.on('pointertap', () => onRestart());
  layer.addChild(btn);
}
