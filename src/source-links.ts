import type { CurrentEvidenceUse } from "./consent-links.ts";
import type {
  EvidenceService,
  SelectorLinkCapture,
} from "@accountability/evidence/service";
import type { IdentityKnowledgeRepository } from "./identity-repository.ts";
import type { EvidenceCredential } from "./current-evidence.ts";
import type { Context } from "./contracts.ts";
import { digest, invariant, nonempty } from "./contracts.ts";
import {
  capturedEvidenceLinks,
  captureEvidenceLinksCommand,
  type EvidenceLinksCommand,
} from "./evidence-links.ts";

/** Explicit owning-service composition. Credentials require trusted human/delegation release policy. */
export class SourceEvidenceLinksWriter {
  readonly #load: IdentityKnowledgeRepository["load"];
  readonly #record: IdentityKnowledgeRepository["recordCapturedEvidenceLinks"];
  readonly #capture: EvidenceService["captureSelectorLinksForHuman"];
  readonly #credential: EvidenceCredential;
  readonly #timeout: number;
  readonly #authorize: CurrentEvidenceUse["authorize"] | undefined;
  constructor(
    repository: IdentityKnowledgeRepository,
    evidence: EvidenceService,
    credential: EvidenceCredential,
    timeoutMs = 10000,
    permissions?: CurrentEvidenceUse,
    captureProfile: "legacy" | "same-human" = "legacy",
  ) {
    invariant(
      typeof credential === "function" &&
        Number.isSafeInteger(timeoutMs) &&
        timeoutMs >= 1 &&
        timeoutMs <= 30000,
      "invalid_policy",
      "Credential provider and bounded acceptance budget required",
    );
    this.#load = repository.load.bind(repository);
    this.#record = repository.recordCapturedEvidenceLinks.bind(repository);
    invariant(captureProfile === "legacy" || captureProfile === "same-human",
      "invalid_policy", "Explicit source capture profile required");
    if (captureProfile === "same-human") {
      invariant(typeof evidence.captureSelectorLinksForHuman === "function",
        "invalid_policy", "Human-bound owning Evidence API required");
      this.#capture = evidence.captureSelectorLinksForHuman.bind(evidence);
    } else {
      const legacy = evidence.captureSelectorLinks.bind(evidence);
      this.#capture = (request, selectors, _humanId) => legacy(request, selectors);
    }
    this.#credential = credential;
    this.#timeout = timeoutMs;
    this.#authorize = permissions?.authorize.bind(permissions);
  }
  async record(
    context: Context,
    expectedStorageRevision: number,
    command: EvidenceLinksCommand,
    commandId: string,
    signal?: AbortSignal,
  ) {
    const started = performance.now(),
      c = structuredClone(context),
      q = captureEvidenceLinksCommand(c, command);
    const principal = { ...c, actor: { ...c.actor, roles: [] } },
      owned = new AbortController();
    nonempty(commandId, "Command", 128);
    invariant(
      Number.isSafeInteger(expectedStorageRevision) &&
        expectedStorageRevision >= 0,
      "invalid_revision",
      "Expected link storage revision required",
    );
    const abort = () => owned.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.#timeout);
    const gate = () =>
      invariant(
        !owned.signal.aborted && performance.now() - started < this.#timeout,
        "source_unavailable",
        "Current source capture unavailable",
      );
    try {
      gate();
      await this.#load(principal, owned.signal);
      gate();
      await this.#authorize?.(principal, q, owned.signal);
      gate();
      let capture: SelectorLinkCapture | null = null;
      if (q.links.length) {
        let rejectAbort!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
          rejectAbort = () => reject(Error("cancelled"));
          owned.signal.addEventListener("abort", rejectAbort, { once: true });
        });
        let token: string;
        try {
          gate();
          token = await Promise.race([
            this.#credential(structuredClone(principal), owned.signal),
            cancelled,
          ]);
          gate();
          nonempty(token, "Credential", 512);
        } catch {
          invariant(
            false,
            "source_unavailable",
            "Current source credential unavailable",
          );
        } finally {
          owned.signal.removeEventListener("abort", rejectAbort);
        }
        try {
          capture = structuredClone(
            await this.#capture(
              {
                token,
                purpose: c.purpose,
                requestId: `knowledge:${digest({ request: c.requestId, commandId, command: q })}`,
              },
              q.links.map((l) => l.selector),
              principal.actor.id,
            ),
          );
          gate();
        } catch {
          invariant(
            false,
            "source_unavailable",
            "Current Evidence capture unavailable",
          );
        }
      }
      capturedEvidenceLinks(c, q, capture);
      gate();
      await this.#authorize?.(principal, q, owned.signal);
      gate();
      // Facade freshly resolves current Identity, then owning SQL reads current claims/links under its project lock.
      // Once SQL begins, preserve its acknowledged result even after cancellation; unknown acknowledgement is not rollback.
      return await this.#record(
        principal,
        expectedStorageRevision,
        capture,
        q,
        commandId,
        owned.signal,
        gate,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      owned.abort();
    }
  }
}
