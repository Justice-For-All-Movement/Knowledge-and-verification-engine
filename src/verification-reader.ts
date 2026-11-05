import { HumanConsentEvidenceKnowledgeReview } from "./consent-links.ts";
import { CurrentEvidenceKnowledgeReview } from "./current-evidence.ts";
import { IdentityKnowledgeRepository } from "./identity-repository.ts";
import { canonical, invariant } from "./contracts.ts";
import type { Context, Ref } from "./contracts.ts";

/** Selected unresolved human observations after sequential current source/use checks; never findings or a permit. */
export class CurrentVerificationReviewReader {
  readonly #review: CurrentEvidenceKnowledgeReview["review"];
  readonly #selected: IdentityKnowledgeRepository["prepareVerificationReview"];
  readonly #timeout: number;
  constructor(repository: IdentityKnowledgeRepository, review: HumanConsentEvidenceKnowledgeReview, timeoutMs = 10000) {
    invariant(repository instanceof IdentityKnowledgeRepository && review instanceof HumanConsentEvidenceKnowledgeReview,
      "invalid_policy", "Owning current Identity and same-human Consent-guarded source review required");
    invariant(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "invalid_policy", "Bounded verification read required");
    this.#selected = IdentityKnowledgeRepository.prototype.prepareVerificationReview.bind(repository);
    this.#review = CurrentEvidenceKnowledgeReview.prototype.review.bind(review);
    this.#timeout = timeoutMs;
  }
  async read(context: Context, selected: Ref, signal?: AbortSignal) {
    const started = performance.now(), owned = new AbortController(), abort = () => owned.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.#timeout);
    const gate = () => invariant(!owned.signal.aborted && performance.now() - started < this.#timeout,
      "verification_unavailable", "Current verification read unavailable");
    try {
      gate();
      const c = structuredClone(context), choice = structuredClone(selected),
        principal = { ...c, actor: { ...c.actor, roles: [] } };
      // The first owning result stays internal until all current source/use and final basis checks succeed.
      const initial = await this.#selected(principal, choice, owned.signal);
      gate();
      const reviewed = await this.#review(principal, initial.record.linkRef, owned.signal);
      gate();
      const expected = canonical({ knowledgeRevision: reviewed.knowledgeRevision,
        linksRevision: reviewed.linksRevision, revision: reviewed.revision });
      const result = await this.#selected(principal, choice, owned.signal, basis => {
        gate();
        invariant(canonical(basis) === expected, "verification_unavailable", "Owning source basis differs");
        gate();
      });
      gate();
      invariant(canonical(result.record) === canonical(initial.record) && result.reviewRevision === initial.reviewRevision,
        "verification_unavailable", "Verification containing edition changed");
      invariant(Buffer.byteLength(canonical(result)) <= 512 * 1024,
        "verification_unavailable", "Verification response exceeds budget");
      const output = structuredClone(result);
      gate();
      return output;
    } catch {
      invariant(false, "verification_unavailable", "Current verification read unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      owned.abort();
    }
  }
}
