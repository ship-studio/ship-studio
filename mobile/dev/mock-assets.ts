/**
 * Files for the mock Mac to hand out, drawn here rather than checked in: a
 * preview "screenshot" of a site, an icon sheet, and a one-page PDF. Enough
 * to see thumbnails, the image viewer and Quick Look on a simulator.
 */

import { deflateSync } from 'node:zlib';

type RGB = [number, number, number];
type Rect = { x: number; y: number; w: number; h: number; color: RGB; r?: number };

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A PNG of rounded rectangles on a background. */
export function png(width: number, height: number, bg: RGB, rects: Rect[]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      let c = bg;
      for (const r of rects) if (inside(r, x, y)) c = r.color;
      raw.set(c, row + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inside({ x, y, w, h, r = 0 }: Rect, px: number, py: number): boolean {
  if (px < x || py < y || px >= x + w || py >= y + h) return false;
  if (!r) return true;
  const cx = px < x + r ? x + r : px >= x + w - r ? x + w - r - 1 : px;
  const cy = py < y + r ? y + r : py >= y + h - r ? y + h - r - 1 : py;
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

/** A landing page as the preview would photograph it, at phone width. */
export function siteScreenshot(): Buffer {
  const W = 390;
  const ink: RGB = [17, 17, 17];
  const soft: RGB = [226, 226, 230];
  const blue: RGB = [77, 143, 245];
  return png(
    W,
    760,
    [250, 250, 250],
    [
      { x: 0, y: 0, w: W, h: 64, color: [255, 255, 255] },
      { x: 20, y: 22, w: 84, h: 20, color: ink, r: 4 },
      { x: 318, y: 20, w: 52, h: 24, color: blue, r: 12 },
      { x: 20, y: 112, w: 300, h: 34, color: ink, r: 6 },
      { x: 20, y: 156, w: 230, h: 34, color: ink, r: 6 },
      { x: 20, y: 214, w: 330, h: 12, color: [150, 150, 156], r: 6 },
      { x: 20, y: 236, w: 280, h: 12, color: [150, 150, 156], r: 6 },
      { x: 20, y: 276, w: 150, h: 46, color: blue, r: 10 },
      { x: 180, y: 276, w: 120, h: 46, color: soft, r: 10 },
      { x: 20, y: 360, w: W - 40, h: 210, color: [232, 238, 252], r: 16 },
      { x: 48, y: 392, w: 140, h: 140, color: [196, 214, 250], r: 70 },
      { x: 210, y: 410, w: 140, h: 14, color: [160, 182, 230], r: 7 },
      { x: 210, y: 436, w: 110, h: 14, color: [160, 182, 230], r: 7 },
      { x: 20, y: 600, w: 170, h: 130, color: soft, r: 14 },
      { x: 200, y: 600, w: 170, h: 130, color: soft, r: 14 },
    ]
  );
}

/** A sheet of icons, as a design agent might export them. */
export function iconSheet(): Buffer {
  const tints: RGB[] = [
    [148, 113, 245],
    [77, 143, 245],
    [63, 191, 106],
    [233, 168, 58],
    [239, 91, 80],
    [47, 179, 161],
  ];
  const rects: Rect[] = [];
  for (let i = 0; i < 12; i++) {
    const col = i % 4;
    const row = Math.floor(i / 4);
    rects.push({
      x: 24 + col * 96,
      y: 24 + row * 96,
      w: 72,
      h: 72,
      color: tints[i % tints.length],
      r: i % 3 === 0 ? 36 : 16,
    });
  }
  return png(408, 312, [24, 24, 27], rects);
}

/** A one-page PDF with a few lines of text. */
export function pdf(title: string, lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const text = [
    'BT /F1 22 Tf 56 760 Td',
    `(${esc(title)}) Tj`,
    '/F1 12 Tf 0 -36 Td',
    ...lines.map((l) => `(${esc(l)}) Tj 0 -20 Td`),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'binary');
}
