import test from "node:test";
import assert from "node:assert/strict";
import * as e from "@accountability/evidence";
import { createKnowledgeState, reviseKnowledge } from "../src/index.ts";
import { createEvidenceLinksState, reviseEvidenceLinks } from "../src/evidence-links.ts";
import { digest } from "../src/contracts.ts";
import { acceptCapturedClaimProposal } from "../src/proposal-acceptance.ts";
import type { Context } from "../src/contracts.ts";
const c: Context = { tenantId: "fiction", projectId: "acceptance", actor: { id: "human", kind: "human", roles: ["researcher"] }, purpose: "review", requestId: "fixture", now: "2026-01-01T00:00:00Z" };
function redigest<T extends { digest: string }>(bundle: T) {
  const { digest: ignored, ...payload } = bundle; return { ...payload, digest: digest(payload) };
}
function fixture() {
  let source = e.acquireEvidence(e.createEvidenceState(c), c, {
    id: "source", bytes: Buffer.from("A😀B"), acquisitionId: "acq", storageVersionRef: "private",
    mediaType: "text/plain", sourceFamilyId: null, capturedAt: c.now, originalLanguage: "und", allowedPurposes: [c.purpose], supersedes: null,
  });
  const v = source.versions[0]!;
  source = e.beginScan(source, c, { id: "start", evidence: v.ref, attemptId: "scan", engineVersion: "synthetic-only" });
  source = e.completeScan(source, c, { id: "end", evidence: v.ref, attemptId: "scan", sha256: v.sha256, status: "clean", reason: "Synthetic test, not deployed scanner proof" });
  source = e.addRepresentation(source, c, { id: "rep", evidence: v.ref, sourceSha256: v.sha256, text: "A😀B", pages: null, durationMs: null, toolVersion: "synthetic" });
  const r = source.representations[0]!;
  const selector: e.EvidenceSelector = { kind: "text", evidence: v.ref, sha256: v.sha256, representationId: r.id, representationDigest: r.digest, page: null, start: 0, end: 4, quote: "A😀B" };
  const knowledge = reviseKnowledge(c, createKnowledgeState(c), { id: "parent", expectedRevision: 0, value: { type: "claim", text: "Fictional parent assertion", subjectRefs: [], time: { earliest: null, latest: null }, accountType: "research_inference", limitations: [], assessment: null, proceduralPosture: null, editorialApproval: null } });
  const links = reviseEvidenceLinks(c, knowledge, source, createEvidenceLinksState(c), { claim: knowledge.records[0]!.ref, expectedRevision: 0, links: [{ id: "citation", relation: "challenges", selector }] });
  const link = links.records[0]!.links[0]!;
  const payload = { schemaVersion: 1, tenantId: c.tenantId, projectId: c.projectId, visibility: "private", purpose: c.purpose,
    basis: { knowledgeRevision: 1, linksRevision: 1, evidenceRevision: 1 /* synthetic containing metadata, not an owning SQL observation */, linkRef: links.records[0]!.ref, claimRef: knowledge.records[0]!.ref },
    proposals: [{ id: "candidate", assertion: "Untrusted interpretation", assessment: null, proceduralPosture: null, editorialApproval: null,
      citation: { linkId: link.id, relation: link.relation, selector: link.selector, selectorFingerprint: link.fingerprint, excerpt: { start: 1, end: 3, quote: "😀" } },
      limitations: ["Untrusted assertion proposal; an exact quotation is not verification or corroboration."] }],
  };
  return { knowledge, links, source, bundle: structuredClone({ ...payload, digest: digest(payload) }), command: { proposalId: "candidate", claimId: "accepted", expectedKnowledgeRevision: 1, expectedLinksRevision: 1 } };
}
test("captured acceptance adds a private unassessed claim and quote-only original citation with exact separate Unicode excerpt", () => {
  const f = fixture(), before = structuredClone(f);
  const result = acceptCapturedClaimProposal(c, f.knowledge, f.links, f.bundle, f.command);
  assert.deepEqual(f, before);
  assert.equal(result.knowledge.records.length, 2); assert.equal(result.links.records.length, 2);
  const claim = result.knowledge.records[1]!.value;
  assert.equal(claim.type, "claim");
  if (claim.type !== "claim") throw Error("claim");
  assert.equal(claim.assessment, null); assert.equal(claim.proceduralPosture, null); assert.equal(claim.editorialApproval, null);
  assert.deepEqual(claim.subjectRefs, []); assert.deepEqual(claim.time, { earliest: null, latest: null });
  const original = f.links.records[0]!.links[0]!, copied = result.links.records[1]!.links[0]!;
  assert.equal(copied.relation, "quotes"); assert.equal(result.acceptance.parentRelation, "challenges");
  assert.deepEqual(copied.selector, original.selector); assert.equal(copied.fingerprint, original.fingerprint); assert.deepEqual(copied.family, original.family);
  assert.deepEqual(result.acceptance.excerpt, { start: 1, end: 3, quote: "😀" });
  assert.equal(result.acceptance.bundleDigest, f.bundle.digest);
  (result.acceptance.excerpt as any).quote = "changed";
  assert.equal(f.bundle.proposals[0]!.citation.excerpt.quote, "😀");
});
test("recomputed invented parent selector, fingerprint or relation cannot be accepted", () => {
  for (const edit of [(b: any) => b.proposals[0].citation.selectorFingerprint = "f".repeat(64), (b: any) => b.proposals[0].citation.relation = "supports", (b: any) => b.proposals[0].citation.selector.representationId = "invented"]) {
    const f = fixture(); edit(f.bundle);
    assert.throws(() => acceptCapturedClaimProposal(c, f.knowledge, f.links, redigest(f.bundle), f.command));
  }
});
test("invented excerpts and half-surrogate spans reject even with recomputed bundle digest", () => {
  for (const edit of [(b: any) => b.proposals[0].citation.excerpt.quote = "invented", (b: any) => b.proposals[0].citation.excerpt.start = 2]) {
    const f = fixture(); edit(f.bundle);
    assert.throws(() => acceptCapturedClaimProposal(c, f.knowledge, f.links, redigest(f.bundle), f.command));
  }
});
test("stale containing basis, unknown proposal and existing claim IDs cannot overwrite or fork history", () => {
  const f = fixture();
  for (const command of [{ ...f.command, expectedLinksRevision: 2 }, { ...f.command, expectedKnowledgeRevision: 2 }, { ...f.command, proposalId: "unknown" }, { ...f.command, claimId: "parent" }])
    assert.throws(() => acceptCapturedClaimProposal(c, f.knowledge, f.links, f.bundle, command));
  const first = acceptCapturedClaimProposal(c, f.knowledge, f.links, f.bundle, f.command);
  assert.throws(() => acceptCapturedClaimProposal(c, first.knowledge, first.links, f.bundle, f.command));
});
test("foreign scope, wrong role and injected authority fields fail before returning any partial state", () => {
  const f = fixture();
  for (const context of [{ ...c, projectId: "foreign" }, { ...c, purpose: "other" }, { ...c, actor: { ...c.actor, kind: "agent" as const } }, { ...c, actor: { ...c.actor, roles: [] } }])
    assert.throws(() => acceptCapturedClaimProposal(context, f.knowledge, f.links, f.bundle, f.command));
  assert.throws(() => acceptCapturedClaimProposal(c, f.knowledge, f.links, f.bundle, { ...f.command, approved: true } as any));
  const before = structuredClone(f); f.bundle.proposals[0]!.assessment = "verified" as any;
  assert.throws(() => acceptCapturedClaimProposal(c, f.knowledge, f.links, redigest(f.bundle), f.command));
  assert.deepEqual(f.knowledge, before.knowledge); assert.deepEqual(f.links, before.links);
});
test("a recomputed captured assertion is not authenticated by this pure profile", () => {
  const f = fixture(); f.bundle.proposals[0]!.assertion = "Different human-selected unassessed interpretation";
  const result = acceptCapturedClaimProposal(c, f.knowledge, f.links, redigest(f.bundle), f.command);
  assert.equal((result.knowledge.records[1]!.value as any).text, f.bundle.proposals[0]!.assertion);
  assert.equal((result.knowledge.records[1]!.value as any).assessment, null);
});
