// Deterministic placeholder icons (sober clock glyph). Run: node scripts/generate_icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BLUE = [0x1f, 0x4f, 0xbf], WHITE = [0xff, 0xff, 0xff];
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// Coverage of a shape at pixel (x,y) with 4x4 supersampling.
function coverage(inside, x, y) {
  let hits = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (inside(x + (i + 0.5) / 4, y + (j + 0.5) / 4)) hits++;
  return hits / 16;
}
function segment(px, py, ax, ay, bx, by, half) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) <= half;
}

function icon(size, maskable) {
  const c = size / 2, scale = maskable ? 0.36 : 0.42;
  const r = size * scale, ring = size * 0.045, hand = size * 0.035, radius = maskable ? 0 : size * 0.18;
  // Rounded square (signed distance): corners of radius `radius`, half-size c.
  const background = (x, y) => Math.hypot(Math.max(Math.abs(x - c) - (c - radius), 0), Math.max(Math.abs(y - c) - (c - radius), 0)) <= radius;
  const glyph = (x, y) => {
    const d = Math.hypot(x - c, y - c);
    return (d <= r && d >= r - ring) || segment(x, y, c, c, c, c - r * 0.62, hand) || segment(x, y, c, c, c + r * 0.45, c + r * 0.12, hand) || d <= hand * 1.3;
  };
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const bg = maskable ? 1 : coverage(background, x, y), fg = coverage(glyph, x, y) * bg;
      const color = BLUE.map((b, i) => Math.round(b * (1 - fg) + WHITE[i] * fg));
      raw.set([...color, Math.round(255 * bg)], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

writeFileSync('public/icons/icon-192.png', icon(192, false));
writeFileSync('public/icons/icon-512.png', icon(512, false));
writeFileSync('public/icons/icon-maskable-512.png', icon(512, true));
