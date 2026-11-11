import { copyJson } from "@accountability/consent-rights";
import { canonical, digest, invariant, nonempty, requireScope, validateRef } from "./contracts.ts";
import type { Context, Ref } from "./contracts.ts";
import type { KnowledgeState } from "./index.ts";
import { selectCurrentEvidenceLinks } from "./evidence-links.ts";
import type { EvidenceLinksState } from "./evidence-links.ts";
import type { acceptCapturedClaimProposal } from "./proposal-acceptance.ts";

export type ProposalAcceptanceRecord = ReturnType<typeof acceptCapturedClaimProposal>["acceptance"];
const fields = ["schemaVersion", "visibility", "tenantId", "projectId", "purpose", "proposalId", "bundleDigest",
  "parentClaim", "parentLinks", "parentKnowledgeRevision", "parentLinksRevision", "capturedEvidenceRevision",
  "parentRelation", "excerpt", "claim", "links", "actorId", "createdAt", "requestId"];
/** Validate retained owning records, without reconstructing a proposal bundle or authenticating its digest. */
export function inspectStoredProposalAcceptance(c: Context, knowledge: KnowledgeState, links: EvidenceLinksState,
  selected: Ref, input: unknown) {
  const a = copyJson(input) as ProposalAcceptanceRecord;
  invariant(a && typeof a === "object" && Object.keys(a).length === fields.length &&
    fields.every(k => Object.hasOwn(a, k)), "invalid_acceptance", "Exact immutable acceptance metadata required");
  requireScope(c, a);
  invariant(a.schemaVersion === 1 && a.visibility === "private" && a.purpose === c.purpose &&
    typeof a.bundleDigest === "string" && /^[a-f0-9]{64}$/.test(a.bundleDigest),
    "invalid_acceptance", "Private scoped acceptance profile required");
  for (const [value, label] of [[a.proposalId, "Proposal"], [a.actorId, "Actor"], [a.requestId, "Request"]] as const)
    nonempty(value, label, 128);
  for (const ref of [a.parentClaim, a.parentLinks, a.claim, a.links]) { validateRef(ref); requireScope(c, ref); }
  const equal = (x: unknown, y: unknown) => canonical(x) === canonical(y);
  invariant(selected.revision === 1 && selected.id === digest({ claim: a.claim }) &&
    a.claim.kind === "claim" && a.claim.revision === 1 && a.links.kind === "knowledge-evidence-links" &&
    a.links.id === a.claim.id && a.links.revision === 1 && a.parentClaim.kind === "claim" &&
    a.parentLinks.kind === "knowledge-evidence-links" && a.parentClaim.id === a.parentLinks.id,
    "invalid_acceptance", "Exact acceptance and claim identities required");
  for (const [n, size] of [[a.parentKnowledgeRevision, knowledge.records.length], [a.parentLinksRevision, links.records.length]] as const)
    invariant(Number.isSafeInteger(n) && n > 0 && n < size, "invalid_acceptance", "Retained containing editions required");
  invariant(a.capturedEvidenceRevision === null || (Number.isSafeInteger(a.capturedEvidenceRevision) && a.capturedEvidenceRevision > 0),
    "invalid_acceptance", "Recorded Evidence edition required");
  // Positions are observed in the ACTUAL retained arrays. No synthetic historical snapshot is exposed.
  const claim = knowledge.records[a.parentKnowledgeRevision]!, citation = links.records[a.parentLinksRevision]!;
  const parentClaim = knowledge.records.slice(0, a.parentKnowledgeRevision).findLast(r => r.ref.id === a.parentClaim.id);
  const parentLinks = links.records.slice(0, a.parentLinksRevision).findLast(r => r.ref.id === a.parentLinks.id);
  invariant(parentClaim && parentLinks && equal(parentClaim.ref, a.parentClaim) && equal(parentLinks.ref, a.parentLinks) &&
    equal(parentLinks.claim, a.parentClaim) && parentClaim.purpose === a.purpose && parentLinks.purpose === a.purpose &&
    equal(claim.ref, a.claim) && equal(citation.ref, a.links) && equal(citation.claim, a.claim) &&
    claim.supersedes === null && citation.supersedes === null && citation.links.length === 1,
    "invalid_acceptance", "Actual original parent and acceptance records differ");
  for (const record of [claim, citation]) invariant(record.actorKind === "human" && record.actorId === a.actorId &&
    record.createdAt === a.createdAt && record.requestId === a.requestId && record.purpose === a.purpose,
    "invalid_acceptance", "Recorded human acceptance attribution differs");
  const v = claim.value;
  invariant(v.type === "claim" && v.accountType === "research_inference" && v.subjectRefs.length === 0 &&
    v.time.earliest === null && v.time.latest === null && v.assessment === null && v.proceduralPosture === null &&
    v.editorialApproval === null && equal(v.limitations, [
      "Untrusted assertion proposal; an exact quotation is not verification or corroboration.",
      "Human accepted an unassessed proposal; the retained quotation is not support or verification."]),
    "invalid_acceptance", "Unassessed acceptance claim profile differs");
  const quote = citation.links[0]!, original = parentLinks.links.find(l => l.id === quote.id);
  invariant(original && original.relation === a.parentRelation && equal(quote, { ...original, relation: "quotes" }),
    "invalid_acceptance", "Original selector, fingerprint, family and quote relation required");
  const s = quote.selector, e = a.excerpt;
  invariant(e && Object.keys(e).length === 3 && ["start", "end", "quote"].every(k => Object.hasOwn(e, k)) &&
    s.kind === "text" && Number.isSafeInteger(e.start) && Number.isSafeInteger(e.end) &&
    e.start >= s.start && e.end <= s.end && e.start < e.end &&
    s.quote.slice(e.start - s.start, e.end - s.start) === e.quote &&
    typeof e.quote === "string" && e.quote.length <= 16000 && Buffer.from(e.quote).toString("utf8") === e.quote,
    "invalid_acceptance", "Exact unchanged UTF16 excerpt required");
  const current = selectCurrentEvidenceLinks(c, knowledge, links, a.links);
  invariant(equal(current, citation), "invalid_acceptance", "Current accepted citation differs");
  return structuredClone({ record: a, claim, citation: current });
}
