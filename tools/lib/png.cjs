/**
 * 手写 PNG 编码器 + 「十六进制色网格 → 图」的渲染。
 *
 * ## 为什么手写
 *
 * 这里只需要一件事：把一张 RGB 网格写成 PNG。PNG 的 IDAT 就是 zlib，而
 * `node:zlib` 是 Node 内置的 —— 于是手写几十行比引一个图像依赖更省事，
 * 也让 `tools/` 保持「不装额外依赖就能跑」。
 *
 * ## 谁在用
 *
 *   tools/wx-beacon-server.cjs  收 IDE 里小游戏发回的像素网格，出图
 *   tools/verify-minigame.cjs   把探针在无 DOM 校验里写的同一份网格出图
 *
 * 两条路径共用同一份编码器，所以「本地出得来图、IDE 里出不来」这种差异
 * 只可能来自数据，不可能来自渲染。
 */

const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** width×height 的 RGBA 缓冲区 → PNG（8 位真彩 + alpha，无隔行，filter 全用 None）。 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolour + alpha
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * 把 `rrggbb` 序列（行优先、从上往下）铺成图，每个采样点放大 `scale` 倍。
 *
 * 探针已经在上屏前把 Y 轴翻转过了（WebGL 原点在左下），所以这里直接顺序铺即可 ——
 * 翻转只做一次，且做在采集端，两边都翻等于没翻。
 */
function pngFromHexGrid(px, cols, rows, scale = 3) {
  const w = cols * scale;
  const h = rows * scale;
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i0 = (y * cols + x) * 6;
      const v = parseInt(px.slice(i0, i0 + 6), 16) || 0;
      const r = (v >> 16) & 0xff;
      const g = (v >> 8) & 0xff;
      const b = v & 0xff;
      for (let dy = 0; dy < scale; dy++) {
        let o = ((y * scale + dy) * w + x * scale) * 4;
        for (let dx = 0; dx < scale; dx++) {
          buf[o] = r;
          buf[o + 1] = g;
          buf[o + 2] = b;
          buf[o + 3] = 255;
          o += 4;
        }
      }
    }
  }
  return { png: encodePng(w, h, buf), width: w, height: h };
}

module.exports = { encodePng, pngFromHexGrid, crc32 };
