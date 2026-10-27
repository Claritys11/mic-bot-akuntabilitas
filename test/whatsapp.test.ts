import { describe, expect, test } from 'bun:test';
import { platformOf } from '../src/adapters/router.ts';
import { helpText, matchChoice, parseCommand, parseFormReply, renderBodyWa, renderFormWa, toWaMarkdown } from '../src/adapters/whatsapp/format.ts';
import { COMMANDS } from '../src/core/commands.ts';
import { channelRef, mention } from '../src/core/types.ts';

const ANI = '6281111111111@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';

describe('render ke WhatsApp', () => {
  test('markdown Discord → WhatsApp', () => {
    expect(toWaMarkdown('**XI RPL** dan __miring__')).toBe('*XI RPL* dan _miring_');
  });

  test('mention jadi @nomor + daftar JID untuk tag sungguhan', () => {
    const r = renderBodyWa({ text: `jadi gak ${mention({ platformUserId: ANI })}? kirim di ${channelRef(GROUP)}` });
    expect(r.text).toBe('jadi gak @6281111111111? kirim di grup ini');
    expect(r.mentions).toEqual([ANI]);
  });

  test('kartu + tombol jadi teks bernomor', () => {
    const r = renderBodyWa({
      card: { title: 'Kas tercatat', description: 'Makasih', fields: [{ name: 'Nominal', value: 'Rp10.000' }], footer: 'catatan' },
      actions: [
        { id: 'p:ok:1', label: '✅ Jadi, catat!', kind: 'success' },
        { id: 'p:no:1', label: '❌ Ga jadi', kind: 'danger' },
      ],
    });
    expect(r.text).toContain('*Kas tercatat*');
    expect(r.text).toContain('• *Nominal:* Rp10.000');
    expect(r.text).toContain('1️⃣ ✅ Jadi, catat!');
    expect(r.text).toContain('2️⃣ ❌ Ga jadi');
  });

  test('tidak pernah menghasilkan mention massal', () => {
    const r = renderBodyWa({ text: '@everyone halo' });
    expect(r.mentions).toEqual([]);
  });
});

describe('balasan pilihan', () => {
  const actions = [{ label: '✅ Jadi, catat!' }, { label: '✏️ Ubah' }, { label: '❌ Ga jadi' }];
  test.each([
    ['1', 0],
    [' 2. ', 1],
    ['pilih 3', 2],
    ['3️⃣', 2],
    ['ga jadi', 2],
    ['4', null],
    ['0', null],
    ['aku yang bikin 2 slide', null],
  ])('%p → %p', (text, want) => {
    expect(matchChoice(text, actions)).toBe(want);
  });
});

describe('form lewat balasan', () => {
  const fields = [
    { id: 'task', label: 'Tugas', required: true },
    { id: 'deadline', label: 'Deadline (mis. Jumat 20.00)' },
  ];
  test('template berisi nilai awal', () => {
    const t = renderFormWa({ id: 'pf:edit:1', title: 'Ubah janji', fields: [{ id: 'task', label: 'Tugas', value: 'bikin PPT' }] });
    expect(t).toContain('Tugas: bikin PPT');
  });
  test('baca "Label: isi", label boleh disingkat', () => {
    expect(parseFormReply('Tugas: bikin poster\ndeadline: senin 19.00', fields)).toEqual({ task: 'bikin poster', deadline: 'senin 19.00' });
  });
  test('field wajib kosong → null', () => {
    expect(parseFormReply('deadline: senin', fields)).toBeNull();
  });
  test('form satu field boleh dibalas isinya saja', () => {
    expect(parseFormReply('25000', [{ id: 'nominal', label: 'Nominal', required: true }])).toEqual({ nominal: '25000' });
  });
});

describe('perintah teks', () => {
  test('subcommand + opsi boolean', () => {
    expect(parseCommand('/janji list punyaku:ya', COMMANDS)).toEqual({ name: 'janji.list', options: { punyaku: true } });
  });
  test('argumen posisi', () => {
    expect(parseCommand('/kas atur 10.000 bulanan', COMMANDS)).toEqual({ name: 'kas.atur', options: { nominal: 10000, periode: 'bulanan' } });
    expect(parseCommand('/rangkum 3', COMMANDS)).toEqual({ name: 'rangkum', options: { jam: 3 } });
  });
  test('opsi user dari mention', () => {
    const r = parseCommand('/kas atur 5000 mingguan bendahara:@6281111111111', COMMANDS, (t) => (t === '@6281111111111' ? ANI : undefined));
    expect(r).toEqual({ name: 'kas.atur', options: { nominal: 5000, periode: 'mingguan', bendahara: ANI } });
  });
  test('kutip untuk teks berspasi', () => {
    expect(parseCommand('/setup kelas:"XI RPL 2" jurusan:RPL', COMMANDS)).toEqual({ name: 'setup', options: { kelas: 'XI RPL 2', jurusan: 'RPL' } });
  });
  test('kesalahan dijelaskan', () => {
    expect(parseCommand('/kas atur', COMMANDS)).toMatchObject({ error: expect.stringContaining('nominal') });
    expect(parseCommand('/kas atur 5000 harian', COMMANDS)).toMatchObject({ error: expect.stringContaining('mingguan') });
    expect(parseCommand('/kas', COMMANDS)).toMatchObject({ error: expect.stringContaining('/kas rekap') });
  });
  test('bukan perintah → null (diperlakukan obrolan)', () => {
    expect(parseCommand('aku yang bikin PPT', COMMANDS)).toBeNull();
    expect(parseCommand('/apaini', COMMANDS)).toBeNull();
    expect(parseCommand('dan/atau', COMMANDS)).toBeNull();
  });
  test('bantuan menyebut semua perintah', () => {
    const h = helpText(COMMANDS);
    for (const c of COMMANDS) expect(h).toContain(`/${c.name}`);
  });
});

describe('router pengirim', () => {
  test('channel WhatsApp vs Discord, DM ikut platform anggota', () => {
    expect(platformOf({ to: { kind: 'channel', channelId: GROUP } })).toBe('whatsapp');
    expect(platformOf({ to: { kind: 'channel', channelId: '1562960561786978374' } })).toBe('discord');
    expect(platformOf({ to: { kind: 'dm', member: { platform: 'whatsapp', platformUserId: ANI, groupId: GROUP, displayName: 'Ani' }, fallbackChannelId: GROUP } })).toBe('whatsapp');
  });
});
