// Generates desktop/build/icon.png (256x256) with the Wyre brand mark:
// rounded square, violet→blue diagonal gradient, white "W" strokes.
// Pure Node: manual RGBA rasterization + PNG encoding via zlib. No dependencies.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
const RADIUS = 58;
const STROKE = 26; // stroke width of the W in pixels

// The W path from the web brand-mark, viewBox 36x36.
const SEGMENTS = [
  [[6, 10], [11, 27]],
  [[11, 27], [18, 16]],
  [[18, 16], [25, 27]],
  [[25, 27], [30, 10]],
];

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function roundedRectDistance(x, y) {
  // Distance to the rounded-rect boundary (negative inside).
  const cx = Math.min(Math.max(x, RADIUS), SIZE - RADIUS);
  const cy = Math.min(Math.max(y, RADIUS), SIZE - RADIUS);
  const dx = x - cx;
  const dy = y - cy;
  return Math.hypot(dx, dy) - RADIUS;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = clamp01(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

function wDistance(x, y) {
  // Scale the 36x36 viewBox up to the icon with padding.
  const pad = 52;
  const scale = (SIZE - pad * 2) / 36;
  const px = (x - pad) / scale;
  const py = (y - pad) / scale;
  let best = Infinity;
  for (const [[ax, ay], [bx, by]] of SEGMENTS) {
    best = Math.min(best, distToSegment(px, py, ax, ay, bx, by) * scale);
  }
  return best;
}

// Supersampling factor for smooth edges.
const SS = 3;

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let coverage = 0;
      let wr = 0;
      let wg = 0;
      let wb = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const inside = roundedRectDistance(px, py) <= 0;
          if (!inside) continue;
          coverage += 1;
          // Diagonal gradient violet → blue.
          const t = clamp01((px + py) / (SIZE * 2));
          wr += 139 + (37 - 139) * t;
          wg += 92 + (99 - 92) * t;
          wb += 246 + (235 - 246) * t;
        }
      }
      const samples = SS * SS;
      if (!coverage) {
        rgba.writeUInt8(0, (y * SIZE + x) * 4 + 3);
        continue;
      }
      const bgA = coverage / samples;
      let r = wr / coverage;
      let g = wg / coverage;
      let b = wb / coverage;

      // The white W with soft anti-aliased edges.
      const wd = wDistance(x + 0.5, y + 0.5);
      const wAlpha = clamp01(0.5 - (wd - STROKE / 2)) * bgA;
      r = r * (1 - wAlpha) + 255 * wAlpha;
      g = g * (1 - wAlpha) + 255 * wAlpha;
      b = b * (1 - wAlpha) + 255 * wAlpha;

      const offset = (y * SIZE + x) * 4;
      rgba.writeUInt8(Math.round(r), offset);
      rgba.writeUInt8(Math.round(g), offset + 1);
      rgba.writeUInt8(Math.round(b), offset + 2);
      rgba.writeUInt8(Math.round(255 * bgA), offset + 3);
    }
  }
  return rgba;
}

// --- Minimal PNG encoder -----------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type RGBA
  // Filter byte 0 per scanline.
  const stride = SIZE * 4;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO container (PNG embedded, valid for 256px icons) --------------------
function encodeIco(png) {
  // ICONDIR: reserved(2) + type(2)=1 + count(2)=1
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  // ICONDIRENTRY: width(1) 0=256, height(1), colors(1), reserved(1),
  // planes(2), bitcount(2), size(4), offset(4)=22
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0); // 256 px is stored as 0
  entry.writeUInt8(0, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const png = encodePng(render());
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(png));
console.log(`Иконки созданы: ${outDir}\\icon.png и icon.ico (${SIZE}x${SIZE})`);
