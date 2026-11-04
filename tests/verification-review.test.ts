import test from "node:test";
import assert from "node:assert/strict";
import * as e from "@accountability/evidence";
import * as k from "../src/index.ts";
import * as l from "../src/evidence-links.ts";
import * as v from "../src/verification-review.ts";
import type { Context } from "../src/contracts.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "verification",
  actor: { id: "human-reviewer", kind: "human", roles: ["researcher"] },
  purpose: "review",
  requestId: "fixture",
  now: "2026-01-01T00:00:00Z",
};
const claim: k.KnowledgeValue = {
  type: "claim",
  text: "An observer described a fictional lamp.",
  subjectRefs: [],
  time: { earliest: null, latest: null },
  accountType: "attributed_testimony",
  limitations: ["Unverified fictional assertion"],
  assessment: null,
  proceduralPosture: null,
  editorialApproval: null,
};
function setup() {
  let evidence = e.acquireEvidence(e.createEvidenceState(c), c, {
    id: "source",
    bytes: Buffer.from("Fictional lamp statement"),
    acquisitionId: "capture",
    storageVersionRef: "private-object",
    mediaType: "text/plain",
    sourceFamilyId: null,
    capturedAt: c.now,
    originalLanguage: "und",
    allowedPurposes: [c.purpose],
    supersedes: null,
  });
  const source = evidence.versions[0]!;
  evidence = e.beginScan(evidence, c, {
    id: "scan-start",
    evidence: source.ref,
    attemptId: "scan",
    engineVersion: "synthetic-only",
  });
  evidence = e.completeScan(evidence, c, {
    id: "scan-done",
    evidence: source.ref,
    attemptId: "scan",
    sha256: source.sha256,
    status: "clean",
    reason: "Synthetic fixture; no scanner qualification",
  });
  const knowledge = k.reviseKnowledge(c, k.createKnowledgeState(c), {
    id: "claim",
    expectedRevision: 0,
    value: claim,
  });
  const selector: e.EvidenceSelector = {
    kind: "whole",
    evidence: source.ref,
    sha256: source.sha256,
  };
  const links = l.reviseEvidenceLinks(
    c,
    knowledge,
    evidence,
    l.createEvidenceLinksState(c),
    {
      claim: knowledge.records[0]!.ref,
      expectedRevision: 0,
      links: [
        { id: "support", relation: "supports", selector },
        { id: "contrary", relation: "challenges", selector },
      ],
    },
  );
  const check: v.ReviewCheck = {
    status: "reviewed",
    note: "Reviewer reports a check; this is not independent proof.",
  };
  const input: v.VerificationReviewInput = {
    linkRef: links.records[0]!.ref,
    expectedRevision: 0,
    checks: {
      authenticity: check,
      sourceKnowledge: check,
      independentSupport: {
        status: "unresolved",
        note: "Copy ancestry cannot establish independent support.",
      },
      counterevidence: {
        status: "concern",
        note: "The same source also challenges the assertion.",
      },
    },
    rationale: "Contradiction remains unresolved.",
  };
  return {
    evidence,
    knowledge,
    links,
    state: v.createVerificationReviewState(c),
    input,
  };
}
const append = (x: ReturnType<typeof setup>) =>
  v.recordVerificationReview(c, x.knowledge, x.links, x.state, x.input);
