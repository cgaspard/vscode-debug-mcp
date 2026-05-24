#!/usr/bin/env node
// Generate a 128x128 PNG icon for the extension.
// Pure Node, no dependencies. Outputs media/icon.png.
//
// Design: dark rounded-square background with a debug-step glyph (a play
// triangle with a small step "ladder" of dots in front of it), recolored
// in VS Code's debug-orange so it reads at small sizes in the marketplace
// and sidebar.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const RADIUS = 44;
const BG = [0x1f, 0x24, 0x2e, 0xff];        // deep slate
const ACCENT = [0xf9, 0x82, 0x2c, 0xff];    // VS Code debug orange
const ACCENT_DIM = [0xff, 0xb2, 0x6b, 0xff];

const out = new Uint8Array(SIZE * SIZE * 4);

function setPx(x, y, rgba) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  out[i] = rgba[0];
  out[i + 1] = rgba[1];
  out[i + 2] = rgba[2];
  out[i + 3] = rgba[3];
}

function blend(dst, src) {
  // src over dst, both straight rgba
  const sa = src[3] / 255;
  const da = dst[3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return [0, 0, 0, 0];
  return [
    Math.round((src[0] * sa + dst[0] * da * (1 - sa)) / oa),
    Math.round((src[1] * sa + dst[1] * da * (1 - sa)) / oa),
    Math.round((src[2] * sa + dst[2] * da * (1 - sa)) / oa),
    Math.round(oa * 255)
  ];
}

function getPx(x, y) {
  const i = (y * SIZE + x) * 4;
  return [out[i], out[i + 1], out[i + 2], out[i + 3]];
}

function aaPx(x, y, rgba, coverage) {
  if (coverage <= 0) return;
  const c = Math.min(1, coverage);
  const tinted = [rgba[0], rgba[1], rgba[2], Math.round(rgba[3] * c)];
  const cur = getPx(x, y);
  const blended = blend(cur, tinted);
  const i = (y * SIZE + x) * 4;
  out[i] = blended[0];
  out[i + 1] = blended[1];
  out[i + 2] = blended[2];
  out[i + 3] = blended[3];
}

// Rounded rect background
function fillRoundedRect(x0, y0, w, h, r, rgba) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      // Distance from nearest corner
      const cx = x < x0 + r ? x0 + r : x > x0 + w - 1 - r ? x0 + w - 1 - r : x;
      const cy = y < y0 + r ? y0 + r : y > y0 + h - 1 - r ? y0 + h - 1 - r : y;
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      // anti-alias edge over 1 px
      if (d <= r - 0.5) {
        setPx(x, y, rgba);
      } else if (d <= r + 0.5) {
        const cov = r + 0.5 - d;
        aaPx(x, y, rgba, cov);
      }
    }
  }
}

// Filled triangle (3 points), simple scanline with edge AA via 2x supersample
function fillTriangle(p1, p2, p3, rgba) {
  const ss = 2;
  const minX = Math.max(0, Math.floor(Math.min(p1[0], p2[0], p3[0])));
  const maxX = Math.min(SIZE - 1, Math.ceil(Math.max(p1[0], p2[0], p3[0])));
  const minY = Math.max(0, Math.floor(Math.min(p1[1], p2[1], p3[1])));
  const maxY = Math.min(SIZE - 1, Math.ceil(Math.max(p1[1], p2[1], p3[1])));

  const sign = (a, b, c) =>
    (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1]);

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          const pt = [px, py];
          const d1 = sign(pt, p1, p2);
          const d2 = sign(pt, p2, p3);
          const d3 = sign(pt, p3, p1);
          const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
          const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
          if (!(hasNeg && hasPos)) hits++;
        }
      }
      if (hits > 0) {
        aaPx(x, y, rgba, hits / (ss * ss));
      }
    }
  }
}

// Filled circle with AA
function fillCircle(cx, cy, r, rgba) {
  const minX = Math.max(0, Math.floor(cx - r - 1));
  const maxX = Math.min(SIZE - 1, Math.ceil(cx + r + 1));
  const minY = Math.max(0, Math.floor(cy - r - 1));
  const maxY = Math.min(SIZE - 1, Math.ceil(cy + r + 1));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = Math.sqrt((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2);
      if (d <= r - 0.5) setPx(x, y, rgba);
      else if (d <= r + 0.5) aaPx(x, y, rgba, r + 0.5 - d);
    }
  }
}

// --- Draw ---
fillRoundedRect(0, 0, SIZE, SIZE, RADIUS, BG);

// Play triangle (debug arrow), pointing right, slightly offset left to leave room for step dots
const cx = SIZE / 2;
const cy = SIZE / 2;
const tHalf = 56;
const tWidth = 76;
const tOffsetX = -16;
fillTriangle(
  [cx - tWidth / 2 + tOffsetX, cy - tHalf],
  [cx - tWidth / 2 + tOffsetX, cy + tHalf],
  [cx + tWidth / 2 + tOffsetX, cy],
  ACCENT
);

// Three "step" dots cascading down-right of the triangle tip — represents stepping through code
const dotR = 10;
const dotStartX = cx + tWidth / 2 + tOffsetX + 26;
const dotStartY = cy - 28;
for (let i = 0; i < 3; i++) {
  const dx = dotStartX + i * 0;
  const dy = dotStartY + i * 28;
  fillCircle(dx, dy, dotR, i === 0 ? ACCENT : ACCENT_DIM);
}

// --- Encode PNG ---
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

// Filter byte 0 per scanline + RGBA pixels
const rowBytes = SIZE * 4;
const raw = Buffer.alloc((rowBytes + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (rowBytes + 1)] = 0;
  out.subarray(y * rowBytes, (y + 1) * rowBytes).forEach((b, i) => {
    raw[y * (rowBytes + 1) + 1 + i] = b;
  });
}
const idatData = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idatData),
  chunk('IEND', Buffer.alloc(0))
]);

const target = path.join('media', 'icon.png');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, png);
console.log(`Wrote ${target} (${png.length} bytes, ${SIZE}x${SIZE})`);
