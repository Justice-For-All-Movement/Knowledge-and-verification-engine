// E07 Knowledge and Verification — schema, vocabulary, input validation and shared types of the service layer.
// This file imports only the vendored kit and contracts; other engines are referenced by universal reference strings.
import { DomainError, invariant, nonempty } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { parseUref, runMigrations, SERVICE_KIT_VERSION } from '../service-kit.ts';
import type { EngineManifestV1, EvidencePort, Migration, Sql, UseDecisionPort, AuthorizationPort } from '../service-kit.ts';

export const SCHEMA = 'e07_knowledge';
export const ENGINE_ID = 'E07';

export const CAPABILITIES = [
  'knowledge:read', 'knowledge:write', 'knowledge:propose', 'knowledge:review', 'knowledge:assess', 'knowledge:approve',
  'knowledge:merge', 'knowledge:disclose_identity', 'knowledge:export', 'knowledge:audit', 'knowledge:events', 'knowledge:upstream',
] as const;

export const EVENTS = [
  'knowledge.claim_created', 'knowledge.claim_changed', 'knowledge.claim_stale', 'knowledge.claim_blocked',
  'knowledge.evidence_link_stale', 'knowledge.evidence_link_blocked', 'knowledge.statement_stale', 'knowledge.statement_blocked',
  'knowledge.relationship_stale', 'knowledge.relationship_blocked', 'knowledge.event_stale', 'knowledge.event_blocked',
  'knowledge.alternative_stale', 'knowledge.alternative_blocked',
  'knowledge.assessment_proposed', 'knowledge.assessment_recorded', 'knowledge.evidence_link_changed',
  'knowledge.source_family_changed', 'knowledge.entity_changed', 'knowledge.entity_merged', 'knowledge.entity_unmerged',
  'knowledge.entity_match_recorded', 'knowledge.relationship_changed', 'knowledge.event_changed', 'knowledge.statement_changed',
  'knowledge.contradiction_changed', 'knowledge.alternative_changed', 'knowledge.proposal_submitted', 'knowledge.proposal_reviewed',
  'knowledge.correction_opened', 'knowledge.flag_resolved',
] as const;

export const manifest: EngineManifestV1 = {
  id: ENGINE_ID, name: 'Knowledge and verification engine', version: '1.0.0', kit: SERVICE_KIT_VERSION,
  capabilities: CAPABILITIES, emits: EVENTS,
  consumes: ['source_corrected', 'source_superseded', 'source_removed', 'content_changed', 'permission_withdrawn', 'permission_changed'],
};

export const migrations: readonly Migration[] = [{
  id: '001_knowledge_core',
  sql: `
create table {s}.objects (
  tenant_id text not null, project_id text not null, kind text not null, id text not null,
  revision int not null, state text not null, compartment text, case_id text,
  stale boolean not null default false, blocked boolean not null default false,
  flags jsonb not null default '[]'::jsonb, body jsonb not null,
  text text, text_public text, tsv tsvector, tsv_public tsvector,
  created_at timestamptz not null, created_by text not null, updated_at timestamptz not null,
  primary key (tenant_id, project_id, kind, id)
);
create index objects_case on {s}.objects (tenant_id, project_id, kind, case_id);
create index objects_tsv on {s}.objects using gin (tsv);
create index objects_tsv_public on {s}.objects using gin (tsv_public);
create table {s}.revisions (
  tenant_id text not null, project_id text not null, kind text not null, id text not null, revision int not null,
  state text not null, compartment text, body jsonb not null, reason text not null,
  actor_id text not null, actor_kind text not null, request_id text not null, at timestamptz not null,
  primary key (tenant_id, project_id, kind, id, revision)
);
create table {s}.deps (
  tenant_id text not null, project_id text not null, owner_kind text not null, owner_id text not null,
  dep_kind text not null, dep_id text not null, source_ref text not null, source_key text not null, role text not null,
  primary key (tenant_id, project_id, owner_kind, owner_id, dep_kind, dep_id, source_ref, role)
);
create index deps_source on {s}.deps (tenant_id, project_id, source_key);
create index deps_dep on {s}.deps (tenant_id, project_id, dep_kind, dep_id);
create table {s}.assessments (
  seq bigint generated always as identity primary key,
  tenant_id text not null, project_id text not null, id text not null, claim_id text not null, claim_revision int not null,
  dimension text not null check (dimension in ('factual','source_type','procedural','editorial')),
  value text not null, rationale text not null, basis text, cites jsonb not null, detail jsonb not null default '{}'::jsonb,
  status text not null check (status in ('proposed','final')),
  decision text check (decision in ('confirmed','rejected')), decided_by text, decided_at timestamptz, decision_reason text,
  proposal_id text, actor_id text not null, actor_kind text not null, request_id text not null, at timestamptz not null,
  flags jsonb not null default '[]'::jsonb,
  unique (tenant_id, project_id, id)
);
create index assessments_claim on {s}.assessments (tenant_id, project_id, claim_id, dimension, seq);
create table {s}.family_members (
  tenant_id text not null, project_id text not null, family_id text not null, source_key text not null, source_ref text not null,
  primary key (tenant_id, project_id, source_key)
);
create index family_members_family on {s}.family_members (tenant_id, project_id, family_id);
create table {s}.upstream_changes (
  tenant_id text not null, project_id text not null, event_id text not null, kind text not null,
  refs jsonb not null, reason text not null, affected jsonb not null, at timestamptz not null,
  primary key (tenant_id, project_id, event_id)
);
create function {s}.forbid_change() returns trigger language plpgsql as $$
begin raise exception 'append-only history: % on %.% is not permitted', tg_op, tg_table_schema, tg_table_name; end $$;
create trigger revisions_append_only before update or delete on {s}.revisions for each row execute function {s}.forbid_change();
create trigger assessments_no_delete before delete on {s}.assessments for each row execute function {s}.forbid_change();
create function {s}.assessment_immutable() returns trigger language plpgsql as $$
begin
  if (new.value, new.rationale, new.dimension, new.claim_id, new.claim_revision, new.status, new.actor_id, new.actor_kind, new.at, new.cites, new.basis, new.detail, new.proposal_id)
     is distinct from (old.value, old.rationale, old.dimension, old.claim_id, old.claim_revision, old.status, old.actor_id, old.actor_kind, old.at, old.cites, old.basis, old.detail, old.proposal_id)
  then raise exception 'assessment records are immutable; record a new assessment instead'; end if;
  return new;
end $$;
create trigger assessments_immutable before update on {s}.assessments for each row execute function {s}.assessment_immutable();
create trigger objects_no_delete before delete on {s}.objects for each row execute function {s}.forbid_change();
`,
}];

