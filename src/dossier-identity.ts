import { copyJson } from "@accountability/consent-rights";
import { MembershipRegistry } from "@accountability/identity-policy/membership";
import { KnowledgeRepository } from "./repository.ts";
import type { ClaimDossierAdmission } from "./repository.ts";
import { KNOWLEDGE_RESOURCE_ID } from "./identity-repository.ts";
import { canonical, invariant, nonempty, requireScope, validateRef } from "./contracts.ts";
import type { Context, Ref, Scope } from "./contracts.ts";

/** Actual current Identity around owning dossier reads; source/Consent authority is a separate mandatory guard. */
export class IdentityClaimDossierReader {
  readonly #resolve: MembershipRegistry["resolveResource"];
  readonly #read: KnowledgeRepository["prepareClaimDossier"];
  readonly #policy: Scope & Readonly<{purpose:string}>;
  readonly #timeout: number;
  constructor(repository: KnowledgeRepository, membership: MembershipRegistry,
    policy: Scope & Readonly<{purpose:string}>, timeoutMs = 10000) {
    invariant(repository instanceof KnowledgeRepository && membership instanceof MembershipRegistry,
      "invalid_policy", "Actual owning Knowledge and Membership required");
    this.#read = KnowledgeRepository.prototype.prepareClaimDossier.bind(repository);
    this.#resolve = MembershipRegistry.prototype.resolveResource.bind(membership);
    this.#policy = copyJson(policy); this.#timeout = timeoutMs;
    invariant(Object.keys(this.#policy).length === 3 && Object.keys(this.#policy).every(k=>["tenantId","projectId","purpose"].includes(k)),
      "invalid_policy", "Fixed dossier scope and purpose required");
    for (const value of [this.#policy.tenantId,this.#policy.projectId,this.#policy.purpose]) nonempty(value,"Fixed policy",128);
    invariant(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "invalid_policy", "Bounded dossier deadline required");
  }
  async read(context: Context, selection: Readonly<{claim:Ref;links:Ref}>, signal?: AbortSignal,
    admission?: ClaimDossierAdmission) {
    const started = performance.now(), owned = new AbortController(), abort = () => owned.abort();
    signal?.addEventListener("abort",abort,{once:true}); if (signal?.aborted) abort();
    const timer = setTimeout(abort,this.#timeout);
    const gate = () => invariant(!owned.signal.aborted && performance.now()-started < this.#timeout,
      "dossier_unavailable", "Current dossier read unavailable");
    const remaining = () => Math.max(1,Math.ceil(this.#timeout-(performance.now()-started)));
    try {
      gate();
      const c = copyJson(context), choice = copyJson(selection);
      requireScope(this.#policy,c);
      invariant(c.actor.kind === "human" && c.purpose === this.#policy.purpose,
        "dossier_unavailable", "Current human dossier authority required");
      invariant(choice !== null && typeof choice === "object" && Object.keys(choice).length === 2 &&
        Object.hasOwn(choice,"claim") && Object.hasOwn(choice,"links") && Buffer.byteLength(canonical(choice)) <= 1024,
        "dossier_unavailable", "Exact bounded dossier selection required");
      for (const [r,kind] of [[choice.claim,"claim"],[choice.links,"knowledge-evidence-links"]] as const) {
        validateRef(r); requireScope(this.#policy,r);
        invariant(r.kind === kind,"dossier_unavailable","Exact dossier reference kind required");
      }
      gate();
      const principal = {...c,actor:{...c.actor,roles:[]}};
      const current = async () => {
        gate();
        // Begun Identity SQL is awaited; no caller role or snapshot fallback.
        const resolved = copyJson(await this.#resolve(principal,KNOWLEDGE_RESOURCE_ID,"investigate"));
        gate(); const actual = resolved.context; requireScope(this.#policy,actual);
        invariant(resolved.resourceId === KNOWLEDGE_RESOURCE_ID && actual.actor.kind === "human" &&
          actual.actor.id === c.actor.id && actual.purpose === c.purpose && actual.requestId === c.requestId,
          "dossier_unavailable", "Current dossier principal binding unavailable");
        return actual;
      };
      const actual = await current(); gate();
      const output = await this.#read(actual,choice,owned.signal,remaining(),basis=>{
        gate(); const value: unknown = admission?.(basis);
        if (value instanceof Promise) void value.catch(()=>{});
        gate(); return value as void;
      });
      gate(); await current(); gate();
      invariant(Buffer.byteLength(canonical(output)) <= 512*1024,"dossier_unavailable","Whole dossier response exceeds budget");
      const result = structuredClone(output); gate(); return result;
    } catch {
      invariant(false,"dossier_unavailable","Current dossier read unavailable");
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort",abort); owned.abort();
    }
  }
}
