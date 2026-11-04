import test from "node:test";
import assert from "node:assert/strict";
import { inspectClaimProposals } from "../src/claim-proposal-review.ts";
import { digest } from "../src/contracts.ts";
const c = {
  tenantId: "fiction",
  projectId: "proposal-review",
  actor: { id: "human", kind: "human" as const, roles: ["researcher"] },
  purpose: "review",
  requestId: "synthetic",
  now: "2026-01-01T00:00:00Z",
};
const ref = (kind: string, id: string) => ({
  tenantId: c.tenantId,
  projectId: c.projectId,
  kind,
  id,
  revision: 1,
});
function signed<T extends object>(payload: T) {
  const { digest: old, ...body } = payload as T & { digest?: string };
  return { ...body, digest: digest(body) };
}
function fixture() {
  return signed({
    schemaVersion: 1,
    tenantId: c.tenantId,
    projectId: c.projectId,
    visibility: "private",
    purpose: c.purpose,
    basis: {
      knowledgeRevision: 1,
      linksRevision: 1,
      evidenceRevision: 4,
      linkRef: ref("knowledge-evidence-links", "claim"),
      claimRef: ref("claim", "claim"),
    },
    proposals: [
      {
        id: "candidate",
        assertion: "Synthetic unverified assertion",
        assessment: null,
        proceduralPosture: null,
        editorialApproval: null,
        citation: {
          linkId: "citation",
          relation: "challenges",
          selector: {
            kind: "text",
            evidence: ref("evidence", "source"),
            sha256: "a".repeat(64),
            representationId: "representation",
            representationDigest: "b".repeat(64),
            page: 2,
            start: 17,
            end: 21,
            quote: "A😀B",
          },
          excerpt: { start: 18, end: 20, quote: "😀" },
          selectorFingerprint: "f".repeat(64),
        },
        limitations: [
          "Untrusted assertion proposal; an exact quotation is not verification or corroboration.",
        ],
      },
    ],
  });
}
test("synthetic bundle inspector preserves Unicode absolute excerpt and original selector without authenticating metadata", () => {
  const b = fixture(),
    review = inspectClaimProposals(c, b);
  assert.deepEqual(review, b);
  assert.equal(review.proposals[0]!.citation.selector.quote, "A😀B");
  assert.equal(review.proposals[0]!.citation.excerpt.quote, "😀");
  b.proposals[0]!.assertion = "mutated";
  assert.notEqual(review.proposals[0]!.assertion, b.proposals[0]!.assertion);
  // Recomputing a digest can change an untrusted assertion: inspection is explicitly not authentication.
  b.proposals[0]!.assertion = "Another unverified proposal";
  assert.equal(
    inspectClaimProposals(c, signed(b)).proposals[0]!.assertion,
    b.proposals[0]!.assertion,
  );
});
test("digest tampering and recomputed injected assessment, authority and notice fields reject", () => {
  const b = fixture();
  b.proposals[0]!.assertion = "changed";
  assert.throws(() => inspectClaimProposals(c, b));
  for (const edit of [
    (x: any) => (x.allowed = true),
    (x: any) => (x.proposals[0].assessment = "verified"),
    (x: any) => (x.proposals[0].editorialApproval = true),
    (x: any) => (x.proposals[0].limitations = []),
    (x: any) => (x.proposals[0].citation.credential = "hidden"),
  ]) {
    const x = fixture();
    edit(x);
    assert.throws(() => inspectClaimProposals(c, signed(x)));
  }
});
test("recomputed wrong edition, scope, relation and absolute half-surrogate or invented excerpts reject", () => {
  for (const edit of [
    (x: any) => (x.basis.claimRef.id = "different"),
    (x: any) => (x.basis.knowledgeRevision = 0),
    (x: any) => (x.basis.linkRef.revision = 2),
    (x: any) => (x.basis.evidenceRevision = null),
    (x: any) =>
      (x.proposals[0].citation.selector.evidence.projectId = "foreign"),
    (x: any) => (x.proposals[0].citation.relation = "verified"),
    (x: any) => (x.proposals[0].citation.excerpt.start = 19),
    (x: any) => (x.proposals[0].citation.excerpt.end = 22),
    (x: any) => (x.proposals[0].citation.excerpt.quote = "made up"),
    (x: any) => (x.proposals[0].citation.selector.end = 22),
    (x: any) => {
      x.proposals[0].citation.selector.quote = "A\uD800B";
      x.proposals[0].citation.selector.end = 20;
    },
  ]) {
    const x = fixture();
    edit(x);
    assert.throws(() => inspectClaimProposals(c, signed(x)));
  }
});
test("duplicate, empty, oversized and non-JSON bundle inputs cannot enter review", () => {
  const b = fixture();
  assert.throws(() =>
    inspectClaimProposals(c, signed({ ...b, proposals: [] })),
  );
  assert.throws(() =>
    inspectClaimProposals(
      c,
      signed({ ...b, proposals: [...b.proposals, ...b.proposals] }),
    ),
  );
  const huge = fixture();
  huge.proposals[0]!.assertion = "x".repeat(300000);
  assert.throws(() => inspectClaimProposals(c, signed(huge)));
  const accessor = fixture();
  Object.defineProperty(accessor.proposals[0]!, "assertion", {
    get() {
      throw Error("sensitive accessor");
    },
    enumerable: true,
  });
  assert.throws(() => inspectClaimProposals(c, accessor));
  const sparse = fixture();
  delete sparse.proposals[0];
  assert.throws(() => inspectClaimProposals(c, sparse));
});
test("host role kind scope purpose and request time admission remain separate from source authorization", () => {
  for (const context of [
    { ...c, purpose: "other" },
    { ...c, projectId: "other" },
    { ...c, actor: { ...c.actor, roles: [] } },
    { ...c, actor: { ...c.actor, kind: "service" } },
    { ...c, now: "not-a-date" },
  ])
    assert.throws(() => inspectClaimProposals(context as never, fixture()));
});
