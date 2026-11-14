import { copyJson } from "@accountability/consent-rights";
import { MembershipRegistry } from "@accountability/identity-policy/membership";
import { KnowledgeRepository } from "./repository.ts";
import { KNOWLEDGE_RESOURCE_ID } from "./identity-repository.ts";
import {
  canonical,
  invariant,
  nonempty,
  requireScope,
  validateRef,
} from "./contracts.ts";
import type { Context, Ref, Scope } from "./contracts.ts";

/** Actual current Identity around owning impact reads; source/Consent authority is a separate mandatory guard. */
export class IdentityKnowledgeCorrectionImpactReader {
  readonly #resolve: MembershipRegistry["resolveResource"];
  readonly #read: KnowledgeRepository["loadCorrectionImpact"];
  readonly #policy: Scope & Readonly<{ purpose: string }>;
  readonly #timeout: number;
  constructor(
    repository: KnowledgeRepository,
    membership: MembershipRegistry,
    policy: Scope & Readonly<{ purpose: string }>,
    timeoutMs = 10000,
  ) {
    invariant(
      repository instanceof KnowledgeRepository &&
        membership instanceof MembershipRegistry,
      "invalid_policy",
      "Actual owning Knowledge and Membership required",
    );
    this.#read =
      KnowledgeRepository.prototype.loadCorrectionImpact.bind(repository);
    this.#resolve =
      MembershipRegistry.prototype.resolveResource.bind(membership);
    this.#policy = copyJson(policy);
    this.#timeout = timeoutMs;
    invariant(
      Object.keys(this.#policy).length === 3 &&
        Object.keys(this.#policy).every((k) =>
          ["tenantId", "projectId", "purpose"].includes(k),
        ),
      "invalid_policy",
      "Fixed impact scope and purpose required",
    );
    for (const value of [
      this.#policy.tenantId,
      this.#policy.projectId,
      this.#policy.purpose,
    ])
      nonempty(value, "Fixed policy", 128);
    invariant(
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "invalid_policy",
      "Bounded impact deadline required",
    );
  }
  async read(
    context: Context,
    before: Ref,
    after: Ref,
    signal?: AbortSignal,
    admission?: () => void,
  ) {
    const started = performance.now(),
      owned = new AbortController(),
      abort = () => owned.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.#timeout);
    const gate = () =>
      invariant(
        !owned.signal.aborted && performance.now() - started < this.#timeout,
        "impact_unavailable",
        "Current impact read unavailable",
      );
    const remaining = () =>
      Math.max(1, Math.ceil(this.#timeout - (performance.now() - started)));
    try {
      gate();
      const c = copyJson(context),
        choice = copyJson({ before, after });
      requireScope(this.#policy, c);
      invariant(
        c.actor.kind === "human" && c.purpose === this.#policy.purpose,
        "impact_unavailable",
        "Current human impact authority required",
      );
      invariant(
        Buffer.byteLength(canonical(choice)) <= 1024,
        "impact_unavailable",
        "Bounded impact selection required",
      );
      for (const r of [choice.before, choice.after]) {
        validateRef(r);
        requireScope(this.#policy, r);
        invariant(
          Object.keys(r).sort().join(",") ===
            "id,kind,projectId,revision,tenantId" &&
            ["claim", "entity", "event", "relationship"].includes(r.kind) &&
            Number.isSafeInteger(r.revision) &&
            r.revision > 0,
          "impact_unavailable",
          "Exact positive Knowledge reference required",
        );
      }
      invariant(
        choice.before.kind === choice.after.kind &&
          choice.before.id === choice.after.id &&
          choice.after.revision === choice.before.revision + 1,
        "impact_unavailable",
        "Consecutive correction editions required",
      );
      gate();
      const principal = { ...c, actor: { ...c.actor, roles: [] } };
      const current = async () => {
        gate();
        // Begun Identity SQL is awaited; no caller role or snapshot fallback.
        const resolved = copyJson(
          await this.#resolve(principal, KNOWLEDGE_RESOURCE_ID, "investigate"),
        );
        gate();
        const actual = resolved.context;
        requireScope(this.#policy, actual);
        invariant(
          resolved.resourceId === KNOWLEDGE_RESOURCE_ID &&
            actual.actor.kind === "human" &&
            actual.actor.id === c.actor.id &&
            actual.purpose === c.purpose &&
            actual.requestId === c.requestId,
          "impact_unavailable",
          "Current impact principal binding unavailable",
        );
        return actual;
      };
      const actual = await current();
      gate();
      const output = await this.#read(
        actual,
        choice.before,
        choice.after,
        owned.signal,
        remaining(),
        () => {
          gate();
          const value: unknown = admission?.();
          if (value instanceof Promise) void value.catch(() => {});
          gate();
          return value as void;
        },
      );
      gate();
      await current();
      gate();
      invariant(
        Buffer.byteLength(canonical(output)) <= 512 * 1024,
        "impact_unavailable",
        "Whole impact response exceeds budget",
      );
      const result = structuredClone(output);
      gate();
      return result;
    } catch {
      invariant(false, "impact_unavailable", "Current impact read unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      owned.abort();
    }
  }
}
