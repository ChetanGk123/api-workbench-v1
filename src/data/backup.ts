// Export envelopes and import reading. Pure. A profile export carries one aggregate; a backup carries
// an explicit list of every profile plus the active pointer. Default exports are redacted.
import { isSchema1, migrateV1 } from './migrate';
import { redactAggregate, SCHEMA, utf8Bytes, validateAggregate, type Aggregate, type Diag } from './schema';

export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

export function exportEnvelope(kind: 'profile' | 'backup', aggs: Aggregate[], activeId: string, includeSensitive: boolean): { text: string; redacted: string[] } {
  const redacted: string[] = [];
  const profiles = aggs.map((a) => {
    if (includeSensitive) return a;
    const r = redactAggregate(a);
    redacted.push(...r.fields.map((f) => (aggs.length > 1 ? `${a.profile.name} · ${f}` : f)));
    return r.agg;
  });
  const env = { format: 'api-workbench', kind, schema: SCHEMA, exportedAt: new Date().toISOString(), redacted: !includeSensitive, ...(kind === 'backup' && { activeProfileId: activeId }), profiles };
  return { text: JSON.stringify(env, null, 2), redacted };
}

export interface ImportRead {
  kind: 'profile' | 'backup' | 'schema1';
  aggs: Aggregate[];
  activeId: string;
  notes: string[];
}

export function readImport(text: string): { ok: true; value: ImportRead } | { ok: false; errors: Diag[] } {
  const fail = (message: string, path = ''): { ok: false; errors: Diag[] } => ({ ok: false, errors: [{ path, message }] });
  if (utf8Bytes(text) > IMPORT_MAX_BYTES) return fail(`Input exceeds ${IMPORT_MAX_BYTES / 1024 / 1024} MiB`);
  let x: unknown;
  try { x = JSON.parse(text); } catch (e) { return fail(`Not valid JSON: ${(e as Error).message}`); }
  if (isSchema1(x)) {
    const m = migrateV1(x);
    return m.ok ? { ok: true, value: { kind: 'schema1', aggs: m.value.aggregates, activeId: m.value.activeId, notes: m.value.notes } } : m;
  }
  const o = x as Record<string, unknown>;
  if (!o || typeof o !== 'object' || o.format !== 'api-workbench') return fail('Not an API Workbench export or backup');
  if (typeof o.schema !== 'number' || o.schema > SCHEMA) return fail(`Schema ${String(o.schema)} is newer than this build supports (${SCHEMA}). Nothing was changed.`, 'schema');
  if (o.kind !== 'profile' && o.kind !== 'backup') return fail('Unknown export kind', 'kind');
  if (!Array.isArray(o.profiles) || !o.profiles.length || (o.kind === 'profile' && o.profiles.length !== 1)) return fail('Expected a list of profiles', 'profiles');
  const aggs: Aggregate[] = [];
  const errors: Diag[] = [];
  o.profiles.forEach((p, i) => {
    const r = validateAggregate(p);
    if (r.ok) aggs.push(r.value);
    else errors.push(...r.errors.map((d) => ({ path: `profiles.${i}.${d.path}`, message: d.message })));
  });
  const ids = new Set(aggs.map((a) => a.profile.id));
  if (ids.size !== aggs.length) errors.push({ path: 'profiles', message: 'Two profiles share an ID' });
  const names = new Set(aggs.map((a) => a.profile.name.toLowerCase()));
  if (names.size !== aggs.length) errors.push({ path: 'profiles', message: 'Two profiles share a name' });
  const activeId = o.kind === 'backup' ? String(o.activeProfileId ?? '') : aggs[0]?.profile.id ?? '';
  if (o.kind === 'backup' && !ids.has(activeId)) errors.push({ path: 'activeProfileId', message: 'Active profile is not in the backup' });
  if (errors.length) return { ok: false, errors };
  const notes = o.redacted ? ['Sensitive header values were redacted in this file; affected requests are blocked until you enter them again.'] : [];
  return { ok: true, value: { kind: o.kind, aggs, activeId, notes } };
}
