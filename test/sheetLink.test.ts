import { describe, expect, test } from 'bun:test';
import { linkSteps, ownerStillAllowed, startButton } from '../src/core/kas/sheetLink.ts';
import type { GroupDoc } from '../src/db/models.ts';

const group = (kas: Record<string, unknown>, roles: Record<string, string[]> = {}) => ({ roles: { ketua: [], bendahara: [], sekretaris: [], ...roles }, kas: { reviewerIds: [], ...kas } }) as unknown as GroupDoc;

describe('laporan kas dibuat bot', () => {
  test('langkah login: link, kode, masa berlaku, dan peringatan jangan dibagikan', () => {
    const t = linkSteps('ABCD-EFGH', 'https://www.google.com/device', 30);
    expect(t).toContain('https://www.google.com/device');
    expect(t).toContain('**ABCD-EFGH**');
    expect(t).toContain('30 menit');
    expect(t).toMatch(/jangan bagikan/i);
  });

  test('tombol membawa ID kelas (tombol di DM tidak punya konteks server)', () => {
    expect(startButton('123').id).toBe('k:gs:start:123');
  });

  test('pemilik sheet bukan pengurus kas lagi → bot berhenti menulis ke Drive-nya', () => {
    const owned = { sheetAuth: 'v1.x', sheetOwnerId: 'budi', sheetOwnerAdmin: false };
    expect(ownerStillAllowed(group(owned, { bendahara: ['budi'] }))).toBe(true);
    expect(ownerStillAllowed(group({ ...owned, reviewerIds: ['budi'] }))).toBe(true);
    expect(ownerStillAllowed(group(owned, { bendahara: ['sari'] }))).toBe(false);
    // Admin server yang membuat → tetap boleh.
    expect(ownerStillAllowed(group({ ...owned, sheetOwnerAdmin: true }))).toBe(true);
    // Sheet manual (akun layanan) tidak terikat pemilik.
    expect(ownerStillAllowed(group({ sheetAuth: null, sheetOwnerId: null }))).toBe(true);
  });
});
