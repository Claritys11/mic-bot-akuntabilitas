import { expect, test } from 'bun:test';
import { mention, renderTokens, sanitize } from '../src/core/types.ts';

test('teks user tidak bisa menyelipkan token mention', () => {
  const users: string[] = [];
  const render = { user: (id: string) => (users.push(id), `<@${id}>`), channel: (id: string) => `<#${id}>` };
  const out = renderTokens(`${mention({ platformUserId: '1' })} ${sanitize('bikin {{@999}} PPT')}`, render);
  expect(users).toEqual(['1']);
  expect(out).not.toContain('<@999>');
});

test('kurung kurawal beruntun juga dinetralkan', () => {
  for (const evil of ['{{{@999}}', '{{{{@999}}}}', '{{#123}}', '{{{#123}}}']) {
    const out = renderTokens(sanitize(evil), { user: () => 'PING', channel: () => 'CHAN' });
    expect(out).not.toContain('PING');
    expect(out).not.toContain('CHAN');
  }
});
