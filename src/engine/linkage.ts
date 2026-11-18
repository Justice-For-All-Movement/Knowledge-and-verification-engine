// E07 record linkage across sources: candidate identity matches, the roster of persons (or other entities) as recorded
// by every source, attribute disagreements between records judged to be the same, incident grouping, bulk human
// decisions, and calendar conversion.
//
// Rules carried over from the rest of the engine and enforced here:
//  * a candidate match is a `similarity` aid; only a human records `same`, `different` or `unresolved`, and nothing merges;
//  * a disagreement between sources is shown with every value and its sources; none is chosen, averaged or hidden;
//  * entities whose identity is withheld from the caller never contribute names, aliases or attributes to any result.
import { DomainError, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { requireCapability } from '../service-kit.ts';
import type { ServiceContext, Sql } from '../service-kit.ts';
import { toGregorian } from './calendar.ts';
import type { Conversion } from './calendar.ts';
import type { Core, Reader } from './core.ts';
import { selfRef } from './core.ts';
import { idOf, label, oneOf, SIMILARITY_NOTICE, strict, text } from './model.ts';
import type { Obj, ObjRef } from './model.ts';
import { bestNameSimilarity, blockingKeys, DEFAULT_LATIN_EQUIVALENCES, foldText, nameKey, nameVariants } from './names.ts';
import type { NameKey } from './names.ts';

const LINKAGE_NOTICE = 'Candidates are found by comparing written names across scripts and romanizations. similarity is a matching aid only: it decides nothing, and every pair needs a human identity decision.';
const ROSTER_NOTICE = 'A person group is the set of records joined by human `same` decisions or merges. Values that differ between records are listed with their sources; none is preferred.';
const INCIDENT_NOTICE = 'Records are grouped by an equal place value and an equal day. A group is a lead for research, not a finding that the people were together or died in one event.';

type Env = {
  core: Core; sql: Sql;
  equivalences: readonly (readonly [string, string])[];
  cmd: <R>(ctx: ServiceContext, capability: string, op: string, input: { idempotencyKey?: string } | undefined, fn: (tx: Sql) => Promise<R>, o?: { human?: boolean; recheck?: boolean }) => Promise<R>;
  mkMatch: (tx: Sql, ctx: ServiceContext, leftId: string, rightId: string, decision: string, rationale: string, sim: Json, expectedRevision?: unknown) => Promise<Obj>;
  reviewProposal: (ctx: ServiceContext, id: string, input: { decision: 'accept' | 'reject'; reason: string }) => Promise<Record<string, any>>;
};

type Member = { entity: Obj; keys: NameKey[]; names: string[] };

export function createLinkage(env: Env) {
  const { core, sql } = env;

  async function membersInScope(ctx: ServiceContext, R: Reader, caseId: string | null, entityType: string): Promise<Member[]> {
    const rows = (await core.scan(sql, ctx, 'entity', { where: '($5::text is null or case_id=$5)', params: [caseId] }))
      .filter((e) => e.state === 'active' && e.body.entityType === entityType && !R.withheld(e.id));
    return rows.map((entity) => {
      const names = [entity.body.name as string, ...(entity.body.aliases as string[])];
      return { entity, names, keys: names.flatMap(nameVariants).map((n) => nameKey(n, { equivalences: env.equivalences })) };
    });
  }
  function attributeComparison(a: Record<string, Json>, b: Record<string, Json>): { agree: string[]; differ: { key: string; left: Json; right: Json }[] } {
    const agree: string[] = [], differ: { key: string; left: Json; right: Json }[] = [];
    for (const key of Object.keys(a)) {
      if (!(key in b) || a[key] === null || b[key] === null) continue;
      if (normValue(a[key] as Json) === normValue(b[key] as Json)) agree.push(key); else differ.push({ key, left: a[key] as Json, right: b[key] as Json });
    }
    return { agree, differ };
  }

  /**
   * Candidate pairs of records that may describe the same entity. Read-only: nothing is recorded. Pairs that already
   * carry a human decision, and records already in one merge group, are left out unless `includeDecided` is set.
   */
  async function suggestEntityMatches(ctx: ServiceContext, input: { caseId?: string | null; entityType?: string; minSimilarity?: number; limit?: number; includeDecided?: boolean; maxBlock?: number } = {}): Promise<Record<string, any>> {
    requireCapability(ctx, 'knowledge:read');
    const i = strict<Record<string, unknown>>(input, ['caseId', 'entityType', 'minSimilarity', 'limit', 'includeDecided', 'maxBlock'], 'match suggestion');
    const caseId = label(i.caseId, 'caseId'), entityType = typeof i.entityType === 'string' ? i.entityType : 'person';
    const min = i.minSimilarity === undefined ? 0.85 : Number(i.minSimilarity);
    invariant(Number.isFinite(min) && min >= 0.5 && min <= 1, 'invalid_input', 'minSimilarity must be between 0.5 and 1');
    const limit = Math.min(Math.max(Math.trunc(Number(i.limit ?? 500)) || 500, 1), 5000);
    const maxBlock = Math.min(Math.max(Math.trunc(Number(i.maxBlock ?? 400)) || 400, 2), 5000);
    const R = await core.reader(sql, ctx);
    const members = await membersInScope(ctx, R, caseId, entityType);
    const decided = new Map<string, string>();
    for (const m of await core.scan(sql, ctx, 'entity_match')) decided.set([m.body.leftId, m.body.rightId].sort().join('|'), m.body.decision as string);
    // Blocking: records are compared only when they share a name-token skeleton; very frequent tokens (common given
    // names) are skipped as keys, and the count of skipped keys is reported so the limitation is visible.
    const blocks = new Map<string, number[]>();
    members.forEach((m, idx) => { for (const k of blockingKeys(m.keys)) { const b = blocks.get(k); if (b === undefined) blocks.set(k, [idx]); else b.push(idx); } });
    const skipped = [...blocks.entries()].filter(([, v]) => v.length > maxBlock).map(([k, v]) => ({ key: k, records: v.length }));
    const seen = new Set<string>();
    const candidates: Record<string, any>[] = [];
    for (const [, idxs] of blocks) {
      if (idxs.length > maxBlock) continue;
      for (let x = 0; x < idxs.length; x++) for (let y = x + 1; y < idxs.length; y++) {
        const a = members[idxs[x] as number] as Member, b = members[idxs[y] as number] as Member;
        const pair = [a.entity.id, b.entity.id].sort().join('|');
        if (seen.has(pair)) continue;
        seen.add(pair);
        if (R.root(a.entity.id) === R.root(b.entity.id)) continue;
        const prior = decided.get(pair);
        if (prior !== undefined && i.includeDecided !== true) continue;
        const best = bestNameSimilarity(a.keys, b.keys);
        if (best.similarity < min) continue;
        candidates.push({
          left: { ref: selfRef('entity', a.entity.id, a.entity.revision), id: a.entity.id, name: a.entity.body.name, caseId: a.entity.caseId, source: a.entity.body.provenance ?? null },
          right: { ref: selfRef('entity', b.entity.id, b.entity.revision), id: b.entity.id, name: b.entity.body.name, caseId: b.entity.caseId, source: b.entity.body.provenance ?? null },
          similarity: { value: best.similarity, label: 'similarity', notice: SIMILARITY_NOTICE }, comparedForms: { left: best.left, right: best.right },
          attributes: attributeComparison(a.entity.body.attributes as Record<string, Json>, b.entity.body.attributes as Record<string, Json>),
          priorDecision: prior ?? null,
        });
      }
    }
    candidates.sort((p, q) => q.similarity.value - p.similarity.value || String(p.left.name).localeCompare(String(q.left.name)));
    return R.deep({ candidates: candidates.slice(0, limit), total: candidates.length, truncated: candidates.length > limit, compared: members.length, skippedFrequentKeys: skipped, notice: LINKAGE_NOTICE });
  }

  /** A human records many identity decisions at once (for example after reviewing a candidate list). One transaction. */
  async function recordEntityMatches(ctx: ServiceContext, input: { decisions: { leftId: string; rightId: string; decision: 'same' | 'different' | 'unresolved'; rationale: string; similarity?: number | null }[]; idempotencyKey?: string }): Promise<Record<string, any>> {
    requireCapability(ctx, 'knowledge:write');
    const i = strict<Record<string, unknown>>(input, ['decisions', 'idempotencyKey'], 'entity match batch');
    invariant(Array.isArray(i.decisions) && i.decisions.length >= 1 && i.decisions.length <= 500, 'invalid_input', 'decisions must hold 1–500 items');
    const items = (i.decisions as unknown[]).map((raw) => {
      const d = strict<Record<string, unknown>>(raw, ['leftId', 'rightId', 'decision', 'rationale', 'similarity'], 'entity match');
      const sim = d.similarity === undefined || d.similarity === null ? null : (invariant(typeof d.similarity === 'number' && d.similarity >= 0 && d.similarity <= 1, 'invalid_input', 'similarity must be between 0 and 1'), { value: d.similarity as number, label: 'similarity', notice: SIMILARITY_NOTICE });
      return { leftId: idOf(d.leftId, 'leftId'), rightId: idOf(d.rightId, 'rightId'), decision: oneOf(d.decision, ['same', 'different', 'unresolved'], 'decision'), rationale: text(d.rationale, 'rationale', 4000), sim };
    });
    const out = await env.cmd(ctx, 'knowledge:write', 'recordEntityMatches', input, async (tx) => {
      const ids: string[] = [];
      for (const d of items) ids.push((await env.mkMatch(tx, ctx, d.leftId, d.rightId, d.decision, d.rationale, d.sim as Json)).id);
      return { ids };
    }, { human: true });
    return { recorded: out.ids.length, matches: out.ids.map((id) => selfRef('entity_match', id)) };
  }

  /** A human accepts or rejects many proposals with one reason. Each proposal is reviewed in its own transaction. */
  async function reviewProposals(ctx: ServiceContext, input: { ids: string[]; decision: 'accept' | 'reject'; reason: string }): Promise<Record<string, any>> {
    requireCapability(ctx, 'knowledge:review');
    invariant(ctx.actor.kind === 'human', 'forbidden', 'Only a human reviewer can accept or reject proposals');
    const i = strict<Record<string, unknown>>(input, ['ids', 'decision', 'reason'], 'proposal batch review');
    invariant(Array.isArray(i.ids) && i.ids.length >= 1 && i.ids.length <= 500, 'invalid_input', 'ids must hold 1–500 proposal identifiers');
    const decision = oneOf(i.decision, ['accept', 'reject'], 'decision'), reason = text(i.reason, 'reason', 2000);
    const results: { id: string; state: string; results?: Json; error?: string }[] = [];
    for (const raw of i.ids as unknown[]) {
      const id = idOf(raw, 'id');
      try { const v = await env.reviewProposal(ctx, id, { decision, reason }); results.push({ id, state: v.state, results: (v.review?.results ?? []) as Json }); }
      catch (e) { results.push({ id, state: 'unchanged', error: e instanceof DomainError ? `${e.code}: ${e.message}` : 'failed' }); }
    }
    return { reviewed: results.filter((r) => r.error === undefined).length, failed: results.filter((r) => r.error !== undefined).length, results };
  }

  /** Union of merge groups and human `same` decisions. */
  async function groupsOf(ctx: ServiceContext, R: Reader, members: readonly Member[]): Promise<{ groups: Map<string, Member[]>; unresolved: Map<string, number>; different: Map<string, number> }> {
    const parent = new Map<string, string>();
    const find = (x: string): string => { let r = x; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r) as string; parent.set(x, r); return r; };
    const unite = (a: string, b: string): void => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
    const byId = new Map(members.map((m) => [m.entity.id, m]));
    for (const m of members) unite(m.entity.id, R.root(m.entity.id));
    const unresolved = new Map<string, number>(), different = new Map<string, number>();
    const matches = await core.scan(sql, ctx, 'entity_match');
    for (const m of matches) if (m.body.decision === 'same' && byId.has(m.body.leftId) && byId.has(m.body.rightId)) unite(m.body.leftId, m.body.rightId);
    for (const m of matches) {
      if (!byId.has(m.body.leftId) || !byId.has(m.body.rightId)) continue;
      const target = m.body.decision === 'unresolved' ? unresolved : m.body.decision === 'different' ? different : null;
      if (target === null) continue;
      for (const g of new Set([find(m.body.leftId), find(m.body.rightId)])) target.set(g, (target.get(g) ?? 0) + 1);
    }
    const groups = new Map<string, Member[]>();
    for (const m of members) { const g = find(m.entity.id); const list = groups.get(g); if (list === undefined) groups.set(g, [m]); else list.push(m); }
    return { groups, unresolved, different };
  }
  /** Evidence references cited by the active claims about each entity. */
  async function sourcesByEntity(ctx: ServiceContext): Promise<Map<string, { claim: string; text: string; evidenceRefs: string[] }[]>> {
    const claims = (await core.scan(sql, ctx, 'claim')).filter((c) => c.state === 'active');
    const links = (await core.scan(sql, ctx, 'evidence_link')).filter((l) => l.state === 'active' && l.body.target?.kind === 'claim');
    const byClaim = new Map<string, string[]>();
    for (const l of links) { const k = l.body.target.id as string; const list = byClaim.get(k); if (list === undefined) byClaim.set(k, [l.body.evidenceRef]); else list.push(l.body.evidenceRef); }
    const out = new Map<string, { claim: string; text: string; evidenceRefs: string[] }[]>();
    for (const c of claims) for (const s of c.body.subjects as ObjRef[]) {
      if (s.kind !== 'entity') continue;
      const entry = { claim: selfRef('claim', c.id, c.revision), text: String(c.body.text), evidenceRefs: [...new Set(byClaim.get(c.id) ?? [])] };
      const list = out.get(s.id); if (list === undefined) out.set(s.id, [entry]); else list.push(entry);
    }
    return out;
  }

  type Group = { groupId: string; name: string; names: string[]; members: Record<string, any>[]; attributes: Record<string, { value: Json; records: string[] }[]>; conflicts: string[]; missing: string[]; unresolvedMatches: number; differentDecisions: number };
  async function buildRoster(ctx: ServiceContext, caseId: string | null, entityType: string, expect: readonly string[]): Promise<{ groups: Group[]; R: Reader }> {
    const R = await core.reader(sql, ctx);
    const members = await membersInScope(ctx, R, caseId, entityType);
    const { groups, unresolved, different } = await groupsOf(ctx, R, members);
    const sources = await sourcesByEntity(ctx);
    const out: Group[] = [];
    for (const [gid, ms] of groups) {
      const attributes: Record<string, { value: Json; records: string[] }[]> = {};
      for (const m of ms) for (const [k, v] of Object.entries(m.entity.body.attributes as Record<string, Json>)) {
        if (v === null || v === '') continue;
        const list = attributes[k] ?? (attributes[k] = []);
        const hit = list.find((x) => normValue(x.value) === normValue(v));
        if (hit === undefined) list.push({ value: v, records: [m.entity.id] }); else hit.records.push(m.entity.id);
      }
      const names = [...new Set(ms.flatMap((m) => m.names))];
      const ordered = [...ms].sort((a, b) => a.entity.createdAt.localeCompare(b.entity.createdAt) || a.entity.id.localeCompare(b.entity.id));
      out.push({
        groupId: gid, name: String((ordered[0] as Member).entity.body.name), names,
        members: ordered.map((m) => ({ ref: selfRef('entity', m.entity.id, m.entity.revision), id: m.entity.id, name: m.entity.body.name, aliases: m.entity.body.aliases, attributes: m.entity.body.attributes, caseId: m.entity.caseId, provenance: m.entity.body.provenance ?? null, claims: sources.get(m.entity.id) ?? [] })),
        attributes, conflicts: Object.entries(attributes).filter(([, v]) => v.length > 1).map(([k]) => k).sort(),
        missing: expect.filter((k) => attributes[k] === undefined), unresolvedMatches: unresolved.get(gid) ?? 0, differentDecisions: different.get(gid) ?? 0,
      });
    }
    out.sort((a, b) => foldText(a.name).localeCompare(foldText(b.name)) || a.groupId.localeCompare(b.groupId));
    return { groups: out, R };
  }

  /**
   * One row per person group (records joined by human decisions), with every written name, every attribute value and
   * the records stating it, disagreements, missing expected attributes, and the claims and evidence about each record.
   */
  async function roster(ctx: ServiceContext, input: { caseId?: string | null; entityType?: string; expect?: string[]; only?: 'conflicts' | 'unresolved' | 'missing'; offset?: number; limit?: number } = {}): Promise<Record<string, any>> {
    requireCapability(ctx, 'knowledge:read');
    const i = strict<Record<string, unknown>>(input, ['caseId', 'entityType', 'expect', 'only', 'offset', 'limit'], 'roster');
    const expect = i.expect === undefined ? [] : (invariant(Array.isArray(i.expect) && i.expect.length <= 50 && i.expect.every((k) => typeof k === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(k)), 'invalid_input', 'expect must be a list of attribute names'), i.expect as string[]);
    const only = i.only === undefined ? null : oneOf(i.only, ['conflicts', 'unresolved', 'missing'], 'only');
    const offset = Math.max(Math.trunc(Number(i.offset ?? 0)) || 0, 0), limit = Math.min(Math.max(Math.trunc(Number(i.limit ?? 200)) || 200, 1), 2000);
    const { groups, R } = await buildRoster(ctx, label(i.caseId, 'caseId'), typeof i.entityType === 'string' ? i.entityType : 'person', expect);
    const filtered = only === null ? groups : groups.filter((g) => (only === 'conflicts' ? g.conflicts.length > 0 : only === 'unresolved' ? g.unresolvedMatches > 0 : g.missing.length > 0));
    const counts = { groups: groups.length, records: groups.reduce((n, g) => n + g.members.length, 0), withConflicts: groups.filter((g) => g.conflicts.length > 0).length, withUnresolvedMatches: groups.filter((g) => g.unresolvedMatches > 0).length, withMissing: groups.filter((g) => g.missing.length > 0).length, singleRecord: groups.filter((g) => g.members.length === 1).length };
    return R.deep({ groups: filtered.slice(offset, offset + limit), total: filtered.length, offset, counts, notice: ROSTER_NOTICE });
  }

  /** Person groups that share an equal place value and an equal day, largest first. A group with conflicting values appears under each. */
  async function incidents(ctx: ServiceContext, input: { caseId?: string | null; entityType?: string; placeAttribute: string; dateAttribute: string; minSize?: number; limit?: number }): Promise<Record<string, any>> {
    requireCapability(ctx, 'knowledge:read');
    const i = strict<Record<string, unknown>>(input, ['caseId', 'entityType', 'placeAttribute', 'dateAttribute', 'minSize', 'limit'], 'incidents');
    const attr = (v: unknown, n: string): string => { invariant(typeof v === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(v), 'invalid_input', `${n} must be an attribute name`); return v as string; };
    const placeKey = attr(i.placeAttribute, 'placeAttribute'), dateKey = attr(i.dateAttribute, 'dateAttribute');
    const minSize = Math.max(Math.trunc(Number(i.minSize ?? 2)) || 2, 1), limit = Math.min(Math.max(Math.trunc(Number(i.limit ?? 200)) || 200, 1), 2000);
    const { groups, R } = await buildRoster(ctx, label(i.caseId, 'caseId'), typeof i.entityType === 'string' ? i.entityType : 'person', []);
    const byKey = new Map<string, { place: Json; date: string; people: Record<string, any>[] }>();
    let undated = 0;
    for (const g of groups) {
      const places = g.attributes[placeKey] ?? [], dates = g.attributes[dateKey] ?? [];
      if (places.length === 0 || dates.length === 0) { undated++; continue; }
      const conflicting = places.length > 1 || dates.length > 1;
      for (const p of places) for (const d of dates) {
        const day = typeof d.value === 'string' ? d.value.slice(0, 10) : String(d.value);
        const key = `${normValue(p.value)}|${day}`;
        const entry = byKey.get(key) ?? { place: p.value, date: day, people: [] };
        entry.people.push({ groupId: g.groupId, name: g.name, records: g.members.length, conflicting, placeRecords: p.records, dateRecords: d.records });
        byKey.set(key, entry);
      }
    }
    const list = [...byKey.values()].filter((x) => x.people.length >= minSize).sort((a, b) => b.people.length - a.people.length || a.date.localeCompare(b.date));
    return R.deep({ incidents: list.slice(0, limit).map((x) => ({ ...x, size: x.people.length })), total: list.length, groupsWithoutPlaceOrDate: undated, notice: INCIDENT_NOTICE });
  }

  /** Deterministic calendar conversion (ICU). Pure; requires only read access. */
  function convertDate(ctx: ServiceContext, input: { calendar: string; year: number; month: number | string; day: number; weekday?: string | null; locales?: string[] }): Conversion {
    requireCapability(ctx, 'knowledge:read');
    const i = strict<Record<string, unknown>>(input, ['calendar', 'year', 'month', 'day', 'weekday', 'locales'], 'date');
    const locales = i.locales === undefined ? ['en'] : (invariant(Array.isArray(i.locales) && i.locales.length <= 10 && i.locales.every((l) => typeof l === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l)), 'invalid_input', 'locales must be BCP 47 language tags'), i.locales as string[]);
    invariant(typeof i.month === 'number' || (typeof i.month === 'string' && i.month.length <= 40), 'invalid_input', 'month must be a number or a month name');
    return toGregorian({ calendar: String(i.calendar), year: Number(i.year), month: i.month as number | string, day: Number(i.day), weekday: (i.weekday ?? null) as string | null, locales });
  }

  return { suggestEntityMatches, recordEntityMatches, reviewProposals, roster, incidents, convertDate };
}

/** Comparable form of an attribute value: folded text for strings, canonical JSON otherwise. */
export function normValue(v: Json): string { return typeof v === 'string' ? foldText(v) : JSON.stringify(v); }
export { DEFAULT_LATIN_EQUIVALENCES };
