#!/usr/bin/env node
// Generates simple PNG icons for the extension.
// Run: node scripts/generate-icons.js
// Requires: npm install canvas (or use the system Node canvas if available)
// Fallback: creates minimal valid PNG files without canvas.

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'icons');

// Minimal PNG encoder (no dependencies)
// Creates a solid rounded-rect icon with a leaf-like "F" letter
function createPNG(size) {
  const { createCanvas } = (() => {
    try { return require('canvas'); } catch { return null; }
  })() ?? {};

  if (createCanvas) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const r = size * 0.18;

    // Background
    ctx.fillStyle = '#18181b';
    roundRect(ctx, 0, 0, size, size, r);
    ctx.fill();

    // Green accent circle
    ctx.fillStyle = '#4ade80';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.3, 0, Math.PI * 2);
    ctx.fill();

    // Letter F
    ctx.fillStyle = '#141414';
    ctx.font = `bold ${size * 0.46}px -apple-system,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('F', size / 2 + size * 0.02, size / 2 + size * 0.03);

    return canvas.toBuffer('image/png');
  }

  // Fallback: write a minimal 1×1 green PNG
  return minimalPNG(size, 0x4a, 0xde, 0x80);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Minimal valid NxN solid-color PNG without external deps
function minimalPNG(size, r, g, b) {
  const zlib = require('zlib');

  const width = size;
  const height = size;
  // Raw image data: filter byte (0) + RGBA per pixel
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOff = y * (1 + width * 4);
    raw[rowOff] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const off = rowOff + 1 + x * 4;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = 255;
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  function crc32(buf) {
    const table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
      }
      return t;
    })();
    let crc = 0xffffffff;
    for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // bit depth 8, color type 2 (RGB)... actually 6 for RGBA
  ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const size of [16, 48, 128]) {
  const buf = createPNG(size);
  const outPath = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(outPath, buf);
  console.log(`Created ${outPath} (${buf.length} bytes)`);
}
