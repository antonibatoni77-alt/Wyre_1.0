// Generates Android launcher icons (the Wyre brand mark: rounded square,
// violet→blue gradient, white "W") for every density. Pure Node, no deps.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SEGMENTS = [
  [[6, 10], [11, 27]],
  [[11, 27], [18, 16]],
  [[18, 16], [25, 27]],
  [[25, 27], [30, 10]],
];

const clamp01 = (value) => Math.min(1, Math.max(0, value));

function roundedRectDistance(x, y, size) {
  const radius = size * 0.225;
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  return Math.hypot(x - cx, y - cy) - radius;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = clamp01(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

function wDistance(x, y, size) {
  const pad = size * 0.2;
  const scale = (size - pad * 2) / 36;
  const px = (x - pad) / scale;
  const py = (y - pad) / scale;
  let best = Infinity;
  for (const [[ax, ay], [bx, by]] of SEGMENTS) {
    best = Math.min(best, distToSegment(px, py, ax, ay, bx, by) * scale);
  }
  return best;
}

const SS = 3;

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const stroke = size * 0.1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let coverage = 0;
      let wr = 0;
      let wg = 0;
      let wb = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (roundedRectDistance(px, py, size) > 0) continue;
          coverage += 1;
          const t = clamp01((px + py) / (size * 2));
          wr += 139 + (37 - 139) * t;
          wg += 92 + (99 - 92) * t;
          wb += 246 + (235 - 246) * t;
        }
      }
      const samples = SS * SS;
      const offset = (y * size + x) * 4;
      if (!coverage) {
        rgba.writeUInt8(0, offset + 3);
        continue;
      }
      let r = wr / coverage;
      let g = wg / coverage;
      let b = wb / coverage;
      const wAlpha = clamp01(0.5 - (wDistance(x + 0.5, y + 0.5, size) - stroke / 2)) * (coverage / samples);
      r = r * (1 - wAlpha) + 255 * wAlpha;
      g = g * (1 - wAlpha) + 255 * wAlpha;
      b = b * (1 - wAlpha) + 255 * wAlpha;
      rgba.writeUInt8(Math.round(r), offset);
      rgba.writeUInt8(Math.round(g), offset + 1);
      rgba.writeUInt8(Math.round(b), offset + 2);
      rgba.writeUInt8(255, offset + 3);
    }
  }
  return rgba;
}

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

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
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

const DENSITIES = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};

const resRoot = path.join(__dirname, '..', 'app', 'src', 'main', 'res');
for (const [dir, size] of Object.entries(DENSITIES)) {
  const target = path.join(resRoot, dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'ic_launcher.png'), encodePng(size, render(size)));
  console.log(`Иконка: ${path.join(dir, 'ic_launcher.png')} (${size}x${size})`);
}
