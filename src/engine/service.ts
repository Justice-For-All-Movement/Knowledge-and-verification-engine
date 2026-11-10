// E07 Knowledge and Verification — service layer (commands, queries, standard surface).
// Design rules enforced here, not just documented:
//  * supporting, challenging and contextual material are stored side by side and never deleted;
//  * the four assessment dimensions are separate append-only tracks; no numeric guilt or credibility score exists;
//  * agents and services propose; only a human finalises an assessment or accepts a proposal;
//  * independence is counted per source family, never per copy; similarity never changes an assessment;
//  * relationships are documented connections and feed no assessment.
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { hasCapability, idempotent, listAudit, parseUref, readEvents, requireCapability } from '../service-kit.ts';
import type { AuditRecord, EngineEvent, Inspection, SearchHit, ServiceContext, Sql, StandardEngine, UpstreamChange, UseAction } from '../service-kit.ts';
import { activeFlags, createCore, objRef, selfRef, statusOf } from './core.ts';
import type { Reader } from './core.ts';
import {
  CLAIM_TYPES, DIMENSIONS, EDITORIAL_VALUES, FACTUAL_VALUES, KINDS, PROPOSAL_NOTICE, PROPOSAL_ORIGINS, RELATIONSHIP_NOTICE, SCHEMA, SIMILARITY_NOTICE, STANCES,
  describeSelector, idOf, ids, interval, label, manifest, oneOf, optText, selector, similarity, strict, text, urefKey, urefOf, urefs,
} from './model.ts';
import type { Dimension, EngineDeps, Flag, Kind, Obj, ObjRef, Selector, TimeInterval } from './model.ts';

const S = SCHEMA;
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const HUMAN_ONLY = 'Only a human may do this directly; agents and services submit proposals for human review';
const INDEPENDENCE_NOTICE = 'Copies of one underlying report are one source family. Repetition adds no independence, and independence is not verification.';

// ───────────────────────────── Public types ─────────────────────────────
export type ObjectView = { ref: string; kind: string; id: string; revision: number; state: string; status: string; compartment: string | null; caseId: string | null; stale: boolean; blocked: boolean; flags: Flag[]; createdAt: string; createdBy: string; updatedAt: string; [field: string]: any };
export type Idem = { idempotencyKey?: string };
export type Placement = { compartment?: string | null; caseId?: string | null };
export type EntityInput = { entityType: string; name: string; aliases?: string[]; description?: string | null; attributes?: Record<string, Json>; protectedIdentity?: boolean; identityCompartment?: string | null; pseudonym?: string; identityRefs?: string[] };
export type ClaimInput = { text: string; claimType: typeof CLAIM_TYPES[number]; subjects?: ObjRef[]; time?: TimeInterval | null; derivedFrom?: string[]; statementId?: string | null; question?: string | null; language?: string | null };
export type LinkInput = { target: ObjRef; evidenceRef: string; representationRef?: string | null; selector: Selector; stance: typeof STANCES[number]; note?: string | null; sourceType?: string | null; similarity?: number | null };
export type EvidenceInput = Omit<LinkInput, 'target'>;
export type RelationshipInput = { relationshipType: string; fromEntityId: string; to: ObjRef; label?: string | null; time?: TimeInterval | null; note?: string | null; evidence: EvidenceInput[] };
export type EventInput = { title: string; description?: string | null; time: TimeInterval; placeEntityId?: string | null; participantEntityIds?: string[]; claimIds?: string[] };
export type StatementInput = { speakerEntityId?: string | null; speakerLabel?: string | null; text: string; saidAt?: TimeInterval | null; venue?: string | null; sourceRef: string; selector?: Selector | null; permissionRefs?: string[]; identityRefs?: string[] };
export type AssessmentInput = { dimension: Dimension; value: string; rationale: string; cites?: { linkIds?: string[]; familyIds?: string[] }; documentedRationale?: boolean; conditions?: string | null; proposalId?: string };
export type ProposalOrigin = { kind: typeof PROPOSAL_ORIGINS[number]; ref?: string; label?: string };
export type AssessmentView = { id: string | null; claimId: string; dimension: Dimension; value: string; recorded: boolean; rationale: string | null; basis: string | null; cites: { linkIds: string[]; familyIds: string[] }; detail: Record<string, Json>; status: 'final' | 'proposed' | 'default'; decision: string | null; decidedBy: string | null; decidedAt: string | null; decisionReason: string | null; proposalId: string | null; claimRevision: number | null; actorId: string | null; actorKind: string | null; at: string | null; flags: Json[]; needsReverification: boolean };
export type Graph = { scope: Record<string, string>; nodes: { id: string; type: string; label: string; [k: string]: any }[]; edges: { from: string; to: string; type: string; [k: string]: any }[]; table: { columns: string[]; rows: string[][] }; text: string; notices: string[] };
export type Impact = { refs: string[]; evidenceLinks: string[]; statements: string[]; claims: string[]; assessments: { id: string; claimId: string; dimension: string; value: string }[]; relationships: string[]; events: string[]; alternatives: string[]; contradictions: string[]; paths: { ref: string; via: string[] }[] };

export type KnowledgeEngine = ReturnType<typeof createEngine>;

