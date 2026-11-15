// E07 service core: scoped storage, append-only revisions, dependency edges, protected-identity redaction and
// stale/blocked propagation. Everything here filters on tenant and project; compartment-hidden rows read as missing.
import { randomUUID } from 'node:crypto';
import { DomainError, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { appendAudit, emitEvent, hasCapability, uref, urefMatches } from '../service-kit.ts';
import type { ServiceContext, Sql } from '../service-kit.ts';
import { DEFAULTS, ENGINE_ID, SCHEMA, urefKey } from './model.ts';
import type { EngineConfig, EngineDeps, Flag, Kind, Obj } from './model.ts';

const S = SCHEMA;
const COLS = 'kind, id, revision, state, compartment, case_id, stale, blocked, flags, body, created_at, created_by, updated_at';
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const toObj = (r: Record<string, unknown>): Obj => ({
  kind: r.kind as Kind, id: r.id as string, revision: r.revision as number, state: r.state as string, compartment: (r.compartment as string | null) ?? null,
  caseId: (r.case_id as string | null) ?? null, stale: r.stale as boolean, blocked: r.blocked as boolean, flags: r.flags as Flag[], body: r.body as Record<string, any>,
  createdAt: iso(r.created_at), createdBy: r.created_by as string, updatedAt: iso(r.updated_at),
});
export const selfRef = (kind: string, id: string, revision?: number): string => uref(ENGINE_ID, kind, id, revision);
export const objRef = (o: Obj): string => selfRef(o.kind, o.id, o.revision);
export const statusOf = (o: { state: string; stale: boolean; blocked: boolean }): string => (o.blocked ? 'blocked' : o.stale ? 'needs_reverification' : o.state);
export const activeFlags = (o: { flags: readonly Flag[] }): Flag[] => o.flags.filter((f) => f.clearedAt === undefined);

/** Searchable text per kind (only claims, entities, events and statements are indexed). */
export function searchText(kind: Kind, b: Record<string, any>): string | null {
  const join = (...parts: unknown[]): string => parts.flat().filter((p) => typeof p === 'string' && p !== '').join('\n');
  if (kind === 'claim') return join(b.text, b.question);
  if (kind === 'entity') return join(b.name, b.aliases, b.description);
  if (kind === 'event') return join(b.title, b.description);
  if (kind === 'statement') return join(b.text, b.speakerLabel, b.venue);
  return null;
}

type Group = { root: string; memberIds: string[]; names: string[]; pseudonym: string; compartments: string[] };
/** Project-wide protection state: merge topology and every identity group that contains a protected entity. */
export type Protection = { parent: Map<string, { survivorId: string; mergeId: string }>; children: Map<string, { entityId: string; mergeId: string }[]>; groups: Group[]; byEntity: Map<string, Group> };
export type Reader = {
  ctx: ServiceContext; protection: Protection; sees: boolean;
  root(id: string): string; members(id: string): string[];
  withheld(entityId: string): boolean; pseudonym(entityId: string): string;
  redact(s: string): string; deep<T>(v: T): T;
};

function redactor(groups: readonly Group[]): (s: string) => string {
  const map = new Map<string, string>();
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const g of groups) for (const n of g.names) if (norm(n).length >= 2) map.set(norm(n), g.pseudonym);
  if (map.size === 0) return (s) => s;
  const alternatives = [...map.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return (s) => s.replace(re, (m) => map.get(norm(m)) ?? '[identity withheld]');
}
function deepMap<T>(v: T, f: (s: string) => string): T {
  if (typeof v === 'string') return f(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => deepMap(x, f)) as unknown as T;
  if (v !== null && typeof v === 'object') { const out: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v)) out[k] = deepMap(x, f); return out as T; }
  return v;
}

