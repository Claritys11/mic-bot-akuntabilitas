import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { LLMEndpoint } from '../src/config.ts';
import { OpenRouterProvider } from '../src/llm/openrouter.ts';
import { parseJson } from '../src/llm/provider.ts';

describe('parseJson', () => {
  const S = z.object({ tanggal: z.string(), nominal: z.number() });
  test('kunci berspasi dirapikan', () => {
    expect(parseJson(S, '```json\n{" tanggal ": "2026-10-22", "nominal": 10000}\n```')).toEqual({ tanggal: '2026-10-22', nominal: 10000 });
  });
  test('JSON rusak → null, bukan crash', () => {
    expect(parseJson(S, 'maaf saya tidak bisa')).toBeNull();
  });
});

describe('fallback model × key', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function mockFetch(handler: (model: string, key: string) => Response) {
    const calls: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model as string;
      const key = String((init.headers as Record<string, string>).Authorization).replace('Bearer ', '');
      calls.push(`${model}|${key}`);
      return handler(model, key);
    }) as typeof fetch;
    return calls;
  }
  const ok = (content: string) => Response.json({ choices: [{ message: { content } }] });
  const err = (status: number) => Response.json({ error: { message: 'x' } }, { status });
  const ep: LLMEndpoint = { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k1', backupApiKey: 'k2', model: 'paid, free' };
  const provider = () => new OpenRouterProvider(ep, ep, true, 5000);

  test('key utama limit → key cadangan', async () => {
    const calls = mockFetch((_m, k) => (k === 'k1' ? err(403) : ok('{}')));
    expect(await provider().chat([{ role: 'user', content: 'hi' }])).toBe('{}');
    expect(calls).toEqual(['paid|k1', 'paid|k2']);
  });

  test('semua key ditolak di model berbayar → model berikutnya; lalu diistirahatkan', async () => {
    const calls = mockFetch((m) => (m === 'paid' ? err(403) : ok('{}')));
    const p = provider();
    await p.chat([{ role: 'user', content: 'a' }]);
    await p.chat([{ role: 'user', content: 'b' }]);
    expect(calls).toEqual(['paid|k1', 'paid|k2', 'free|k1', 'free|k1']);
  });

  test('respons kosong sesaat → dicoba ulang sekali di key yang sama dulu', async () => {
    let n = 0;
    const calls = mockFetch(() => (++n === 1 ? ok('') : ok('{"a":1}')));
    expect(await provider().chat([{ role: 'user', content: 'hi' }])).toBe('{"a":1}');
    expect(calls).toEqual(['paid|k1', 'paid|k1']);
  });

  test('kosong terus → pindah key, tidak mengulang tanpa batas', async () => {
    const calls = mockFetch(() => ok(''));
    expect(provider().chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('kosong');
    await Bun.sleep(5);
    expect(calls).toEqual(['paid|k1', 'paid|k1', 'paid|k2', 'paid|k2', 'free|k1', 'free|k1', 'free|k2', 'free|k2']);
  });

  test('semua gagal → lempar error (pemanggil yang menangani)', async () => {
    mockFetch(() => err(500));
    expect(provider().chat([{ role: 'user', content: 'a' }])).rejects.toThrow('LLM HTTP 500');
  });
});
