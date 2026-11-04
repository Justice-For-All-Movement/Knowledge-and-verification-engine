import type { EvidenceService } from "@accountability/evidence/service";
import type { MembershipRegistry } from "@accountability/identity-policy/membership";
import type { PermissionRegistry } from "@accountability/consent-rights/registry";
import { copyJson } from "@accountability/consent-rights";
import type {
  ExactResource,
  UseDecision,
} from "@accountability/consent-rights";
import type { Context, Ref, Scope } from "./contracts.ts";
import {
  canonical,
  digest,
  invariant,
  nonempty,
  requireScope,
  validTime,
  validateRef,
} from "./contracts.ts";
import { captureEvidenceLinksCommand } from "./evidence-links.ts";
import type { EvidenceLinksCommand } from "./evidence-links.ts";
import type { EvidenceCredential } from "./current-evidence.ts";
import type { IdentityKnowledgeRepository } from "./identity-repository.ts";
import { SourceEvidenceLinksWriter } from "./source-links.ts";

export type EvidenceUseBinding = Readonly<{
  resource: ExactResource;
  rights: readonly string[];
  consents: readonly string[];
  attribution: string | null;
}>;
export type EvidenceUsePolicy = Scope &
  Readonly<{
    purpose: string;
    bindings: readonly EvidenceUseBinding[];
  }>;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const hash = /^[a-f0-9]{64}$/;
function exact(value: object, keys: string[]) {
  invariant(
    value &&
      Object.getPrototypeOf(value) === Object.prototype &&
      same(Object.keys(value).sort(), keys.toSorted()),
    "invalid_policy",
    "Exact evidence use binding required",
  );
}
function evidenceRef(ref: Ref) {
  const value = validateRef(ref);
  invariant(
    value.kind === "evidence",
    "invalid_reference",
    "Exact owning Evidence edition required",
  );
  return value;
}
/** Separate opt-in Identity resource for evaluation of one exact Evidence edition. */
export function evidenceUseResourceId(ref: Ref): string {
  return digest({
    kind: "knowledge-evidence-use-v1",
    resource: evidenceRef(ref),
  });
}