export type Core = ReturnType<typeof createCore>;
export function createCore(deps: EngineDeps) {
  const sql = deps.sql;
  const cfg: Required<EngineConfig> = { ...DEFAULTS, ...(deps.config ?? {}) } as Required<EngineConfig>;
  invariant(/^[a-z_]{1,40}$/.test(cfg.searchConfig), 'invalid_config', 'searchConfig must be a PostgreSQL text search configuration name');
  const TS = `'${cfg.searchConfig}'::regconfig`;
  const scope = (ctx: ServiceContext): unknown[] => [ctx.tenantId, ctx.projectId];
  /** `$3` is the caller's compartment list; null (raw) bypasses the filter for internal propagation only. */
  const VIS = '($3::text[] is null or compartment is null or compartment = any($3))';
  const cmp = (ctx: ServiceContext, raw?: boolean): string[] | null => (raw === true ? null : [...ctx.compartments]);

  async function load(q: Sql, ctx: ServiceContext, kind: Kind, id: string, o: { raw?: boolean; lock?: boolean } = {}): Promise<Obj | null> {
    const rows = await q.query(`select ${COLS} from ${S}.objects where tenant_id=$1 and project_id=$2 and ${VIS} and kind=$4 and id=$5${o.lock === true ? ' for update' : ''}`, [...scope(ctx), cmp(ctx, o.raw), kind, id]);
    return rows[0] === undefined ? null : toObj(rows[0]);
  }
  async function need(q: Sql, ctx: ServiceContext, kind: Kind, id: string, o: { raw?: boolean; lock?: boolean } = {}): Promise<Obj> {
    const out = typeof id === 'string' ? await load(q, ctx, kind, id, o) : null;
    if (out === null) throw new DomainError('not_found', 'Not found');
    return out;
  }
  async function many(q: Sql, ctx: ServiceContext, kind: Kind, ids: readonly string[], o: { raw?: boolean } = {}): Promise<Obj[]> {
    if (ids.length === 0) return [];
    return (await q.query(`select ${COLS} from ${S}.objects where tenant_id=$1 and project_id=$2 and ${VIS} and kind=$4 and id = any($5) order by created_at, id`, [...scope(ctx), cmp(ctx, o.raw), kind, [...ids]])).map(toObj);
  }
  /** Lists visible rows of a kind; `where` is trusted SQL over the objects columns with parameters starting at $5. */
  async function list(q: Sql, ctx: ServiceContext, kind: Kind, o: { where?: string; params?: unknown[]; limit?: number; raw?: boolean } = {}): Promise<Obj[]> {
    const limit = Math.min(Math.max(Math.trunc(Number(o.limit ?? 500)) || 500, 1), 5000);
    return (await q.query(`select ${COLS} from ${S}.objects where tenant_id=$1 and project_id=$2 and ${VIS} and kind=$4${o.where === undefined ? '' : ` and (${o.where})`} order by created_at, id limit ${limit}`,
      [...scope(ctx), cmp(ctx, o.raw), kind, ...(o.params ?? [])])).map(toObj);
  }

  // ── protection / merges ──
  async function protection(q: Sql, ctx: ServiceContext): Promise<Protection> {
    const merges = await q.query<{ id: string; body: Record<string, any> }>(`select id, body from ${S}.objects where tenant_id=$1 and project_id=$2 and kind='entity_merge' and state='active'`, scope(ctx));
    const parent: Protection['parent'] = new Map(), children: Protection['children'] = new Map();
    for (const m of merges) {
      parent.set(m.body.mergedId, { survivorId: m.body.survivorId, mergeId: m.id });
      children.set(m.body.survivorId, [...(children.get(m.body.survivorId) ?? []), { entityId: m.body.mergedId, mergeId: m.id }]);
    }
    const root = (id: string): string => { let cur = id; for (let i = 0; i < 1000 && parent.has(cur); i++) cur = (parent.get(cur) as { survivorId: string }).survivorId; return cur; };
    const members = (r: string): string[] => { const out = [r]; for (let i = 0; i < out.length; i++) for (const c of children.get(out[i] as string) ?? []) out.push(c.entityId); return out; };
    const prot = await q.query<{ id: string; body: Record<string, any> }>(`select id, body from ${S}.objects where tenant_id=$1 and project_id=$2 and kind='entity' and body->>'protectedIdentity'='true' order by id`, scope(ctx));
    const bodies = new Map(prot.map((p) => [p.id, p.body]));
    const roots = [...new Set(prot.map((p) => root(p.id)))];
    const missing = roots.flatMap(members).filter((id) => !bodies.has(id));
    if (missing.length > 0) for (const r of await q.query<{ id: string; body: Record<string, any> }>(`select id, body from ${S}.objects where tenant_id=$1 and project_id=$2 and kind='entity' and id = any($3)`, [...scope(ctx), missing])) bodies.set(r.id, r.body);
    const groups: Group[] = [], byEntity = new Map<string, Group>();
    for (const r of roots) {
      const memberIds = members(r);
      const protectedMembers = memberIds.filter((id) => bodies.get(id)?.protectedIdentity === true).sort();
      const g: Group = {
        root: r, memberIds,
        names: memberIds.flatMap((id) => { const b = bodies.get(id); return b === undefined ? [] : [b.name as string, ...(b.aliases as string[])]; }),
        pseudonym: bodies.get(protectedMembers[0] as string)?.pseudonym as string,
        compartments: protectedMembers.map((id) => bodies.get(id)?.identityCompartment as string | null).filter((c): c is string => typeof c === 'string'),
      };
      groups.push(g); for (const id of memberIds) byEntity.set(id, g);
    }
    return { parent, children, groups, byEntity };
  }
  function readerFrom(ctx: ServiceContext, p: Protection): Reader {
    const disclose = hasCapability(ctx, 'knowledge:disclose_identity');
    const hidden = p.groups.filter((g) => !(disclose && g.compartments.every((c) => ctx.compartments.includes(c))));
    const hiddenSet = new Set(hidden.flatMap((g) => g.memberIds));
    const redact = redactor(hidden);
    const root = (id: string): string => { let cur = id; for (let i = 0; i < 1000 && p.parent.has(cur); i++) cur = (p.parent.get(cur) as { survivorId: string }).survivorId; return cur; };
    return {
      ctx, protection: p, sees: hidden.length === 0, root,
      members: (id) => { const out = [root(id)]; for (let i = 0; i < out.length; i++) for (const c of p.children.get(out[i] as string) ?? []) out.push(c.entityId); return out; },
      withheld: (id) => hiddenSet.has(id), pseudonym: (id) => p.byEntity.get(id)?.pseudonym ?? '[identity withheld]',
      redact, deep: (v) => deepMap(v, redact),
    };
  }
  async function reader(q: Sql, ctx: ServiceContext): Promise<Reader> { return readerFrom(ctx, await protection(q, ctx)); }
  /** Public (identity-safe) search text: every protected group is redacted, whoever the eventual caller is. */
  function publicText(p: Protection, kind: Kind, id: string, text: string | null): string | null {
    if (text === null) return null;
    if (kind === 'entity' && p.byEntity.has(id)) return (p.byEntity.get(id) as Group).pseudonym;
    return redactor(p.groups)(text);
  }
  async function index(tx: Sql, ctx: ServiceContext, kind: Kind, id: string, text: string | null, p?: Protection): Promise<void> {
    const pub = publicText(p ?? await protection(tx, ctx), kind, id, text);
    await tx.query(`update ${S}.objects set text=$5, text_public=$6, tsv=to_tsvector(${TS}, coalesce($5,'')), tsv_public=to_tsvector(${TS}, coalesce($6,'')) where tenant_id=$1 and project_id=$2 and kind=$3 and id=$4`, [...scope(ctx), kind, id, text, pub]);
  }
  /** Recomputes identity-safe text for every indexed record after a protection, name or merge change. */
  async function reindexProject(tx: Sql, ctx: ServiceContext): Promise<void> {
    const p = await protection(tx, ctx);
    const rows = await tx.query<{ kind: Kind; id: string; text: string; text_public: string | null }>(`select kind, id, text, text_public from ${S}.objects where tenant_id=$1 and project_id=$2 and text is not null`, scope(ctx));
    for (const r of rows) { const pub = publicText(p, r.kind, r.id, r.text); if (pub !== r.text_public) await tx.query(`update ${S}.objects set text_public=$5, tsv_public=to_tsvector(${TS}, coalesce($5,'')) where tenant_id=$1 and project_id=$2 and kind=$3 and id=$4`, [...scope(ctx), r.kind, r.id, pub]); }
  }

  // ── writes ──
  async function create(tx: Sql, ctx: ServiceContext, kind: Kind, p: { body: Record<string, any>; state?: string; compartment?: string | null; caseId?: string | null; reason?: string; id?: string }): Promise<Obj> {
    const id = p.id ?? randomUUID();
    const rows = await tx.query(`insert into ${S}.objects (tenant_id, project_id, kind, id, revision, state, compartment, case_id, body, created_at, created_by, updated_at)
      values ($1,$2,$3,$4,1,$5,$6,$7,$8::jsonb,$9,$10,$9) returning ${COLS}`, [...scope(ctx), kind, id, p.state ?? 'active', p.compartment ?? null, p.caseId ?? null, JSON.stringify(p.body), ctx.now, ctx.actor.id]);
    const o = toObj(rows[0] as Record<string, unknown>);
    await history(tx, ctx, o, p.reason ?? 'created');
    const text = searchText(kind, o.body); if (text !== null) await index(tx, ctx, kind, id, text);
    return o;
  }
  async function history(tx: Sql, ctx: ServiceContext, o: Obj, reason: string): Promise<void> {
    await tx.query(`insert into ${S}.revisions (tenant_id, project_id, kind, id, revision, state, compartment, body, reason, actor_id, actor_kind, request_id, at) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)`,
      [...scope(ctx), o.kind, o.id, o.revision, o.state, o.compartment, JSON.stringify(o.body), reason.slice(0, 2000), ctx.actor.id, ctx.actor.kind, ctx.requestId, ctx.now]);
  }
  /** Appends a revision. The caller must hold the row lock (load with `lock`) and have checked `expectedRevision`. */
  async function revise(tx: Sql, ctx: ServiceContext, o: Obj, p: { body?: Record<string, any>; state?: string; compartment?: string | null; reason: string }): Promise<Obj> {
    const next: Obj = { ...o, revision: o.revision + 1, body: p.body ?? o.body, state: p.state ?? o.state, compartment: p.compartment === undefined ? o.compartment : p.compartment, updatedAt: iso(ctx.now) };
    await tx.query(`update ${S}.objects set revision=$5, state=$6, compartment=$7, body=$8::jsonb, updated_at=$9 where tenant_id=$1 and project_id=$2 and kind=$3 and id=$4`,
      [...scope(ctx), o.kind, o.id, next.revision, next.state, next.compartment, JSON.stringify(next.body), ctx.now]);
    await history(tx, ctx, next, p.reason);
    const text = searchText(o.kind, next.body); if (text !== null) await index(tx, ctx, o.kind, o.id, text);
    return next;
  }
  function expect(o: Obj, expectedRevision: unknown): void {
    invariant(Number.isSafeInteger(expectedRevision), 'invalid_input', 'expectedRevision is required');
    if (o.revision !== expectedRevision) throw new DomainError('revision_conflict', `Current revision is ${o.revision}`);
  }
  async function setDeps(tx: Sql, ctx: ServiceContext, ownerKind: Kind, ownerId: string, rows: readonly { depKind: Kind; depId: string; sourceRef: string; role: string }[]): Promise<void> {
    await tx.query(`delete from ${S}.deps where tenant_id=$1 and project_id=$2 and owner_kind=$3 and owner_id=$4`, [...scope(ctx), ownerKind, ownerId]);
    for (const r of rows) await tx.query(`insert into ${S}.deps (tenant_id, project_id, owner_kind, owner_id, dep_kind, dep_id, source_ref, source_key, role) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`,
      [...scope(ctx), ownerKind, ownerId, r.depKind, r.depId, r.sourceRef, urefKey(r.sourceRef), r.role]);
  }
  async function record(tx: Sql, ctx: ServiceContext, action: string, subject: string, detail: Json, event?: { type: string; payload?: Json }): Promise<void> {
    await appendAudit(tx, S, ctx, action, subject, detail);
    if (event !== undefined) await emitEvent(tx, S, ctx, event.type, subject, event.payload ?? detail);
  }

  // ── dependency traversal and stale/blocked propagation ──
  type Hit = { kind: Kind; id: string; via: string[] };
  /** Everything that depends, directly or transitively, on the given urefs (external or this engine's). */
  async function dependents(q: Sql, ctx: ServiceContext, seeds: readonly string[]): Promise<Hit[]> {
    const found = new Map<string, Hit>();
    let frontier = [...new Set(seeds)];
    for (let depth = 0; depth < 64 && frontier.length > 0; depth++) {
      const rows = await q.query<{ dep_kind: Kind; dep_id: string; source_ref: string }>(`select dep_kind, dep_id, source_ref from ${S}.deps where tenant_id=$1 and project_id=$2 and source_key = any($3)`, [...scope(ctx), [...new Set(frontier.map(urefKey))]]);
      const next: string[] = [];
      for (const r of rows) {
        const from = frontier.filter((f) => urefMatches(f, r.source_ref));
        if (from.length === 0) continue;
        const key = `${r.dep_kind}:${r.dep_id}`;
        const hit = found.get(key);
        if (hit === undefined) { found.set(key, { kind: r.dep_kind, id: r.dep_id, via: [r.source_ref] }); next.push(selfRef(r.dep_kind, r.dep_id)); }
        else if (!hit.via.includes(r.source_ref)) hit.via.push(r.source_ref);
      }
      frontier = next;
    }
    return [...found.values()];
  }
  type Mark = { flag: 'stale' | 'blocked'; reason: string; cause: string; changeKind: string };
  /** Flags records without touching their content or assessments' values. Returns the urefs newly flagged. */
  async function mark(tx: Sql, ctx: ServiceContext, hits: readonly Hit[], m: Mark): Promise<string[]> {
    const out: string[] = [];
    for (const h of [...hits].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))) {
      const o = await load(tx, ctx, h.kind, h.id, { raw: true, lock: true });
      if (o === null || o.state === 'retracted') continue;
      if (o.flags.some((f) => f.cause === m.cause && f.flag === m.flag)) continue;
      const flag: Flag = { id: randomUUID(), flag: m.flag, reason: m.reason.slice(0, 1000), cause: m.cause, changeKind: m.changeKind, via: h.via.slice(0, 50), at: iso(ctx.now) };
      await tx.query(`update ${S}.objects set flags = flags || $5::jsonb, stale = stale or $6, blocked = blocked or $7, updated_at=$8 where tenant_id=$1 and project_id=$2 and kind=$3 and id=$4`,
        [...scope(ctx), o.kind, o.id, JSON.stringify([flag]), m.flag === 'stale', m.flag === 'blocked', ctx.now]);
      const ref = objRef(o);
      if (o.kind === 'claim') {
        // Assessments keep their recorded value; they are flagged so that nothing downstream relies on them unreviewed.
        await tx.query(`update ${S}.assessments a set flags = a.flags || $4::jsonb where tenant_id=$1 and project_id=$2 and claim_id=$3 and status='final'
          and seq in (select max(seq) from ${S}.assessments where tenant_id=$1 and project_id=$2 and claim_id=$3 and status='final' group by dimension)`,
          [...scope(ctx), o.id, JSON.stringify([{ flag: m.flag === 'stale' ? 'needs_reverification' : 'blocked', reason: flag.reason, cause: m.cause, at: flag.at }])]);
      }
      await record(tx, ctx, `knowledge.${o.kind}_${m.flag}`, selfRef(o.kind, o.id), { reason: flag.reason, cause: m.cause, changeKind: m.changeKind, via: [...flag.via] },
        { type: `knowledge.${o.kind}_${m.flag}`, payload: { reason: flag.reason, cause: m.cause, changeKind: m.changeKind, refs: [ref], ...(o.kind === 'claim' ? { claims: [ref] } : {}) } });
      out.push(ref);
    }
    return out;
  }
  /** Marks active flags of one kind as cleared (history is kept inside the flag list). */
  async function clearFlags(tx: Sql, ctx: ServiceContext, o: Obj, flag: 'stale' | 'blocked', note: string): Promise<Obj> {
    const flags = o.flags.map((f) => (f.flag === flag && f.clearedAt === undefined ? { ...f, clearedAt: iso(ctx.now), clearedBy: ctx.actor.id, clearNote: note.slice(0, 1000) } : f));
    await tx.query(`update ${S}.objects set flags=$5::jsonb, stale=$6, blocked=$7, updated_at=$8 where tenant_id=$1 and project_id=$2 and kind=$3 and id=$4`,
      [...scope(ctx), o.kind, o.id, JSON.stringify(flags), flag === 'stale' ? false : o.stale, flag === 'blocked' ? false : o.blocked, ctx.now]);
    return { ...o, flags, stale: flag === 'stale' ? false : o.stale, blocked: flag === 'blocked' ? false : o.blocked };
  }

  return { sql, cfg, TS, VIS, scope, cmp, load, need, many, list, protection, reader, readerFrom, reindexProject, create, revise, expect, setDeps, record, dependents, mark, clearFlags };
}
