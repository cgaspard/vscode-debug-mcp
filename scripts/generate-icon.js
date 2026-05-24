#!/usr/bin/env node
// Generate a 256x256 PNG icon for the extension.
// Pure Node, no dependencies. Outputs media/icon.png.
//
// Design: a stylized bug (ladybug silhouette) with two antennae that
// terminate in circuit-style nodes — the "bug" reads as "debugger" and
// the antenna-nodes evoke being plugged into AI tooling (MCP).
//
// Palette: amber bug + warm highlight, dark slate background, soft
// connection lines.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const RADIUS = 44;

const BG = [0x1a, 0x1f, 0x2a, 0xff];          // deep slate
const BG_GLOW = [0x26, 0x2d, 0x3d, 0xff];      // subtle radial center
const BUG = [0xf2, 0x7d, 0x2a, 0xff];          // primary amber
const BUG_DARK = [0xc2, 0x5a, 0x16, 0xff];     // bug shadow / underside
const BUG_HILITE = [0xff, 0xb0, 0x5e, 0xff];   // top sheen
const SPOT = [0x2a, 0x18, 0x09, 0xff];         // ladybug spots
const WIRE = [0x7b, 0xc3, 0xe8, 0xff];         // cool cyan for circuitry
const NODE = [0xa8, 0xe0, 0xff, 0xff];         // brighter node

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

function fillRoundedRect(x0, y0, w, h, r, rgba) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const cx = x < x0 + r ? x0 + r : x > x0 + w - 1 - r ? x0 + w - 1 - r : x;
      const cy = y < y0 + r ? y0 + r : y > y0 + h - 1 - r ? y0 + h - 1 - r : y;
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= r - 0.5) setPx(x, y, rgba);
      else if (d <= r + 0.5) aaPx(x, y, rgba, r + 0.5 - d);
    }
  }
}

// Radial gradient overlay (center to edges)
function radialGlow(cx, cy, rOuter, rgba) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.sqrt((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2);
      if (d >= rOuter) continue;
      const t = 1 - d / rOuter;
      aaPx(x, y, rgba, t * t * 0.5);
    }
  }
}

function fillEllipse(cx, cy, rx, ry, rgba, rotateRad = 0) {
  const cos = Math.cos(rotateRad);
  const sin = Math.sin(rotateRad);
  const maxR = Math.max(rx, ry) + 1;
  const minX = Math.max(0, Math.floor(cx - maxR));
  const maxX = Math.min(SIZE - 1, Math.ceil(cx + maxR));
  const minY = Math.max(0, Math.floor(cy - maxR));
  const maxY = Math.min(SIZE - 1, Math.ceil(cy + maxR));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const rxv = dx * cos + dy * sin;
      const ryv = -dx * sin + dy * cos;
      const v = (rxv / rx) ** 2 + (ryv / ry) ** 2;
      if (v <= 0.96) setPx(x, y, rgba);
      else if (v <= 1.04) {
        const cov = (1.04 - v) / 0.08;
        aaPx(x, y, rgba, cov);
      }
    }
  }
}

function fillCircle(cx, cy, r, rgba) {
  fillEllipse(cx, cy, r, r, rgba);
}

// Anti-aliased line via supersampling, with rounded caps
function drawLine(x0, y0, x1, y1, thickness, rgba) {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - thickness - 1));
  const maxX = Math.min(SIZE - 1, Math.ceil(Math.max(x0, x1) + thickness + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - thickness - 1));
  const maxY = Math.min(SIZE - 1, Math.ceil(Math.max(y0, y1) + thickness + 1));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let t = lenSq === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const cx = x0 + t * dx;
      const cy = y0 + t * dy;
      const d = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
      const half = thickness / 2;
      if (d <= half - 0.5) setPx(x, y, rgba);
      else if (d <= half + 0.5) aaPx(x, y, rgba, half + 0.5 - d);
    }
  }
}