export function migrate(sql: Sql): Promise<string[]> { return runMigrations(sql, SCHEMA, migrations); }

// ───────────────────────────── Vocabulary ─────────────────────────────
export const KINDS = ['entity', 'relationship', 'event', 'claim', 'statement', 'evidence_link', 'source_family', 'contradiction', 'alternative', 'proposal', 'entity_match', 'entity_merge'] as const;
export type Kind = typeof KINDS[number];
export const CLAIM_TYPES = ['allegation', 'attributed_statement', 'observation', 'inference', 'reconstruction_note'] as const;
export const STANCES = ['supports', 'challenges', 'context'] as const;
export const FACTUAL_VALUES = ['unassessed', 'supported', 'contested', 'refuted', 'unresolvable'] as const;
export const EDITORIAL_VALUES = ['not_reviewed', 'approved', 'approved_with_conditions', 'rejected', 'withdrawn'] as const;
export const DIMENSIONS = ['factual', 'source_type', 'procedural', 'editorial'] as const;
export type Dimension = typeof DIMENSIONS[number];
export const PRECISIONS = ['instant', 'minute', 'hour', 'day', 'month', 'year', 'decade', 'approximate', 'unknown'] as const;
export const SELECTOR_KINDS = ['whole', 'page', 'text', 'time', 'segment', 'region'] as const;
export const PROPOSAL_ORIGINS = ['model', 'reply', 'extraction', 'import', 'discovery', 'human'] as const;

/** The standing notice attached to every relationship: a documented connection is not evidence of involvement. */
export const RELATIONSHIP_NOTICE = 'A relationship records a documented connection between two records. It is not an assessment of involvement, responsibility or culpability, and no assessment is derived from it.';
export const SIMILARITY_NOTICE = 'similarity is a retrieval or matching aid. It is not factual verification and cannot change an assessment.';
export const PROPOSAL_NOTICE = 'Untrusted proposal: unassessed in every dimension until a human reviewer accepts it; acceptance is not verification.';

export type EngineConfig = Readonly<{
  /** Vocabulary for dimension 2 (source type) and for per-link source classification. */
  sourceTypes?: readonly string[];
  /** Source types that count as primary material for the `supported` rule and the research-gap report. */
  primarySourceTypes?: readonly string[];
  /** Deployment vocabulary for dimension 3 (procedural/legal status). Never inferred; only recorded by a human. */
  proceduralVocabulary?: readonly string[];
  entityTypes?: readonly string[];
  /** Minimum length of a documented rationale that may stand in for a released primary source. */
  minRationaleLength?: number;
  /** PostgreSQL text search configuration (default `simple`, language-neutral). */
  searchConfig?: string;
}>;
export type EnginePorts = Readonly<{ evidence?: Pick<EvidencePort, 'describe'>; useDecision?: UseDecisionPort; authorization?: AuthorizationPort }>;
export type EngineDeps = Readonly<{ sql: Sql; ports?: EnginePorts; config?: EngineConfig }>;

