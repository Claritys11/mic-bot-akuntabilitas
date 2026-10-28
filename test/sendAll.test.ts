import { describe, expect, test } from 'bun:test';
import { sendAll } from '../src/adapters/sendAll.ts';
import { typingDelayMs } from '../src/adapters/typing.ts';
import type { OutgoingMessage } from '../src/core/types.ts';

const to = (channelId: string) => ({ kind: 'channel' as const, channelId });

describe('sendAll — jangan mengklaim yang gagal (QA T9)', () => {
  test('kartu gagal → ucapan "diteruskan" diganti pesan jujur; pesan lain tetap jalan', async () => {
    const sent: string[] = [];
    const sender = { send: async (m: OutgoingMessage) => (m.to.kind === 'channel' && m.to.channelId === 'tim' ? Promise.reject(new Error('400')) : void sent.push(m.text ?? '')) };
    let marked = false;
    await sendAll(
      sender,
      [
        { to: to('tim'), text: 'kartu', afterSend: async () => void (marked = true) },
        { to: to('kas'), text: 'udah aku terusin', onlyIfPreviousSent: true, elseText: 'maaf, belum bisa diteruskan' },
        { to: to('kas'), text: 'pesan lain' },
      ],
      'test',
    );
    expect(sent).toEqual(['maaf, belum bisa diteruskan', 'pesan lain']);
    expect(marked).toBe(false);
  });
  test('kartu berhasil → afterSend dipanggil, ucapan terkirim', async () => {
    const sent: string[] = [];
    let marked = false;
    await sendAll({ send: async (m) => void sent.push(m.text ?? '') }, [
      { to: to('tim'), text: 'kartu', afterSend: async () => void (marked = true) },
      { to: to('kas'), text: 'udah aku terusin', onlyIfPreviousSent: true },
    ], 'test');
    expect(sent).toEqual(['kartu', 'udah aku terusin']);
    expect(marked).toBe(true);
  });
});

describe('indikator mengetik', () => {
  test('jeda sebanding panjang balasan, dibatasi, dan dikurangi waktu berpikir', () => {
    expect(typingDelayMs('ok')).toBe(600);
    expect(typingDelayMs('x'.repeat(100))).toBe(1200);
    expect(typingDelayMs('x'.repeat(1000))).toBe(2500);
    expect(typingDelayMs('x'.repeat(100), 5000)).toBe(0);
  });
  test('beforeSend dipanggil sebelum tiap pesan; gagalnya tidak menggagalkan pesan', async () => {
    const log: string[] = [];
    await sendAll({ send: async (m) => void log.push(`kirim ${m.text}`) }, [{ to: to('a'), text: '1' }, { to: to('a'), text: '2' }], 'test', {
      beforeSend: async (m) => {
        log.push(`ketik ${m.text}`);
        if (m.text === '2') throw new Error('typing gagal');
      },
    });
    expect(log).toEqual(['ketik 1', 'kirim 1', 'ketik 2', 'kirim 2']);
  });
});
