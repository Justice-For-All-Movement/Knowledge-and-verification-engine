import test from "node:test";
import assert from "node:assert/strict";
import { createEvidenceState } from "@accountability/evidence";
import { createKnowledgeState, reviseKnowledge } from "../src/index.ts";
import {
  createEvidenceLinksState,
  reviseEvidenceLinks,
} from "../src/evidence-links.ts";
import {
  createVerificationReviewState,
  inspectVerificationReviews,
  recordVerificationReview,
} from "../src/verification-review.ts";
import type { Context } from "../src/contracts.ts";

test("a valid full history stays readable and cannot evict records to append; aggregate bytes reject independently of individual note limits", () => {
  const c: Context = {
    tenantId: "fiction",
    projectId: "review-capacity",
    purpose: "review",
    requestId: "fixture",
    now: "2026-01-01T00:00:00Z",
    actor: { id: "reviewer", kind: "human", roles: ["researcher"] },
  };
  const knowledge = reviseKnowledge(c, createKnowledgeState(c), {
    id: "claim",
    expectedRevision: 0,
    value: {
      type: "claim",
      text: "An unresolved fictional assertion.",
      subjectRefs: [],
      time: { earliest: null, latest: null },
      accountType: "research_inference",
      limitations: ["No evidence is asserted by this capacity fixture."],
      assessment: null,
      proceduralPosture: null,
      editorialApproval: null,
    },
  });
  const links = reviseEvidenceLinks(
    c,
    knowledge,
    createEvidenceState(c),
    createEvidenceLinksState(c),
    {
      claim: knowledge.records[0]!.ref,
      expectedRevision: 0,
      links: [],
    },
  );
  const check = { status: "unreviewed" as const, note: "Not reviewed." };
  const input = {
    linkRef: links.records[0]!.ref,
    expectedRevision: 0,
    rationale: "Empty links are not absence proof.",
    checks: {
      authenticity: check,
      sourceKnowledge: check,
      independentSupport: check,
      counterevidence: check,
    },
  };
  const first = recordVerificationReview(
    c,
    knowledge,
    links,
    createVerificationReviewState(c),
    input,
  );
  const seed = first.records[0]!;
  const full = {
    ...first,
    records: Array.from({ length: 512 }, (_, i) => ({
      ...structuredClone(seed),
      ref: { ...seed.ref, revision: i + 1 },
      supersedes: i === 0 ? null : { ...seed.ref, revision: i },
    })),
  };
  const captured = structuredClone(full);
  const review = inspectVerificationReviews(c, knowledge, links, full);
  assert.equal(review.history.length, 512);
  assert.equal(review.latest[0]!.record.ref.revision, 512);
  assert.equal(review.latest[0]!.record.resolution, "unresolved");
  assert.throws(
    () =>
      recordVerificationReview(c, knowledge, links, full, {
        ...input,
        expectedRevision: 512,
      }),
    { code: "invalid_review" },
  );
  assert.deepEqual(full, captured);
  const overBytes = {
    ...full,
    records: full.records.map((r) => ({ ...r, rationale: "x".repeat(4000) })),
  };
  assert.throws(
    () => inspectVerificationReviews(c, knowledge, links, overBytes),
    { code: "review_full" },
  );
  assert.equal(first.records.length, 1);
});
