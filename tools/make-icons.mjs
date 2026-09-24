// 生成扩展图标：蓝底圆角方块 + 白色存档箱 + 向下箭头。纯 Node，无依赖，跑一次即可。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = buf => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
const encodePng = (size, px) => {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const BG = [76, 154, 255];   // #4c9aff，和侧栏主色一致
const FG = [255, 255, 255];
const INK = [37, 99, 235];

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const u = size / 128; // 以 128 为基准按比例缩放
  const set = (x, y, c, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = a;
  };
  const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
    const cx = Math.max(x0 + r, Math.min(x, x1 - r - 1));
    const cy = Math.max(y0 + r, Math.min(y, y1 - r - 1));
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 底：圆角方块
      if (!inRoundRect(x, y, 0, 0, size, size, 26 * u)) continue;
      set(x, y, BG);
      // 箱子盖
      if (inRoundRect(x, y, 20 * u, 24 * u, 108 * u, 40 * u, 6 * u)) set(x, y, FG);
      // 箱身
      if (inRoundRect(x, y, 26 * u, 42 * u, 102 * u, 86 * u, 7 * u)) set(x, y, FG);
      // 盖上的提手
      if (inRoundRect(x, y, 52 * u, 29 * u, 76 * u, 35 * u, 2 * u)) set(x, y, INK);
      // 箭头杆
      if (x >= 61 * u && x < 67 * u && y >= 48 * u && y < 66 * u) set(x, y, INK);
      // 箭头尖：向下三角
      if (y >= 60 * u && y < 78 * u) {
        const half = (78 * u - y) * 0.9;
        if (Math.abs(x - 64 * u) < half) set(x, y, INK);
      }
    }
  }
  return encodePng(size, px);
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(join(outDir, `icon${size}.png`), drawIcon(size));
  console.log(`icons/icon${size}.png 完成`);
}
