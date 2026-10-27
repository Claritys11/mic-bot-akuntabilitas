import { describe, expect, test } from 'bun:test';
import { sendAll } from '../src/adapters/sendAll.ts';
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