// Draw a quadratic Bezier curve as a thick stroke (samples + drawLine)
function drawCurve(p0, p1, p2, thickness, rgba, steps = 32) {
  let prev = p0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
    const y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
    drawLine(prev[0], prev[1], x, y, thickness, rgba);
    prev = [x, y];
  }
}

// --- Draw ---
fillRoundedRect(0, 0, SIZE, SIZE, RADIUS, BG);
radialGlow(SIZE / 2, SIZE / 2 + 12, 160, BG_GLOW);

const cx = SIZE / 2;
const bodyCy = SIZE / 2 + 32;   // bug sits lower so antennae have breathing room at top
const headCy = bodyCy - 60;     // head above body

// --- Antennae as clean circuit traces with square L-bend routing ---
// Head -> diagonal up-out -> horizontal -> connector. A single inline
// junction node sits on the diagonal segment to evoke signal routing.
const antennaThickness = 6;
const headTopL = [cx - 10, headCy - 18];
const headTopR = [cx + 10, headCy - 18];
const bendL = [cx - 50, headCy - 48];
const bendR = [cx + 50, headCy - 48];
const tipL = [cx - 80, headCy - 48];
const tipR = [cx + 80, headCy - 48];

// Left antenna: head -> bend -> tip (diagonal then horizontal)
drawLine(headTopL[0], headTopL[1], bendL[0], bendL[1], antennaThickness, WIRE);
drawLine(bendL[0], bendL[1], tipL[0], tipL[1], antennaThickness, WIRE);
// Right antenna: mirror
drawLine(headTopR[0], headTopR[1], bendR[0], bendR[1], antennaThickness, WIRE);
drawLine(bendR[0], bendR[1], tipR[0], tipR[1], antennaThickness, WIRE);

// Inline junction nodes on the diagonal segment — circuit "via" feel.
function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
const jL = lerp(headTopL, bendL, 0.6);
const jR = lerp(headTopR, bendR, 0.6);
fillCircle(jL[0], jL[1], 7, WIRE);
fillCircle(jL[0], jL[1], 3.5, BG);
fillCircle(jR[0], jR[1], 7, WIRE);
fillCircle(jR[0], jR[1], 3.5, BG);

// Connector nodes (the "plugged into AI" part) — large rounded squares
function fillRoundedNode(nx, ny, half, r, fill, outline) {
  fillRoundedRect(nx - half, ny - half, half * 2, half * 2, r, outline);
  fillRoundedRect(nx - half + 3, ny - half + 3, half * 2 - 6, half * 2 - 6, Math.max(0, r - 3), fill);
}
fillRoundedNode(tipL[0], tipL[1], 14, 5, NODE, WIRE);
fillRoundedNode(tipR[0], tipR[1], 14, 5, NODE, WIRE);
// Small inner dot for a "pin" on each connector
fillCircle(tipL[0], tipL[1], 4, BG);
fillCircle(tipR[0], tipR[1], 4, BG);

// --- Body shadow under the bug ---
fillEllipse(cx, bodyCy + 9, 72, 60, BUG_DARK);

// --- Bug body (main ellipse, slightly taller than wide) ---
fillEllipse(cx, bodyCy, 66, 58, BUG);

// Top sheen — narrow lighter band on the upper third
fillEllipse(cx, bodyCy - 22, 46, 14, BUG_HILITE);

// Center seam (vertical line dividing wing-cases)
drawLine(cx, bodyCy - 52, cx, bodyCy + 52, 4, BUG_DARK);

// Ladybug spots — 3 per side, staggered for a more insect-y feel
fillCircle(cx - 30, bodyCy - 14, 9, SPOT);
fillCircle(cx + 30, bodyCy - 14, 9, SPOT);
fillCircle(cx - 20, bodyCy + 14, 8, SPOT);
fillCircle(cx + 20, bodyCy + 14, 8, SPOT);
fillCircle(cx - 12, bodyCy + 38, 6, SPOT);
fillCircle(cx + 12, bodyCy + 38, 6, SPOT);

// --- Head (smaller dark ellipse above body, partly overlapping) ---
fillEllipse(cx, headCy, 26, 22, BUG_DARK);

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
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

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
