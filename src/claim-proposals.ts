import { copyJson } from "@accountability/consent-rights";
import { ConsentEvidenceKnowledgeReview } from "./consent-links.ts";
import { CurrentEvidenceKnowledgeReview } from "./current-evidence.ts";
import {
  canonical,
  digest,
  invariant,
  nonempty,
  requireScope,
  validateRef,
} from "./contracts.ts";
import type { Context, Ref } from "./contracts.ts";
export type ClaimCandidate = Readonly<{
  id: string;
  assertion: string;
  linkId: string;
  start: number;
  end: number;
  quote: string;
}>;
function exact(v: object, keys: string[]) {
  invariant(
    v &&
      Object.keys(v).length === keys.length &&
      keys.every((k) => Object.hasOwn(v, k)),
    "invalid_proposal",
    "Exact proposal fields required",
  );
}
function boundary(text: string, i: number) {
  return !(
    i > 0 &&
    i < text.length &&
    /[\uD800-\uDBFF]/.test(text[i - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[i]!)
  );
}
/** Untrusted candidates become private unassessed proposals only, never Knowledge revisions or findings. */
export class ClaimProposalReader {
  readonly #review: CurrentEvidenceKnowledgeReview["review"];
  readonly #timeout: number;
  constructor(review: ConsentEvidenceKnowledgeReview, timeoutMs = 10000) {
    invariant(
      review instanceof ConsentEvidenceKnowledgeReview,
      "invalid_policy",
      "Mandatory owning Consent-guarded review required",
    );
    invariant(
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "invalid_policy",
      "Bounded proposal acceptance required",
    );
    // Use the owning implementation, retaining the constructed instance's mandatory guard and private fields.
    this.#review = CurrentEvidenceKnowledgeReview.prototype.review.bind(review);
    this.#timeout = timeoutMs;
  }
  async propose(
    context: Context,
    selected: Ref,
    candidates: readonly ClaimCandidate[],
    signal?: AbortSignal,
  ) {
    const started = performance.now(),
      owned = new AbortController();
    const abort = () => owned.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.#timeout);
    const gate = () =>
      invariant(
        !signal?.aborted &&
          !owned.signal.aborted &&
          performance.now() - started < this.#timeout,
        "proposal_unavailable",
        "Current proposal observation unavailable",
      );
    try {
      gate();
      const c = structuredClone(context),
        choice = copyJson(selected),
        q = copyJson(candidates);
      gate();
      exact(choice, ["tenantId", "projectId", "kind", "id", "revision"]);
      validateRef(choice);
      requireScope(c, choice);
      invariant(
        c.actor.kind === "human" && choice.kind === "knowledge-evidence-links",
        "invalid_proposal",
        "Human and exact link-set revision required",
      );
      invariant(
        Array.isArray(q) &&
          q.length > 0 &&
          q.length <= 32 &&
          Buffer.byteLength(canonical(q)) <= 128 * 1024,
        "invalid_proposal",
        "Bounded nonempty candidates required",
      );
      const ids = new Set<string>();
      for (const p of q) {
        exact(p, ["id", "assertion", "linkId", "start", "end", "quote"]);
        nonempty(p.id, "Proposal ID", 128);
        nonempty(p.assertion, "Assertion", 4000);
        nonempty(p.linkId, "Link ID", 128);
        nonempty(p.quote, "Quote", 16000);
        invariant(
          !ids.has(p.id) &&
            Number.isSafeInteger(p.start) &&
            Number.isSafeInteger(p.end) &&
            p.start >= 0 &&
            p.end > p.start,
          "invalid_proposal",
          "Unique candidate and exact half-open UTF16 span required",
        );
        ids.add(p.id);
      }
      gate();
      let reviewed;
      try {
        reviewed = await this.#review(c, choice, owned.signal);
      } catch {
        invariant(
          false,
          "proposal_unavailable",
          "Current proposal observation unavailable",
        );
      }
      gate();
      invariant(
        canonical(reviewed.revision.ref) === canonical(choice) &&
          reviewed.evidenceRevision !== null,
        "invalid_proposal",
        "Current nonempty citation set required",
      );
      const proposals = q.map((p) => {
        const link = reviewed.revision.links.find((l) => l.id === p.linkId),
          s = link?.selector;
        invariant(
          s?.kind === "text" &&
            p.end <= s.quote.length &&
            boundary(s.quote, p.start) &&
            boundary(s.quote, p.end) &&
            s.quote.slice(p.start, p.end) === p.quote,
          "invalid_proposal",
          "Exact cited text span required",
        );
        return {
          id: p.id,
          assertion: p.assertion,
          assessment: null,
          proceduralPosture: null,
          editorialApproval: null,
          citation: {
            linkId: link!.id,
            relation: link!.relation,
            selector: {
              ...s,
              start: s.start + p.start,
              end: s.start + p.end,
              quote: p.quote,
            },
            fingerprint: link!.fingerprint,
          },
          limitations: [
            "Untrusted assertion proposal; an exact quotation is not verification or corroboration.",
          ],
        };
      });
      const result = {
        schemaVersion: 1,
        tenantId: c.tenantId,
        projectId: c.projectId,
        visibility: "private",
        purpose: c.purpose,
        basis: {
          knowledgeRevision: reviewed.knowledgeRevision,
          linksRevision: reviewed.linksRevision,
          evidenceRevision: reviewed.evidenceRevision,
          linkRef: reviewed.revision.ref,
          claimRef: reviewed.revision.claim,
        },
        proposals,
      };
      invariant(
        Buffer.byteLength(canonical(result)) <= 256 * 1024,
        "proposal_full",
        "Proposal response exceeds budget",
      );
      gate();
      const copied = structuredClone({ ...result, digest: digest(result) });
      gate();
      return copied;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      owned.abort();
    }
  }
}