test("actual owning claim and contrary citation editions remain separate unresolved review observations", () => {
  const x = setup(),
    original = structuredClone(x),
    s = append(x),
    r = v.inspectVerificationReviews(c, x.knowledge, x.links, s);
  assert.deepEqual(x, original);
  assert.deepEqual(r.latest[0]!.record.challengeLinkIds, ["contrary"]);
  assert.equal(r.latest[0]!.basisStatus, "current-editions");
  assert.equal(r.latest[0]!.record.resolution, "unresolved");
  assert.equal(r.latest[0]!.record.assessment, null);
  assert.equal(r.latest[0]!.record.proceduralPosture, null);
  assert.equal(r.latest[0]!.record.editorialApproval, null);
  assert.equal((x.knowledge.records[0]!.value as any).assessment, null);
  assert.equal(r.history[0]!.checks.independentSupport.status, "unresolved");
  assert.equal(r.history[0]!.checks.counterevidence.status, "concern");
});
test("corrections preserve challenge history, use exact CAS and need explicit current link editions", () => {
  const x = setup(),
    s = append(x);
  const links = l.reviseEvidenceLinks(c, x.knowledge, x.evidence, x.links, {
    claim: x.knowledge.records[0]!.ref,
    expectedRevision: 1,
    links: [],
  });
  assert.equal(
    v.inspectVerificationReviews(c, x.knowledge, links, s).latest[0]!
      .basisStatus,
    "needs-review",
  );
  assert.throws(
    () =>
      v.recordVerificationReview(c, x.knowledge, links, s, {
        ...x.input,
        expectedRevision: 1,
      }),
    { code: "stale_links" },
  );
  const next = v.recordVerificationReview(c, x.knowledge, links, s, {
    ...x.input,
    expectedRevision: 1,
    linkRef: links.records[1]!.ref,
  });
  assert.deepEqual(next.records[0]!.challengeLinkIds, ["contrary"]);
  assert.deepEqual(next.records[1]!.challengeLinkIds, []);
  assert.deepEqual(next.records[1]!.supersedes, next.records[0]!.ref);
  assert.equal(next.records[1]!.resolution, "unresolved");
  assert.throws(
    () =>
      v.recordVerificationReview(c, x.knowledge, links, next, {
        ...x.input,
        linkRef: links.records[1]!.ref,
        expectedRevision: 1,
      }),
    { code: "revision_conflict" },
  );
});
test("changed or missing claims need review; a current-looking old link never admits a new review of a stale claim", () => {
  const x = setup(),
    s = append(x),
    knowledge = k.reviseKnowledge(c, x.knowledge, {
      id: "claim",
      expectedRevision: 1,
      value: { ...claim, text: "Updated unverified assertion" },
    });
  assert.equal(
    v.inspectVerificationReviews(c, knowledge, x.links, s).latest[0]!
      .basisStatus,
    "needs-review",
  );
  assert.throws(
    () =>
      v.recordVerificationReview(c, knowledge, x.links, s, {
        ...x.input,
        expectedRevision: 1,
      }),
    { code: "stale_claim" },
  );
  assert.equal(
    v.inspectVerificationReviews(
      c,
      k.createKnowledgeState(c),
      l.createEvidenceLinksState(c),
      s,
    ).latest[0]!.basisStatus,
    "needs-review",
  );
});
test("host human role, scope and purpose admission does not accept service actors or forged finding fields", () => {
  const x = setup();
  for (const ctx of [
    { ...c, actor: { ...c.actor, kind: "agent" as const } },
    { ...c, actor: { ...c.actor, roles: [] } },
    { ...c, projectId: "foreign" },
    { ...c, purpose: "publish" },
  ])
    assert.throws(() =>
      v.recordVerificationReview(ctx, x.knowledge, x.links, x.state, x.input),
    );
  assert.throws(() =>
    append({ ...x, input: { ...x.input, resolution: "verified" } as any }),
  );
  const bad = structuredClone(x.input) as any;
  bad.checks.authenticity.status = "verified";
  assert.throws(() => append({ ...x, input: bad }));
  const allReviewed = structuredClone(x.input);
  for (const check of Object.values(allReviewed.checks))
    Object.assign(check, { status: "reviewed" });
  assert.equal(
    append({ ...x, input: allReviewed }).records[0]!.resolution,
    "unresolved",
  );
});
test("strict detached JSON rejects hidden getters/extra authority and exact stored challenge tampering", () => {
  const x = setup(),
    s = append(x);
  const withGetter = { ...x.input };
  Object.defineProperty(withGetter, "rationale", {
    enumerable: true,
    get: () => "hidden",
  });
  assert.throws(() => append({ ...x, input: withGetter }));
  const tampered = structuredClone(s);
  (tampered.records[0] as any).challengeLinkIds = [];
  assert.throws(
    () => v.inspectVerificationReviews(c, x.knowledge, x.links, tampered),
    { code: "invalid_review" },
  );
  assert.throws(
    () =>
      v.recordVerificationReview(c, x.knowledge, x.links, tampered, {
        ...x.input,
        expectedRevision: 1,
      }),
    { code: "invalid_review" },
  );
  const result = v.inspectVerificationReviews(c, x.knowledge, x.links, s);
  (x.input.checks.authenticity as any).note = "caller changed";
  (s.records[0]!.checks.sourceKnowledge as any).note = "state changed";
  assert.notEqual(
    result.history[0]!.checks.authenticity.note,
    "caller changed",
  );
  assert.notEqual(
    result.history[0]!.checks.sourceKnowledge.note,
    "state changed",
  );
});
test("review history rejects forks, missing axes, excessive notes and bounded-history overflow without eviction", () => {
  const x = setup(),
    s = append(x),
    fork = structuredClone(s);
  (fork as any).records.push(structuredClone(fork.records[0]));
  assert.throws(
    () => v.inspectVerificationReviews(c, x.knowledge, x.links, fork),
    { code: "invalid_revision" },
  );
  const noAxis = structuredClone(x.input) as any;
  delete noAxis.checks.counterevidence;
  assert.throws(() => append({ ...x, input: noAxis }));
  const excessive = structuredClone(x.input) as any;
  excessive.checks.authenticity.note = "x".repeat(4001);
  assert.throws(() => append({ ...x, input: excessive }));
  const tooMany = { ...s, records: Array(513).fill(s.records[0]) };
  assert.throws(
    () => v.inspectVerificationReviews(c, x.knowledge, x.links, tooMany),
    { code: "invalid_review" },
  );
  assert.equal(s.records.length, 1);
});
