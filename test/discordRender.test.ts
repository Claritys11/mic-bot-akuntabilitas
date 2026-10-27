import { describe, expect, test } from 'bun:test';
import { renderBody, renderText } from '../src/adapters/discord/render.ts';
import { mention } from '../src/core/types.ts';

describe('render Discord', () => {
  test('orang yang sama disebut dua kali → allowed_mentions tanpa duplikat (bug QA: kartu kas tidak terkirim)', () => {
    const t = `Ada bukti kas baru dari ${mention({ platformUserId: '42' })} 🧾 ${mention({ platformUserId: '42' })}`;
    expect(renderText(t).users).toEqual(['42']);
    expect(renderBody({ text: t, card: { title: 'x', fields: [{ name: 'Dari', value: mention({ platformUserId: '42' }) }] } }).allowedMentions.users).toEqual(['42']);
  });
});