export const DEFAULTS = {
  sourceTypes: ['primary', 'official_record', 'testimony', 'secondary', 'tertiary', 'statement_of_subject', 'derived_analysis', 'unknown'],
  primarySourceTypes: ['primary', 'official_record'],
  proceduralVocabulary: ['not_recorded', 'none_known', 'complaint_filed', 'alleged', 'under_investigation', 'charged', 'adjudicated', 'dismissed', 'under_appeal', 'closed'],
  entityTypes: ['person', 'organization', 'place', 'object', 'document', 'account', 'vehicle', 'group', 'other', 'unknown'],
  minRationaleLength: 40,
  searchConfig: 'simple',
} as const;

// ───────────────────────────── Shared shapes ─────────────────────────────
export type TimeInterval = Readonly<{ earliest: string | null; latest: string | null; precision: typeof PRECISIONS[number]; note?: string }>;
export type ObjRef = Readonly<{ kind: string; id: string }>;
export type Flag = Readonly<{ id: string; flag: 'stale' | 'blocked'; reason: string; cause: string; changeKind: string; via: readonly string[]; at: string; clearedAt?: string; clearedBy?: string; clearNote?: string }>;
export type Selector = Readonly<{ kind: typeof SELECTOR_KINDS[number]; page?: number; pageEnd?: number; start?: number; end?: number; quote?: string; segmentId?: string; region?: Json; label?: string }>;
export type Obj = {
  kind: Kind; id: string; revision: number; state: string; compartment: string | null; caseId: string | null;
  stale: boolean; blocked: boolean; flags: Flag[]; body: Record<string, any>; createdAt: string; createdBy: string; updatedAt: string;
};

// ───────────────────────────── Validation ─────────────────────────────
export const bad = (message: string, code = 'invalid_input'): never => { throw new DomainError(code, message); };
/** Rejects unknown keys so untrusted inputs cannot smuggle scores, assessments, capabilities or instructions. */
export function strict<T extends Record<string, unknown>>(input: unknown, allowed: readonly string[], label: string): T {
  invariant(input !== null && typeof input === 'object' && !Array.isArray(input), 'invalid_input', `${label} must be an object`);
  for (const k of Object.keys(input as object)) invariant(allowed.includes(k), 'invalid_input', `${label}: unknown field ${k.slice(0, 60)}`);
  return input as T;
}
export function text(v: unknown, label: string, max = 2000): string { nonempty(v, label, max); return (v as string).trim(); }
export function optText(v: unknown, label: string, max = 2000): string | null { return v === undefined || v === null || v === '' ? null : text(v, label, max); }
export function oneOf<T extends string>(v: unknown, values: readonly T[], label: string): T {
  invariant(typeof v === 'string' && (values as readonly string[]).includes(v), 'invalid_input', `${label} must be one of: ${values.join(', ')}`);
  return v as T;
}
const ID = /^[A-Za-z0-9._~-]{1,128}$/;
export function idOf(v: unknown, label: string): string { invariant(typeof v === 'string' && ID.test(v), 'invalid_input', `${label} must be an identifier`); return v as string; }
export function ids(v: unknown, label: string, max = 200): string[] {
  if (v === undefined || v === null) return [];
  invariant(Array.isArray(v) && v.length <= max, 'invalid_input', `${label} must be a list of at most ${max} identifiers`);
  return [...new Set(v.map((x) => idOf(x, label)))];
}
export function label(v: unknown, name: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  invariant(typeof v === 'string' && /^[A-Za-z0-9._:@~-]{1,200}$/.test(v), 'invalid_input', `${name} must be a short token`);
  return v as string;
}
export function urefOf(v: unknown, name: string, options: { pinned?: boolean } = {}): string {
  invariant(typeof v === 'string' && v.length <= 400, 'invalid_reference', `${name} must be a universal reference`);
  const p = parseUref(v as string);
  if (options.pinned === true) invariant(p.revision !== undefined, 'invalid_reference', `${name} must name a specific version (…@<revision>)`);
  return v as string;
}
export function urefs(v: unknown, name: string, max = 100): string[] {
  if (v === undefined || v === null) return [];
  invariant(Array.isArray(v) && v.length <= max, 'invalid_reference', `${name} must be a list of universal references`);
  return [...new Set(v.map((x) => urefOf(x, name)))];
}
/** Identity of a referenced object without its revision: `E05:evidence_version:<id>`. */
export function urefKey(ref: string): string { const p = parseUref(ref); return `${p.engine}:${p.kind}:${p.id}`; }

