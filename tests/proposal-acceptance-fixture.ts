import * as e from "@accountability/evidence";
import { createKnowledgeState, reviseKnowledge } from "../src/index.ts";
import { createEvidenceLinksState, reviseEvidenceLinks } from "../src/evidence-links.ts";
import { digest } from "../src/contracts.ts";
import type { Context } from "../src/contracts.ts";
export const c: Context = { tenantId: "fiction", projectId: "acceptance", actor: { id: "human", kind: "human", roles: ["researcher"] }, purpose: "review", requestId: "fixture", now: "2026-01-01T00:00:00Z" };
export function fixture(withFamily = false) {
  let initial = e.createEvidenceState(c);
  if (withFamily) {
    initial = e.addSourceFamily(initial, c, { id: "root", label: "Fictional root", parentIds: [], reason: "Synthetic ancestry" });
    initial = e.addSourceFamily(initial, c, { id: "copy", label: "Fictional copy", parentIds: ["root"], reason: "Synthetic copy ancestry" });
  }
  let source = e.acquireEvidence(initial, c, {
    id: "source", bytes: Buffer.from("A😀B"), acquisitionId: "acq", storageVersionRef: "private",
    mediaType: "text/plain", sourceFamilyId: withFamily ? "copy" : null, capturedAt: c.now, originalLanguage: "und", allowedPurposes: [c.purpose], supersedes: null,
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