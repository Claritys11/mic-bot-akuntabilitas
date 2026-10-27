import { describe, expect, test } from 'bun:test';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { hamming, perceptualHash, SIMILAR_MAX_DISTANCE } from '../src/core/kas/phash.ts';

// Gambar sintetis mirip struk transfer: latar terang, blok-blok "teks" gelap di posisi acak (seed tetap).
function receipt(seed: number, w = 360, h = 720): Uint8Array {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const px = new Uint8Array(w * h * 4).fill(245);
  for (let b = 0; b < 40; b++) {
    const bx = Math.floor(rnd() * (w - 80)), by = Math.floor(rnd() * (h - 20));
    const bw = 20 + Math.floor(rnd() * 120), bh = 6 + Math.floor(rnd() * 16), c = Math.floor(rnd() * 120);
    for (let y = by; y < Math.min(h, by + bh); y++) for (let x = bx; x < Math.min(w, bx + bw); x++) px.fill(c, (y * w + x) * 4, (y * w + x) * 4 + 3);
  }
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  return px;
}

const asPng = (px: Uint8Array, w: number, h: number) => {
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(px);
  return new Uint8Array(PNG.sync.write(png));
};
const asJpeg = (px: Uint8Array, w: number, h: number, q: number) => new Uint8Array(jpeg.encode({ data: px, width: w, height: h }, q).data);
function resize(px: Uint8Array, w: number, h: number, nw: number, nh: number) {
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const sx = Math.floor((x * w) / nw), sy = Math.floor((y * h) / nh);
    out.set(px.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * nw + x) * 4);
  }
  return out;
}
function crop(px: Uint8Array, w: number, h: number, m: number) {
  const nw = w - 2 * m, nh = h - 2 * m, out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) out.set(px.subarray(((y + m) * w + m) * 4, ((y + m) * w + m + nw) * 4), y * nw * 4);
  return { out, nw, nh };
}

describe('perceptual hash bukti transfer', () => {
  const W = 360, H = 720;
  const base = receipt(7);
  const original = perceptualHash(asPng(base, W, H))!;

  test('PNG asli menghasilkan hash 64-bit', () => {
    expect(original).toMatch(/^[0-9a-f]{16}$/);
  });
  test('dikompres ulang jadi JPEG (seperti lewat WhatsApp) tetap dianggap sama', () => {
    expect(hamming(original, perceptualHash(asJpeg(base, W, H, 40))!)).toBeLessThanOrEqual(SIMILAR_MAX_DISTANCE);
  });
  test('di-screenshot ulang dengan ukuran berbeda tetap dianggap sama', () => {
    const small = resize(base, W, H, 540, 1080);
    expect(hamming(original, perceptualHash(asJpeg(small, 540, 1080, 80))!)).toBeLessThanOrEqual(SIMILAR_MAX_DISTANCE);
  });
  test('crop tipis di pinggir tetap dianggap sama', () => {
    const { out, nw, nh } = crop(base, W, H, 6);
    expect(hamming(original, perceptualHash(asPng(out, nw, nh))!)).toBeLessThanOrEqual(SIMILAR_MAX_DISTANCE);
  });
  test('bukti lain dianggap berbeda', () => {
    for (const seed of [8, 99, 1234]) expect(hamming(original, perceptualHash(asPng(receipt(seed), W, H))!)).toBeGreaterThan(SIMILAR_MAX_DISTANCE);
  });
  test('PNG raksasa (dari header) ditolak sebelum di-decode', () => {
    const png = asPng(receipt(1, 16, 16), 16, 16);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    view.setUint32(16, 100_000);
    view.setUint32(20, 100_000);
    expect(perceptualHash(png)).toBeNull();
  });
  test('format tidak dikenal / rusak → null, tidak crash', () => {
    expect(perceptualHash(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
    expect(perceptualHash(new Uint8Array([0xff, 0xd8, 0, 0]))).toBeNull();
  });
});
