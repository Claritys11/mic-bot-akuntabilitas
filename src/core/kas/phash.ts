import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

// Perceptual hash (dHash 64-bit) untuk mengenali bukti transfer yang sama walau di-screenshot ulang,
// dikompres ulang (WhatsApp), atau diubah ukurannya — hal yang lolos dari SHA-256. Crop besar atau
// editan tetap bisa lolos; itu sebabnya refId duplikat & persetujuan bendahara tetap dipakai.

interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

const MAX_PIXELS = 40_000_000;

function decode(data: Uint8Array): Rgba | null {
  if (data[0] === 0xff && data[1] === 0xd8) {
    const img = jpeg.decode(data, { useTArray: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 512 });
    return { width: img.width, height: img.height, data: img.data };
  }
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    const img = PNG.sync.read(Buffer.from(data));
    if (img.width * img.height > MAX_PIXELS) return null;
    return { width: img.width, height: img.height, data: img.data };
  }
  return null; // WebP dll. belum didukung → hanya SHA-256
}

/** Rata-rata kecerahan per sel grid w×h (area averaging, aman untuk gambar besar). */
function grayGrid(img: Rgba, w: number, h: number): number[] {
  const sum = new Float64Array(w * h);
  const count = new Uint32Array(w * h);
  for (let y = 0; y < img.height; y++) {
    const gy = Math.min(h - 1, Math.floor((y * h) / img.height));
    for (let x = 0; x < img.width; x++) {
      const gx = Math.min(w - 1, Math.floor((x * w) / img.width));
      const i = (y * img.width + x) * 4;
      sum[gy * w + gx]! += 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
      count[gy * w + gx]! += 1;
    }
  }
  return Array.from(sum, (s, i) => s / Math.max(1, count[i]!));
}

/** dHash: tiap bit = apakah sel kiri lebih terang dari kanannya, di grid 9×8 → 64 bit (16 hex). */
export function dHash(img: Rgba): string {
  const g = grayGrid(img, 9, 8);
  let hex = '';
  for (let row = 0; row < 8; row++) {
    let nibble = 0;
    for (let col = 0; col < 8; col++) {
      nibble = (nibble << 1) | (g[row * 9 + col]! > g[row * 9 + col + 1]! ? 1 : 0);
      if (col % 4 === 3) {
        hex += nibble.toString(16);
        nibble = 0;
      }
    }
  }
  return hex;
}

export function perceptualHash(data: Uint8Array): string | null {
  try {
    const img = decode(data);
    return img && img.width >= 9 && img.height >= 8 ? dHash(img) : null;
  } catch {
    return null;
  }
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d + Math.abs(a.length - b.length) * 4;
}

/** Jarak ≤ ini dianggap gambar yang sama (dari 64 bit). */
export const SIMILAR_MAX_DISTANCE = 6;
