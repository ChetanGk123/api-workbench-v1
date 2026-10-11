// Durable storage (IndexedDB `api-workbench-v2`) and the session that owns the live profile.
// One aggregate per profile is one record, so one transaction never leaves half-remapped links.
// Ordinary edits are live first and saved after (Unsaved until the latest revision lands);
// imports, restore, profile create/delete and Promote are durable first: success only after commit.
import { copyAggregate, defaultProfile, validateAggregate, type Aggregate, type Diag } from './schema';

const DB = 'api-workbench-v2';
const DB_VERSION = 2;
const ACTIVE = 'activeProfile';

export class Conflict extends Error {}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

let conn: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  conn ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB, DB_VERSION);
    r.onupgradeneeded = () => {
      for (const name of ['profiles', 'metadata', 'recorderDrafts']) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); conn = null; };
      resolve(db);
    };
    r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'));
    r.onblocked = () => reject(new Error('IndexedDB is blocked by another open version'));
  }).catch((e) => { conn = null; throw e; });
  return conn;
}

/** One readwrite/readonly transaction over both stores; resolves only when it commits. */
async function tx<T>(mode: IDBTransactionMode, fn: (p: IDBObjectStore, m: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await open();
  const t = db.transaction(['profiles', 'metadata'], mode);
  const committed = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
  });
  let out: T;
  try {
    out = await fn(t.objectStore('profiles'), t.objectStore('metadata'));
  } catch (e) {
    try { t.abort(); } catch { /* already finished */ }
    await committed.catch(() => {});
    throw e;
  }
  await committed;
  return out;
}

export const store = {
  async load(): Promise<{ aggs: unknown[]; activeId: unknown }> {
    return tx('readonly', async (p, m) => ({ aggs: await req(p.getAll()), activeId: await req(m.get(ACTIVE)) }));
  },
  /** Compare-and-set on the stored revision: a write from a stale tab or stale edit is refused. */
  async put(agg: Aggregate, expected: number | null, activate = false): Promise<number> {
    return tx('readwrite', async (p, m) => {
      const cur = (await req(p.get(agg.profile.id))) as Aggregate | undefined;
      if (expected !== null && (cur?.revision ?? 0) !== expected) throw new Conflict(`Stored revision is ${cur?.revision ?? 0}, this tab expected ${expected}`);
      const revision = (cur?.revision ?? 0) + 1;
      p.put({ ...agg, revision }, agg.profile.id);
      if (activate) m.put(agg.profile.id, ACTIVE);
      return revision;
    });
  },
  /**
   * Replace the listed profiles (or every profile) and the active pointer in one transaction.
   * `expect` maps profile ID → stored revision the caller based its change on (0 = must not exist yet).
   */
  async replace(aggs: Aggregate[], activeId: string, remove: string[] | 'all', expect: Record<string, number> = {}): Promise<Aggregate[]> {
    return tx('readwrite', async (p, m) => {
      for (const [id, rev] of Object.entries(expect)) {
        const cur = (await req(p.get(id))) as Aggregate | undefined;
        if ((cur?.revision ?? 0) !== rev) throw new Conflict(`Profile changed since the review (stored revision ${cur?.revision ?? 0}, review expected ${rev})`);
      }
      if (remove === 'all') p.clear();
      else for (const id of remove) p.delete(id);
      const out: Aggregate[] = [];
      for (const a of aggs) {
        const cur = remove === 'all' ? undefined : ((await req(p.get(a.profile.id))) as Aggregate | undefined);
        const next = { ...a, revision: (cur?.revision ?? 0) + 1 };
        p.put(next, a.profile.id);
        out.push(next);
      }
      m.put(activeId, ACTIVE);
      return out;
    });
  },
  async setActive(id: string): Promise<void> {
    await tx('readwrite', async (_p, m) => { m.put(id, ACTIVE); });
  },
};

