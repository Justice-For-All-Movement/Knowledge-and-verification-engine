import {
  analyzeSources,
  assertEvidenceState,
  evidenceDependencyFingerprint,
  getFamilySnapshot,
  validateEvidenceSelector,
} from "@accountability/evidence";
import type {
  EvidenceState,
  EvidenceSelector,
  FamilySnapshot,
  SourceAnalysis,
} from "@accountability/evidence";
import {
  canonical,
  invariant,
  nonempty,
  requireScope,
  validateRef,
} from "./contracts.ts";
import type { Context, Ref, Scope } from "./contracts.ts";
import { inspectKnowledge } from "./index.ts";
import type { KnowledgeState } from "./index.ts";

export type EvidenceLinkInput = Readonly<{
  id: string;
  relation: "supports" | "challenges" | "quotes";
  selector: EvidenceSelector;
}>;
export type EvidenceLink = EvidenceLinkInput &
  Readonly<{
    family: FamilySnapshot;
    fingerprint: string;
  }>;
export type EvidenceLinksRevision = Readonly<{
  ref: Ref;
  supersedes: Ref | null;
  claim: Ref;
  visibility: "private";
  actorId: string;
  actorKind: Context["actor"]["kind"];
  createdAt: string;
  requestId: string;
  purpose: string;
  links: readonly EvidenceLink[];
}>;
export type EvidenceLinksState = Scope &
  Readonly<{
    schemaVersion: 1;
    visibility: "private";
    records: readonly EvidenceLinksRevision[];
  }>;
