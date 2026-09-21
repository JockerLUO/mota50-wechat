/**
 * 微信开发者工具「启动取证」接收端。
 *
 * 收 `src/minigame/beacon.ts` 发回来的东西，落盘成能直接看的证据：
 *   assets/preview/wx-beacon/stages.json    逐条阶段记录（含异常）
 *   assets/preview/wx-beacon/frame-1.png    首帧粗网格重建出来的图
 *   assets/preview/wx-beacon/shot-1.png     真实截图（`wx.canvasToTempFilePath` 成功时才有）
 *
 * ## 为什么需要它
 *
 * IDE 的服务端口默认关闭，而那是在外部驱动模拟器的唯一入口（见 beacon.ts 的说明）。
 * 没有服务端口、没有屏幕录制权限的情况下，**让游戏自己把画面发回来**是唯一的观测手段。
 *
 * ## 用法
 *
 *   node tools/wx-beacon-server.cjs          # 起服务，等到收齐后自动退出
 *   然后在微信开发者工具里点「编译」
 *
 * ## 出图用的是共享编码器
 *
 * `tools/lib/png.cjs` —— 手写它是为了不引图像依赖（PNG 的 IDAT 就是 zlib，
 * 而 `node:zlib` 是内置的）。`verify-minigame.cjs` 用同一份编码器出图，
 * 于是「本地出得来、IDE 里出不来」只可能源于数据，不可能源于渲染。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pngFromHexGrid } = require('./lib/png.cjs');

const PORT = Number(process.env.WX_BEACON_PORT || 8899);
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'preview', 'wx-beacon');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
// 静默多久算「取证结束」。90 帧 ≈ 1.5s，加上可能的截图回传，12s 足够宽裕。
const IDLE_MS = flag('idle', 12) * 1000;
const HARD_MS = flag('timeout', 300) * 1000;
/** 重建图的放大倍数。网格本身约 105×195，×3 后是能看清布局的大小。 */
const SCALE = flag('scale', 3);

fs.mkdirSync(OUT, { recursive: true });

// ── 状态 ────────────────────────────────────────────────────────────
const stages = [];
let frameCount = 0;
let shotCount = 0;
let idleTimer = null;
let gotAny = false;
let finished = false;

function finish(reason) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(path.join(OUT, 'stages.json'), JSON.stringify(stages, null, 2));

  console.log('\n══ 微信小游戏 · 启动取证 ══\n');
  if (!stages.length) {
    console.log('  一条记录都没收到。');
    console.log('  → 说明产物里没有探针（要用 `npm run build:minigame:beacon` 构建），');
    console.log('    或者 IDE 里还没点「编译」。');
  }
  for (const s of stages) {
    const t = typeof s.t === 'number' ? `${String(s.t).padStart(5)}ms` : '    -';
    if (s.stage === 'pixels') {
      console.log(
        `  ${t}  pixels         绘制缓冲 ${s.drawingBuffer.w}×${s.drawingBuffer.h}` +
          `  采样 ${s.cols}×${s.rows}  非黑 ${(s.nonBlackRatio * 100).toFixed(1)}%` +
          `  ${s.distinctColors} 种颜色`
      );
    } else if (s.stage === 'error' || s.stage === 'wxError' || s.stage === 'unhandledRejection') {
      console.log(`  ${t}  ❌ ${s.stage} @ ${s.where || '-'}`);
      console.log(`         ${String(s.message).split('\n')[0].slice(0, 200)}`);
      if (s.stack) console.log(`         ${String(s.stack).split('\n').slice(0, 4).join('\n         ')}`);
    } else {
      const extra = s.data ? `  ${JSON.stringify(s.data).slice(0, 220)}` : '';
      console.log(`  ${t}  ${s.stage}${extra}`);
    }
  }
  console.log(`\n  记录 ${stages.length} 条，重建图 ${frameCount} 张，真实截图 ${shotCount} 张`);
  console.log(`  输出目录：${path.relative(ROOT, OUT)}/`);
  console.log(`  （结束原因：${reason}）\n`);
  server.close();
  process.exit(0);
}

function bump() {
  gotAny = true;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => finish(`静默 ${IDLE_MS / 1000}s`), IDLE_MS);
}

// ── 服务 ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    res.writeHead(204).end();
    bump();

    if (url === '/shot') {
      // 真实截图（base64 PNG）。`wx.canvasToTempFilePath` 在 WebGL 主画布上
      // 未必被支持，所以这条是加分项 —— 失败不影响粗网格那条证据链。
      try {
        const buf = Buffer.from(body, 'base64');
        if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) {
          shotCount += 1;
          fs.writeFileSync(path.join(OUT, `shot-${shotCount}.png`), buf);
        }
      } catch {
        /* 忽略 */
      }
      return;
    }

    if (url !== '/beacon') return;

    let rec;
    try {
      rec = JSON.parse(body);
    } catch (e) {
      stages.push({ stage: 'parseError', message: e.message });
      return;
    }

    if (rec.stage === 'pixels') {
      frameCount += 1;
      const { png } = pngFromHexGrid(rec.px, rec.cols, rec.rows, SCALE);
      fs.writeFileSync(path.join(OUT, `frame-${frameCount}.png`), png);
      delete rec.px; // 落盘时不留 130KB 的像素串
    }
    stages.push(rec);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`取证端点已就绪：http://127.0.0.1:${PORT}/beacon`);
  console.log('请在微信开发者工具里点「编译」，或在模拟器里让它重新加载。');
  console.log(
    `（首条记录到达前等 ${HARD_MS / 1000}s；到达后静默 ${IDLE_MS / 1000}s 即结束）\n`
  );
});

setTimeout(() => finish(`硬超时 ${HARD_MS / 1000}s（一条记录都没收到）`), HARD_MS);
process.on('SIGINT', () => finish('手动中断'));