export function createEngine(deps: EngineDeps) {
  const core = createCore(deps);
  const { sql, cfg } = core;
  const ports = deps.ports ?? {};

  // ───────────────────────────── plumbing ─────────────────────────────
  async function reauthorize(ctx: ServiceContext, capability: string, resource?: string): Promise<void> {
    if (ports.authorization === undefined) return;
    let allowed = false;
    try { allowed = (await ports.authorization.authorize(ctx, { capability, ...(resource === undefined ? {} : { resource }) })).allowed === true; } catch { allowed = false; }
    if (!allowed) throw new DomainError('forbidden', `Authorization for ${capability} was not confirmed`);
  }
  async function cmd<R>(ctx: ServiceContext, capability: string, op: string, input: Idem | undefined, fn: (tx: Sql) => Promise<R>, o: { human?: boolean; recheck?: boolean } = {}): Promise<R> {
    requireCapability(ctx, capability);
    if (o.human === true) invariant(ctx.actor.kind === 'human', 'forbidden', HUMAN_ONLY);
    if (o.recheck === true) await reauthorize(ctx, capability);
    const { idempotencyKey, ...rest } = (input ?? {}) as Idem & Record<string, unknown>;
    return sql.tx((tx) => idempotent(tx, S, ctx, idempotencyKey, { op, input: rest }, async () => (await fn(tx)) as unknown as Json)) as Promise<R>;
  }
  const placement = (i: Record<string, unknown>): { compartment: string | null; caseId: string | null } => ({ compartment: label(i.compartment, 'compartment'), caseId: label(i.caseId, 'caseId') });
  const PLACE = ['compartment', 'caseId', 'idempotencyKey'];
  const REV = ['expectedRevision', 'reason', 'idempotencyKey'];

  // ───────────────────────────── views ─────────────────────────────
  function bodyView(kind: Kind, id: string, b: Record<string, any>, R: Reader): Record<string, any> {
    if (kind === 'entity') {
      if (R.withheld(id)) return { entityType: b.entityType, name: R.pseudonym(id), aliases: [], description: null, attributes: {}, protectedIdentity: b.protectedIdentity === true, identityCompartment: b.identityCompartment ?? null, pseudonym: R.pseudonym(id), identityRefs: [], identityWithheld: true };
      return { ...b, identityWithheld: false };
    }
    if (kind === 'claim') return { ...b, subjects: (b.subjects as ObjRef[]).map((s) => (s.kind === 'entity' ? { ...s, resolvedId: R.root(s.id) } : s)) };
    if (kind === 'relationship') return { ...b, from: { ...b.from, resolvedId: R.root(b.from.id) }, to: b.to.kind === 'entity' ? { ...b.to, resolvedId: R.root(b.to.id) } : b.to, notice: RELATIONSHIP_NOTICE };
    if (kind === 'event') return { ...b, resolvedParticipantEntityIds: [...new Set((b.participantEntityIds as string[]).map(R.root))] };
    if (kind === 'statement') return { ...b, resolvedSpeakerEntityId: b.speakerEntityId === null ? null : R.root(b.speakerEntityId) };
    if (kind === 'evidence_link') return { ...b, selectorLabel: describeSelector(b.selector as Selector) };
    if (kind === 'proposal') {
      const it = b.item as Record<string, any>;
      const hide = b.proposalType === 'entity' && it.protectedIdentity === true && !(hasCapability(R.ctx, 'knowledge:disclose_identity') && (it.identityCompartment === null || R.ctx.compartments.includes(it.identityCompartment)));
      return { ...b, item: hide ? { ...it, name: '[identity withheld]', aliases: [], description: null, attributes: {}, identityRefs: [], identityWithheld: true } : it };
    }
    return { ...b };
  }
  function view(o: Obj, R: Reader): ObjectView {
    const out: ObjectView = { ref: objRef(o), kind: o.kind, id: o.id, revision: o.revision, state: o.state, status: statusOf(o), compartment: o.compartment, caseId: o.caseId, stale: o.stale, blocked: o.blocked, flags: activeFlags(o), createdAt: o.createdAt, createdBy: o.createdBy, updatedAt: o.updatedAt, ...bodyView(o.kind, o.id, o.body, R) };
    if (o.kind === 'entity') {
      const p = R.protection.parent.get(o.id);
      out.mergedInto = p === undefined ? null : R.root(o.id);
      out.mergedFrom = (R.protection.children.get(o.id) ?? []).map((c) => ({ entityId: c.entityId, mergeId: c.mergeId }));
      if (p !== undefined) out.status = 'merged';
    }
    return out;
  }
  function titleOf(o: Obj, R: Reader): string {
    const b = o.body, cut = (s: unknown): string => { const t = String(s ?? ''); return t.length > 140 ? `${t.slice(0, 140)}…` : t; };
    switch (o.kind) {
      case 'entity': return R.withheld(o.id) ? R.pseudonym(o.id) : cut(b.name);
      case 'claim': return cut(b.text);
      case 'event': return cut(b.title);
      case 'statement': return `Statement: ${cut(b.text)}`;
      case 'relationship': return `Relationship (${b.relationshipType})`;
      case 'evidence_link': return `${b.stance}: ${b.evidenceRef} (${describeSelector(b.selector as Selector)})`;
      case 'source_family': return cut(b.label);
      case 'contradiction': return `Contradiction: ${cut(b.description)}`;
      case 'alternative': return `Alternative explanation: ${cut(b.text)}`;
      case 'proposal': return `Proposed ${b.proposalType}`;
      case 'entity_match': return `Entity match decision: ${b.decision}`;
      default: return `Entity merge (${o.state})`;
    }
  }
  /** Merged-group alias union for an entity view (names of withheld members appear only as their pseudonym). */
  async function entityView(q: Sql, ctx: ServiceContext, o: Obj, R: Reader): Promise<ObjectView> {
    const v = view(o, R);
    const others = R.members(o.id).filter((id) => id !== R.root(o.id));
    if (v.mergedInto === null && others.length > 0 && !R.withheld(o.id)) {
      const merged = await core.many(q, ctx, 'entity', others, { raw: true });
      v.aliases = [...new Set([...(v.aliases as string[]), ...merged.flatMap((m) => [m.body.name as string, ...(m.body.aliases as string[])])])].filter((a) => a !== v.name);
    }
    return v;
  }

  // ───────────────────────────── assessments (read) ─────────────────────────────
  const DEFAULT_VALUE: Record<Dimension, string> = { factual: 'unassessed', source_type: 'unclassified', procedural: 'not_recorded', editorial: 'not_reviewed' };
  const toAssessment = (r: Record<string, any>): AssessmentView => ({
    id: r.id, claimId: r.claim_id, dimension: r.dimension, value: r.value, recorded: true, rationale: r.rationale, basis: r.basis ?? null, cites: r.cites, detail: r.detail, status: r.status,
    decision: r.decision ?? null, decidedBy: r.decided_by ?? null, decidedAt: r.decided_at ? iso(r.decided_at) : null, decisionReason: r.decision_reason ?? null, proposalId: r.proposal_id ?? null,
    claimRevision: r.claim_revision, actorId: r.actor_id, actorKind: r.actor_kind, at: iso(r.at), flags: r.flags, needsReverification: (r.flags as any[]).some((f) => f.clearedAt === undefined),
  });
  async function assessmentsOf(q: Sql, ctx: ServiceContext, claimIds: readonly string[]): Promise<Map<string, AssessmentView[]>> {
    const out = new Map<string, AssessmentView[]>();
    if (claimIds.length === 0) return out;
    for (const r of await q.query(`select * from ${S}.assessments where tenant_id=$1 and project_id=$2 and claim_id = any($3) order by seq`, [...core.scope(ctx), [...claimIds]])) {
      const a = toAssessment(r); out.set(a.claimId, [...(out.get(a.claimId) ?? []), a]);
    }
    return out;
  }
  function currentOf(claimId: string, rows: readonly AssessmentView[]): Record<Dimension, AssessmentView> & { pendingProposals: AssessmentView[] } {
    const cur = {} as Record<Dimension, AssessmentView>;
    for (const d of DIMENSIONS) {
      const last = rows.filter((r) => r.dimension === d && r.status === 'final').at(-1);
      cur[d] = last ?? { id: null, claimId, dimension: d, value: DEFAULT_VALUE[d], recorded: false, rationale: null, basis: null, cites: { linkIds: [], familyIds: [] }, detail: {}, status: 'default', decision: null, decidedBy: null, decidedAt: null, decisionReason: null, proposalId: null, claimRevision: null, actorId: null, actorKind: null, at: null, flags: [], needsReverification: false };
    }
    return { ...cur, pendingProposals: rows.filter((r) => r.status === 'proposed' && r.decision === null) };
  }

  // ───────────────────────────── links, families, independence ─────────────────────────────
  async function linksFor(q: Sql, ctx: ServiceContext, targetIds: readonly string[], o: { raw?: boolean; all?: boolean } = {}): Promise<Obj[]> {
    if (targetIds.length === 0) return [];
    const rows = await core.list(q, ctx, 'evidence_link', { where: `body->'target'->>'id' = any($5)`, params: [[...targetIds]], limit: 5000, ...(o.raw === true ? { raw: true } : {}) });
    return o.all === true ? rows : rows.filter((l) => l.state === 'active');
  }
  async function familyMap(q: Sql, ctx: ServiceContext, keys: readonly string[]): Promise<Map<string, { id: string; label: string }>> {
    const out = new Map<string, { id: string; label: string }>();
    if (keys.length === 0) return out;
    for (const r of await q.query<{ source_key: string; family_id: string; label: string }>(`select m.source_key, m.family_id, o.body->>'label' as label from ${S}.family_members m join ${S}.objects o on o.tenant_id=m.tenant_id and o.project_id=m.project_id and o.kind='source_family' and o.id=m.family_id
      where m.tenant_id=$1 and m.project_id=$2 and m.source_key = any($3)`, [...core.scope(ctx), [...new Set(keys)]])) out.set(r.source_key, { id: r.family_id, label: r.label });
    return out;
  }
  const linkKeys = (l: Obj): string[] => [urefKey(l.body.evidenceRef), ...(l.body.representationRef ? [urefKey(l.body.representationRef)] : [])];
  function familyOfLink(l: Obj, fam: Map<string, { id: string; label: string }>): { key: string; familyId: string | null; label: string } {
    for (const k of linkKeys(l)) { const f = fam.get(k); if (f !== undefined) return { key: `family:${f.id}`, familyId: f.id, label: f.label }; }
    const k = urefKey(l.body.evidenceRef);
    return { key: `single:${k}`, familyId: null, label: `Single source ${k}` };
  }
  function independenceOf(links: readonly Obj[], fam: Map<string, { id: string; label: string }>): Record<string, any> {
    const groups = new Map<string, { key: string; familyId: string | null; label: string; linkIds: string[]; stances: string[]; sources: string[] }>();
    for (const l of links) {
      const f = familyOfLink(l, fam);
      const g = groups.get(f.key) ?? { ...f, linkIds: [], stances: [], sources: [] };
      g.linkIds.push(l.id); if (!g.stances.includes(l.body.stance)) g.stances.push(l.body.stance); const src = urefKey(l.body.evidenceRef); if (!g.sources.includes(src)) g.sources.push(src);
      groups.set(f.key, g);
    }
    const families = [...groups.values()].map((g) => ({ ...g, copies: g.sources.length }));
    const count = (stance: string): { links: number; families: number } => ({ links: links.filter((l) => l.body.stance === stance).length, families: families.filter((f) => f.stances.includes(stance)).length });
    const supporting = count('supports');
    return { supporting, challenging: count('challenges'), context: count('context'), families, independentCorroboration: supporting.families >= 2, notice: INDEPENDENCE_NOTICE };
  }

  // ───────────────────────────── validation of inputs ─────────────────────────────
  const E_KEYS = ['entityType', 'name', 'aliases', 'description', 'attributes', 'protectedIdentity', 'identityCompartment', 'pseudonym', 'identityRefs'];
  function vEntity(i: Record<string, unknown>, prior?: Record<string, any>): Record<string, any> {
    const m = { ...(prior ?? {}), ...Object.fromEntries(Object.entries(i).filter(([k, v]) => E_KEYS.includes(k) && v !== undefined)) } as Record<string, unknown>;
    const aliases = m.aliases === undefined || m.aliases === null ? [] : (invariant(Array.isArray(m.aliases) && m.aliases.length <= 100, 'invalid_input', 'aliases must be a list'), [...new Set((m.aliases as unknown[]).map((a) => text(a, 'alias', 500)))]);
    const attributes = m.attributes === undefined || m.attributes === null ? {} : m.attributes;
    invariant(typeof attributes === 'object' && !Array.isArray(attributes) && JSON.stringify(attributes).length <= 8192, 'invalid_input', 'attributes must be a small JSON object');
    invariant(m.protectedIdentity === undefined || typeof m.protectedIdentity === 'boolean', 'invalid_input', 'protectedIdentity must be a boolean');
    return {
      entityType: oneOf(m.entityType, cfg.entityTypes, 'entityType'), name: text(m.name, 'name', 500), aliases, description: optText(m.description, 'description', 8000),
      attributes: JSON.parse(JSON.stringify(attributes)), protectedIdentity: m.protectedIdentity === true, identityCompartment: label(m.identityCompartment, 'identityCompartment'),
      pseudonym: optText(m.pseudonym, 'pseudonym', 120), identityRefs: urefs(m.identityRefs, 'identityRefs'),
    };
  }
  const C_KEYS = ['text', 'claimType', 'subjects', 'time', 'derivedFrom', 'statementId', 'question', 'language'];
  function objRefs(v: unknown, kinds: readonly string[], name: string): ObjRef[] {
    if (v === undefined || v === null) return [];
    invariant(Array.isArray(v) && v.length <= 50, 'invalid_input', `${name} must be a list of at most 50 references`);
    const seen = new Set<string>();
    return (v as unknown[]).map((x) => { const r = strict<Record<string, unknown>>(x, ['kind', 'id'], name); return { kind: oneOf(r.kind, kinds, `${name}.kind`), id: idOf(r.id, `${name}.id`) }; }).filter((r) => (seen.has(`${r.kind}:${r.id}`) ? false : (seen.add(`${r.kind}:${r.id}`), true)));
  }
  function vClaim(i: Record<string, unknown>, prior?: Record<string, any>): Record<string, any> {
    const m = { ...(prior ?? {}), ...Object.fromEntries(Object.entries(i).filter(([k, v]) => C_KEYS.includes(k) && v !== undefined)) } as Record<string, unknown>;
    const out = {
      text: text(m.text, 'text', 16000), claimType: oneOf(m.claimType, CLAIM_TYPES, 'claimType'), subjects: objRefs(m.subjects, ['entity', 'event', 'relationship'], 'subjects'),
      time: interval(m.time, 'time'), derivedFrom: ids(m.derivedFrom, 'derivedFrom', 50), statementId: m.statementId === undefined || m.statementId === null ? null : idOf(m.statementId, 'statementId'),
      question: optText(m.question, 'question', 2000), language: label(m.language, 'language'), provenance: (prior?.provenance ?? null) as Json,
    };
    invariant(out.claimType !== 'attributed_statement' || out.statementId !== null, 'invalid_input', 'An attributed_statement claim must reference the statement it attributes (statementId)');
    return out;
  }
  const L_KEYS = ['evidenceRef', 'representationRef', 'selector', 'stance', 'note', 'sourceType', 'similarity'];
  function vEvidence(i: Record<string, unknown>, prior?: Record<string, any>): Record<string, any> {
    const m = { ...(prior ?? {}), ...Object.fromEntries(Object.entries(i).filter(([k, v]) => L_KEYS.includes(k) && v !== undefined)) } as Record<string, any>;
    return {
      evidenceRef: urefOf(m.evidenceRef, 'evidenceRef', { pinned: true }), representationRef: m.representationRef === undefined || m.representationRef === null ? null : urefOf(m.representationRef, 'representationRef'),
      selector: selector(m.selector), stance: oneOf(m.stance, STANCES, 'stance'), note: optText(m.note, 'note', 4000),
      sourceType: m.sourceType === undefined || m.sourceType === null ? null : oneOf(m.sourceType, cfg.sourceTypes, 'sourceType'),
      similarity: prior !== undefined && i.similarity === undefined ? (prior.similarity ?? null) : similarity(m.similarity),
    };
  }
  const vTarget = (v: unknown): ObjRef => { const r = strict<Record<string, unknown>>(v, ['kind', 'id'], 'target'); return { kind: oneOf(r.kind, ['claim', 'relationship', 'event', 'alternative'], 'target.kind'), id: idOf(r.id, 'target.id') }; };
  function vOrigin(v: unknown): Record<string, Json> {
    const o = strict<Record<string, unknown>>(v, ['kind', 'ref', 'label'], 'origin');
    return { kind: oneOf(o.kind, PROPOSAL_ORIGINS, 'origin.kind'), ref: o.ref === undefined || o.ref === null ? null : urefOf(o.ref, 'origin.ref'), label: optText(o.label, 'origin.label', 300) };
  }

  // ───────────────────────────── evidence validation (optional port) ─────────────────────────────
  type Validation = { state: 'released' | 'not_released' | 'unvalidated'; reason?: string; checkedAt: string; sha256?: string; mediaType?: string; evidenceCompartment?: string | null };
  async function validateEvidence(ctx: ServiceContext, ref: string): Promise<Validation> {
    const at = iso(ctx.now);
    if (ports.evidence === undefined) return { state: 'unvalidated', reason: 'No EvidencePort is configured; existence and release of the cited version were not checked', checkedAt: at };
    if (parseUref(ref).engine !== 'E05') return { state: 'unvalidated', reason: 'Only E05 evidence versions can be validated through the EvidencePort', checkedAt: at };
    let info;
    try { info = await ports.evidence.describe(ctx, ref); }
    catch (error) { if (error instanceof DomainError && ['not_found', 'scope_denied', 'forbidden'].includes(error.code)) info = null; else throw new DomainError('unavailable', 'The evidence engine could not confirm the cited version'); }
    if (info === null) throw new DomainError('invalid_reference', 'The cited evidence version does not exist or is not accessible');
    return { state: info.available ? 'released' : 'not_released', checkedAt: at, sha256: info.sha256, mediaType: info.mediaType, evidenceCompartment: info.compartment };
  }

  // ───────────────────────────── internal creators (shared by direct commands and accepted proposals) ─────────────────────────────
  const claimDeps = (id: string, b: Record<string, any>) => [
    ...(b.derivedFrom as string[]).map((d) => ({ depKind: 'claim' as Kind, depId: id, sourceRef: selfRef('claim', d), role: 'derived_from' })),
    ...(b.statementId === null ? [] : [{ depKind: 'claim' as Kind, depId: id, sourceRef: selfRef('statement', b.statementId), role: 'statement' }]),
  ];
  async function checkClaimRefs(tx: Sql, ctx: ServiceContext, b: Record<string, any>): Promise<void> {
    for (const s of b.subjects as ObjRef[]) await core.need(tx, ctx, s.kind as Kind, s.id);
    for (const d of b.derivedFrom as string[]) await core.need(tx, ctx, 'claim', d);
    if (b.statementId !== null) await core.need(tx, ctx, 'statement', b.statementId);
  }
  async function mkClaim(tx: Sql, ctx: ServiceContext, b: Record<string, any>, place: { compartment: string | null; caseId: string | null }, provenance: Json): Promise<Obj> {
    await checkClaimRefs(tx, ctx, b);
    const o = await core.create(tx, ctx, 'claim', { body: { ...b, provenance }, ...place });
    await core.setDeps(tx, ctx, 'claim', o.id, claimDeps(o.id, o.body));
    await core.record(tx, ctx, 'knowledge.claim_created', selfRef('claim', o.id), { revision: 1, claimType: b.claimType, provenance }, { type: 'knowledge.claim_created', payload: { ref: objRef(o), claimType: b.claimType } });
    return o;
  }
  async function mkEntity(tx: Sql, ctx: ServiceContext, b: Record<string, any>, place: { compartment: string | null; caseId: string | null }, provenance: Json): Promise<Obj> {
    const id = randomUUID();
    const body: Record<string, any> = { ...b, pseudonym: b.pseudonym ?? `Protected ${b.entityType} ${createHash('sha256').update(id).digest('hex').slice(0, 6)}`, provenance };
    const o = await core.create(tx, ctx, 'entity', { id, body, ...place });
    if (body.protectedIdentity) await core.reindexProject(tx, ctx);
    await core.record(tx, ctx, 'knowledge.entity_created', selfRef('entity', o.id), { revision: 1, entityType: b.entityType, protectedIdentity: body.protectedIdentity }, { type: 'knowledge.entity_changed', payload: { ref: objRef(o), change: 'created' } });
    return o;
  }
  async function mkLink(tx: Sql, ctx: ServiceContext, target: ObjRef, e: Record<string, any>, validation: Validation, compartment: string | null, provenance: Json): Promise<Obj> {
    const t = await core.need(tx, ctx, target.kind as Kind, target.id);
    const o = await core.create(tx, ctx, 'evidence_link', { body: { target, ...e, validation, provenance }, compartment: compartment ?? validation.evidenceCompartment ?? t.compartment, caseId: t.caseId });
    await linkDeps(tx, ctx, o);
    await core.record(tx, ctx, 'knowledge.evidence_link_added', selfRef('evidence_link', o.id), { target: selfRef(target.kind, target.id), stance: e.stance, evidenceRef: e.evidenceRef, validation: validation.state },
      { type: 'knowledge.evidence_link_changed', payload: { ref: objRef(o), target: selfRef(target.kind, target.id), stance: e.stance, change: 'added' } });
    return o;
  }
  async function linkDeps(tx: Sql, ctx: ServiceContext, l: Obj): Promise<void> {
    await core.setDeps(tx, ctx, 'evidence_link', l.id, l.state !== 'active' ? [] : [
      { depKind: 'evidence_link', depId: l.id, sourceRef: l.body.evidenceRef, role: 'evidence' },
      ...(l.body.representationRef ? [{ depKind: 'evidence_link' as Kind, depId: l.id, sourceRef: l.body.representationRef as string, role: 'representation' }] : []),
      { depKind: l.body.target.kind as Kind, depId: l.body.target.id, sourceRef: selfRef('evidence_link', l.id), role: 'evidence_link' },
    ]);
  }
  /** Flags a claim (and everything derived from it) for re-verification when something it was assessed on changed. */
  async function staleClaim(tx: Sql, ctx: ServiceContext, claimId: string, via: string, m: { reason: string; cause: string; changeKind: string }, o: { onlyIfAssessed?: boolean; includeSelf?: boolean } = {}): Promise<string[]> {
    let self = o.includeSelf !== false;
    if (self && o.onlyIfAssessed === true) {
      const cur = currentOf(claimId, (await assessmentsOf(tx, ctx, [claimId])).get(claimId) ?? []);
      self = DIMENSIONS.some((d) => cur[d].recorded && cur[d].value !== DEFAULT_VALUE[d]);
    }
    const hits = [...(self ? [{ kind: 'claim' as Kind, id: claimId, via: [via] }] : []), ...(await core.dependents(tx, ctx, [selfRef('claim', claimId)])).filter((h) => !(h.kind === 'claim' && h.id === claimId))];
    return core.mark(tx, ctx, hits, { flag: 'stale', ...m });
  }
  async function citedBy(tx: Sql, ctx: ServiceContext, link: Obj): Promise<boolean> {
    if (link.body.target.kind !== 'claim') return false;
    const cur = currentOf(link.body.target.id, (await assessmentsOf(tx, ctx, [link.body.target.id])).get(link.body.target.id) ?? []);
    return DIMENSIONS.some((d) => cur[d].recorded && cur[d].cites.linkIds.includes(link.id));
  }

  // ───────────────────────────── entities ─────────────────────────────
  async function createEntity(ctx: ServiceContext, input: EntityInput & Placement & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, [...E_KEYS, ...PLACE], 'entity');
    const b = vEntity(i);
    const { id } = await cmd(ctx, 'knowledge:write', 'createEntity', input, async (tx) => ({ id: (await mkEntity(tx, ctx, b, placement(i), null)).id }), { human: true });
    return getEntity(ctx, id);
  }
  async function reviseEntity(ctx: ServiceContext, id: string, input: Partial<EntityInput> & { expectedRevision: number; reason: string; state?: string } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, [...E_KEYS, ...REV, 'state', 'compartment'], 'entity revision');
    const reason = text(i.reason, 'reason', 2000);
    await cmd(ctx, 'knowledge:write', `reviseEntity:${id}`, input, async (tx) => {
      const o = await core.need(tx, ctx, 'entity', id, { lock: true });
      core.expect(o, i.expectedRevision);
      if ((await core.reader(tx, ctx)).withheld(id)) throw new DomainError('forbidden', 'This identity is withheld from you; it cannot be revised without knowledge:disclose_identity');
      const body: Record<string, any> = { ...vEntity(i, o.body), provenance: o.body.provenance ?? null };
      body.pseudonym = body.pseudonym ?? o.body.pseudonym;
      const next = await core.revise(tx, ctx, o, { body, reason, ...(i.state === undefined ? {} : { state: oneOf(i.state, ['active', 'withdrawn'], 'state') }), ...(i.compartment === undefined ? {} : { compartment: label(i.compartment, 'compartment') }) });
      await core.reindexProject(tx, ctx);
      await core.record(tx, ctx, 'knowledge.entity_revised', selfRef('entity', id), { revision: next.revision, protectedIdentity: body.protectedIdentity }, { type: 'knowledge.entity_changed', payload: { ref: objRef(next), change: 'revised' } });
      return { id };
    }, { human: true });
    return getEntity(ctx, id);
  }
  async function getEntity(ctx: ServiceContext, id: string): Promise<ObjectView> {
    requireCapability(ctx, 'knowledge:read');
    const o = await core.need(sql, ctx, 'entity', id);
    const R = await core.reader(sql, ctx);
    if (o.body.protectedIdentity === true && !R.withheld(id)) {
      await reauthorize(ctx, 'knowledge:disclose_identity', selfRef('entity', id));
      await sql.tx((tx) => core.record(tx, ctx, 'knowledge.identity_disclosed', selfRef('entity', id), { revision: o.revision }));
    }
    return R.deep(await entityView(sql, ctx, o, R));
  }
  async function mergeEntities(ctx: ServiceContext, input: { survivorId: string; mergedId: string; rationale: string } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, ['survivorId', 'mergedId', 'rationale', 'idempotencyKey'], 'merge');
    const survivorId = idOf(i.survivorId, 'survivorId'), mergedId = idOf(i.mergedId, 'mergedId'), rationale = text(i.rationale, 'rationale', 4000);
    const { id } = await cmd(ctx, 'knowledge:merge', 'mergeEntities', input, async (tx) => {
      const a = await core.need(tx, ctx, 'entity', survivorId, { lock: true }), b = await core.need(tx, ctx, 'entity', mergedId, { lock: true });
      const R = await core.reader(tx, ctx);
      invariant(!R.withheld(a.id) && !R.withheld(b.id), 'forbidden', 'Entities whose identity is withheld from you cannot be merged');
      invariant(R.root(a.id) !== R.root(b.id), 'conflict', 'These records are already one merged entity');
      invariant(!R.protection.parent.has(b.id), 'conflict', 'The record to merge is already merged into another entity; reverse that merge first');
      const match = await core.load(tx, ctx, 'entity_match', matchId(a.id, b.id), { raw: true });
      invariant(match === null || match.body.decision !== 'different', 'conflict', 'A recorded identity decision says these are different entities; revise that decision before merging');
      // The merge is a separate reversible record: neither original row is modified, and links are re-pointed only virtually.
      const m = await core.create(tx, ctx, 'entity_merge', { body: { survivorId, mergedId, rationale, originals: { survivor: objRef(a), merged: objRef(b) }, reversal: null }, reason: rationale });
      await core.reindexProject(tx, ctx);
      await core.record(tx, ctx, 'knowledge.entity_merged', selfRef('entity', survivorId), { mergeId: m.id, merged: selfRef('entity', mergedId) }, { type: 'knowledge.entity_merged', payload: { mergeId: m.id, survivor: objRef(a), merged: objRef(b) } });
      return { id: m.id };
    }, { human: true, recheck: true });
    return get(ctx, 'entity_merge', id);
  }
  async function unmergeEntities(ctx: ServiceContext, mergeId: string, input: { reason: string } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, ['reason', 'idempotencyKey'], 'unmerge');
    const reason = text(i.reason, 'reason', 4000);
    await cmd(ctx, 'knowledge:merge', `unmergeEntities:${mergeId}`, input, async (tx) => {
      const m = await core.need(tx, ctx, 'entity_merge', mergeId, { lock: true });
      invariant(m.state === 'active', 'invalid_state', 'This merge has already been reversed');
      await core.revise(tx, ctx, m, { state: 'reversed', body: { ...m.body, reversal: { reason, by: ctx.actor.id, at: iso(ctx.now) } }, reason });
      await core.reindexProject(tx, ctx);
      await core.record(tx, ctx, 'knowledge.entity_unmerged', selfRef('entity', m.body.survivorId), { mergeId, merged: selfRef('entity', m.body.mergedId) }, { type: 'knowledge.entity_unmerged', payload: { mergeId, survivor: selfRef('entity', m.body.survivorId), merged: selfRef('entity', m.body.mergedId) } });
      return { id: mergeId };
    }, { human: true, recheck: true });
    return get(ctx, 'entity_merge', mergeId);
  }
  const matchId = (a: string, b: string): string => `m-${createHash('sha256').update([a, b].sort().join('|')).digest('hex').slice(0, 40)}`;
  async function mkMatch(tx: Sql, ctx: ServiceContext, leftId: string, rightId: string, decision: string, rationale: string, sim: Json, expectedRevision?: unknown): Promise<Obj> {
    invariant(leftId !== rightId, 'invalid_input', 'Two different entities are required');
    await core.need(tx, ctx, 'entity', leftId); await core.need(tx, ctx, 'entity', rightId);
    const [a, b] = [leftId, rightId].sort() as [string, string];
    const id = matchId(a, b);
    const prior = await core.load(tx, ctx, 'entity_match', id, { raw: true, lock: true });
    const body = { leftId: a, rightId: b, decision, rationale, similarity: sim };
    let o: Obj;
    if (prior === null) o = await core.create(tx, ctx, 'entity_match', { id, body, reason: rationale });
    else { if (expectedRevision !== undefined) core.expect(prior, expectedRevision); o = await core.revise(tx, ctx, prior, { body, reason: rationale }); }
    await core.record(tx, ctx, 'knowledge.entity_match_recorded', selfRef('entity_match', id), { decision, revision: o.revision }, { type: 'knowledge.entity_match_recorded', payload: { ref: objRef(o), decision, entities: [selfRef('entity', a), selfRef('entity', b)] } });
    return o;
  }
  /** Records a same/different/unresolved identity decision for a pair. It never merges; disputed matches stay visible. */
  async function recordEntityMatch(ctx: ServiceContext, input: { leftId: string; rightId: string; decision: 'same' | 'different' | 'unresolved'; rationale: string; similarity?: number | null; expectedRevision?: number } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, ['leftId', 'rightId', 'decision', 'rationale', 'similarity', 'expectedRevision', 'idempotencyKey'], 'entity match');
    const decision = oneOf(i.decision, ['same', 'different', 'unresolved'], 'decision'), rationale = text(i.rationale, 'rationale', 4000), sim = similarity(i.similarity);
    const { id } = await cmd(ctx, 'knowledge:write', 'recordEntityMatch', input, async (tx) => ({ id: (await mkMatch(tx, ctx, idOf(i.leftId, 'leftId'), idOf(i.rightId, 'rightId'), decision, rationale, sim, i.expectedRevision)).id }), { human: true });
    return get(ctx, 'entity_match', id);
  }

  // ───────────────────────────── claims ─────────────────────────────
  async function createClaim(ctx: ServiceContext, input: ClaimInput & Placement & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, [...C_KEYS, ...PLACE], 'claim');
    const b = vClaim(i);
    const { id } = await cmd(ctx, 'knowledge:write', 'createClaim', input, async (tx) => ({ id: (await mkClaim(tx, ctx, b, placement(i), null)).id }), { human: true });
    return getClaim(ctx, id);
  }
  async function reviseClaim(ctx: ServiceContext, id: string, input: Partial<ClaimInput> & { expectedRevision: number; reason: string; state?: 'active' | 'withdrawn' | 'superseded'; compartment?: string | null } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, [...C_KEYS, ...REV, 'state', 'compartment'], 'claim revision');
    const reason = text(i.reason, 'reason', 2000);
    await cmd(ctx, 'knowledge:write', `reviseClaim:${id}`, input, async (tx) => {
      const o = await core.need(tx, ctx, 'claim', id, { lock: true });
      core.expect(o, i.expectedRevision);
      const body = vClaim(i, o.body);
      await checkClaimRefs(tx, ctx, body);
      const down = await core.dependents(tx, ctx, [selfRef('claim', id)]);
      invariant(!body.derivedFrom.includes(id) && !down.some((h) => h.kind === 'claim' && body.derivedFrom.includes(h.id)), 'invalid_input', 'A claim cannot be derived from itself or from its own derivatives');
      const next = await core.revise(tx, ctx, o, { body, reason, ...(i.state === undefined ? {} : { state: oneOf(i.state, ['active', 'withdrawn', 'superseded'], 'state') }), ...(i.compartment === undefined ? {} : { compartment: label(i.compartment, 'compartment') }) });
      await core.setDeps(tx, ctx, 'claim', id, claimDeps(id, body));
      const substantive = body.text !== o.body.text || body.claimType !== o.body.claimType || JSON.stringify(body.subjects) !== JSON.stringify(o.body.subjects) || JSON.stringify(body.time) !== JSON.stringify(o.body.time) || next.state !== o.state;
      await core.record(tx, ctx, 'knowledge.claim_revised', selfRef('claim', id), { revision: next.revision, substantive, state: next.state }, { type: 'knowledge.claim_changed', payload: { ref: objRef(next), change: 'revised', substantive, refs: [objRef(next)], claims: [objRef(next)] } });
      if (substantive) await staleClaim(tx, ctx, id, objRef(next), { reason: 'The claim was revised after it was assessed or relied upon', cause: `claim-revision:${id}@${next.revision}`, changeKind: 'claim_changed' }, { onlyIfAssessed: true });
      return { id };
    }, { human: true });
    return getClaim(ctx, id);
  }
  /** Claim dossier: the claim with all four assessment tracks, supporting AND challenging material, families, contradictions and alternatives. */
  async function getClaim(ctx: ServiceContext, id: string): Promise<ObjectView> {
    requireCapability(ctx, 'knowledge:read');
    const R = await core.reader(sql, ctx);
    return R.deep((await dossiers(sql, ctx, [await core.need(sql, ctx, 'claim', id)], R))[0] as ObjectView);
  }
  async function dossiers(q: Sql, ctx: ServiceContext, claims: readonly Obj[], R: Reader): Promise<ObjectView[]> {
    const cids = claims.map((c) => c.id);
    const [assess, links, alts, contras] = [await assessmentsOf(q, ctx, cids), await linksFor(q, ctx, cids), await core.list(q, ctx, 'alternative', { where: `body->>'claimId' = any($5)`, params: [cids], limit: 5000 }), await core.list(q, ctx, 'contradiction', { limit: 5000 })];
    const fam = await familyMap(q, ctx, links.flatMap(linkKeys));
    const statements = new Map((await core.many(q, ctx, 'statement', claims.flatMap((c) => (c.body.statementId ? [c.body.statementId as string] : [])))).map((s) => [s.id, s]));
    return claims.map((c) => {
      const mine = links.filter((l) => l.body.target.kind === 'claim' && l.body.target.id === c.id);
      const lv = (stance: string) => mine.filter((l) => l.body.stance === stance).map((l) => ({ ...view(l, R), family: familyOfLink(l, fam) }));
      const linkIdSet = new Set(mine.map((l) => l.id));
      const st = c.body.statementId ? statements.get(c.body.statementId) : undefined;
      return {
        ...view(c, R),
        assessments: currentOf(c.id, assess.get(c.id) ?? []),
        evidence: { supporting: lv('supports'), challenging: lv('challenges'), context: lv('context') },
        independence: independenceOf(mine, fam),
        contradictions: contras.filter((x) => (x.body.members as ObjRef[]).some((m) => (m.kind === 'claim' && m.id === c.id) || (m.kind === 'evidence_link' && linkIdSet.has(m.id)))).map((x) => view(x, R)),
        alternatives: alts.filter((a) => a.body.claimId === c.id).map((a) => view(a, R)),
        statement: st === undefined ? null : view(st, R),
        notices: [INDEPENDENCE_NOTICE, 'Factual assessment, source type, procedural status and editorial approval are separate decisions; none implies another.'],
      };
    });
  }

  // ───────────────────────────── attributed statements ─────────────────────────────
  const ST_KEYS = ['speakerEntityId', 'speakerLabel', 'text', 'saidAt', 'venue', 'sourceRef', 'selector', 'permissionRefs', 'identityRefs'];
  function vStatement(i: Record<string, unknown>, prior?: Record<string, any>): Record<string, any> {
    const m = { ...(prior ?? {}), ...Object.fromEntries(Object.entries(i).filter(([k, v]) => ST_KEYS.includes(k) && v !== undefined)) } as Record<string, unknown>;
    const out = {
      speakerEntityId: m.speakerEntityId === undefined || m.speakerEntityId === null ? null : idOf(m.speakerEntityId, 'speakerEntityId'), speakerLabel: optText(m.speakerLabel, 'speakerLabel', 500),
      text: text(m.text, 'text', 16000), saidAt: interval(m.saidAt, 'saidAt'), venue: optText(m.venue, 'venue', 1000), sourceRef: urefOf(m.sourceRef, 'sourceRef'),
      selector: m.selector === undefined || m.selector === null ? null : selector(m.selector), permissionRefs: urefs(m.permissionRefs, 'permissionRefs'), identityRefs: urefs(m.identityRefs, 'identityRefs'),
    };
    invariant(out.speakerEntityId !== null || out.speakerLabel !== null, 'invalid_input', 'An attributed statement needs a speaker (speakerEntityId or speakerLabel)');
    return out;
  }
  async function useOf(ctx: ServiceContext, b: Record<string, any>): Promise<Record<string, Json>> {
    if (ports.useDecision === undefined) return { decision: 'unchecked', reasons: ['No UseDecisionPort is configured; permission to use this statement was not checked'], permissionRefs: [], restrictions: [], decidedAt: iso(ctx.now) };
    const d = await ports.useDecision.decide(ctx, { subjects: [b.sourceRef, ...b.permissionRefs, ...b.identityRefs], action: 'investigate', purpose: ctx.purpose });
    if (d.decision === 'deny') throw new DomainError('consent_denied', 'Use of this statement for investigation is not permitted');
    return { decision: d.decision, reasons: [...d.reasons], permissionRefs: [...d.permissionRefs], restrictions: [...d.restrictions], decidedAt: d.decidedAt };
  }
  const statementDeps = (id: string, b: Record<string, any>) => [
    { depKind: 'statement' as Kind, depId: id, sourceRef: b.sourceRef as string, role: 'source' },
    ...[...new Set([...(b.permissionRefs as string[]), ...((b.use?.permissionRefs ?? []) as string[])])].map((r) => ({ depKind: 'statement' as Kind, depId: id, sourceRef: r, role: 'permission' })),
    ...(b.identityRefs as string[]).map((r) => ({ depKind: 'statement' as Kind, depId: id, sourceRef: r, role: 'identity' })),
  ];
  async function createStatement(ctx: ServiceContext, input: StatementInput & Placement & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, [...ST_KEYS, ...PLACE], 'statement');
    requireCapability(ctx, 'knowledge:write');
    const b = vStatement(i);
    const use = await useOf(ctx, b);
    const { id } = await cmd(ctx, 'knowledge:write', 'createStatement', input, async (tx) => {
      if (b.speakerEntityId !== null) await core.need(tx, ctx, 'entity', b.speakerEntityId);
      const o = await core.create(tx, ctx, 'statement', { body: { ...b, use }, ...placement(i) });
      await core.setDeps(tx, ctx, 'statement', o.id, statementDeps(o.id, o.body));
      await core.record(tx, ctx, 'knowledge.statement_created', selfRef('statement', o.id), { revision: 1, sourceRef: b.sourceRef, use: use.decision as string }, { type: 'knowledge.statement_changed', payload: { ref: objRef(o), change: 'created' } });
      return { id: o.id };
    }, { human: true });
    return get(ctx, 'statement', id);
  }
  async function reviseStatement(ctx: ServiceContext, id: string, input: Partial<StatementInput> & { expectedRevision: number; reason: string; state?: 'active' | 'withdrawn' } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, [...ST_KEYS, ...REV, 'state'], 'statement revision');
    requireCapability(ctx, 'knowledge:write');
    const reason = text(i.reason, 'reason', 2000);
    const prior = await core.need(sql, ctx, 'statement', id);
    const b = vStatement(i, prior.body);
    const use = await useOf(ctx, b);
    await cmd(ctx, 'knowledge:write', `reviseStatement:${id}`, input, async (tx) => {
      const o = await core.need(tx, ctx, 'statement', id, { lock: true });
      core.expect(o, i.expectedRevision);
      if (b.speakerEntityId !== null) await core.need(tx, ctx, 'entity', b.speakerEntityId);
      const next = await core.revise(tx, ctx, o, { body: { ...b, use }, reason, ...(i.state === undefined ? {} : { state: oneOf(i.state, ['active', 'withdrawn'], 'state') }) });
      await core.setDeps(tx, ctx, 'statement', id, statementDeps(id, next.body));
      await core.record(tx, ctx, 'knowledge.statement_revised', selfRef('statement', id), { revision: next.revision }, { type: 'knowledge.statement_changed', payload: { ref: objRef(next), change: 'revised' } });
      const hits = (await core.dependents(tx, ctx, [selfRef('statement', id)]));
      await core.mark(tx, ctx, hits, { flag: 'stale', reason: 'The attributed statement this depends on was revised', cause: `statement-revision:${id}@${next.revision}`, changeKind: 'statement_changed' });
      return { id };
    }, { human: true });
    return get(ctx, 'statement', id);
  }

  // ───────────────────────────── evidence links ─────────────────────────────
  async function addEvidenceLink(ctx: ServiceContext, input: LinkInput & { compartment?: string | null } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, ['target', ...L_KEYS, 'compartment', 'idempotencyKey'], 'evidence link');
    requireCapability(ctx, 'knowledge:write');
    const target = vTarget(i.target), e = vEvidence(i), compartment = label(i.compartment, 'compartment');
    await core.need(sql, ctx, target.kind as Kind, target.id); // a foreign or hidden target is "not found" before anything else is checked
    const validation = await validateEvidence(ctx, e.evidenceRef);
    const { id } = await cmd(ctx, 'knowledge:write', 'addEvidenceLink', input, async (tx) => ({ id: (await mkLink(tx, ctx, target, e, validation, compartment, null)).id }), { human: true });
    return get(ctx, 'evidence_link', id);
  }
  async function reviseEvidenceLink(ctx: ServiceContext, id: string, input: Partial<EvidenceInput> & { expectedRevision: number; reason: string } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, [...L_KEYS, ...REV], 'evidence link revision');
    requireCapability(ctx, 'knowledge:write');
    const reason = text(i.reason, 'reason', 2000);
    const prior = await core.need(sql, ctx, 'evidence_link', id);
    const e = vEvidence(i, prior.body);
    const repointed = e.evidenceRef !== prior.body.evidenceRef || e.representationRef !== prior.body.representationRef;
    const validation = repointed ? await validateEvidence(ctx, e.evidenceRef) : prior.body.validation;
    await cmd(ctx, 'knowledge:write', `reviseEvidenceLink:${id}`, input, async (tx) => {
      let o = await core.need(tx, ctx, 'evidence_link', id, { lock: true });
      core.expect(o, i.expectedRevision);
      invariant(o.state === 'active', 'invalid_state', 'A retracted link cannot be revised; add a new link instead');
      // Re-pointing to another version re-establishes the citation; the earlier stale flag stays in the flag history as cleared.
      if (repointed && o.stale) o = await core.clearFlags(tx, ctx, o, 'stale', `Re-pointed to ${e.evidenceRef}: ${reason}`);
      const next = await core.revise(tx, ctx, o, { body: { ...o.body, ...e, validation }, reason });
      await linkDeps(tx, ctx, next);
      await core.record(tx, ctx, 'knowledge.evidence_link_revised', selfRef('evidence_link', id), { revision: next.revision, repointed, stance: e.stance }, { type: 'knowledge.evidence_link_changed', payload: { ref: objRef(next), target: selfRef(o.body.target.kind, o.body.target.id), stance: e.stance, change: 'revised' } });
      const material = repointed || e.stance !== o.body.stance || JSON.stringify(e.selector) !== JSON.stringify(o.body.selector);
      if (material && await citedBy(tx, ctx, o)) await staleClaim(tx, ctx, o.body.target.id, objRef(next), { reason: 'An evidence link cited by an assessment was revised', cause: `link-revision:${id}@${next.revision}`, changeKind: 'link_changed' });
      return { id };
    }, { human: true });
    return get(ctx, 'evidence_link', id);
  }
  /** Retraction keeps the link and its history; nothing that supports or challenges a claim is ever deleted. */
  async function retractEvidenceLink(ctx: ServiceContext, id: string, input: { expectedRevision: number; reason: string } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, REV, 'evidence link retraction');
    const reason = text(i.reason, 'reason', 2000);
    await cmd(ctx, 'knowledge:write', `retractEvidenceLink:${id}`, input, async (tx) => {
      const o = await core.need(tx, ctx, 'evidence_link', id, { lock: true });
      core.expect(o, i.expectedRevision);
      invariant(o.state === 'active', 'invalid_state', 'This link is already retracted');
      if (o.body.target.kind === 'relationship') {
        const rel = await core.load(tx, ctx, 'relationship', o.body.target.id, { raw: true });
        const others = (await linksFor(tx, ctx, [o.body.target.id], { raw: true })).filter((l) => l.id !== id);
        invariant(rel === null || rel.state !== 'active' || others.length > 0, 'invalid_state', 'A relationship must keep at least one evidence link; add another link or withdraw the relationship first');
      }
      const cited = await citedBy(tx, ctx, o);
      const next = await core.revise(tx, ctx, o, { state: 'retracted', reason });
      await linkDeps(tx, ctx, next);
      await core.record(tx, ctx, 'knowledge.evidence_link_retracted', selfRef('evidence_link', id), { revision: next.revision, stance: o.body.stance }, { type: 'knowledge.evidence_link_changed', payload: { ref: objRef(next), target: selfRef(o.body.target.kind, o.body.target.id), stance: o.body.stance, change: 'retracted' } });
      if (cited) await staleClaim(tx, ctx, o.body.target.id, objRef(next), { reason: 'An evidence link cited by an assessment was retracted', cause: `link-revision:${id}@${next.revision}`, changeKind: 'link_changed' });
      return { id };
    }, { human: true });
    return get(ctx, 'evidence_link', id);
  }

  // ───────────────────────────── relationships and events ─────────────────────────────
  const relType = (v: unknown): string => { invariant(typeof v === 'string' && /^[a-z][a-z0-9_]{1,60}$/.test(v), 'invalid_input', 'relationshipType must be a lowercase token such as employment or membership'); return v as string; };
  async function createRelationship(ctx: ServiceContext, input: RelationshipInput & Placement & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, ['relationshipType', 'fromEntityId', 'to', 'label', 'time', 'note', 'evidence', ...PLACE], 'relationship');
    requireCapability(ctx, 'knowledge:write');
    const to = strict<Record<string, unknown>>(i.to, ['kind', 'id'], 'to');
    const b = { relationshipType: relType(i.relationshipType), from: { kind: 'entity', id: idOf(i.fromEntityId, 'fromEntityId') }, to: { kind: oneOf(to.kind, ['entity', 'event'], 'to.kind'), id: idOf(to.id, 'to.id') }, label: optText(i.label, 'label', 500), time: interval(i.time, 'time'), note: optText(i.note, 'note', 4000) };
    invariant(Array.isArray(i.evidence) && i.evidence.length >= 1 && i.evidence.length <= 20, 'invalid_input', 'A relationship requires at least one evidence link (evidence: [...])');
    invariant(!(b.to.kind === 'entity' && b.to.id === b.from.id), 'invalid_input', 'A relationship needs two different endpoints');
    const evidence = (i.evidence as unknown[]).map((x) => vEvidence(strict<Record<string, unknown>>(x, L_KEYS, 'evidence')));
    const validations = await Promise.all(evidence.map((e) => validateEvidence(ctx, e.evidenceRef)));
    const { id } = await cmd(ctx, 'knowledge:write', 'createRelationship', input, async (tx) => {
      await core.need(tx, ctx, 'entity', b.from.id); await core.need(tx, ctx, b.to.kind as Kind, b.to.id);
      const o = await core.create(tx, ctx, 'relationship', { body: b, ...placement(i) });
      for (const [n, e] of evidence.entries()) await mkLink(tx, ctx, { kind: 'relationship', id: o.id }, e, validations[n] as Validation, null, null);
      await core.record(tx, ctx, 'knowledge.relationship_created', selfRef('relationship', o.id), { revision: 1, relationshipType: b.relationshipType }, { type: 'knowledge.relationship_changed', payload: { ref: objRef(o), change: 'created' } });
      return { id: o.id };
    }, { human: true });
    return get(ctx, 'relationship', id);
  }
  async function reviseRelationship(ctx: ServiceContext, id: string, input: { relationshipType?: string; label?: string | null; time?: TimeInterval | null; note?: string | null; state?: 'active' | 'withdrawn'; expectedRevision: number; reason: string } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, ['relationshipType', 'label', 'time', 'note', 'state', ...REV], 'relationship revision');
    const reason = text(i.reason, 'reason', 2000);
    await cmd(ctx, 'knowledge:write', `reviseRelationship:${id}`, input, async (tx) => {
      const o = await core.need(tx, ctx, 'relationship', id, { lock: true });
      core.expect(o, i.expectedRevision);
      const body = { ...o.body, ...(i.relationshipType === undefined ? {} : { relationshipType: relType(i.relationshipType) }), ...(i.label === undefined ? {} : { label: optText(i.label, 'label', 500) }), ...(i.time === undefined ? {} : { time: interval(i.time, 'time') }), ...(i.note === undefined ? {} : { note: optText(i.note, 'note', 4000) }) };
      const state = i.state === undefined ? o.state : oneOf(i.state, ['active', 'withdrawn'], 'state');
      if (state === 'active') invariant((await linksFor(tx, ctx, [id], { raw: true })).length > 0, 'invalid_state', 'An active relationship requires at least one evidence link');
      const next = await core.revise(tx, ctx, o, { body, state, reason });
      await core.record(tx, ctx, 'knowledge.relationship_revised', selfRef('relationship', id), { revision: next.revision, state }, { type: 'knowledge.relationship_changed', payload: { ref: objRef(next), change: 'revised' } });
      return { id };
    }, { human: true });
    return get(ctx, 'relationship', id);
  }
  const EV_KEYS = ['title', 'description', 'time', 'placeEntityId', 'participantEntityIds', 'claimIds'];
  function vEvent(i: Record<string, unknown>, prior?: Record<string, any>): Record<string, any> {
    const m = { ...(prior ?? {}), ...Object.fromEntries(Object.entries(i).filter(([k, v]) => EV_KEYS.includes(k) && v !== undefined)) } as Record<string, unknown>;
    return { title: text(m.title, 'title', 500), description: optText(m.description, 'description', 8000), time: interval(m.time ?? { earliest: null, latest: null, precision: 'unknown' }, 'time'),
      placeEntityId: m.placeEntityId === undefined || m.placeEntityId === null ? null : idOf(m.placeEntityId, 'placeEntityId'), participantEntityIds: ids(m.participantEntityIds, 'participantEntityIds'), claimIds: ids(m.claimIds, 'claimIds') };
  }
  async function putEvent(tx: Sql, ctx: ServiceContext, b: Record<string, any>): Promise<void> {
    for (const e of [...(b.placeEntityId === null ? [] : [b.placeEntityId]), ...b.participantEntityIds] as string[]) await core.need(tx, ctx, 'entity', e);
    for (const c of b.claimIds as string[]) await core.need(tx, ctx, 'claim', c);
  }
  const eventDeps = (id: string, b: Record<string, any>) => (b.claimIds as string[]).map((c) => ({ depKind: 'event' as Kind, depId: id, sourceRef: selfRef('claim', c), role: 'claim' }));
  async function createEvent(ctx: ServiceContext, input: EventInput & Placement & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, [...EV_KEYS, ...PLACE], 'event');
    const b = vEvent(i);
    const { id } = await cmd(ctx, 'knowledge:write', 'createEvent', input, async (tx) => {
      await putEvent(tx, ctx, b);
      const o = await core.create(tx, ctx, 'event', { body: b, ...placement(i) });
      await core.setDeps(tx, ctx, 'event', o.id, eventDeps(o.id, b));
      await core.record(tx, ctx, 'knowledge.event_created', selfRef('event', o.id), { revision: 1 }, { type: 'knowledge.event_changed', payload: { ref: objRef(o), change: 'created' } });
      return { id: o.id };
    }, { human: true });
    return get(ctx, 'event', id);
  }
  async function reviseEvent(ctx: ServiceContext, id: string, input: Partial<EventInput> & { expectedRevision: number; reason: string; state?: 'active' | 'withdrawn' } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, [...EV_KEYS, ...REV, 'state'], 'event revision');
    const reason = text(i.reason, 'reason', 2000);
    await cmd(ctx, 'knowledge:write', `reviseEvent:${id}`, input, async (tx) => {
      const o = await core.need(tx, ctx, 'event', id, { lock: true });
      core.expect(o, i.expectedRevision);
      const body = vEvent(i, o.body);
      await putEvent(tx, ctx, body);
      const next = await core.revise(tx, ctx, o, { body, reason, ...(i.state === undefined ? {} : { state: oneOf(i.state, ['active', 'withdrawn'], 'state') }) });
      await core.setDeps(tx, ctx, 'event', id, eventDeps(id, body));
      await core.record(tx, ctx, 'knowledge.event_revised', selfRef('event', id), { revision: next.revision }, { type: 'knowledge.event_changed', payload: { ref: objRef(next), change: 'revised' } });
      return { id };
    }, { human: true });
    return get(ctx, 'event', id);
  }

  // ───────────────────────────── source families ─────────────────────────────
  async function claimsCiting(tx: Sql, ctx: ServiceContext, keys: readonly string[]): Promise<{ claimId: string; linkRef: string }[]> {
    if (keys.length === 0) return [];
    const links = await core.list(tx, ctx, 'evidence_link', { raw: true, limit: 5000, where: `state='active' and body->'target'->>'kind'='claim'` });
    return links.filter((l) => linkKeys(l).some((k) => keys.includes(k))).map((l) => ({ claimId: l.body.target.id as string, linkRef: objRef(l) }));
  }
  async function putFamily(tx: Sql, ctx: ServiceContext, fam: Obj, before: readonly string[], change: string): Promise<void> {
    const members = fam.state === 'active' ? (fam.body.members as { ref: string }[]) : [];
    await tx.query(`delete from ${S}.family_members where tenant_id=$1 and project_id=$2 and family_id=$3`, [...core.scope(ctx), fam.id]);
    for (const m of members) {
      const taken = await tx.query(`insert into ${S}.family_members (tenant_id, project_id, family_id, source_key, source_ref) values ($1,$2,$3,$4,$5) on conflict do nothing returning source_key`, [...core.scope(ctx), fam.id, urefKey(m.ref), m.ref]);
      invariant(taken.length === 1, 'conflict', `Source ${urefKey(m.ref)} already belongs to another source family; a source has exactly one family`);
    }
    const after = members.map((m) => urefKey(m.ref));
    // A source joining a family changes the dependence of every existing member too, so any membership change touches the union.
    const changed = before.length === after.length && before.every((k) => after.includes(k)) ? [] : [...new Set([...before, ...after])];
    const citing = await claimsCiting(tx, ctx, changed);
    const claimIds = [...new Set(citing.map((c) => c.claimId))];
    await core.record(tx, ctx, `knowledge.source_family_${change}`, selfRef('source_family', fam.id), { revision: fam.revision, members: members.length, changedSources: changed },
      { type: 'knowledge.source_family_changed', payload: { ref: objRef(fam), change, members: members.length, claims: claimIds.map((c) => selfRef('claim', c)) } });
    // Source dependence changed under these claims: an assessment that relied on independence must be looked at again.
    for (const c of claimIds) await staleClaim(tx, ctx, c, objRef(fam), { reason: 'Source dependence changed: cited sources were grouped into (or released from) a source family', cause: `family:${fam.id}@${fam.revision}`, changeKind: 'source_family_changed' }, { onlyIfAssessed: true });
  }
  const vMembers = (v: unknown, basis: string, ctx: ServiceContext, origin: Json = null): Record<string, Json>[] => urefs(v, 'members', 500).map((ref) => ({ ref, basis, origin, addedBy: ctx.actor.id, at: iso(ctx.now) }));
  async function mkFamily(tx: Sql, ctx: ServiceContext, b: { label: string; description: string | null; basis: string; members: Record<string, Json>[] }, caseId: string | null, provenance: Json): Promise<Obj> {
    invariant(b.members.length >= 1, 'invalid_input', 'A source family needs at least one member source');
    const o = await core.create(tx, ctx, 'source_family', { body: { ...b, provenance }, caseId });
    await putFamily(tx, ctx, o, [], 'created');
    return o;
  }
  async function createSourceFamily(ctx: ServiceContext, input: { label: string; description?: string | null; basis?: string; members: string[]; caseId?: string | null } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, ['label', 'description', 'basis', 'members', 'caseId', 'idempotencyKey'], 'source family');
    const basis = optText(i.basis, 'basis', 500) ?? 'manual';
    const b = { label: text(i.label, 'label', 500), description: optText(i.description, 'description', 4000), basis, members: vMembers(i.members, basis, ctx) };
    const { id } = await cmd(ctx, 'knowledge:write', 'createSourceFamily', input, async (tx) => ({ id: (await mkFamily(tx, ctx, b, label(i.caseId, 'caseId'), null)).id }), { human: true });
    return get(ctx, 'source_family', id);
  }
  async function reviseSourceFamily(ctx: ServiceContext, id: string, input: { label?: string; description?: string | null; addMembers?: string[]; removeMembers?: string[]; state?: 'active' | 'dissolved'; expectedRevision: number; reason: string } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, ['label', 'description', 'addMembers', 'removeMembers', 'state', ...REV], 'source family revision');
    const reason = text(i.reason, 'reason', 2000);
    await cmd(ctx, 'knowledge:write', `reviseSourceFamily:${id}`, input, async (tx) => {
      const o = await core.need(tx, ctx, 'source_family', id, { lock: true });
      core.expect(o, i.expectedRevision);
      const remove = urefs(i.removeMembers, 'removeMembers', 500).map(urefKey);
      const kept = (o.body.members as Record<string, Json>[]).filter((m) => !remove.includes(urefKey(m.ref as string)));
      const add = vMembers(i.addMembers, 'manual', ctx).filter((m) => !kept.some((k) => urefKey(k.ref as string) === urefKey(m.ref as string)));
      const state = i.state === undefined ? o.state : oneOf(i.state, ['active', 'dissolved'], 'state');
      const members = [...kept, ...add];
      invariant(state !== 'active' || members.length >= 1, 'invalid_input', 'An active source family needs at least one member; dissolve it instead');
      const before = o.state === 'active' ? (o.body.members as Record<string, Json>[]).map((m) => urefKey(m.ref as string)) : [];
      const next = await core.revise(tx, ctx, o, { state, reason, body: { ...o.body, members, ...(i.label === undefined ? {} : { label: text(i.label, 'label', 500) }), ...(i.description === undefined ? {} : { description: optText(i.description, 'description', 4000) }) } });
      await putFamily(tx, ctx, next, before, state === 'dissolved' ? 'dissolved' : 'revised');
      return { id };
    }, { human: true });
    return get(ctx, 'source_family', id);
  }
  /** Independence of the material attached to one claim, counted per source family. */
  async function independence(ctx: ServiceContext, claimId: string): Promise<Record<string, any>> {
    requireCapability(ctx, 'knowledge:read');
    await core.need(sql, ctx, 'claim', claimId);
    const links = (await linksFor(sql, ctx, [claimId])).filter((l) => l.body.target.kind === 'claim');
    return { claim: selfRef('claim', claimId), ...independenceOf(links, await familyMap(sql, ctx, links.flatMap(linkKeys))) };
  }

  // ───────────────────────────── contradictions and alternative explanations ─────────────────────────────
  async function recordContradiction(ctx: ServiceContext, input: { members: ObjRef[]; description: string } & Placement & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, ['members', 'description', ...PLACE], 'contradiction');
    const members = objRefs(i.members, ['claim', 'evidence_link'], 'members'), description = text(i.description, 'description', 4000);
    invariant(members.length >= 2, 'invalid_input', 'A contradiction needs at least two claims or evidence links in tension');
    const { id } = await cmd(ctx, 'knowledge:write', 'recordContradiction', input, async (tx) => {
      for (const m of members) await core.need(tx, ctx, m.kind as Kind, m.id);
      const o = await core.create(tx, ctx, 'contradiction', { state: 'open', body: { members, description, resolution: null }, ...placement(i) });
      await core.record(tx, ctx, 'knowledge.contradiction_recorded', selfRef('contradiction', o.id), { members: members.map((m) => selfRef(m.kind, m.id)) }, { type: 'knowledge.contradiction_changed', payload: { ref: objRef(o), state: 'open', members: members.map((m) => selfRef(m.kind, m.id)) } });
      return { id: o.id };
    }, { human: true });
    return get(ctx, 'contradiction', id);
  }
  /** Sets the resolution state. Every member claim and link stays in place with its contrary material. */
  async function resolveContradiction(ctx: ServiceContext, id: string, input: { state: 'open' | 'resolved' | 'unresolvable' | 'dismissed'; note: string; expectedRevision: number } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, ['state', 'note', 'expectedRevision', 'idempotencyKey'], 'contradiction resolution');
    const state = oneOf(i.state, ['open', 'resolved', 'unresolvable', 'dismissed'], 'state'), note = text(i.note, 'note', 4000);
    await cmd(ctx, 'knowledge:write', `resolveContradiction:${id}`, input, async (tx) => {
      const o = await core.need(tx, ctx, 'contradiction', id, { lock: true });
      core.expect(o, i.expectedRevision);
      const next = await core.revise(tx, ctx, o, { state, reason: note, body: { ...o.body, resolution: state === 'open' ? null : { state, note, by: ctx.actor.id, at: iso(ctx.now) } } });
      await core.record(tx, ctx, 'knowledge.contradiction_resolution_set', selfRef('contradiction', id), { state, revision: next.revision }, { type: 'knowledge.contradiction_changed', payload: { ref: objRef(next), state } });
      return { id };
    }, { human: true });
    return get(ctx, 'contradiction', id);
  }
  async function addAlternativeExplanation(ctx: ServiceContext, input: { claimId?: string | null; question?: string | null; text: string } & Placement & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, ['claimId', 'question', 'text', ...PLACE], 'alternative explanation');
    const b = { claimId: i.claimId === undefined || i.claimId === null ? null : idOf(i.claimId, 'claimId'), question: optText(i.question, 'question', 2000), text: text(i.text, 'text', 8000), note: null };
    invariant(b.claimId !== null || b.question !== null, 'invalid_input', 'An alternative explanation belongs to a claim (claimId) or a question');
    const { id } = await cmd(ctx, 'knowledge:write', 'addAlternativeExplanation', input, async (tx) => {
      const claim = b.claimId === null ? null : await core.need(tx, ctx, 'claim', b.claimId);
      const place = placement(i);
      const o = await core.create(tx, ctx, 'alternative', { state: 'open', body: b, compartment: place.compartment ?? claim?.compartment ?? null, caseId: place.caseId ?? claim?.caseId ?? null });
      await core.record(tx, ctx, 'knowledge.alternative_added', selfRef('alternative', o.id), { claim: b.claimId === null ? null : selfRef('claim', b.claimId) }, { type: 'knowledge.alternative_changed', payload: { ref: objRef(o), state: 'open', claim: b.claimId === null ? null : selfRef('claim', b.claimId) } });
      return { id: o.id };
    }, { human: true });
    return get(ctx, 'alternative', id);
  }
  async function reviseAlternativeExplanation(ctx: ServiceContext, id: string, input: { text?: string; state?: 'open' | 'plausible' | 'ruled_out' | 'adopted'; note?: string | null; expectedRevision: number; reason: string } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, ['text', 'state', 'note', ...REV], 'alternative explanation revision');
    const reason = text(i.reason, 'reason', 2000);
    await cmd(ctx, 'knowledge:write', `reviseAlternative:${id}`, input, async (tx) => {
      const o = await core.need(tx, ctx, 'alternative', id, { lock: true });
      core.expect(o, i.expectedRevision);
      const state = i.state === undefined ? o.state : oneOf(i.state, ['open', 'plausible', 'ruled_out', 'adopted'], 'state');
      const next = await core.revise(tx, ctx, o, { state, reason, body: { ...o.body, ...(i.text === undefined ? {} : { text: text(i.text, 'text', 8000) }), ...(i.note === undefined ? {} : { note: optText(i.note, 'note', 4000) }) } });
      await core.record(tx, ctx, 'knowledge.alternative_revised', selfRef('alternative', id), { state, revision: next.revision }, { type: 'knowledge.alternative_changed', payload: { ref: objRef(next), state } });
      return { id };
    }, { human: true });
    return get(ctx, 'alternative', id);
  }

  // ───────────────────────────── verification assessments (four separate dimensions) ─────────────────────────────
  const A_KEYS = ['dimension', 'value', 'rationale', 'cites', 'documentedRationale', 'conditions', 'proposalId', 'idempotencyKey'];
  function vocabulary(d: Dimension): readonly string[] { return d === 'factual' ? FACTUAL_VALUES : d === 'editorial' ? EDITORIAL_VALUES : d === 'procedural' ? cfg.proceduralVocabulary : cfg.sourceTypes; }
  function vAssessment(input: unknown): { dimension: Dimension; value: string; rationale: string; cites: { linkIds: string[]; familyIds: string[] }; documented: boolean; conditions: string | null; proposalId: string | null } {
    const i = strict<Record<string, unknown>>(input, A_KEYS, 'assessment');
    const dimension = oneOf(i.dimension, DIMENSIONS, 'dimension');
    const c = i.cites === undefined || i.cites === null ? {} : strict<Record<string, unknown>>(i.cites, ['linkIds', 'familyIds'], 'cites');
    invariant(i.documentedRationale === undefined || typeof i.documentedRationale === 'boolean', 'invalid_input', 'documentedRationale must be a boolean');
    return { dimension, value: oneOf(i.value, vocabulary(dimension), `${dimension} value`), rationale: text(i.rationale, 'rationale', 8000), cites: { linkIds: ids(c.linkIds, 'cites.linkIds'), familyIds: ids(c.familyIds, 'cites.familyIds') },
      documented: i.documentedRationale === true, conditions: optText(i.conditions, 'conditions', 4000), proposalId: i.proposalId === undefined || i.proposalId === null ? null : idOf(i.proposalId, 'proposalId') };
  }
  /** Checks an assessment against the claim's own material. Returns the basis that justifies it. Never consults relationships, counts or similarity. */
  async function checkAssessment(tx: Sql, ctx: ServiceContext, claim: Obj, a: ReturnType<typeof vAssessment>, final: boolean): Promise<{ basis: string | null; detail: Record<string, Json> }> {
    const links = (await linksFor(tx, ctx, [claim.id], { raw: true })).filter((l) => l.body.target.kind === 'claim');
    const cited = a.cites.linkIds.map((id) => { const l = links.find((x) => x.id === id); invariant(l !== undefined, 'invalid_input', 'cites.linkIds must name active evidence links attached to this claim'); return l as Obj; });
    for (const f of a.cites.familyIds) await core.need(tx, ctx, 'source_family', f);
    if (final) invariant(!cited.some((l) => l.stale || l.blocked), 'invalid_state', 'A cited evidence link is stale or blocked; re-point or retract it before relying on it');
    if (a.dimension === 'factual') {
      if (a.value === 'supported') {
        const support = cited.filter((l) => l.body.stance === 'supports');
        const primary = support.some((l) => l.body.validation.state === 'released' && cfg.primarySourceTypes.includes(l.body.sourceType));
        if (primary) return { basis: 'released_primary_source', detail: {} };
        invariant(a.documented && a.rationale.length >= cfg.minRationaleLength, 'invalid_state', `"supported" needs a cited supporting link to a released primary source, or an explicitly documented rationale (documentedRationale: true, at least ${cfg.minRationaleLength} characters)`);
        return { basis: 'documented_rationale', detail: {} };
      }
      if (a.value === 'refuted') invariant(cited.some((l) => l.body.stance === 'challenges'), 'invalid_state', '"refuted" must cite at least one challenging evidence link attached to this claim');
      if (a.value === 'contested') invariant(cited.length >= 1, 'invalid_state', '"contested" must cite the evidence links in tension');
      return { basis: cited.length > 0 ? 'cited_evidence' : 'rationale_only', detail: {} };
    }
    if (a.dimension === 'editorial') {
      const cur = currentOf(claim.id, (await assessmentsOf(tx, ctx, [claim.id])).get(claim.id) ?? []);
      if (final && (a.value === 'approved' || a.value === 'approved_with_conditions')) {
        invariant(!claim.stale && !claim.blocked, 'invalid_state', 'Editorial approval cannot be given while the claim needs re-verification or is blocked');
        invariant(a.value !== 'approved_with_conditions' || a.conditions !== null, 'invalid_input', 'approved_with_conditions requires conditions');
      }
      // Recorded for traceability only: the editorial decision neither reads nor writes the factual value.
      return { basis: 'editorial_decision', detail: { claimRevision: claim.revision, factualAssessmentId: cur.factual.id, conditions: a.conditions } };
    }
    return { basis: a.dimension === 'procedural' ? 'recorded_by_reviewer' : 'classified_by_reviewer', detail: {} };
  }
  async function insertAssessment(tx: Sql, ctx: ServiceContext, claim: Obj, a: ReturnType<typeof vAssessment>, status: 'proposed' | 'final', chk: { basis: string | null; detail: Record<string, Json> }): Promise<string> {
    const id = randomUUID();
    await tx.query(`insert into ${S}.assessments (tenant_id, project_id, id, claim_id, claim_revision, dimension, value, rationale, basis, cites, detail, status, proposal_id, actor_id, actor_kind, request_id, at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17)`, [...core.scope(ctx), id, claim.id, claim.revision, a.dimension, a.value, a.rationale, chk.basis, JSON.stringify(a.cites), JSON.stringify(chk.detail), status, a.proposalId, ctx.actor.id, ctx.actor.kind, ctx.requestId, ctx.now]);
    return id;
  }
  /** Any actor (including agents) may propose an assessment. A proposal changes nothing until a human records it. */
  async function proposeAssessment(ctx: ServiceContext, claimId: string, input: Omit<AssessmentInput, 'proposalId'> & Idem): Promise<AssessmentView> {
    const a = vAssessment(input);
    invariant(a.proposalId === null, 'invalid_input', 'proposalId is not accepted on a proposal');
    const { id } = await cmd(ctx, 'knowledge:propose', `proposeAssessment:${claimId}`, input, async (tx) => {
      const claim = await core.need(tx, ctx, 'claim', claimId);
      const chk = await checkAssessment(tx, ctx, claim, a, false).catch((e: unknown) => { if (e instanceof DomainError && e.code === 'invalid_state') return { basis: null, detail: { unmetRequirement: e.message } }; throw e; });
      const aid = await insertAssessment(tx, ctx, claim, a, 'proposed', chk);
      await core.record(tx, ctx, 'knowledge.assessment_proposed', selfRef('claim', claimId), { assessmentId: aid, dimension: a.dimension, value: a.value, actorKind: ctx.actor.kind }, { type: 'knowledge.assessment_proposed', payload: { assessmentId: aid, dimension: a.dimension, claim: objRef(claim) } });
      return { id: aid };
    });
    return assessment(ctx, id);
  }
  /**
   * Records a final assessment in ONE dimension. Human only. Factual, procedural and editorial decisions need
   * `knowledge:approve`; source-type classification needs `knowledge:assess`. Other dimensions are not read or changed.
   */
  async function recordAssessment(ctx: ServiceContext, claimId: string, input: AssessmentInput & Idem): Promise<AssessmentView> {
    const a = vAssessment(input);
    const capability = a.dimension === 'source_type' ? 'knowledge:assess' : 'knowledge:approve';
    requireCapability(ctx, capability);
    invariant(ctx.actor.kind === 'human', 'forbidden', 'Only a human can finalise an assessment; agents and services may propose one (proposeAssessment)');
    const { id } = await cmd(ctx, capability, `recordAssessment:${claimId}`, input, async (tx) => {
      let claim = await core.need(tx, ctx, 'claim', claimId, { lock: true });
      if (a.proposalId !== null) {
        const p = (await tx.query(`select * from ${S}.assessments where tenant_id=$1 and project_id=$2 and id=$3 and claim_id=$4 for update`, [...core.scope(ctx), a.proposalId, claimId]))[0];
        invariant(p !== undefined && p.status === 'proposed' && p.dimension === a.dimension, 'not_found', 'Not found');
        invariant(p.decision === null, 'invalid_state', 'This proposal has already been decided');
        await tx.query(`update ${S}.assessments set decision='confirmed', decided_by=$4, decided_at=$5, decision_reason=$6 where tenant_id=$1 and project_id=$2 and id=$3`, [...core.scope(ctx), a.proposalId, ctx.actor.id, ctx.now, a.rationale.slice(0, 2000)]);
      }
      const chk = await checkAssessment(tx, ctx, claim, a, true);
      const aid = await insertAssessment(tx, ctx, claim, a, 'final', chk);
      if (a.dimension === 'factual' && claim.stale && !(await linksFor(tx, ctx, [claimId], { raw: true })).some((l) => l.stale)) claim = await core.clearFlags(tx, ctx, claim, 'stale', `Re-verified by factual assessment ${aid}`);
      const ref = objRef(claim);
      await core.record(tx, ctx, 'knowledge.assessment_recorded', selfRef('claim', claimId), { assessmentId: aid, dimension: a.dimension, value: a.value, basis: chk.basis, proposalId: a.proposalId }, { type: 'knowledge.assessment_recorded', payload: { assessmentId: aid, dimension: a.dimension, value: a.value, claim: ref } });
      await core.record(tx, ctx, 'knowledge.claim_changed', selfRef('claim', claimId), { change: 'assessment', dimension: a.dimension, assessmentId: aid }, { type: 'knowledge.claim_changed', payload: { ref, change: 'assessment', dimension: a.dimension, assessmentId: aid, refs: [ref], claims: [ref] } });
      return { id: aid };
    }, { recheck: capability === 'knowledge:approve' });
    return assessment(ctx, id);
  }
  async function rejectAssessmentProposal(ctx: ServiceContext, assessmentId: string, input: { reason: string } & Idem): Promise<AssessmentView> {
    const i = strict<Record<string, unknown>>(input, ['reason', 'idempotencyKey'], 'rejection');
    const reason = text(i.reason, 'reason', 2000);
    await cmd(ctx, 'knowledge:approve', `rejectAssessmentProposal:${assessmentId}`, input, async (tx) => {
      const p = (await tx.query(`select * from ${S}.assessments where tenant_id=$1 and project_id=$2 and id=$3 for update`, [...core.scope(ctx), idOf(assessmentId, 'assessmentId')]))[0];
      invariant(p !== undefined && p.status === 'proposed', 'not_found', 'Not found');
      await core.need(tx, ctx, 'claim', p.claim_id as string);
      invariant(p.decision === null, 'invalid_state', 'This proposal has already been decided');
      await tx.query(`update ${S}.assessments set decision='rejected', decided_by=$4, decided_at=$5, decision_reason=$6 where tenant_id=$1 and project_id=$2 and id=$3`, [...core.scope(ctx), assessmentId, ctx.actor.id, ctx.now, reason]);
      await core.record(tx, ctx, 'knowledge.assessment_proposal_rejected', selfRef('claim', p.claim_id as string), { assessmentId, dimension: p.dimension as string });
      return { id: assessmentId };
    }, { human: true });
    return assessment(ctx, assessmentId);
  }
  async function assessment(ctx: ServiceContext, id: string): Promise<AssessmentView> {
    requireCapability(ctx, 'knowledge:read');
    const r = (await sql.query(`select * from ${S}.assessments where tenant_id=$1 and project_id=$2 and id=$3`, [...core.scope(ctx), id]))[0];
    if (r === undefined) throw new DomainError('not_found', 'Not found');
    await core.need(sql, ctx, 'claim', r.claim_id as string);
    return (await core.reader(sql, ctx)).deep(toAssessment(r));
  }
  /** Current value of each dimension plus every assessment record ever made for the claim. */
  async function assessments(ctx: ServiceContext, claimId: string): Promise<{ current: ReturnType<typeof currentOf>; history: AssessmentView[] }> {
    requireCapability(ctx, 'knowledge:read');
    await core.need(sql, ctx, 'claim', claimId);
    const rows = (await assessmentsOf(sql, ctx, [claimId])).get(claimId) ?? [];
    return (await core.reader(sql, ctx)).deep({ current: currentOf(claimId, rows), history: rows });
  }

  // ───────────────────────────── proposals (untrusted input) ─────────────────────────────
  /** Ported from the earlier guarded proposal review: a quoted excerpt must sit exactly inside the cited text selector. */
  function checkExcerpt(sel: Selector, excerpt: unknown): Json {
    if (excerpt === undefined || excerpt === null) return null;
    const e = strict<Record<string, unknown>>(excerpt, ['start', 'end', 'quote'], 'excerpt');
    const quote = sel.quote;
    invariant(sel.kind === 'text' && typeof quote === 'string', 'invalid_proposal', 'An excerpt needs a text selector that carries the quoted passage');
    const boundary = (t: string, n: number): boolean => !(n > 0 && n < t.length && /[\uD800-\uDBFF]/.test(t[n - 1] as string) && /[\uDC00-\uDFFF]/.test(t[n] as string));
    invariant(Number.isSafeInteger(e.start) && Number.isSafeInteger(e.end) && (e.start as number) >= 0 && (e.end as number) > (e.start as number) && (e.end as number) <= quote.length
      && boundary(quote, e.start as number) && boundary(quote, e.end as number) && quote.slice(e.start as number, e.end as number) === e.quote, 'invalid_proposal', 'The excerpt must be an exact span of the cited text');
    return { start: e.start as number, end: e.end as number, quote: e.quote as string };
  }
  function vProposalItem(type: string, raw: unknown): Record<string, any> {
    // strict() rejects anything beyond these fields: a proposal cannot carry an assessment, status, approval, score or capability.
    if (type === 'claim') {
      const i = strict<Record<string, unknown>>(raw, [...C_KEYS, 'evidence'], 'proposed claim');
      invariant(i.evidence === undefined || (Array.isArray(i.evidence) && i.evidence.length <= 20), 'invalid_input', 'evidence must be a list');
      return { ...vClaim(i), evidence: ((i.evidence ?? []) as unknown[]).map((x) => { const e = strict<Record<string, unknown>>(x, [...L_KEYS, 'excerpt'], 'proposed evidence'); const v = vEvidence(e); return { ...v, excerpt: checkExcerpt(v.selector as Selector, e.excerpt) }; }) };
    }
    if (type === 'entity') {
      const i = strict<Record<string, unknown>>(raw, [...E_KEYS, 'matchEntityId', 'similarity'], 'proposed entity');
      return { ...vEntity(i), matchEntityId: i.matchEntityId === undefined || i.matchEntityId === null ? null : idOf(i.matchEntityId, 'matchEntityId'), similarity: similarity(i.similarity) };
    }
    if (type === 'link') {
      const i = strict<Record<string, unknown>>(raw, ['target', ...L_KEYS, 'excerpt'], 'proposed link');
      const v = vEvidence(i);
      return { target: vTarget(i.target), ...v, excerpt: checkExcerpt(v.selector as Selector, i.excerpt) };
    }
    const i = strict<Record<string, unknown>>(raw, ['refs', 'basis', 'label', 'similarity'], 'source family hint');
    const refs = urefs(i.refs, 'refs', 500);
    invariant(refs.length >= 2, 'invalid_input', 'A source family hint needs at least two source references');
    return { refs, basis: optText(i.basis, 'basis', 200) ?? 'suggested', label: optText(i.label, 'label', 500), similarity: similarity(i.similarity) };
  }
  async function propose(ctx: ServiceContext, type: 'claim' | 'entity' | 'link' | 'family', input: { origin: ProposalOrigin; items: unknown[] } & Placement & Idem): Promise<ObjectView[]> {
    const i = strict<Record<string, unknown>>(input, ['origin', 'items', ...PLACE], 'proposal batch');
    const origin = vOrigin(i.origin);
    invariant(Array.isArray(i.items) && i.items.length >= 1 && i.items.length <= 100 && JSON.stringify(i.items).length <= 512 * 1024, 'invalid_input', 'items must hold 1–100 bounded proposals');
    const items = (i.items as unknown[]).map((x) => vProposalItem(type, x));
    const out = await cmd(ctx, 'knowledge:propose', `propose:${type}`, input, async (tx) => {
      const made: string[] = [];
      for (const item of items) {
        const o = await core.create(tx, ctx, 'proposal', { state: 'pending', body: { proposalType: type, origin, item, proposedBy: { id: ctx.actor.id, kind: ctx.actor.kind }, notice: PROPOSAL_NOTICE, review: null }, ...placement(i) });
        await core.record(tx, ctx, 'knowledge.proposal_submitted', selfRef('proposal', o.id), { proposalType: type, origin: origin.kind as string, actorKind: ctx.actor.kind }, { type: 'knowledge.proposal_submitted', payload: { ref: objRef(o), proposalType: type } });
        made.push(o.id);
      }
      return { ids: made };
    });
    requireCapability(ctx, 'knowledge:propose');
    const R = await core.reader(sql, ctx);
    return R.deep((await core.many(sql, ctx, 'proposal', out.ids)).map((o) => view(o, R)));
  }
  const proposeClaims = (ctx: ServiceContext, input: { origin: ProposalOrigin; items: (ClaimInput & { evidence?: (EvidenceInput & { excerpt?: { start: number; end: number; quote: string } })[] })[] } & Placement & Idem) => propose(ctx, 'claim', input);
  const proposeEntities = (ctx: ServiceContext, input: { origin: ProposalOrigin; items: (EntityInput & { matchEntityId?: string | null; similarity?: number | null })[] } & Placement & Idem) => propose(ctx, 'entity', input);
  const proposeLinks = (ctx: ServiceContext, input: { origin: ProposalOrigin; items: (LinkInput & { excerpt?: { start: number; end: number; quote: string } })[] } & Placement & Idem) => propose(ctx, 'link', input);
  /** Mirror / content-family hints (for example from E04) become suggestions; sources are grouped only when a human accepts. */
  const suggestSourceFamilies = (ctx: ServiceContext, input: { origin: ProposalOrigin; hints: { refs: string[]; basis?: string; label?: string; similarity?: number | null }[] } & Placement & Idem) => {
    const { hints, ...rest } = strict<Record<string, any>>(input, ['origin', 'hints', ...PLACE], 'source family hints');
    return propose(ctx, 'family', { ...rest, items: hints } as { origin: ProposalOrigin; items: unknown[] });
  };
  /** A human accepts or rejects one proposal. Acceptance creates ordinary unassessed records with provenance; it verifies nothing. */
  async function reviewProposal(ctx: ServiceContext, id: string, input: { decision: 'accept' | 'reject'; reason: string; expectedRevision?: number } & Idem): Promise<ObjectView> {
    const i = strict<Record<string, unknown>>(input, ['decision', 'reason', 'expectedRevision', 'idempotencyKey'], 'proposal review');
    requireCapability(ctx, 'knowledge:review');
    invariant(ctx.actor.kind === 'human', 'forbidden', 'Only a human reviewer can accept or reject a proposal');
    const decision = oneOf(i.decision, ['accept', 'reject'], 'decision'), reason = text(i.reason, 'reason', 2000);
    const seen = await core.need(sql, ctx, 'proposal', id);
    const item = seen.body.item as Record<string, any>;
    const validations = new Map<string, Validation>();
    if (decision === 'accept') for (const e of seen.body.proposalType === 'claim' ? (item.evidence as Record<string, any>[]) : seen.body.proposalType === 'link' ? [item] : []) validations.set(e.evidenceRef, await validateEvidence(ctx, e.evidenceRef));
    await cmd(ctx, 'knowledge:review', `reviewProposal:${id}`, input, async (tx) => {
      const p = await core.need(tx, ctx, 'proposal', id, { lock: true });
      if (i.expectedRevision !== undefined) core.expect(p, i.expectedRevision);
      invariant(p.state === 'pending' && p.revision === seen.revision, 'invalid_state', 'This proposal has already been reviewed');
      const provenance = { proposalId: id, origin: p.body.origin, acceptedBy: ctx.actor.id } as Json;
      const place = { compartment: p.compartment, caseId: p.caseId };
      const results: string[] = [];
      if (decision === 'accept') {
        const strip = (e: Record<string, any>): Record<string, any> => { const { excerpt, ...rest } = e; return excerpt === null || excerpt === undefined ? rest : { ...rest, note: rest.note ?? `Excerpt: “${String(excerpt.quote).slice(0, 500)}”` }; };
        if (p.body.proposalType === 'claim') {
          const { evidence, ...claim } = item;
          const c = await mkClaim(tx, ctx, claim, place, provenance); results.push(objRef(c));
          for (const e of evidence as Record<string, any>[]) results.push(objRef(await mkLink(tx, ctx, { kind: 'claim', id: c.id }, strip(e), validations.get(e.evidenceRef) as Validation, null, provenance)));
        } else if (p.body.proposalType === 'entity') {
          const { matchEntityId, similarity: sim, ...entity } = item;
          const e = await mkEntity(tx, ctx, entity, place, provenance); results.push(objRef(e));
          // A suggested match stays an unresolved identity question; it is never turned into a merge here.
          if (matchEntityId !== null) results.push(objRef(await mkMatch(tx, ctx, e.id, matchEntityId, 'unresolved', `Suggested by proposal ${id}; not reviewed as an identity decision`, sim ?? null)));
        } else if (p.body.proposalType === 'link') {
          const { target, ...e } = item;
          results.push(objRef(await mkLink(tx, ctx, target, strip(e), validations.get(e.evidenceRef) as Validation, null, provenance)));
        } else {
          const keys = (item.refs as string[]).map(urefKey);
          const existing = [...new Set((await tx.query<{ family_id: string }>(`select family_id from ${S}.family_members where tenant_id=$1 and project_id=$2 and source_key = any($3)`, [...core.scope(ctx), keys])).map((r) => r.family_id))];
          invariant(existing.length <= 1, 'conflict', 'These sources already belong to different source families; revise those families by hand');
          const members = vMembers(item.refs, item.basis, ctx, p.body.origin as Json);
          if (existing.length === 0) results.push(objRef(await mkFamily(tx, ctx, { label: item.label ?? `Source family suggested by ${p.body.origin.kind}`, description: null, basis: item.basis, members }, p.caseId, provenance)));
          else {
            const fam = await core.need(tx, ctx, 'source_family', existing[0] as string, { raw: true, lock: true });
            const before = (fam.body.members as Record<string, Json>[]).map((m) => urefKey(m.ref as string));
            const next = await core.revise(tx, ctx, fam, { reason: `Members added from accepted proposal ${id}`, body: { ...fam.body, members: [...fam.body.members, ...members.filter((m) => !before.includes(urefKey(m.ref as string)))] } });
            await putFamily(tx, ctx, next, before, 'revised'); results.push(objRef(next));
          }
        }
      }
      const next = await core.revise(tx, ctx, p, { state: decision === 'accept' ? 'accepted' : 'rejected', reason, body: { ...p.body, review: { decision, reason, by: ctx.actor.id, at: iso(ctx.now), results } } });
      await core.record(tx, ctx, 'knowledge.proposal_reviewed', selfRef('proposal', id), { decision, results }, { type: 'knowledge.proposal_reviewed', payload: { ref: objRef(next), decision, results } });
      return { id };
    });
    return get(ctx, 'proposal', id);
  }

  // ───────────────────────────── generic reads ─────────────────────────────
  const kindOf = (v: unknown): Kind => oneOf(v, KINDS, 'kind');
  async function get(ctx: ServiceContext, kind: Kind, id: string): Promise<ObjectView> {
    requireCapability(ctx, 'knowledge:read');
    if (kindOf(kind) === 'entity') return getEntity(ctx, id);
    if (kind === 'claim') return getClaim(ctx, id);
    const R = await core.reader(sql, ctx);
    return R.deep(view(await core.need(sql, ctx, kind, id), R));
  }
  async function list(ctx: ServiceContext, kind: Kind, filter: { caseId?: string; state?: string; limit?: number } = {}): Promise<ObjectView[]> {
    requireCapability(ctx, 'knowledge:read');
    const f = strict<Record<string, unknown>>(filter, ['caseId', 'state', 'limit'], 'filter');
    const R = await core.reader(sql, ctx);
    const rows = await core.list(sql, ctx, kindOf(kind), { where: '($5::text is null or case_id=$5) and ($6::text is null or state=$6)', params: [label(f.caseId, 'caseId'), label(f.state, 'state')], limit: Number(f.limit ?? 200) });
    return R.deep(rows.map((o) => view(o, R)));
  }
  type RevisionView = { revision: number; state: string; at: string; actorId: string; actorKind: string; reason: string; requestId: string; body: Record<string, any> };
  async function revisionsOf(q: Sql, ctx: ServiceContext, kind: Kind, idList: readonly string[], R: Reader): Promise<Map<string, RevisionView[]>> {
    const out = new Map<string, RevisionView[]>();
    if (idList.length === 0) return out;
    for (const r of await q.query<Record<string, any>>(`select id, revision, state, body, reason, actor_id, actor_kind, request_id, at from ${S}.revisions where tenant_id=$1 and project_id=$2 and kind=$3 and id = any($4) order by revision`, [...core.scope(ctx), kind, [...idList]])) {
      out.set(r.id, [...(out.get(r.id) ?? []), { revision: r.revision, state: r.state, at: iso(r.at), actorId: r.actor_id, actorKind: r.actor_kind, reason: r.reason, requestId: r.request_id, body: bodyView(kind, r.id, r.body, R) }]);
    }
    return out;
  }
  /** Every revision of one record: who, when, why and the content at that revision. */
  async function history(ctx: ServiceContext, kind: Kind, id: string): Promise<{ ref: string; revisions: RevisionView[]; flags: Flag[] }> {
    requireCapability(ctx, 'knowledge:read');
    const o = await core.need(sql, ctx, kindOf(kind), id);
    const R = await core.reader(sql, ctx);
    return R.deep({ ref: objRef(o), revisions: (await revisionsOf(sql, ctx, kind, [id], R)).get(id) ?? [], flags: o.flags });
  }
  /** Claim history: all revisions, assessments in every dimension, link changes (including retracted links), flags — who, when, why. */
  async function claimHistory(ctx: ServiceContext, claimId: string): Promise<Record<string, any>> {
    requireCapability(ctx, 'knowledge:read');
    const claim = await core.need(sql, ctx, 'claim', claimId);
    const R = await core.reader(sql, ctx);
    const links = (await linksFor(sql, ctx, [claimId], { all: true })).filter((l) => l.body.target.kind === 'claim');
    const linkRevisions = await revisionsOf(sql, ctx, 'evidence_link', links.map((l) => l.id), R);
    const revisions = (await revisionsOf(sql, ctx, 'claim', [claimId], R)).get(claimId) ?? [];
    const assess = (await assessmentsOf(sql, ctx, [claimId])).get(claimId) ?? [];
    const timeline = [
      ...revisions.map((r) => ({ at: r.at, actorId: r.actorId, actorKind: r.actorKind, type: r.revision === 1 ? 'claim_created' : 'claim_revised', why: r.reason, detail: { revision: r.revision, state: r.state } })),
      ...assess.flatMap((a) => [{ at: a.at as string, actorId: a.actorId as string, actorKind: a.actorKind as string, type: a.status === 'final' ? 'assessment_recorded' : 'assessment_proposed', why: a.rationale as string, detail: { assessmentId: a.id, dimension: a.dimension, value: a.value, basis: a.basis } },
        ...(a.decidedAt === null ? [] : [{ at: a.decidedAt, actorId: a.decidedBy as string, actorKind: 'human', type: `assessment_proposal_${a.decision}`, why: a.decisionReason ?? '', detail: { assessmentId: a.id, dimension: a.dimension } }])]),
      ...links.flatMap((l) => (linkRevisions.get(l.id) ?? []).map((r) => ({ at: r.at, actorId: r.actorId, actorKind: r.actorKind, type: r.revision === 1 ? 'link_added' : r.state === 'retracted' ? 'link_retracted' : 'link_revised', why: r.reason, detail: { linkId: l.id, revision: r.revision, stance: r.body.stance, evidenceRef: r.body.evidenceRef } }))),
      ...claim.flags.flatMap((f) => [{ at: f.at, actorId: 'system', actorKind: 'service', type: f.flag === 'stale' ? 'flagged_needs_reverification' : 'flagged_blocked', why: f.reason, detail: { cause: f.cause, via: [...f.via] } },
        ...(f.clearedAt === undefined ? [] : [{ at: f.clearedAt, actorId: f.clearedBy ?? '', actorKind: 'human', type: 'flag_cleared', why: f.clearNote ?? '', detail: { cause: f.cause, flag: f.flag } }])]),
    ].sort((a, b) => a.at.localeCompare(b.at));
    return R.deep({ claim: view(claim, R), revisions, assessments: { current: currentOf(claimId, assess), history: assess }, links: links.map((l) => ({ ...view(l, R), revisions: linkRevisions.get(l.id) ?? [] })), flags: claim.flags, timeline });
  }

  // ───────────────────────────── evidence graph ─────────────────────────────
  async function evidenceGraph(ctx: ServiceContext, scopeInput: { claimId?: string; entityId?: string; caseId?: string }): Promise<Graph> {
    requireCapability(ctx, 'knowledge:read');
    const sc = strict<Record<string, unknown>>(scopeInput, ['claimId', 'entityId', 'caseId'], 'graph scope');
    invariant([sc.claimId, sc.entityId, sc.caseId].filter((x) => x !== undefined && x !== null && x !== '').length === 1, 'invalid_input', 'Exactly one of claimId, entityId or caseId is required');
    const R = await core.reader(sql, ctx);
    const claims = new Map<string, Obj>(), rels = new Map<string, Obj>(), events = new Map<string, Obj>(), entityIds = new Set<string>();
    const allClaims = await core.list(sql, ctx, 'claim', { limit: 5000 }), allRels = await core.list(sql, ctx, 'relationship', { limit: 5000 }), allEvents = await core.list(sql, ctx, 'event', { limit: 5000 });
    const scope: Record<string, string> = {};
    if (typeof sc.claimId === 'string' && sc.claimId !== '') {
      const c = await core.need(sql, ctx, 'claim', sc.claimId); scope.claimId = c.id; claims.set(c.id, c);
      const pending = [c];
      while (pending.length > 0) { const x = pending.pop() as Obj; for (const y of allClaims) if (!claims.has(y.id) && ((x.body.derivedFrom as string[]).includes(y.id) || (y.body.derivedFrom as string[]).includes(x.id))) { claims.set(y.id, y); pending.push(y); } }
      for (const e of allEvents) if ((e.body.claimIds as string[]).some((id) => claims.has(id))) events.set(e.id, e);
    } else if (typeof sc.entityId === 'string' && sc.entityId !== '') {
      const e = await core.need(sql, ctx, 'entity', sc.entityId); scope.entityId = e.id;
      const group = new Set(R.members(e.id)); for (const g of group) entityIds.add(g);
      for (const r of allRels) if (group.has(r.body.from.id) || (r.body.to.kind === 'entity' && group.has(r.body.to.id))) rels.set(r.id, r);
      for (const ev of allEvents) if ((ev.body.participantEntityIds as string[]).some((p) => group.has(p)) || (ev.body.placeEntityId !== null && group.has(ev.body.placeEntityId))) events.set(ev.id, ev);
      for (const c of allClaims) if ((c.body.subjects as ObjRef[]).some((s) => (s.kind === 'entity' && group.has(s.id)) || (s.kind === 'relationship' && rels.has(s.id)) || (s.kind === 'event' && events.has(s.id)))) claims.set(c.id, c);
    } else {
      const caseId = label(sc.caseId, 'caseId') as string; scope.caseId = caseId;
      for (const c of allClaims) if (c.caseId === caseId) claims.set(c.id, c);
      for (const r of allRels) if (r.caseId === caseId) rels.set(r.id, r);
      for (const e of allEvents) if (e.caseId === caseId) events.set(e.id, e);
    }
    const cids = [...claims.keys()];
    const alts = await core.list(sql, ctx, 'alternative', { where: `body->>'claimId' = any($5)`, params: [cids], limit: 5000 });
    const links = await linksFor(sql, ctx, [...cids, ...rels.keys(), ...events.keys(), ...alts.map((a) => a.id)]);
    const linkIdSet = new Set(links.map((l) => l.id));
    const contras = (await core.list(sql, ctx, 'contradiction', { limit: 5000 })).filter((x) => (x.body.members as ObjRef[]).some((m) => (m.kind === 'claim' && claims.has(m.id)) || (m.kind === 'evidence_link' && linkIdSet.has(m.id))));
    const statements = await core.many(sql, ctx, 'statement', [...claims.values()].flatMap((c) => (c.body.statementId ? [c.body.statementId as string] : [])));
    for (const c of claims.values()) for (const s of c.body.subjects as ObjRef[]) if (s.kind === 'entity') entityIds.add(s.id);
    for (const r of rels.values()) { entityIds.add(r.body.from.id); if (r.body.to.kind === 'entity') entityIds.add(r.body.to.id); }
    for (const e of events.values()) for (const p of [...(e.body.participantEntityIds as string[]), ...(e.body.placeEntityId === null ? [] : [e.body.placeEntityId as string])]) entityIds.add(p);
    for (const s of statements) if (s.body.speakerEntityId !== null) entityIds.add(s.body.speakerEntityId);
    const entities = await core.many(sql, ctx, 'entity', [...new Set([...entityIds].flatMap((id) => [id, R.root(id)]))]);
    const assess = await assessmentsOf(sql, ctx, cids);
    const fam = await familyMap(sql, ctx, links.flatMap(linkKeys));

    const nodes: Graph['nodes'] = [], edges: Graph['edges'] = [], seen = new Set<string>();
    const node = (n: Graph['nodes'][number]): void => { if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); } };
    const nid = (kind: string, id: string): string => selfRef(kind, id);
    const en = (id: string): string => nid('entity', R.root(id));
    for (const e of entities) if (R.root(e.id) === e.id) node({ id: nid('entity', e.id), type: 'entity', label: titleOf(e, R), entityType: e.body.entityType, identityWithheld: R.withheld(e.id), mergedFrom: R.members(e.id).filter((m) => m !== e.id) });
    for (const c of claims.values()) {
      const cur = currentOf(c.id, assess.get(c.id) ?? []);
      node({ id: nid('claim', c.id), type: 'claim', label: titleOf(c, R), claimType: c.body.claimType, status: statusOf(c), stale: c.stale, blocked: c.blocked, factual: cur.factual.value, sourceType: cur.source_type.value, procedural: cur.procedural.value, editorial: cur.editorial.value });
      for (const s of c.body.subjects as ObjRef[]) edges.push({ from: nid('claim', c.id), to: s.kind === 'entity' ? en(s.id) : nid(s.kind, s.id), type: 'about' });
      for (const d of c.body.derivedFrom as string[]) if (claims.has(d)) edges.push({ from: nid('claim', c.id), to: nid('claim', d), type: 'derived_from' });
    }
    for (const s of statements) { node({ id: nid('statement', s.id), type: 'statement', label: titleOf(s, R), status: statusOf(s), source: s.body.sourceRef }); for (const c of claims.values()) if (c.body.statementId === s.id) edges.push({ from: nid('statement', s.id), to: nid('claim', c.id), type: 'attributed_in' }); if (s.body.speakerEntityId !== null) edges.push({ from: en(s.body.speakerEntityId), to: nid('statement', s.id), type: 'said' }); }
    for (const e of events.values()) { node({ id: nid('event', e.id), type: 'event', label: titleOf(e, R), time: e.body.time, status: statusOf(e) }); for (const c of e.body.claimIds as string[]) if (claims.has(c)) edges.push({ from: nid('claim', c), to: nid('event', e.id), type: 'describes' }); for (const p of e.body.participantEntityIds as string[]) edges.push({ from: en(p), to: nid('event', e.id), type: 'participant' }); if (e.body.placeEntityId !== null) edges.push({ from: nid('event', e.id), to: en(e.body.placeEntityId), type: 'located_at' }); }
    for (const r of rels.values()) { node({ id: nid('relationship', r.id), type: 'relationship', label: `${r.body.relationshipType}${r.body.label ? `: ${r.body.label}` : ''}`, status: statusOf(r), notice: RELATIONSHIP_NOTICE }); edges.push({ from: en(r.body.from.id), to: nid('relationship', r.id), type: 'relationship_from' }); edges.push({ from: nid('relationship', r.id), to: r.body.to.kind === 'entity' ? en(r.body.to.id) : nid('event', r.body.to.id), type: 'relationship_to' }); }
    for (const a of alts) { node({ id: nid('alternative', a.id), type: 'alternative', label: titleOf(a, R), state: a.state }); if (a.body.claimId !== null) edges.push({ from: nid('alternative', a.id), to: nid('claim', a.body.claimId), type: 'alternative_to' }); }
    for (const l of links) {
      const f = familyOfLink(l, fam), src = urefKey(l.body.evidenceRef);
      node({ id: src, type: 'evidence', label: src });
      if (f.familyId !== null) { node({ id: nid('source_family', f.familyId), type: 'source_family', label: f.label }); if (!edges.some((e) => e.from === src && e.type === 'member_of')) edges.push({ from: src, to: nid('source_family', f.familyId), type: 'member_of' }); }
      edges.push({ from: src, to: nid(l.body.target.kind, l.body.target.id), type: l.body.stance, stance: l.body.stance, linkId: l.id, evidenceRef: l.body.evidenceRef, selector: describeSelector(l.body.selector as Selector), family: f.key, familyLabel: f.label, stale: l.stale, blocked: l.blocked, validation: l.body.validation.state, sourceType: l.body.sourceType, note: l.body.note });
    }
    for (const x of contras) { node({ id: nid('contradiction', x.id), type: 'contradiction', label: titleOf(x, R), state: x.state }); for (const m of x.body.members as ObjRef[]) { const l = m.kind === 'evidence_link' ? links.find((k) => k.id === m.id) : undefined; edges.push({ from: nid('contradiction', x.id), to: m.kind === 'claim' ? nid('claim', m.id) : l === undefined ? nid('evidence_link', m.id) : urefKey(l.body.evidenceRef), type: 'in_tension', ...(m.kind === 'evidence_link' ? { linkId: m.id } : {}) }); } }
    const known = new Set(nodes.map((n) => n.id));
    const kept = edges.filter((e) => known.has(e.from) && known.has(e.to));
    const name = new Map(nodes.map((n) => [n.id, `${n.type} “${n.label}”`]));
    const rows = kept.map((e) => [name.get(e.from) as string, e.type, name.get(e.to) as string, e.selector ?? '', e.familyLabel ?? '', e.stale === true ? 'stale' : e.blocked === true ? 'blocked' : '', e.note ?? '']);
    const lines = [`Evidence graph for ${Object.entries(scope).map(([k, v]) => `${k} ${v}`).join(', ')}: ${nodes.length} nodes, ${kept.length} links.`,
      ...[...claims.values()].map((c) => { const cur = currentOf(c.id, assess.get(c.id) ?? []); const mine = links.filter((l) => l.body.target.kind === 'claim' && l.body.target.id === c.id); const ind = independenceOf(mine, fam);
        return `Claim “${titleOf(c, R)}” — factual assessment: ${cur.factual.value}; status: ${statusOf(c)}; supporting links: ${ind.supporting.links} from ${ind.supporting.families} source famil${ind.supporting.families === 1 ? 'y' : 'ies'}; challenging links: ${ind.challenging.links} from ${ind.challenging.families}.`; }),
      ...rows.map((r) => `${r[0]} —[${r[1]}]→ ${r[2]}${r[3] === '' ? '' : ` (${r[3]})`}${r[4] === '' ? '' : ` [${r[4]}]`}${r[5] === '' ? '' : ` {${r[5]}}`}`)];
    return R.deep({ scope, nodes, edges: kept, table: { columns: ['From', 'Relation', 'To', 'Cited part', 'Source family', 'Flag', 'Note'], rows }, text: lines.join('\n'), notices: [INDEPENDENCE_NOTICE, RELATIONSHIP_NOTICE] });
  }

  // ───────────────────────────── research gaps and chronology ─────────────────────────────
  async function researchGaps(ctx: ServiceContext, filter: { caseId?: string } = {}): Promise<{ scope: Record<string, string | null>; gaps: { claim: string; title: string; status: string; gaps: { gap: string; detail: string }[] }[]; counts: Record<string, number>; notice: string }> {
    requireCapability(ctx, 'knowledge:read');
    const f = strict<Record<string, unknown>>(filter, ['caseId'], 'filter');
    const caseId = label(f.caseId, 'caseId');
    const R = await core.reader(sql, ctx);
    const claims = (await core.list(sql, ctx, 'claim', { where: '($5::text is null or case_id=$5)', params: [caseId], limit: 5000 })).filter((c) => c.state === 'active');
    const ds = await dossiers(sql, ctx, claims, R);
    const counts: Record<string, number> = {};
    const out = ds.map((d) => {
      const g: { gap: string; detail: string }[] = [];
      const add = (gap: string, detail: string): void => { g.push({ gap, detail }); counts[gap] = (counts[gap] ?? 0) + 1; };
      const sup = d.evidence.supporting as ObjectView[], all = [...sup, ...(d.evidence.challenging as ObjectView[]), ...(d.evidence.context as ObjectView[])];
      if (sup.length === 0) add('no_supporting_evidence', 'No evidence link supports this claim.');
      else if (!sup.some((l) => cfg.primarySourceTypes.includes(l.sourceType))) add('no_primary_support', 'No supporting link cites a source classified as primary material.');
      if (sup.length > 0 && d.independence.supporting.families === 1) add('single_family_support', `All ${sup.length} supporting link(s) come from one source family; copies are not independent corroboration.`);
      if ((d.contradictions as ObjectView[]).some((x) => x.state === 'open')) add('unresolved_contradiction', 'An open contradiction involves this claim or its evidence.');
      if (!d.assessments.factual.recorded || d.assessments.factual.value === 'unassessed') add('unassessed', 'No factual assessment has been recorded by a human.');
      if (['allegation', 'inference', 'reconstruction_note'].includes(d.claimType) && (d.alternatives as ObjectView[]).length === 0) add('missing_alternative_explanations', 'No alternative explanation has been recorded for this claim.');
      if (all.some((l) => l.stale)) add('stale_links', 'At least one evidence link points at a source that was corrected, superseded or removed.');
      if (all.some((l) => l.validation?.state !== 'released')) add('unvalidated_links', 'At least one cited evidence version was not confirmed as existing and released.');
      if (d.stale) add('needs_reverification', (d.flags as Flag[]).filter((x) => x.flag === 'stale').map((x) => x.reason).join('; '));
      if (d.blocked) add('blocked', (d.flags as Flag[]).filter((x) => x.flag === 'blocked').map((x) => x.reason).join('; '));
      return { claim: d.ref, title: titleOf(claims.find((c) => c.id === d.id) as Obj, R), status: d.status, gaps: g };
    }).filter((x) => x.gaps.length > 0);
    return R.deep({ scope: { caseId }, gaps: out, counts, notice: 'Gaps are computed only from records you are permitted to see.' });
  }
  /** Events in time order with their uncertainty and supporting claims. Labels follow recorded factual assessments only. */
  async function chronology(ctx: ServiceContext, filter: { caseId?: string; entityId?: string; from?: string; to?: string } = {}): Promise<{ entries: Record<string, any>[]; notice: string }> {
    requireCapability(ctx, 'knowledge:read');
    const f = strict<Record<string, unknown>>(filter, ['caseId', 'entityId', 'from', 'to'], 'filter');
    const R = await core.reader(sql, ctx);
    const caseId = label(f.caseId, 'caseId');
    const group = typeof f.entityId === 'string' && f.entityId !== '' ? new Set(R.members((await core.need(sql, ctx, 'entity', f.entityId)).id)) : null;
    const bound = (v: unknown, n: string): string | null => (v === undefined || v === null || v === '' ? null : (invariant(typeof v === 'string' && Number.isFinite(Date.parse(v)), 'invalid_time', `${n} must be a timestamp`), new Date(v as string).toISOString()));
    const from = bound(f.from, 'from'), to = bound(f.to, 'to');
    let events = (await core.list(sql, ctx, 'event', { where: '($5::text is null or case_id=$5)', params: [caseId], limit: 5000 })).filter((e) => e.state === 'active');
    if (group !== null) events = events.filter((e) => (e.body.participantEntityIds as string[]).some((p) => group.has(p)) || (e.body.placeEntityId !== null && group.has(e.body.placeEntityId)));
    events = events.filter((e) => { const t = e.body.time as TimeInterval; return (from === null || (t.latest ?? t.earliest ?? '9999') >= from) && (to === null || (t.earliest ?? t.latest ?? '0000') <= to); });
    const allClaims = (await core.list(sql, ctx, 'claim', { limit: 5000 })).filter((c) => c.state === 'active');
    const byEvent = new Map(events.map((e) => [e.id, allClaims.filter((c) => (e.body.claimIds as string[]).includes(c.id) || (c.body.subjects as ObjRef[]).some((s) => s.kind === 'event' && s.id === e.id))]));
    const ds = new Map((await dossiers(sql, ctx, [...new Set([...byEvent.values()].flat())], R)).map((d) => [d.id, d]));
    const key = (e: Obj): string => { const t = e.body.time as TimeInterval; return `${t.earliest ?? t.latest ?? '9999-99'}|${t.latest ?? ''}|${e.id}`; };
    const entries = events.sort((a, b) => key(a).localeCompare(key(b))).map((e) => {
      const cs = (byEvent.get(e.id) ?? []).map((c) => ds.get(c.id) as ObjectView);
      const values = cs.map((c) => c.assessments.factual.value as string);
      const flagged = e.stale || e.blocked || cs.some((c) => c.stale || c.blocked);
      const disputed = values.some((v) => v === 'contested' || v === 'refuted') || cs.some((c) => (c.contradictions as ObjectView[]).some((x) => x.state === 'open'));
      const established = cs.length > 0 && values.some((v) => v === 'supported') && !disputed && !flagged;
      const t = e.body.time as TimeInterval;
      return {
        event: objRef(e), title: titleOf(e, R), time: t, uncertainty: t.earliest === null && t.latest === null ? 'date unknown' : t.earliest === t.latest ? `${t.precision}` : `between ${t.earliest ?? 'unknown'} and ${t.latest ?? 'unknown'} (${t.precision})`,
        label: disputed ? 'disputed' : established ? 'established' : 'unknown',
        labelBasis: disputed ? 'A linked claim is contested or refuted, or an open contradiction exists.' : established ? 'At least one linked claim has a human factual assessment of supported, and none is contested, refuted or flagged.' : flagged ? 'A linked record needs re-verification or is blocked.' : 'No linked claim has a human factual assessment of supported.',
        needsReverification: flagged, participants: [...new Set((e.body.participantEntityIds as string[]).map(R.root))].map((p) => selfRef('entity', p)),
        claims: cs.map((c) => ({ ref: c.ref, text: c.text, claimType: c.claimType, factual: c.assessments.factual.value, status: c.status, supporting: (c.evidence.supporting as ObjectView[]).map((l) => ({ link: l.ref, evidenceRef: l.evidenceRef, selector: l.selectorLabel, family: l.family.label })), challenging: (c.evidence.challenging as ObjectView[]).map((l) => ({ link: l.ref, evidenceRef: l.evidenceRef, selector: l.selectorLabel, family: l.family.label })) })),
      };
    });
    return R.deep({ entries, notice: 'established / disputed / unknown reflect recorded human factual assessments of the linked claims; they are not legal findings.' });
  }

  // ───────────────────────────── correction impact and upstream changes ─────────────────────────────
  /** Everything that depends on the given evidence / representation / permission urefs, transitively through derived claims. Read-only. */
  async function impactOf(ctx: ServiceContext, refs: readonly string[]): Promise<Impact> {
    requireCapability(ctx, 'knowledge:read');
    const seeds = urefs(refs, 'refs', 500);
    const hits = await core.dependents(sql, ctx, seeds);
    const visible: { o: Obj; via: string[] }[] = [];
    for (const k of KINDS) { const mine = hits.filter((h) => h.kind === k); for (const o of await core.many(sql, ctx, k, mine.map((h) => h.id))) visible.push({ o, via: (mine.find((h) => h.id === o.id) as { via: string[] }).via }); }
    const of = (k: Kind): string[] => visible.filter((v) => v.o.kind === k).map((v) => objRef(v.o));
    const claimIds = visible.filter((v) => v.o.kind === 'claim').map((v) => v.o.id), linkIds = new Set(visible.filter((v) => v.o.kind === 'evidence_link').map((v) => v.o.id));
    const assess = await assessmentsOf(sql, ctx, claimIds);
    const contras = (await core.list(sql, ctx, 'contradiction', { limit: 5000 })).filter((x) => (x.body.members as ObjRef[]).some((m) => (m.kind === 'claim' && claimIds.includes(m.id)) || (m.kind === 'evidence_link' && linkIds.has(m.id))));
    return {
      refs: seeds, evidenceLinks: of('evidence_link'), statements: of('statement'), claims: of('claim'),
      assessments: claimIds.flatMap((c) => { const cur = currentOf(c, assess.get(c) ?? []); return DIMENSIONS.filter((d) => cur[d].recorded).map((d) => ({ id: cur[d].id as string, claimId: c, dimension: d, value: cur[d].value })); }),
      relationships: of('relationship'), events: of('event'), alternatives: of('alternative'), contradictions: contras.map(objRef),
      paths: visible.map((v) => ({ ref: objRef(v.o), via: v.via })),
    };
  }
  const STALE_KINDS = ['source_corrected', 'source_superseded', 'source_removed', 'content_changed', 'permission_changed'];
  async function applyChange(tx: Sql, ctx: ServiceContext, change: { eventId: string; kind: string; refs: string[]; reason: string }): Promise<string[]> {
    const prior = (await tx.query<{ affected: string[] }>(`select affected from ${S}.upstream_changes where tenant_id=$1 and project_id=$2 and event_id=$3`, [...core.scope(ctx), change.eventId]))[0];
    if (prior !== undefined) return prior.affected;
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`e07-upstream:${ctx.tenantId}:${ctx.projectId}:${change.eventId}`]);
    let affected: string[] = [];
    const flag = change.kind === 'permission_withdrawn' ? 'blocked' : STALE_KINDS.includes(change.kind) ? 'stale' : null;
    if (flag !== null) affected = await core.mark(tx, ctx, await core.dependents(tx, ctx, change.refs), { flag, reason: change.reason, cause: change.eventId, changeKind: change.kind });
    const done = await tx.query(`insert into ${S}.upstream_changes (tenant_id, project_id, event_id, kind, refs, reason, affected, at) values ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8) on conflict do nothing returning event_id`,
      [...core.scope(ctx), change.eventId, change.kind, JSON.stringify(change.refs), change.reason, JSON.stringify(affected), ctx.now]);
    invariant(done.length === 1, 'conflict', 'This upstream change is being applied concurrently');
    await core.record(tx, ctx, 'knowledge.upstream_change_applied', change.refs[0] ?? selfRef('proposal', 'none'), { eventId: change.eventId, kind: change.kind, refs: change.refs, affected: affected.length });
    return affected;
  }
  function vChange(change: unknown): { eventId: string; kind: string; refs: string[]; reason: string } {
    const c = strict<Record<string, unknown>>(change, ['eventId', 'kind', 'refs', 'reason'], 'upstream change');
    invariant(typeof c.eventId === 'string' && c.eventId.length > 0 && c.eventId.length <= 300, 'invalid_input', 'eventId is required');
    return { eventId: c.eventId as string, kind: oneOf(c.kind, ['source_corrected', 'source_superseded', 'source_removed', 'permission_withdrawn', 'permission_changed', 'claim_changed', 'content_changed', 'render_changed', 'audience_changed', 'rights_changed'], 'kind'), refs: urefs(c.refs, 'refs', 1000), reason: text(c.reason, 'reason', 1000) };
  }
  async function applyUpstreamChange(ctx: ServiceContext, change: UpstreamChange): Promise<{ affected: string[] }> {
    requireCapability(ctx, 'knowledge:upstream');
    const c = vChange(change);
    return { affected: await sql.tx((tx) => applyChange(tx, ctx, c)) };
  }
  /** A correction opened by a researcher inside this engine: same marking as an upstream change, plus the impact set. */
  async function openCorrection(ctx: ServiceContext, input: { refs: string[]; kind?: 'source_corrected' | 'source_superseded' | 'source_removed' | 'content_changed'; reason: string } & Idem): Promise<{ correctionId: string; affected: string[]; impact: Impact }> {
    const i = strict<Record<string, unknown>>(input, ['refs', 'kind', 'reason', 'idempotencyKey'], 'correction');
    const kind = i.kind === undefined ? 'source_corrected' : oneOf(i.kind, ['source_corrected', 'source_superseded', 'source_removed', 'content_changed'], 'kind');
    const refs = urefs(i.refs, 'refs', 500), reason = text(i.reason, 'reason', 1000);
    invariant(refs.length >= 1, 'invalid_input', 'refs must name at least one source');
    const out = await cmd(ctx, 'knowledge:write', 'openCorrection', input, async (tx) => {
      const correctionId = `correction-${randomUUID()}`;
      await core.record(tx, ctx, 'knowledge.correction_opened', refs[0] as string, { correctionId, kind, refs }, { type: 'knowledge.correction_opened', payload: { correctionId, kind, refs, reason } });
      return { correctionId, affected: await applyChange(tx, ctx, { eventId: correctionId, kind, refs, reason }) };
    }, { human: true });
    return { ...out, impact: await impactOf(ctx, refs) };
  }
  /** A human with `knowledge:approve` clears a stale or blocked flag after checking the cause; refused while the cause still feeds the record. */
  async function resolveFlag(ctx: ServiceContext, target: ObjRef, input: { flag: 'stale' | 'blocked'; note: string } & Idem): Promise<ObjectView> {
    const t = strict<Record<string, unknown>>(target, ['kind', 'id'], 'target'), i = strict<Record<string, unknown>>(input, ['flag', 'note', 'idempotencyKey'], 'flag resolution');
    const kind = oneOf(t.kind, ['claim', 'evidence_link', 'statement', 'relationship', 'event', 'alternative'], 'kind') as Kind, id = idOf(t.id, 'id');
    const flag = oneOf(i.flag, ['stale', 'blocked'], 'flag'), note = text(i.note, 'note', 2000);
    await cmd(ctx, 'knowledge:approve', `resolveFlag:${kind}:${id}`, input, async (tx) => {
      const o = await core.need(tx, ctx, kind, id, { lock: true });
      invariant(flag === 'stale' ? o.stale : o.blocked, 'invalid_state', `This record is not ${flag}`);
      if (kind !== 'evidence_link' && kind !== 'statement') {
        const feeding = await tx.query<{ source_ref: string }>(`select d.source_ref from ${S}.deps d join ${S}.objects s on s.tenant_id=d.tenant_id and s.project_id=d.project_id and d.source_ref = 'E07:' || s.kind || ':' || s.id
          where d.tenant_id=$1 and d.project_id=$2 and d.dep_kind=$3 and d.dep_id=$4 and s.state <> 'retracted' and ${flag === 'stale' ? 's.stale' : 's.blocked'}`, [...core.scope(ctx), kind, id]);
        invariant(feeding.length === 0, 'invalid_state', `Still depends on ${flag} records (${feeding.map((f) => f.source_ref).join(', ')}); resolve, re-point or retract those first`);
      }
      await core.clearFlags(tx, ctx, o, flag, note);
      if (kind === 'claim') await tx.query(`update ${S}.assessments set flags = (select coalesce(jsonb_agg(case when f ? 'clearedAt' or (f->>'flag') <> $4 then f else f || jsonb_build_object('clearedAt', $5::text, 'clearedBy', $6::text) end), '[]'::jsonb) from jsonb_array_elements(flags) f)
        where tenant_id=$1 and project_id=$2 and claim_id=$3 and jsonb_array_length(flags) > 0`, [...core.scope(ctx), id, flag === 'stale' ? 'needs_reverification' : 'blocked', iso(ctx.now), ctx.actor.id]);
      await core.record(tx, ctx, 'knowledge.flag_resolved', selfRef(kind, id), { flag, note }, { type: 'knowledge.flag_resolved', payload: { ref: objRef(o), flag } });
      return { id };
    }, { human: true, recheck: true });
    return get(ctx, kind, id);
  }
  /** Whether claims may be used for an action: blocked claims deny; otherwise the UseDecisionPort decides for attributed statements. */
  async function usability(ctx: ServiceContext, input: { claimIds: string[]; action: UseAction; audience?: string }): Promise<{ claim: string; decision: 'allow' | 'deny' | 'review' | 'unchecked'; reasons: string[] }[]> {
    requireCapability(ctx, 'knowledge:read');
    const i = strict<Record<string, unknown>>(input, ['claimIds', 'action', 'audience'], 'usability request');
    const action = oneOf(i.action, ['investigate', 'preserve', 'cite', 'reproduce', 'adapt', 'publish', 'license', 'contact', 'process'], 'action') as UseAction;
    const out: { claim: string; decision: 'allow' | 'deny' | 'review' | 'unchecked'; reasons: string[] }[] = [];
    for (const id of ids(i.claimIds, 'claimIds', 200)) {
      const c = await core.need(sql, ctx, 'claim', id);
      if (c.blocked) { out.push({ claim: objRef(c), decision: 'deny', reasons: activeFlags(c).filter((f) => f.flag === 'blocked').map((f) => f.reason) }); continue; }
      const st = c.body.statementId === null ? null : await core.load(sql, ctx, 'statement', c.body.statementId, { raw: true });
      const reasons = c.stale ? ['The claim needs re-verification'] : [];
      if (st === null) { out.push({ claim: objRef(c), decision: c.stale ? 'review' : 'allow', reasons }); continue; }
      if (ports.useDecision === undefined) { out.push({ claim: objRef(c), decision: 'unchecked', reasons: [...reasons, 'No UseDecisionPort is configured; permission was not checked'] }); continue; }
      const d = await ports.useDecision.decide(ctx, { subjects: [st.body.sourceRef, ...st.body.permissionRefs, ...st.body.identityRefs], action, purpose: ctx.purpose, ...(typeof i.audience === 'string' ? { audience: i.audience } : {}) });
      out.push({ claim: objRef(c), decision: d.decision === 'allow' && c.stale ? 'review' : d.decision, reasons: [...reasons, ...d.reasons] });
    }
    return out;
  }

  // ───────────────────────────── search, export, standard surface ─────────────────────────────
  const SEARCH_KINDS = ['claim', 'entity', 'event', 'statement'];
  async function searchRows(ctx: ServiceContext, q: string, kinds: readonly string[], limit: number, R: Reader): Promise<{ rows: Record<string, any>[]; total: number }> {
    // Callers from whom any identity is withheld search the identity-safe index only, so names cannot be probed through hits or counts.
    const col = R.sees ? 'tsv' : 'tsv_public', txt = R.sees ? 'text' : 'text_public';
    const base = `from ${S}.objects, plainto_tsquery(${core.TS}, $5) query where tenant_id=$1 and project_id=$2 and ${core.VIS} and kind = any($4) and ${col} @@ query`;
    const params = [...core.scope(ctx), core.cmp(ctx), [...kinds], q];
    const rows = await sql.query(`select kind, id, revision, state, compartment, case_id, stale, blocked, flags, body, created_at, created_by, updated_at, ts_rank(${col}, query) as rank, ts_headline(${core.TS}, ${txt}, query, 'MaxWords=30, MinWords=8') as snippet ${base} order by rank desc, id limit ${limit}`, params);
    const total = Number(((await sql.query<{ n: string }>(`select count(*)::text as n ${base}`, params))[0] as { n: string }).n);
    return { rows, total };
  }
  /** Full-text search over claims, entities, events and statements. `similarity` is a text-match rank, not verification. */
  async function searchRecords(ctx: ServiceContext, query: { q: string; limit?: number; kinds?: string[] }): Promise<{ hits: (SearchHit & { similarity: number })[]; total: number; notice: string }> {
    requireCapability(ctx, 'knowledge:read');
    const i = strict<Record<string, unknown>>(query, ['q', 'limit', 'kinds'], 'search');
    const q = typeof i.q === 'string' ? i.q.trim().slice(0, 500) : '';
    if (q === '') return { hits: [], total: 0, notice: SIMILARITY_NOTICE };
    const kinds = i.kinds === undefined ? SEARCH_KINDS : (invariant(Array.isArray(i.kinds), 'invalid_input', 'kinds must be a list'), (i.kinds as unknown[]).map((k) => oneOf(k, SEARCH_KINDS, 'kinds')));
    const R = await core.reader(sql, ctx);
    const { rows, total } = await searchRows(ctx, q, kinds, Math.min(Math.max(Math.trunc(Number(i.limit ?? 20)) || 20, 1), 200), R);
    const hits = rows.map((r) => {
      const o: Obj = { kind: r.kind, id: r.id, revision: r.revision, state: r.state, compartment: r.compartment, caseId: r.case_id, stale: r.stale, blocked: r.blocked, flags: r.flags, body: r.body, createdAt: iso(r.created_at), createdBy: r.created_by, updatedAt: iso(r.updated_at) };
      return { ref: objRef(o), kind: o.kind, title: titleOf(o, R), snippet: String(r.snippet ?? ''), state: statusOf(o), similarity: Number(r.rank) };
    });
    return R.deep({ hits, total, notice: SIMILARITY_NOTICE });
  }
  async function search(ctx: ServiceContext, query: { q: string; limit?: number }): Promise<SearchHit[]> { return (await searchRecords(ctx, query)).hits; }
  /** Versioned dossier export for one claim or a whole case. Requires `knowledge:export`; identities stay withheld without disclosure rights. */
  async function exportDossier(ctx: ServiceContext, scopeInput: { claimId?: string; caseId?: string }): Promise<Record<string, any>> {
    requireCapability(ctx, 'knowledge:export');
    await reauthorize(ctx, 'knowledge:export');
    const sc = strict<Record<string, unknown>>(scopeInput, ['claimId', 'caseId'], 'export scope');
    invariant((typeof sc.claimId === 'string') !== (typeof sc.caseId === 'string'), 'invalid_input', 'Exactly one of claimId or caseId is required');
    const readCtx: ServiceContext = { ...ctx, capabilities: [...ctx.capabilities, 'knowledge:read'] };
    const graph = await evidenceGraph(readCtx, sc as { claimId?: string; caseId?: string });
    const claimIds = graph.nodes.filter((n) => n.type === 'claim').map((n) => parseUref(n.id).id);
    const claims = []; for (const id of claimIds) claims.push({ dossier: await getClaim(readCtx, id), history: await claimHistory(readCtx, id) });
    const R = await core.reader(sql, ctx);
    const entities = []; for (const o of await core.many(sql, ctx, 'entity', graph.nodes.filter((n) => n.type === 'entity').map((n) => parseUref(n.id).id))) entities.push(await entityView(sql, ctx, o, R));
    const others: ObjectView[] = [];
    for (const k of ['relationship', 'event', 'statement', 'alternative', 'contradiction', 'source_family'] as Kind[]) for (const o of await core.many(sql, ctx, k, graph.nodes.filter((n) => n.type === k).map((n) => parseUref(n.id).id))) others.push(view(o, R));
    await sql.tx((tx) => core.record(tx, ctx, 'knowledge.exported', typeof sc.claimId === 'string' ? selfRef('claim', sc.claimId) : selfRef('proposal', 'case-export'), { scope: graph.scope, claims: claimIds.length, identitiesDisclosed: R.sees && R.protection.groups.length > 0 }));
    return R.deep({ format: 'e07-dossier/1', exportedAt: iso(ctx.now), exportedBy: ctx.actor.id, scope: graph.scope, claims, entities, records: others, graph, notices: [...graph.notices, 'No numeric guilt or credibility score exists in this engine.'] });
  }
  const INSPECT_KINDS: readonly string[] = KINDS;
  async function inspect(ctx: ServiceContext, ref: string): Promise<Inspection | null> {
    requireCapability(ctx, 'knowledge:read');
    let p; try { p = parseUref(ref); } catch { return null; }
    if (p.engine !== 'E07' || !INSPECT_KINDS.includes(p.kind)) return null;
    const kind = p.kind as Kind;
    const o = await core.load(sql, ctx, kind, p.id);
    if (o === null) return null;
    const R = await core.reader(sql, ctx);
    const revs = (await revisionsOf(sql, ctx, kind, [o.id], R)).get(o.id) ?? [];
    const sources = (await sql.query<{ source_ref: string }>(`select distinct source_ref from ${S}.deps where tenant_id=$1 and project_id=$2 and dep_kind=$3 and dep_id=$4 order by 1`, [...core.scope(ctx), kind, o.id])).map((r) => r.source_ref);
    const dependents = (await sql.query<{ kind: string; id: string; revision: number }>(`select distinct o.kind, o.id, o.revision from ${S}.deps d join ${S}.objects o on o.tenant_id=d.tenant_id and o.project_id=d.project_id and o.kind=d.dep_kind and o.id=d.dep_id
      where d.tenant_id=$1 and d.project_id=$2 and d.source_key=$4 and (o.compartment is null or o.compartment = any($3)) order by 1,2`, [...core.scope(ctx), [...ctx.compartments], selfRef(kind, o.id)])).map((r) => selfRef(r.kind, r.id, r.revision));
    const assess = kind === 'claim' ? (await assessmentsOf(sql, ctx, [o.id])).get(o.id) ?? [] : [];
    const data = kind === 'entity' ? await entityView(sql, ctx, o, R) : view(o, R);
    return R.deep({
      ref: objRef(o), kind, title: titleOf(o, R), state: statusOf(o), stale: o.stale, blocked: o.blocked, staleReasons: activeFlags(o).map((f) => `${f.flag}: ${f.reason} (cause ${f.cause})`),
      versions: revs.map((r) => ({ revision: r.revision, at: r.at, actorId: r.actorId, summary: r.reason })), sources, dependents,
      permissions: kind === 'statement' ? [o.body.use as Json] : [],
      decisions: kind === 'claim' ? (DIMENSIONS.map((d) => currentOf(o.id, assess)[d]) as unknown as Json[]) : kind === 'proposal' && o.body.review !== null ? [o.body.review as Json] : [],
      history: [...revs.map((r) => ({ at: r.at, actorId: r.actorId, action: r.revision === 1 ? 'created' : 'revised', detail: { revision: r.revision, reason: r.reason, state: r.state } as Json })),
        ...o.flags.map((f) => ({ at: f.at, actorId: 'system', action: `flagged_${f.flag}`, detail: { reason: f.reason, cause: f.cause, cleared: f.clearedAt ?? null } as Json }))].sort((a, b) => a.at.localeCompare(b.at)),
      data: data as unknown as Json,
    });
  }
  async function audit(ctx: ServiceContext, options: { after?: string; limit?: number; subject?: string } = {}): Promise<AuditRecord[]> {
    requireCapability(ctx, 'knowledge:audit');
    return listAudit(sql, S, ctx, options);
  }
  async function events(ctx: ServiceContext, options: { after?: string; limit?: number } = {}): Promise<EngineEvent[]> {
    requireCapability(ctx, 'knowledge:events');
    return (await readEvents(sql, S, { ...options, tenantId: ctx.tenantId })).map((e) => ({ ...e, engine: 'E07' }));
  }
  async function health(): Promise<{ ok: boolean; detail: Json }> {
    try { const r = await sql.query<{ n: string }>(`select count(*)::text as n from ${S}._migrations`); return { ok: true, detail: { schema: S, migrations: Number(r[0]?.n ?? 0), evidencePort: ports.evidence !== undefined, useDecisionPort: ports.useDecision !== undefined, authorizationPort: ports.authorization !== undefined } }; }
    catch { return { ok: false, detail: { schema: S, error: 'database unavailable' } }; }
  }

  const engine = {
    manifest,
    // entities, identity decisions, reversible merges
    createEntity, reviseEntity, getEntity, recordEntityMatch, mergeEntities, unmergeEntities,
    // claims, statements, evidence, relationships, events
    createClaim, reviseClaim, getClaim, claimHistory, createStatement, reviseStatement, addEvidenceLink, reviseEvidenceLink, retractEvidenceLink,
    createRelationship, reviseRelationship, createEvent, reviseEvent,
    // source families, contradictions, alternatives
    createSourceFamily, reviseSourceFamily, suggestSourceFamilies, independence, recordContradiction, resolveContradiction, addAlternativeExplanation, reviseAlternativeExplanation,
    // assessments and proposals
    proposeAssessment, recordAssessment, rejectAssessmentProposal, assessments, proposeClaims, proposeEntities, proposeLinks, reviewProposal,
    // queries
    get, list, history, evidenceGraph, researchGaps, chronology, impactOf, searchRecords, exportDossier, usability,
    // corrections and flags
    openCorrection, resolveFlag,
    // standard surface
    inspect, search, audit, events, applyUpstreamChange, health,
  };
  return engine satisfies StandardEngine;
}