/** Recorder recovery: one bounded draft for this origin (the database is per origin). */
export const recovery = {
  async get(): Promise<unknown> {
    const db = await open();
    return req(db.transaction('recorderDrafts', 'readonly').objectStore('recorderDrafts').get('draft'));
  },
  async put(value: unknown | null): Promise<void> {
    const db = await open();
    const t = db.transaction('recorderDrafts', 'readwrite');
    const done = new Promise<void>((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction failed')); });
    if (value === null) t.objectStore('recorderDrafts').delete('draft'); else t.objectStore('recorderDrafts').put(value, 'draft');
    await done;
  },
};

/** Read the schema 1 record for this origin without creating or changing the old database. */
export function readV1(origin: string): Promise<unknown | null> {
  return new Promise((resolve) => {
    let r: IDBOpenDBRequest;
    try { r = indexedDB.open('api-workbench'); } catch { return resolve(null); }
    r.onupgradeneeded = () => r.transaction?.abort(); // it did not exist: do not create it
    r.onerror = () => resolve(null);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('configs')) { db.close(); return resolve(null); }
      const g = db.transaction('configs', 'readonly').objectStore('configs').get(origin);
      g.onsuccess = () => { db.close(); resolve(g.result ?? null); };
      g.onerror = () => { db.close(); resolve(null); };
    };
  });
}

// ---------- session

export type Persist = 'loading' | 'saved' | 'saving' | 'unsaved' | 'conflict' | 'session-only';

export interface Session {
  agg(): Aggregate;
  all(): Aggregate[];
  persist(): Persist;
  error(): string;
  /** Diagnostics from stored records that could not be loaded (kept out of the live set). */
  loadIssues(): string[];
  ready: Promise<void>;
  subscribe(fn: () => void): () => void;
  /** Validate and apply. Returns diagnostics (nothing changed) or null. `durable` writes before applying and throws on failure. */
  edit(mutate: (a: Aggregate) => void, durable?: boolean): Promise<Diag[] | null>;
  retry(): void;
  useStored(): Promise<void>;
  overwrite(): void;
  switchTo(id: string): Promise<void>;
  create(name: string, copy: boolean): Promise<void>;
  rename(name: string): Promise<Diag[] | null>;
  remove(id: string): Promise<void>;
  replaceAll(aggs: Aggregate[], activeId: string, scope: 'all' | 'add', expect?: Record<string, number>): Promise<void>;
  clearAll(): Promise<void>;
}

