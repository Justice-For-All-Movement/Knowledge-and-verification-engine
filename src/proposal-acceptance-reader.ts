import { copyJson } from "@accountability/consent-rights";
import { HumanConsentEvidenceKnowledgeReview } from "./consent-links.ts";
import { CurrentEvidenceKnowledgeReview } from "./current-evidence.ts";
import { IdentityKnowledgeRepository } from "./identity-repository.ts";
import { canonical, invariant, validateRef } from "./contracts.ts";
import type { Context, Ref } from "./contracts.ts";

/** Private selected acceptance read after current sequential source/use checks; no historical profile certification. */
export class CurrentProposalAcceptanceReader {
  readonly #selected: IdentityKnowledgeRepository["prepareProposalAcceptance"];
  readonly #review: CurrentEvidenceKnowledgeReview["review"];
  readonly #timeout: number;
  constructor(repository: IdentityKnowledgeRepository, review: HumanConsentEvidenceKnowledgeReview, timeoutMs = 10000) {
    invariant(repository instanceof IdentityKnowledgeRepository && review instanceof HumanConsentEvidenceKnowledgeReview,
      "invalid_policy", "Owning Identity and same-human Consent/Evidence review required");
    invariant(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "invalid_policy", "Bounded acceptance read required");
    this.#selected = IdentityKnowledgeRepository.prototype.prepareProposalAcceptance.bind(repository);
    this.#review = CurrentEvidenceKnowledgeReview.prototype.review.bind(review);
    this.#timeout = timeoutMs;
  }
  async read(context: Context, selected: Ref, signal?: AbortSignal) {
    const started = performance.now(), owned = new AbortController(), abort = () => owned.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.#timeout);
    const gate = () => invariant(!owned.signal.aborted && performance.now() - started < this.#timeout,
      "proposal_acceptance_unavailable", "Current acceptance read unavailable");
    try {
      gate();
      const c = copyJson(context), choice = validateRef(copyJson(selected)),
        principal = { ...c, actor: { ...c.actor, roles: [] } };
      // Intermediate owning metadata remains internal until current source/use and final owning basis succeed.
      const initial = await this.#selected(principal, choice, owned.signal, () => gate());
      gate();
      const reviewed = await this.#review(principal, initial.record.links, owned.signal);
      gate();
      const expected = canonical({ knowledgeRevision: reviewed.knowledgeRevision,
        linksRevision: reviewed.linksRevision, revision: reviewed.revision });
      const result = await this.#selected(principal, choice, owned.signal, basis => {
        gate();
        invariant(canonical(basis) === expected, "proposal_acceptance_unavailable", "Actual selected source basis differs");
        gate();
      });
      gate();
      invariant(canonical(result.record) === canonical(initial.record) && canonical(result.claim) === canonical(initial.claim),
        "proposal_acceptance_unavailable", "Selected acceptance changed");
      invariant(Buffer.byteLength(canonical(result)) <= 512 * 1024,
        "proposal_acceptance_unavailable", "Acceptance response exceeds budget");
      const output = structuredClone(result);
      gate();
      return output;
    } catch {
      invariant(false, "proposal_acceptance_unavailable", "Current acceptance read unavailable");
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); owned.abort();
    }
  }
}