const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
export function interval(v: unknown, name: string): TimeInterval | null {
  if (v === undefined || v === null) return null;
  const t = strict<Record<string, unknown>>(v, ['earliest', 'latest', 'precision', 'note'], name);
  const at = (x: unknown): string | null => {
    if (x === undefined || x === null) return null;
    invariant(typeof x === 'string' && INSTANT.test(x) && Number.isFinite(Date.parse(x)), 'invalid_time', `${name}: bounds must be UTC instants (YYYY-MM-DDTHH:MM:SSZ) or null`);
    return new Date(x as string).toISOString();
  };
  const earliest = at(t.earliest), latest = at(t.latest);
  invariant(earliest === null || latest === null || earliest <= latest, 'invalid_time', `${name}: earliest is after latest`);
  const precision = t.precision === undefined ? (earliest === null && latest === null ? 'unknown' : 'approximate') : oneOf(t.precision, PRECISIONS, `${name}.precision`);
  const note = optText(t.note, `${name}.note`, 1000);
  return { earliest, latest, precision, ...(note === null ? {} : { note }) };
}
export function selector(v: unknown): Selector {
  const s = strict<Record<string, unknown>>(v, ['kind', 'page', 'pageEnd', 'start', 'end', 'quote', 'segmentId', 'region', 'label'], 'selector');
  const kind = oneOf(s.kind, SELECTOR_KINDS, 'selector.kind');
  const num = (x: unknown, n: string, min = 0): number | undefined => {
    if (x === undefined || x === null) return undefined;
    invariant(typeof x === 'number' && Number.isFinite(x) && x >= min && x <= 1e12, 'invalid_input', `selector.${n} must be a number ≥ ${min}`);
    return x as number;
  };
  const out: Record<string, Json> = { kind };
  const page = num(s.page, 'page', 1), pageEnd = num(s.pageEnd, 'pageEnd', 1), start = num(s.start, 'start'), end = num(s.end, 'end');
  const quote = optText(s.quote, 'selector.quote', 16000), segmentId = optText(s.segmentId, 'selector.segmentId', 200), lab = optText(s.label, 'selector.label', 300);
  if (kind === 'page') invariant(page !== undefined && Number.isInteger(page) && (pageEnd === undefined || (Number.isInteger(pageEnd) && pageEnd >= page)), 'invalid_input', 'A page selector needs page (and optionally pageEnd ≥ page)');
  if (kind === 'time') invariant(start !== undefined && (end === undefined || end >= start), 'invalid_input', 'A time selector needs start seconds (and optionally end ≥ start)');
  if (kind === 'text') invariant(quote !== null || (start !== undefined && end !== undefined && end > start), 'invalid_input', 'A text selector needs a quote or a start/end character range');
  if (kind === 'segment') invariant(segmentId !== null, 'invalid_input', 'A segment selector needs segmentId');
  if (kind === 'region') invariant(s.region !== undefined && s.region !== null && JSON.stringify(s.region).length <= 2000, 'invalid_input', 'A region selector needs a bounded region');
  if (page !== undefined) out.page = page; if (pageEnd !== undefined) out.pageEnd = pageEnd;
  if (start !== undefined) out.start = start; if (end !== undefined) out.end = end;
  if (quote !== null) out.quote = quote; if (segmentId !== null) out.segmentId = segmentId; if (lab !== null) out.label = lab;
  if (s.region !== undefined && s.region !== null) out.region = JSON.parse(JSON.stringify(s.region)) as Json;
  return out as unknown as Selector;
}
/** A similarity value is carried only under this explicit label. */
export function similarity(v: unknown): { value: number; label: 'similarity'; notice: string } | null {
  if (v === undefined || v === null) return null;
  invariant(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1, 'invalid_input', 'similarity must be a number between 0 and 1');
  return { value: v as number, label: 'similarity', notice: SIMILARITY_NOTICE };
}
export function describeSelector(s: Selector): string {
  switch (s.kind) {
    case 'whole': return 'whole item';
    case 'page': return s.pageEnd === undefined ? `page ${s.page}` : `pages ${s.page}–${s.pageEnd}`;
    case 'time': return s.end === undefined ? `at ${s.start}s` : `${s.start}s–${s.end}s`;
    case 'segment': return `segment ${s.segmentId}`;
    case 'region': return `region${s.page === undefined ? '' : ` on page ${s.page}`}`;
    default: return s.quote !== undefined ? `text “${s.quote.length > 80 ? `${s.quote.slice(0, 80)}…` : s.quote}”` : `characters ${s.start}–${s.end}`;
  }
}
