import { HumanConsentEvidenceKnowledgeReview } from "./consent-links.ts";
import { CurrentEvidenceKnowledgeReview } from "./current-evidence.ts";
import { IdentityKnowledgeRepository } from "./identity-repository.ts";
import { captureVerificationReviewInput } from "./verification-review.ts";
import type { VerificationReviewInput } from "./verification-review.ts";
import { canonical, invariant, nonempty } from "./contracts.ts";
import type { VerificationAdmission } from "./repository.ts";
import type { CurrentEvidenceReview } from "./current-evidence.ts";
import type { Context } from "./contracts.ts";

/** Sequential current source/use admission for unresolved human notes, never proof of their truth or work. */
export class CurrentVerificationReviewWriter {
  readonly #review: CurrentEvidenceKnowledgeReview["review"];
  readonly #write: IdentityKnowledgeRepository["recordVerificationReview"];
  readonly #timeout: number;
  constructor(
    repository: IdentityKnowledgeRepository,
    review: HumanConsentEvidenceKnowledgeReview,
    timeoutMs = 10000,
  ) {
    invariant(
      repository instanceof IdentityKnowledgeRepository &&
        review instanceof HumanConsentEvidenceKnowledgeReview,
      "invalid_policy",
      "Owning current Identity and same-human Consent-guarded source review required",
    );
    invariant(
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "invalid_policy",
      "Bounded verification admission required",
    );
    // Keep the constructed owning private fields and mandatory guards; ignore instance method replacement.
    this.#review = CurrentEvidenceKnowledgeReview.prototype.review.bind(review);
    this.#write =
      IdentityKnowledgeRepository.prototype.recordVerificationReview.bind(
        repository,
      );
    this.#timeout = timeoutMs;
  }
  async record(
    context: Context,
    expectedStorageRevision: number,
    input: VerificationReviewInput,
    commandId: string,
    signal?: AbortSignal,
    admission?: () => void,
  ) {
    const started = performance.now(),
      owned = new AbortController(),
      abort = () => owned.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.#timeout);
    const gate = () => {
      const available = () =>
        invariant(
          !owned.signal.aborted && performance.now() - started < this.#timeout,
          "verification_unavailable",
          "Current verification admission unavailable",
        );
      available();
      invariant(
        admission === undefined || typeof admission === "function",
        "invalid_policy",
        "Synchronous admission required",
      );
      const result: unknown = admission?.();
      if (result instanceof Promise) void result.catch(() => {});
      invariant(
        result === undefined,
        "invalid_policy",
        "Admission must return synchronously without a value",
      );
      available();
    };
    try {
      gate();
      const c = structuredClone(context),
        q = captureVerificationReviewInput(c, input),
        principal = { ...c, actor: { ...c.actor, roles: [] } };
      invariant(
        c.actor.kind === "human" &&
          Number.isSafeInteger(expectedStorageRevision) &&
          expectedStorageRevision >= 0,
        "invalid_review",
        "Human and expected verification storage revision required",
      );
      nonempty(commandId, "Command", 128);
      invariant(
        Buffer.byteLength(canonical(q)) <= 128 * 1024,
        "invalid_review",
        "Verification command exceeds budget",
      );
      gate();
      let reviewed: CurrentEvidenceReview;
      try {
        reviewed = await this.#review(principal, q.linkRef, owned.signal);
        gate();
      } catch {
        invariant(
          false,
          "verification_unavailable",
          "Current verification admission unavailable",
        );
      }
      const expected = canonical({
        knowledgeRevision: reviewed.knowledgeRevision,
        linksRevision: reviewed.linksRevision,
        revision: reviewed.revision,
      });
      const admit: VerificationAdmission = (basis) => {
        gate();
        invariant(
          canonical(basis) === expected,
          "verification_unavailable",
          "Owning verification basis differs from source admission",
        );
        gate();
      };
      try {
        // Fresh owning Identity and own-DB basis/history checks run again. Admission is checked under the project lock,
        // before cached acknowledgements and immediately before a new SQL put. Begun SQL is awaited.
        const result = await this.#write(
          principal,
          expectedStorageRevision,
          q,
          commandId,
          owned.signal,
          admit,
        );
        // Acknowledged commit stays acknowledged even if cancellation/deadline happened while SQL was settling.
        return structuredClone(result);
      } catch {
        invariant(
          false,
          "verification_commit_unknown",
          "Verification recording outcome unavailable; inspect or explicitly replay the identical command",
        );
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      owned.abort();
    }
  }
}
