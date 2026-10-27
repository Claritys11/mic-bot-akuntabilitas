import { createHash } from 'node:crypto';
import { GroupModel, type GroupDoc, type OpportunityDoc } from '../../db/models.ts';

// Katalog sumber info lomba/beasiswa. Bawaan dikurasi operator bot (tinggal dinyalakan/dimatikan per kelas);
// kelas boleh menambah sumber sendiri (RSS/Atom) — isinya HANYA untuk kelas itu.

export interface LombaSource {
  id: string;
  name: string;
  url: string;
  desc: string;
}

/** Sumber bawaan (feed yang sudah dicek bisa dibaca). Tambahan dari env LOMBA_FEEDS ikut masuk katalog. */
export const BUILTIN_SOURCES: LombaSource[] = [
  { id: 'lombasma', name: 'LombaSMA', url: 'https://www.lombasma.com/feed', desc: 'Info lomba & olimpiade tingkat SMA/SMK' },
  { id: 'indbeasiswa', name: 'IndBeasiswa', url: 'https://www.indbeasiswa.com/feed', desc: 'Info beasiswa (disaring yang untuk SMA/SMK)' },
];

export const MAX_CUSTOM_SOURCES = 5;

export const customSourceId = (url: string) => `custom-${createHash('sha256').update(url).digest('hex').slice(0, 10)}`;

export function catalog(envFeeds: string[] = []): LombaSource[] {
  const known = new Set(BUILTIN_SOURCES.map((s) => s.url));
  const extra = envFeeds
    .filter((u) => !known.has(u))
    .map((url) => ({ id: `env-${createHash('sha256').update(url).digest('hex').slice(0, 8)}`, name: new URL(url).hostname.replace(/^www\./, ''), url, desc: 'Sumber tambahan operator bot' }));
  return [...BUILTIN_SOURCES, ...extra];
}

type SourcePrefs = Pick<GroupDoc, 'lombaSources'>;

export const isEnabled = (g: SourcePrefs, sourceId: string) => !(g.lombaSources?.disabled ?? []).includes(sourceId);

/** Info lomba yang boleh dilihat kelas ini: tambahan kelas sendiri, atau global dari sumber yang dinyalakan. */
export function visibleTo(g: SourcePrefs & Pick<GroupDoc, 'groupId'>, o: Pick<OpportunityDoc, 'groupId' | 'sourceId'>): boolean {
  if (o.groupId != null) return o.groupId === g.groupId;
  return !o.sourceId || isEnabled(g, o.sourceId);
}

export interface FeedTarget {
  url: string;
  sourceId: string;
  /** null = info global (sumber katalog); selain itu khusus kelas yang menambahkan sumbernya. */
  groupId: string | null;
}

/** Feed yang perlu dibaca: katalog yang dinyalakan minimal satu kelas + sumber custom tiap kelas. */
export async function feedTargets(all: LombaSource[], onlyGroupId?: string): Promise<FeedTarget[]> {
  const groups = await GroupModel.find(onlyGroupId ? { groupId: onlyGroupId } : {}, { groupId: 1, lombaSources: 1 }).lean<Pick<GroupDoc, 'groupId' | 'lombaSources'>[]>();
  const out: FeedTarget[] = [];
  for (const s of all) if (!groups.length || groups.some((g) => isEnabled(g, s.id))) out.push({ url: s.url, sourceId: s.id, groupId: null });
  for (const g of groups) for (const c of g.lombaSources?.custom ?? []) if (c.url && c.id) out.push({ url: c.url, sourceId: c.id, groupId: g.groupId });
  return out;
}
