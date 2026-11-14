import { copyJson } from "@accountability/consent-rights";
import { HumanConsentEvidenceKnowledgeReview } from "./consent-links.ts";
import { CurrentEvidenceKnowledgeReview } from "./current-evidence.ts";
import { IdentityKnowledgeRepository } from "./identity-repository.ts";
import { captureClaimProposalBundle } from "./claim-proposal-review.ts";
import { captureProposalAcceptanceInput } from "./proposal-acceptance.ts";
import type { ProposalAcceptanceInput } from "./proposal-acceptance.ts";
import type { ProposalAcceptanceAdmission } from "./repository.ts";
import type { CurrentEvidenceReview } from "./current-evidence.ts";
import { canonical, invariant, nonempty } from "./contracts.ts";
import type { Context } from "./contracts.ts";

/** Current same-human source/use admission for private unassessed acceptance; sequential observations are not a distributed fence. */
export class CurrentProposalAcceptanceWriter {
  readonly #review: CurrentEvidenceKnowledgeReview["review"];
  readonly #write: IdentityKnowledgeRepository["acceptCapturedProposal"];
  readonly #timeout: number;
  constructor(repository: IdentityKnowledgeRepository, review: HumanConsentEvidenceKnowledgeReview, timeoutMs = 10000) {
    invariant(repository instanceof IdentityKnowledgeRepository && review instanceof HumanConsentEvidenceKnowledgeReview,
      "invalid_policy", "Owning Identity and mandatory same-human Consent/Evidence review required");
    invariant(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "invalid_policy", "Bounded acceptance admission required");
    this.#review = CurrentEvidenceKnowledgeReview.prototype.review.bind(review);
    this.#write = IdentityKnowledgeRepository.prototype.acceptCapturedProposal.bind(repository);
    this.#timeout = timeoutMs;
  }
  async accept(context: Context, bundle: unknown, input: ProposalAcceptanceInput, commandId: string,
    signal?: AbortSignal, admission?: () => void) {
    const started = performance.now(), owned = new AbortController(), abort = () => owned.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.#timeout);
    const gate = () => {
      const available = () => invariant(!owned.signal.aborted && performance.now() - started < this.#timeout,
        "proposal_acceptance_unavailable", "Current proposal admission unavailable");
      available();
      invariant(admission === undefined || typeof admission === "function", "invalid_policy", "Synchronous void admission required");
      const value: unknown = admission?.();
      if (value instanceof Promise) void value.catch(() => {});
      invariant(value === undefined, "invalid_policy", "Admission must return synchronously without a value");
      available();
    };
    try {
      gate();
      const c = copyJson(context), b = captureClaimProposalBundle(c, bundle), q = captureProposalAcceptanceInput(input),
        principal = { ...c, actor: { ...c.actor, roles: [] } };
      nonempty(commandId, "Command", 128);
      invariant(Buffer.byteLength(canonical({ bundle: b, input: q })) <= 272 * 1024,
        "invalid_acceptance", "Bounded acceptance command required");
      const proposal = b.proposals.find(p => p.id === q.proposalId);
      invariant(proposal, "missing_proposal", "Explicit proposal selection required");
      gate();
      let reviewed: CurrentEvidenceReview;
      try {
        reviewed = await this.#review(principal, b.basis.linkRef, owned.signal);
        gate();
      } catch {
        invariant(false, "proposal_acceptance_unavailable", "Current proposal admission unavailable");
      }
      const link = reviewed.revision.links.find(l => l.id === proposal.citation.linkId);
      invariant(canonical(reviewed.revision.claim) === canonical(b.basis.claimRef) && link &&
        link.fingerprint === proposal.citation.selectorFingerprint && link.relation === proposal.citation.relation &&
        canonical(link.selector) === canonical(proposal.citation.selector),
        "proposal_acceptance_unavailable", "Original selected citation differs from current source admission");
      const expected = canonical({ knowledgeRevision: reviewed.knowledgeRevision,
        linksRevision: reviewed.linksRevision, revision: reviewed.revision });
      const admit: ProposalAcceptanceAdmission = (basis, phase) => {
        gate();
        invariant(canonical(basis) === expected, "proposal_acceptance_unavailable", "Owning acceptance basis differs from source admission");
        // Only new effects require the original captured observation editions to be current.
        // Replay rechecks current authority/basis but returns the ORIGINAL historical ACK/fingerprint.
        if (phase === "write") invariant(
          b.basis.knowledgeRevision === reviewed.knowledgeRevision && b.basis.linksRevision === reviewed.linksRevision &&
          b.basis.evidenceRevision === reviewed.evidenceRevision,
          "proposal_acceptance_unavailable", "New acceptance requires the exact observed containing editions");
        gate();
      };
      gate();
      try {
        // Fresh current Identity and complete own-DB basis checks, before cache and new puts.
        // Begun SQL is awaited; an acknowledged commit stays acknowledged after cancellation.
        const result = await this.#write(principal, b, q, commandId, owned.signal, admit);
        return structuredClone(result);
      } catch {
        invariant(false, "proposal_acceptance_unknown", "Acceptance outcome unavailable; inspect or explicitly replay the identical command");
      }
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); owned.abort();
    }
  }
}