/** Actual owning Identity/Consent observations. Fixed host mappings are not credentials. */
export class CurrentEvidenceUse {
  readonly #resolve: MembershipRegistry["resolveResource"];
  readonly #evaluate: PermissionRegistry["evaluateCurrent"];
  readonly #policy: EvidenceUsePolicy;
  readonly #clock: () => string;
  readonly #timeout: number;
  constructor(
    membership: MembershipRegistry,
    permissions: PermissionRegistry,
    policy: EvidenceUsePolicy,
    clock: () => string,
    timeoutMs = 10000,
  ) {
    const p = copyJson(policy);
    exact(p, ["tenantId", "projectId", "purpose", "bindings"]);
    for (const value of [p.tenantId, p.projectId, p.purpose])
      nonempty(value, "Fixed scope/purpose", 128);
    invariant(
      Array.isArray(p.bindings) &&
        p.bindings.length <= 64 &&
        Buffer.byteLength(canonical(p)) <= 256 * 1024,
      "invalid_policy",
      "Bounded explicit evidence use bindings required",
    );
    const seen = new Set<string>();
    for (const binding of p.bindings) {
      exact(binding, ["resource", "rights", "consents", "attribution"]);
      exact(binding.resource, ["ref", "digest"]);
      const ref = evidenceRef(binding.resource.ref);
      requireScope(p, ref);
      invariant(
        typeof binding.resource.digest === "string" &&
          binding.resource.digest.length === 64 &&
          hash.test(binding.resource.digest),
        "invalid_policy",
        "Exact original-byte digest required",
      );
      const key = canonical(ref);
      invariant(
        !seen.has(key),
        "invalid_policy",
        "One mapping per exact Evidence edition required",
      );
      seen.add(key);
      for (const ids of [binding.rights, binding.consents]) {
        invariant(
          Array.isArray(ids) &&
            ids.length <= 100 &&
            new Set(ids).size === ids.length,
          "invalid_policy",
          "Bounded unique permission IDs required",
        );
        for (const id of ids) nonempty(id, "Permission ID", 200);
      }
      if (binding.attribution !== null)
        nonempty(binding.attribution, "Attribution", 200);
    }
    invariant(
      typeof clock === "function" &&
        Number.isSafeInteger(timeoutMs) &&
        timeoutMs >= 1 &&
        timeoutMs <= 30000,
      "invalid_policy",
      "Synchronous clock and bounded acceptance budget required",
    );
    this.#resolve = membership.resolveResource.bind(membership);
    this.#evaluate = permissions.evaluateCurrent.bind(permissions);
    this.#policy = p;
    this.#clock = clock;
    this.#timeout = timeoutMs;
  }
  async authorize(
    context: Context,
    command: EvidenceLinksCommand,
    signal?: AbortSignal,
  ): Promise<void> {
    const started = performance.now();
    const c = copyJson(context),
      q = captureEvidenceLinksCommand(c, copyJson(command));
    requireScope(this.#policy, c);
    invariant(
      c.actor.kind === "human" && c.purpose === this.#policy.purpose,
      "use_denied",
      "Fixed human purpose required",
    );
    const principal = { ...c, actor: { ...c.actor, roles: [] } };
    const gate = () =>
      invariant(
        !signal?.aborted && performance.now() - started < this.#timeout,
        "use_unavailable",
        "Current evidence use observation unavailable",
      );
    const selected = new Map<
      string,
      { binding: EvidenceUseBinding; action: "reproduce" | "metadata-citation" }
    >();
    // Resolve the entire explicit mapping before any Identity/Consent SQL, never infer empty requirements.
    for (const link of q.links) {
      const binding = this.#policy.bindings.find(
        (b) =>
          same(b.resource.ref, link.selector.evidence) &&
          b.resource.digest === link.selector.sha256,
      );
      invariant(binding, "use_denied", "Exact Evidence use mapping required");
      const action =
        link.selector.kind === "text" ? "reproduce" : "metadata-citation";
      selected.set(canonical([binding.resource, action]), { binding, action });
    }
    gate();
    for (const { binding, action } of selected.values()) {
      const resourceId = evidenceUseResourceId(binding.resource.ref);
      let actual: Context;
      try {
        const resolved = copyJson(
          await this.#resolve(principal, resourceId, "investigate"),
        );
        gate();
        actual = resolved.context;
        requireScope(c, actual);
        invariant(
          resolved.resourceId === resourceId &&
            actual.actor.kind === "human" &&
            actual.actor.id === c.actor.id &&
            actual.purpose === c.purpose &&
            actual.requestId === c.requestId,
          "use_unavailable",
          "Current Identity binding unavailable",
        );
      } catch {
        invariant(
          false,
          "use_unavailable",
          "Current evidence use observation unavailable",
        );
      }
      let decision: UseDecision;
      try {
        decision = copyJson(
          await this.#evaluate(
            actual,
            binding.resource.ref,
            { action, audience: "private", attribution: binding.attribution },
            { rights: binding.rights, consents: binding.consents },
            this.#clock,
          ),
        );
        gate();
        exact(decision, ["allowed", "action", "audience", "purpose", "resource", "reasons", "grants", "consents", "checkedAt"]);
        invariant(Array.isArray(decision.grants) && decision.grants.length <= 1 &&
          Array.isArray(decision.consents) && decision.consents.length <= 100,
          "use_unavailable", "Bounded current permission references required");
        invariant(
          Buffer.byteLength(canonical(decision)) <= 256 * 1024 &&
            same(decision.resource, binding.resource) &&
            decision.action === action &&
            decision.audience === "private" &&
            decision.purpose === c.purpose &&
            validTime(decision.checkedAt) >= validTime(actual.now) &&
            typeof decision.allowed === "boolean" &&
            Array.isArray(decision.reasons),
          "use_unavailable",
          "Exact current permission binding unavailable",
        );
      } catch {
        invariant(
          false,
          "use_unavailable",
          "Current evidence use observation unavailable",
        );
      }
      invariant(
        decision.allowed === true && decision.reasons.length === 0 && decision.grants.length === 1,
        "use_denied",
        "Current evidence use is not permitted",
      );
      gate();
    }
    gate();
  }
}

/** Mandatory current-use guard; legacy source-only writer is unchanged unless explicitly configured. */
export class ConsentEvidenceLinksWriter extends SourceEvidenceLinksWriter {
  constructor(
    repository: IdentityKnowledgeRepository,
    evidence: EvidenceService,
    credential: EvidenceCredential,
    permissions: CurrentEvidenceUse,
    timeoutMs = 10000,
  ) {
    invariant(
      permissions instanceof CurrentEvidenceUse,
      "invalid_policy",
      "Current owning permission guard required",
    );
    super(repository, evidence, credential, timeoutMs, permissions);
  }
}