export function createSession(): Session {
  const list = new Map<string, Aggregate>();
  let active = defaultProfile();
  list.set(active.profile.id, active);
  /** Stored revision of the active profile that the live state is based on. */
  let base = 0;
  let state: Persist = 'loading';
  let err = '';
  let issues: string[] = [];
  let pending = 0; // edits not yet written
  let writing: Promise<void> | null = null;
  let force = false;
  const subs = new Set<() => void>();
  const changed = () => subs.forEach((f) => f());
  const set = (p: Persist, e = '') => { state = p; err = e; changed(); };
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  function adopt(a: Aggregate) {
    active = a;
    base = a.revision;
    list.set(a.profile.id, a);
  }

  async function load() {
    let raw: { aggs: unknown[]; activeId: unknown };
    try {
      raw = await store.load();
    } catch (e) {
      return set('session-only', `Storage unavailable (${msg(e)}). Changes last for this page session; export to keep them.`);
    }
    issues = [];
    list.clear();
    for (const x of raw.aggs) {
      const r = validateAggregate(x);
      if (r.ok) list.set(r.value.profile.id, r.value);
      else issues.push(`A stored profile could not be loaded: ${r.errors.slice(0, 3).map((d) => `${d.path} ${d.message}`).join('; ')}`);
    }
    const pick = list.get(String(raw.activeId)) ?? [...list.values()][0];
    if (pick) { adopt(pick); return set('saved'); }
    // Nothing usable stored: install a safe empty profile (stored records that failed validation stay untouched).
    const fresh = defaultProfile();
    try {
      fresh.revision = await store.put(fresh, 0, true);
      adopt(fresh);
      set('saved');
    } catch (e) {
      adopt(fresh);
      set('session-only', `Storage unavailable (${msg(e)}). Changes last for this page session; export to keep them.`);
    }
  }

  function flush() {
    if (writing || state === 'conflict' || state === 'session-only') return;
    writing = (async () => {
      while (pending) {
        const seq = pending;
        const snap = active;
        set('saving');
        try {
          const rev = await store.put(snap, force ? null : base);
          force = false;
          base = rev;
          if (active === snap) { active = { ...snap, revision: rev }; list.set(snap.profile.id, active); }
          if (pending === seq) pending = 0; // only the latest revision clears Unsaved
        } catch (e) {
          writing = null;
          return set(e instanceof Conflict ? 'conflict' : 'unsaved', e instanceof Conflict
            ? 'Another tab saved this profile after this tab loaded it. Choose which version to keep.'
            : `Not saved: ${msg(e)}. Your changes are live in this tab; retry or export them.`);
        }
      }
      writing = null;
      set('saved');
    })();
  }

  async function durable(a: Aggregate, activate: boolean) {
    if (state === 'session-only') { adopt(a); return changed(); }
    const rev = await store.put(a, list.has(a.profile.id) ? (a.profile.id === active.profile.id ? base : list.get(a.profile.id)!.revision) : 0, activate);
    adopt({ ...a, revision: rev });
    changed();
  }

  /** Unwritten edits block profile-level commands, except when nothing can be written anyway. */
  const unsaved = () => pending > 0 && state !== 'session-only';
  /** Let an in-flight save land first; then refuse if edits are still unwritten. */
  const settled = async (why: string) => {
    if (writing) await writing;
    if (unsaved()) throw new Error(why);
  };
  const uniqueName = (name: string, except?: string) =>
    [...list.values()].some((a) => a.profile.id !== except && a.profile.name.trim().toLowerCase() === name.trim().toLowerCase());

  const s: Session = {
    agg: () => active,
    all: () => [...list.values()],
    persist: () => state,
    error: () => err,
    loadIssues: () => issues,
    ready: Promise.resolve(),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    async edit(mutate, isDurable = false) {
      await s.ready; // an edit made while loading must apply to the loaded profile, not be replaced by it
      const draft = structuredClone(active);
      mutate(draft);
      draft.profile.updatedAt = Date.now();
      const r = validateAggregate(draft);
      if (!r.ok) return r.errors;
      if (isDurable) {
        await settled('Earlier changes are not saved yet; retry or wait before this change');
        await durable(r.value, false);
        return null;
      }
      active = r.value;
      list.set(active.profile.id, active);
      pending++;
      changed();
      flush();
      return null;
    },
    retry() {
      if (state === 'session-only') { load().then(() => flush()); return; }
      if (state === 'unsaved') { set('unsaved', err); flush(); }
    },
    async useStored() {
      pending = 0;
      await load();
    },
    overwrite() {
      force = true;
      state = 'unsaved';
      flush();
    },
    async switchTo(id) {
      await s.ready;
      const next = list.get(id);
      if (!next || id === active.profile.id) return;
      await settled('This profile has unsaved changes; retry saving or export before switching');
      if (state !== 'session-only') await store.setActive(id);
      adopt(next);
      changed();
    },
    async create(name, copy) {
      await s.ready;
      if (uniqueName(name)) throw new Error(`A profile named "${name}" already exists`);
      const a = copy ? copyAggregate(active, name.trim()) : defaultProfile(name.trim());
      const r = validateAggregate(a);
      if (!r.ok) throw new Error(r.errors[0]!.message);
      await settled('This profile has unsaved changes; retry saving first');
      await durable(r.value, true);
    },
    async rename(name) {
      if (uniqueName(name, active.profile.id)) return [{ path: 'profile.name', message: `A profile named "${name}" already exists` }];
      return s.edit((a) => { a.profile.name = name.trim(); });
    },
    async remove(id) {
      await s.ready;
      const rest = [...list.values()].filter((a) => a.profile.id !== id);
      const next = rest.find((a) => a.profile.id === active.profile.id) ?? rest[0] ?? defaultProfile();
      if (state !== 'session-only') {
        const keep = rest.length ? [] : [next];
        const written = await store.replace(keep, next.profile.id, [id]);
        if (written[0]) list.set(next.profile.id, written[0]);
      }
      list.delete(id);
      if (!list.has(next.profile.id)) list.set(next.profile.id, next);
      if (active.profile.id === id || !rest.length) { pending = 0; adopt(list.get(next.profile.id)!); }
      changed();
    },
    async replaceAll(aggs, activeId, scope, expect) {
      await s.ready;
      await settled('This profile has unsaved changes; retry saving or export before restoring');
      const written = state === 'session-only' ? aggs : await store.replace(aggs, activeId, scope === 'all' ? 'all' : [], expect);
      if (scope === 'all') list.clear();
      for (const a of written) list.set(a.profile.id, a);
      adopt(list.get(activeId)!);
      if (state !== 'session-only') state = 'saved';
      changed();
    },
    async clearAll() {
      const fresh = defaultProfile();
      pending = 0;
      await s.replaceAll([fresh], fresh.profile.id, 'all');
    },
  };
  s.ready = load();
  return s;
}
