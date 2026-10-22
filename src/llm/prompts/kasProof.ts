export function kasProofPrompt(nowWIB: string): string {
  return `Ini gambar (mungkin) bukti transfer bank/e-wallet Indonesia. Ekstrak datanya.
Balas HANYA JSON valid:
{"isTransferProof": boolean, "nominal": number|null, "tanggal": "YYYY-MM-DD"|null, "bank": string|null, "pengirim": string|null, "penerima": string|null, "refId": string|null}

- nominal dalam rupiah, angka bulat tanpa titik (Rp25.000 → 25000).
- refId: nomor referensi/ID transaksi kalau terlihat.
- Jangan menebak; isi null kalau tidak terbaca.
Sekarang: ${nowWIB}.`;
}
