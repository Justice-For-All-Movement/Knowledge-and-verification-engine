import type test from "node:test";
import { writeFixture, c } from "./verification-write-fixture.ts";
import { scoped } from "@accountability/evidence-sql/database";
import type { EvidenceState } from "@accountability/evidence";
import { CurrentEvidenceUse, HumanConsentEvidenceLinksWriter, HumanConsentEvidenceKnowledgeReview } from "../src/consent-links.ts";
import { ClaimProposalReader } from "../src/claim-proposals.ts";
import { CurrentProposalAcceptanceWriter } from "../src/proposal-acceptance-writer.ts";
export { c };
export async function acceptanceFixture(t: test.TestContext) {
  const f = await writeFixture(t);
  const stored = await scoped(f.evidence, c, tx => tx.get<{domain:EvidenceState}>("evidence.aggregate", "project"));
  const rep = await f.service.representation(f.req, f.source.ref, stored!.value.domain.representations[0]!.id);
  const selector = { ...f.selector, kind: "text" as const, representationId: rep.id, representationDigest: rep.digest,
    page: null, start: 0, end: rep.text!.length, quote: rep.text! };
  const terms = { ...f.terms, actions: ["reproduce" as const] };
  await f.permissions.grantRights(c, { ...terms, id: "text-rights", holderId: "fictional-owner", attribution: null, noDerivatives: false }, "text-rights");
  await f.permissions.recordConsent(c, { ...terms, id: "text-consent", subjectId: "subject" }, "text-consent");
  const guard = new CurrentEvidenceUse(f.membership, f.permissions, { ...f.fixed, bindings: [{ resource: terms.resource,
    rights: ["text-rights"], consents: ["text-consent"], attribution: null }] }, () => f.time.now);
  const command = { ...f.linkCommand, expectedRevision: 1, links: [{ id: "passage", relation: "quotes" as const, selector }] };
  const link = await new HumanConsentEvidenceLinksWriter(f.facade, f.service, f.credential, guard).record(c, 1, command, "text-link");
  const review = new HumanConsentEvidenceKnowledgeReview(f.facade, f.service, f.credential, guard);
  const reader = new ClaimProposalReader(review);
  const candidate = { id: "candidate", assertion: "Untrusted fictional interpretation", linkId: "passage", start: 0, end: 7, quote: "Neutral" };
  const bundle = await reader.propose(c, link.record, [candidate]);
  const input = { proposalId: "candidate", claimId: "accepted", expectedKnowledgeRevision: bundle.basis.knowledgeRevision,
    expectedLinksRevision: bundle.basis.linksRevision };
  return { ...f, selector, command, review, guard, reader, bundle, input,
    writer: new CurrentProposalAcceptanceWriter(f.facade, review) };
}
