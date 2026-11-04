import { copyJson } from "@accountability/consent-rights";
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
import {
  inspectEvidenceLinks,
  selectCurrentEvidenceLinks,
} from "./evidence-links.ts";
import type { EvidenceLinksState } from "./evidence-links.ts";

const axes = [
  "authenticity",
  "sourceKnowledge",
  "independentSupport",
  "counterevidence",
] as const;
export type ReviewCheck = Readonly<{
  status: "unreviewed" | "unresolved" | "concern" | "reviewed";
  note: string;
}>;
export type VerificationChecks = Readonly<
  Record<(typeof axes)[number], ReviewCheck>
>;
export type VerificationReviewInput = Readonly<{
  linkRef: Ref;
  expectedRevision: number;
  checks: VerificationChecks;
  rationale: string;
}>;
export type VerificationReviewRecord = Readonly<{
  ref: Ref;
  supersedes: Ref | null;
  claim: Ref;
  linkRef: Ref;
  challengeLinkIds: readonly string[];
  checks: VerificationChecks;
  rationale: string;
  resolution: "unresolved";
  assessment: null;
  proceduralPosture: null;
  editorialApproval: null;
  visibility: "private";
  actorId: string;
  createdAt: string;
  requestId: string;
}>;
export type VerificationReviewState = Scope &
  Readonly<{
    schemaVersion: 1;
    visibility: "private";
    purpose: string;
    records: readonly VerificationReviewRecord[];
  }>;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function exact(value: unknown, fields: readonly string[]) {
  invariant(
    value &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.keys(value).length === fields.length &&
      fields.every((k) => Object.hasOwn(value, k)),
    "invalid_review",
    "Exact plain review fields required",
  );
}
function authorize(c: Context, s: Scope & { purpose: string }) {
  inspectKnowledge(c, {
    tenantId: s.tenantId,
    projectId: s.projectId,
    schemaVersion: 1,
    visibility: "private",
    records: [],
  });
  invariant(
    c.actor.kind === "human" && c.purpose === s.purpose,
    "forbidden",
    "Host-authorized human exact-purpose review required",
  );
}
function typedRef(value: Ref, s: Scope, kind: string) {
  validateRef(value);
  requireScope(s, value);
  invariant(
    value.kind === kind,
    "invalid_review",
    "Exact typed review basis required",
  );
}
function validateState(s: VerificationReviewState) {
  exact(s, [
    "tenantId",
    "projectId",
    "schemaVersion",
    "visibility",
    "purpose",
    "records",
  ]);
  nonempty(s.purpose, "Purpose", 200);
  invariant(
    s.schemaVersion === 1 &&
      s.visibility === "private" &&
      Array.isArray(s.records) &&
      s.records.length <= 512,
    "invalid_review",
    "Bounded private review history required",
  );
  invariant(
    Buffer.byteLength(canonical(s)) <= 2 * 1024 * 1024,
    "review_full",
    "Review history byte budget exceeded",
  );
  const latest = new Map<string, VerificationReviewRecord>();
  for (const r of s.records) {
    exact(r, [
      "ref",
      "supersedes",
      "claim",
      "linkRef",
      "challengeLinkIds",
      "checks",
      "rationale",
      "resolution",
      "assessment",
      "proceduralPosture",
      "editorialApproval",
      "visibility",
      "actorId",
      "createdAt",
      "requestId",
    ]);
    typedRef(r.ref, s, "knowledge-verification-review");
    typedRef(r.claim, s, "claim");
    typedRef(r.linkRef, s, "knowledge-evidence-links");
    invariant(
      r.ref.id === r.claim.id &&
        r.linkRef.id === r.claim.id &&
        r.visibility === "private" &&
        r.resolution === "unresolved" &&
        r.assessment === null &&
        r.proceduralPosture === null &&
        r.editorialApproval === null,
      "invalid_review",
      "Review observations cannot become findings or approvals",
    );
    authorize(
      {
        tenantId: s.tenantId,
        projectId: s.projectId,
        actor: { id: r.actorId, kind: "human", roles: ["researcher"] },
        requestId: r.requestId,
        now: r.createdAt,
        purpose: s.purpose,
      },
      s,
    );
    nonempty(r.rationale, "Rationale", 4000);
    exact(r.checks, axes);
    for (const axis of axes) {
      const check = r.checks[axis];
      exact(check, ["status", "note"]);
      invariant(
        ["unreviewed", "unresolved", "concern", "reviewed"].includes(
          check.status,
        ),
        "invalid_review",
        "Explicit review observation required",
      );
      nonempty(check.note, "Review note", 4000);
    }
    invariant(
      Array.isArray(r.challengeLinkIds) &&
        r.challengeLinkIds.length <= 64 &&
        new Set(r.challengeLinkIds).size === r.challengeLinkIds.length,
      "invalid_review",
      "Distinct bounded captured challenge IDs required",
    );
    for (const id of r.challengeLinkIds) nonempty(id, "Challenge link ID", 128);
    const previous = latest.get(r.ref.id);
    invariant(
      r.ref.revision === (previous?.ref.revision ?? 0) + 1 &&
        (previous
          ? same(r.supersedes, previous.ref) &&
            r.claim.revision >= previous.claim.revision &&
            r.linkRef.revision >= previous.linkRef.revision
          : r.supersedes === null),
      "invalid_revision",
      "Exact contiguous nonregressing review history required",
    );
    latest.set(r.ref.id, r);
  }
}
/** Pure host-context admission; no authentication, source observation or persistence. */
export function createVerificationReviewState(
  context: Context,
): VerificationReviewState {
  const c = structuredClone(context);
  authorize(c, c);
  return {
    tenantId: c.tenantId,
    projectId: c.projectId,
    schemaVersion: 1,
    visibility: "private",
    purpose: c.purpose,
    records: [],
  };
}
/** Human-authored observations only. Even all reviewed axes remain unresolved. */
export function recordVerificationReview(
  context: Context,
  knowledge: KnowledgeState,
  links: EvidenceLinksState,
  state: VerificationReviewState,
  input: VerificationReviewInput,
): VerificationReviewState {
  const c = structuredClone(context),
    s = copyJson(state) as unknown as VerificationReviewState,
    q = copyJson(input) as unknown as VerificationReviewInput;
  authorize(c, s);
  validateState(s);
  exact(q, ["linkRef", "expectedRevision", "checks", "rationale"]);
  invariant(
    Number.isSafeInteger(q.expectedRevision) &&
      q.expectedRevision >= 0 &&
      q.expectedRevision < Number.MAX_SAFE_INTEGER,
    "invalid_revision",
    "Safe expected review revision required",
  );
  // Validate preserved observations against every available exact historical citation edition before appending.
  inspectVerificationReviews(c, knowledge, links, s);
  const selected = selectCurrentEvidenceLinks(c, knowledge, links, q.linkRef);
  const previous = s.records
    .filter((r) => r.ref.id === selected.claim.id)
    .at(-1);
  invariant(
    (previous?.ref.revision ?? 0) === q.expectedRevision,
    "revision_conflict",
    "Review changed",
  );
  const record: VerificationReviewRecord = {
    ref: {
      tenantId: s.tenantId,
      projectId: s.projectId,
      kind: "knowledge-verification-review",
      id: selected.claim.id,
      revision: q.expectedRevision + 1,
    },
    supersedes: previous?.ref ?? null,
    claim: selected.claim,
    linkRef: selected.ref,
    challengeLinkIds: selected.links
      .filter((l) => l.relation === "challenges")
      .map((l) => l.id),
    checks: q.checks,
    rationale: q.rationale,
    resolution: "unresolved",
    assessment: null,
    proceduralPosture: null,
    editorialApproval: null,
    visibility: "private",
    actorId: c.actor.id,
    createdAt: c.now,
    requestId: c.requestId,
  };
  const next: VerificationReviewState = {
    ...s,
    records: [...s.records, record],
  };
  validateState(next);
  return next;
}
/** Captured basis freshness only; current editions do not establish current source/rights permission or truth. */
export function inspectVerificationReviews(
  context: Context,
  knowledge: KnowledgeState,
  links: EvidenceLinksState,
  state: VerificationReviewState,
): Readonly<{
  history: readonly VerificationReviewRecord[];
  latest: readonly Readonly<{
    record: VerificationReviewRecord;
    basisStatus: "current-editions" | "needs-review";
  }>[];
}> {
  const c = structuredClone(context),
    s = copyJson(state) as unknown as VerificationReviewState;
  authorize(c, s);
  validateState(s);
  const claims = inspectKnowledge(c, knowledge),
    citations = inspectEvidenceLinks(c, links);
  const latest = new Map<string, VerificationReviewRecord>();
  for (const r of s.records) {
    const link = citations.find((x) => same(x.ref, r.linkRef));
    if (link)
      invariant(
        same(link.claim, r.claim) &&
          link.purpose === s.purpose &&
          same(
            link.links
              .filter((x) => x.relation === "challenges")
              .map((x) => x.id),
            r.challengeLinkIds,
          ),
        "invalid_review",
        "Captured challenge history conflicts with exact cited edition",
      );
    latest.set(r.ref.id, r);
  }
  return {
    history: s.records,
    latest: [...latest.values()].map((record) => ({
      record,
      basisStatus:
        claims.some((x) => same(x.ref, record.claim)) &&
        citations.some((x) => same(x.ref, record.linkRef)) &&
        !claims.some(
          (x) =>
            x.ref.kind === "claim" &&
            x.ref.id === record.claim.id &&
            x.ref.revision > record.claim.revision,
        ) &&
        !citations.some(
          (x) =>
            x.ref.id === record.linkRef.id &&
            x.ref.revision > record.linkRef.revision,
        )
          ? "current-editions"
          : "needs-review",
    })),
  };
}
