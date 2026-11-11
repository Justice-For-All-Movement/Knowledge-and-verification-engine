import { copyJson } from "@accountability/consent-rights";
import { inspectClaimProposals } from "./claim-proposal-review.ts";
import { canonical, invariant, nonempty } from "./contracts.ts";
import type { Context } from "./contracts.ts";
import { inspectKnowledge, reviseKnowledge } from "./index.ts";
import type { KnowledgeState } from "./index.ts";
import { assertEvidenceLinksState, selectCurrentEvidenceLinks } from "./evidence-links.ts";
import type { EvidenceLinksState } from "./evidence-links.ts";

export type ProposalAcceptanceInput = Readonly<{
  proposalId: string;
  claimId: string;
  expectedKnowledgeRevision: number;
  expectedLinksRevision: number;
}>;
/** Pure captured-state transition only. Host context and bundle digest are not authentication or current source permission. */
export function acceptCapturedClaimProposal(
  context: Context,
  knowledge: KnowledgeState,
  links: EvidenceLinksState,
  bundle: unknown,
  input: ProposalAcceptanceInput,
) {
  const c = copyJson(context), k = copyJson(knowledge), l = copyJson(links),
    b = inspectClaimProposals(c, bundle), q = copyJson(input);
  invariant(q && typeof q === "object" && Object.keys(q).length === 4 &&
    ["proposalId", "claimId", "expectedKnowledgeRevision", "expectedLinksRevision"].every(key => Object.hasOwn(q, key)),
    "invalid_acceptance", "Exact acceptance fields required");
  nonempty(q.proposalId, "Proposal ID", 128);
  nonempty(q.claimId, "New claim ID", 128);
  inspectKnowledge(c, k);
  assertEvidenceLinksState(l);
  for (const n of [q.expectedKnowledgeRevision, q.expectedLinksRevision])
    invariant(Number.isSafeInteger(n) && n > 0, "invalid_revision", "Positive containing revision required");
  invariant(q.expectedKnowledgeRevision === k.records.length &&
    q.expectedLinksRevision === l.records.length &&
    b.basis.knowledgeRevision === k.records.length && b.basis.linksRevision === l.records.length,
    "stale_proposal", "Complete captured Knowledge and citation editions must match");
  const parent = selectCurrentEvidenceLinks(c, k, l, b.basis.linkRef);
  invariant(canonical(parent.claim) === canonical(b.basis.claimRef),
    "stale_proposal", "Exact parent claim edition required");
  const proposal = b.proposals.find(p => p.id === q.proposalId);
  invariant(proposal, "missing_proposal", "Explicit proposal selection required");
  const citation = parent.links.find(link => link.id === proposal.citation.linkId);
  invariant(citation && citation.fingerprint === proposal.citation.selectorFingerprint &&
    citation.relation === proposal.citation.relation &&
    canonical(citation.selector) === canonical(proposal.citation.selector),
    "invalid_acceptance", "Proposal citation must equal the actual captured parent citation");
  invariant(!k.records.some(r => r.ref.id === q.claimId) && !l.records.some(r => r.ref.id === q.claimId),
    "claim_exists", "A fresh claim identity is required; acceptance cannot overwrite history");
  // The assertion may interpret or contradict its source. Accepting it must never copy the
  // parent claim's supports/challenges relation as corroboration for this different assertion.
  const nextKnowledge = reviseKnowledge(c, k, {
    id: q.claimId, expectedRevision: 0,
    value: {
      type: "claim", text: proposal.assertion, subjectRefs: [],
      time: { earliest: null, latest: null }, accountType: "research_inference",
      limitations: [...proposal.limitations, "Human accepted an unassessed proposal; the retained quotation is not support or verification."],
      assessment: null, proceduralPosture: null, editorialApproval: null,
    },
  });
  const claim = nextKnowledge.records.at(-1)!.ref;
  const nextLinks: EvidenceLinksState = {
    ...l, records: [...l.records, {
      ref: { ...claim, kind: "knowledge-evidence-links" }, supersedes: null,
      claim, visibility: "private", actorId: c.actor.id, actorKind: c.actor.kind,
      createdAt: c.now, requestId: c.requestId, purpose: c.purpose,
      // Preserve the complete original selector/fingerprint/family; the exact subspan remains
      // a distinct excerpt in the acceptance record, never a newly fingerprinted selector.
      links: [{ ...citation, relation: "quotes" }],
    }],
  };
  assertEvidenceLinksState(nextLinks);
  const acceptance = {
    schemaVersion: 1 as const, visibility: "private" as const,
    tenantId: c.tenantId, projectId: c.projectId, purpose: c.purpose,
    proposalId: q.proposalId, bundleDigest: b.digest,
    parentClaim: parent.claim, parentLinks: parent.ref,
    parentKnowledgeRevision: k.records.length, parentLinksRevision: l.records.length,
    capturedEvidenceRevision: b.basis.evidenceRevision,
    parentRelation: citation.relation,
    excerpt: proposal.citation.excerpt,
    claim, links: nextLinks.records.at(-1)!.ref,
    actorId: c.actor.id, createdAt: c.now, requestId: c.requestId,
  };
  return structuredClone({ knowledge: nextKnowledge, links: nextLinks, acceptance });
}
