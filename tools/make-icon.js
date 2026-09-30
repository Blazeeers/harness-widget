'use strict';

// Генерирует assets/icon.png (32x32) для трея без внешних зависимостей.
// Рисуем «H» на скруглённом квадрате с вертикальным градиентом.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 32;
const RADIUS = 7;

function inRoundedRect(x, y, size, radius) {
  const r = radius;
  if (x >= r && x < size - r) return true;
  if (y >= r && y < size - r) return true;
  const cx = x < r ? r : size - r - 1;
  const cy = y < r ? r : size - r - 1;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Буква H: две стойки и перекладина.
function inLetterH(x, y) {
  const top = 9;
  const bottom = 23;
  const leftX = 10;
  const rightX = 21;
  const barY = 14;
  if (y < top || y > bottom) return false;
  const isStem = (x >= leftX && x <= leftX + 2) || (x >= rightX - 1 && x <= rightX + 1);
  const isBar = y >= barY && y <= barY + 2 && x > leftX && x < rightX + 1;
  return isStem || isBar;
}

// Точка состояния в правом нижнем углу: агент работает (янтарная) или ответил
// (зелёная). У обычной иконки точки нет.
function inStatusDot(x, y) {
  const cx = 25;
  const cy = 25;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= 12; // радиус ~3.5 px
}

function renderPixels(variant = 'idle') {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  let offset = 0;
  for (let y = 0; y < SIZE; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < SIZE; x += 1) {
      const inside = inRoundedRect(x, y, SIZE, RADIUS);
      const t = y / (SIZE - 1);
      let r = Math.round(38 + (91 - 38) * t);
      let g = Math.round(102 + (140 - 102) * t);
      let b = Math.round(255 + (255 - 255) * t);
      let a = 255;

      if (!inside) {
        a = 0;
      } else if (inLetterH(x, y)) {
        r = 255; g = 255; b = 255;
      }

      if (variant !== 'idle' && inside && inStatusDot(x, y)) {
        if (variant === 'done') {
          r = 74; g = 222; b = 128;
        } else {
          r = 255; g = 179; b = 71;
        }
        g = variant === 'done' ? 222 : g;
        a = 255;
      }

      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
      offset += 4;
    }
  }
  return raw;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function buildPng(variant = 'idle') {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace
  const idat = zlib.deflateSync(renderPixels(variant), { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
for (const [variant, file] of [['idle', 'icon.png'], ['busy', 'icon-busy.png'], ['done', 'icon-done.png']]) {
  const outFile = path.join(outDir, file);
  fs.writeFileSync(outFile, buildPng(variant));
  console.log('icon written:', outFile);
}