export type EvidenceLinksCommand = Readonly<{
  claim: Ref;
  expectedRevision: number;
  links: readonly EvidenceLinkInput[];
}>;
export type EvidenceLinksReview = Readonly<{
  revision: EvidenceLinksRevision;
  sources: Readonly<Record<EvidenceLinkInput["relation"], SourceAnalysis>>;
}>;
const relations = ["supports", "challenges", "quotes"] as const;
const hash = /^[a-f0-9]{64}$/;
function exact(v: unknown, keys: readonly string[]): void {
  invariant(
    v !== null &&
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype &&
      Object.keys(v).length === keys.length &&
      keys.every((k) => Object.hasOwn(v, k)),
    "invalid_links",
    "Exact plain record fields required",
  );
}
function bounded(v: unknown, limit: number) {
  invariant(
    Buffer.byteLength(canonical(v)) <= limit,
    "links_full",
    "Snapshot byte budget exceeded",
  );
}
function ref(r: Ref, s: Scope, kind: string) {
  validateRef(r);
  requireScope(s, r);
  nonempty(r.id, "Reference", 128);
  invariant(
    r.kind === kind,
    "invalid_reference",
    "Exact typed reference required",
  );
}
function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
function selector(s: EvidenceSelector, scope: Scope) {
  invariant(
    s && ["whole", "text", "page", "time"].includes(s.kind),
    "invalid_selector",
    "Known selector required",
  );
  const base = ["evidence", "sha256", "kind"];
  const anchor = [...base, "representationId", "representationDigest"];
  exact(
    s,
    s.kind === "whole"
      ? base
      : s.kind === "text"
        ? [...anchor, "page", "start", "end", "quote"]
        : s.kind === "page"
          ? [...anchor, "fromPage", "toPage"]
          : [...anchor, "startMs", "endMs"],
  );
  ref(s.evidence, scope, "evidence");
  invariant(hash.test(s.sha256), "invalid_selector", "Byte digest required");
  if (s.kind === "whole") return;
  nonempty(s.representationId, "Representation", 128);
  invariant(
    hash.test(s.representationDigest),
    "invalid_selector",
    "Representation digest required",
  );
  const integer = (n: number, min: number) =>
    invariant(
      Number.isSafeInteger(n) && n >= min,
      "invalid_selector",
      "Bounded integer required",
    );
  if (s.kind === "text") {
    if (s.page !== null) integer(s.page, 1);
    integer(s.start, 0);
    integer(s.end, 1);
    nonempty(s.quote, "Quote", 16000);
    invariant(
      s.start < s.end,
      "invalid_selector",
      "Nonempty ordered text span required",
    );
  } else if (s.kind === "page") {
    integer(s.fromPage, 1);
    integer(s.toPage, 1);
    invariant(
      s.fromPage <= s.toPage,
      "invalid_selector",
      "Ordered pages required",
    );
  } else {
    integer(s.startMs, 0);
    integer(s.endMs, 1);
    invariant(
      s.startMs < s.endMs,
      "invalid_selector",
      "Ordered media interval required",
    );
  }
}
function input(i: EvidenceLinkInput, s: Scope) {
  nonempty(i.id, "Link", 128);
  invariant(
    relations.includes(i.relation),
    "invalid_links",
    "Explicit support/challenge/quotation relation required",
  );
  selector(i.selector, s);
}
function stamp(
  r: Pick<
    EvidenceLinksRevision,
    "actorId" | "actorKind" | "createdAt" | "requestId" | "purpose"
  >,
) {
  nonempty(r.actorId, "Actor", 128);
  nonempty(r.requestId, "Request", 128);
  nonempty(r.purpose, "Purpose", 200);
  invariant(
    ["human", "agent", "service"].includes(r.actorKind) &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(r.createdAt) &&
      Number.isFinite(Date.parse(r.createdAt)) &&
      new Date(r.createdAt).toISOString() ===
        r.createdAt.replace(/Z$/, r.createdAt.includes(".") ? "Z" : ".000Z"),
    "invalid_links",
    "Valid actor and UTC request time required",
  );
}
function authorize(c: Context, s: Scope) {
  // Reuse the accepted Knowledge role/scope/time admission, without claiming current authentication.
  inspectKnowledge(c, {
    tenantId: s.tenantId,
    projectId: s.projectId,
    schemaVersion: 1,
    visibility: "private",
    records: [],
  });
}
/** Syntax/history validation only. Stored fingerprints are not current source authorization. */
export function assertEvidenceLinksState(s: EvidenceLinksState): void {
  exact(s, ["tenantId", "projectId", "schemaVersion", "visibility", "records"]);
  nonempty(s.tenantId, "Tenant", 128);
  nonempty(s.projectId, "Project", 128);
  invariant(
    s.schemaVersion === 1 &&
      s.visibility === "private" &&
      Array.isArray(s.records) &&
      s.records.length <= 512,
    "invalid_links",
    "Bounded private link history required",
  );
  bounded(s, 2 * 1024 * 1024);
  const latest = new Map<string, EvidenceLinksRevision>();
  for (const r of s.records) {
    exact(r, [
      "ref",
      "supersedes",
      "claim",
      "visibility",
      "actorId",
      "actorKind",
      "createdAt",
      "requestId",
      "purpose",
      "links",
    ]);
    ref(r.ref, s, "knowledge-evidence-links");
    ref(r.claim, s, "claim");
    stamp(r);
    invariant(
      r.visibility === "private" && r.ref.id === r.claim.id,
      "invalid_links",
      "Claim-bound private record required",
    );
    const previous = latest.get(r.ref.id);
    invariant(
      r.ref.revision === (previous?.ref.revision ?? 0) + 1 &&
        (previous
          ? same(r.supersedes, previous.ref) &&
            r.claim.revision >= previous.claim.revision
          : r.supersedes === null),
      "invalid_revision",
      "Exact contiguous predecessor and nonregressing claim required",
    );
    invariant(
      Array.isArray(r.links) && r.links.length <= 64,
      "invalid_links",
      "At most 64 links required",
    );
    const ids = new Set<string>();
    const selectors = new Set<string>();
    for (const l of r.links) {
      exact(l, ["id", "relation", "selector", "family", "fingerprint"]);
      input(l, s);
      const k = canonical([l.relation, l.selector]);
      invariant(
        !ids.has(l.id) && !selectors.has(k),
        "duplicate_link",
        "Distinct link IDs and relation/selectors required",
      );
      ids.add(l.id);
      selectors.add(k);
      exact(l.family, ["familyId", "roots", "basisDigest"]);
      if (l.family.familyId !== null)
        nonempty(l.family.familyId, "Family", 128);
      invariant(
        Array.isArray(l.family.roots) &&
          l.family.roots.length <= 128 &&
          new Set(l.family.roots).size === l.family.roots.length &&
          hash.test(l.family.basisDigest) &&
          hash.test(l.fingerprint),
        "invalid_links",
        "Bounded captured family and fingerprint required",
      );
      for (const root of l.family.roots) nonempty(root, "Root", 128);
    }
    latest.set(r.ref.id, r);
  }
}
export function createEvidenceLinksState(context: Context): EvidenceLinksState {
  const c = structuredClone(context);
  authorize(c, c);
  return {
    tenantId: c.tenantId,
    projectId: c.projectId,
    schemaVersion: 1,
    visibility: "private",
    records: [],
  };
}
function currentClaim(c: Context, k: KnowledgeState, claim: Ref) {
  ref(claim, k, "claim");
  const records = inspectKnowledge(c, k);
  invariant(
    records.some((r) => same(r.ref, claim)),
    "missing_reference",
    "Claim edition missing",
  );
  invariant(
    !records.some(
      (r) =>
        r.ref.kind === "claim" &&
        r.ref.id === claim.id &&
        r.ref.revision > claim.revision,
    ),
    "stale_claim",
    "Explicit current claim edition required",
  );
}
function captureEvidence(s: EvidenceState, c: Context) {
  requireScope(c, s);
  // Bound the caller-supplied snapshot before copying or entering recursive upstream validators.
  bounded(s, 8 * 1024 * 1024);
  for (const a of [
    s.versions,
    s.families,
    s.independence,
    s.scans,
    s.representations,
    s.integrity,
    s.handling,
    s.redactionPlans,
  ])
    invariant(
      Array.isArray(a) && a.length <= 4096,
      "invalid_links",
      "Bounded Evidence collections required",
    );
  invariant(
    s.families.length <= 64 && s.versions.length <= 512,
    "invalid_links",
    "Bounded Evidence graph required",
  );
  // Upstream roots walks every ancestry path. Refuse exponential/cyclic graph expansion first.
  const graph = new Map(s.families.map((f) => [f.id, f.parentIds]));
  let visits = 0;
  function walk(id: string, path: Set<string>) {
    invariant(
      ++visits <= 8192 && !path.has(id),
      "invalid_links",
      "Evidence family expansion budget exceeded",
    );
    const parents = graph.get(id);
    invariant(
      Array.isArray(parents) && parents.length <= 64,
      "invalid_links",
      "Bounded known family parents required",
    );
    const next = new Set(path).add(id);
    for (const parent of parents) walk(parent, next);
  }
  for (const id of graph.keys()) walk(id, new Set());
  const captured = structuredClone(s);
  assertEvidenceState(captured);
  return captured;
}
/** Append a citation-set revision after actual pinned Evidence validation. No assessment or effect. */
export function reviseEvidenceLinks(
  context: Context,
  knowledge: KnowledgeState,
  evidence: EvidenceState,
  state: EvidenceLinksState,
  command: EvidenceLinksCommand,
): EvidenceLinksState {
  const c = structuredClone(context),
    s = structuredClone(state),
    q = structuredClone(command);
  authorize(c, s);
  assertEvidenceLinksState(s);
  currentClaim(c, knowledge, q.claim);
  exact(q, ["claim", "expectedRevision", "links"]);
  invariant(
    Number.isSafeInteger(q.expectedRevision) &&
      q.expectedRevision >= 0 &&
      q.expectedRevision < Number.MAX_SAFE_INTEGER,
    "invalid_revision",
    "Expected logical link revision required",
  );
  invariant(
    Array.isArray(q.links) && q.links.length <= 64,
    "invalid_links",
    "Bounded link input required",
  );
  const previous = s.records.filter((r) => r.ref.id === q.claim.id).at(-1);
  invariant(
    (previous?.ref.revision ?? 0) === q.expectedRevision,
    "revision_conflict",
    "Link edition changed",
  );
  const e = captureEvidence(evidence, c);
  const links = q.links.map((l) => {
    exact(l, ["id", "relation", "selector"]);
    input(l, s);
    validateEvidenceSelector(e, c, l.selector);
    return {
      ...l,
      family: getFamilySnapshot(e, c, l.selector.evidence),
      fingerprint: evidenceDependencyFingerprint(e, c, l.selector),
    };
  });
  const r: EvidenceLinksRevision = {
    ref: {
      tenantId: s.tenantId,
      projectId: s.projectId,
      kind: "knowledge-evidence-links",
      id: q.claim.id,
      revision: q.expectedRevision + 1,
    },
    supersedes: previous?.ref ?? null,
    claim: q.claim,
    visibility: "private",
    actorId: c.actor.id,
    actorKind: c.actor.kind,
    createdAt: c.now,
    requestId: c.requestId,
    purpose: c.purpose,
    links,
  };
  const next: EvidenceLinksState = { ...s, records: [...s.records, r] };
  assertEvidenceLinksState(next);
  return next;
}
/** Read captured history without presenting it as revalidated evidence or a current permission. */
export function inspectEvidenceLinks(
  context: Context,
  state: EvidenceLinksState,
): readonly EvidenceLinksRevision[] {
  const c = structuredClone(context),
    s = structuredClone(state);
  authorize(c, s);
  assertEvidenceLinksState(s);
  return s.records;
}
/** Explicitly revalidate the latest link set/current claim against a supplied current authorized snapshot. */
export function reviewEvidenceLinks(
  context: Context,
  knowledge: KnowledgeState,
  evidence: EvidenceState,
  state: EvidenceLinksState,
  selected: Ref,
): EvidenceLinksReview {
  const c = structuredClone(context),
    r = selectCurrentEvidenceLinks(c, knowledge, state, selected);
  const e = captureEvidence(evidence, c);
  for (const l of r.links) {
    invariant(
      evidenceDependencyFingerprint(e, c, l.selector) === l.fingerprint &&
        same(getFamilySnapshot(e, c, l.selector.evidence), l.family),
      "stale_evidence_links",
      "Evidence dependency changed; explicitly revise links",
    );
  }
  const analyze = (relation: EvidenceLinkInput["relation"]) =>
    analyzeSources(
      e,
      c,
      r.links
        .filter((l) => l.relation === relation)
        .map((l) => l.selector.evidence),
    );
  return {
    revision: r,
    sources: {
      supports: analyze("supports"),
      challenges: analyze("challenges"),
      quotes: analyze("quotes"),
    },
  };
}

export function selectCurrentEvidenceLinks(
  context: Context, knowledge: KnowledgeState, state: EvidenceLinksState, selected: Ref,
): EvidenceLinksRevision {
  const c = structuredClone(context),
    s = structuredClone(state),
    rref = structuredClone(selected);
  authorize(c, s);
  assertEvidenceLinksState(s);
  ref(rref, s, "knowledge-evidence-links");
  const r = s.records.find((r) => same(r.ref, rref));
  invariant(r, "missing_reference", "Exact link edition missing");
  invariant(
    !s.records.some(
      (x) => x.ref.id === r.ref.id && x.ref.revision > r.ref.revision,
    ),
    "stale_links",
    "Explicit latest link set required",
  );
  currentClaim(c, knowledge, r.claim);
  requireScope(c, knowledge);
  invariant(
    r.purpose === c.purpose,
    "purpose_denied",
    "Review purpose differs from capture",
  );
  return structuredClone(r);
}
