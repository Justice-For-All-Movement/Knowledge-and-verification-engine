import { copyJson } from "@accountability/consent-rights";
import { EvidenceService } from "@accountability/evidence/service";
import type { EvidenceLink, EvidenceLinksCommand } from "./evidence-links.ts";
import { captureEvidenceLinksCommand } from "./evidence-links.ts";
import { CurrentEvidenceUse } from "./consent-links.ts";
import { IdentityClaimDossierReader } from "./dossier-identity.ts";
import type { EvidenceCredential } from "./current-evidence.ts";
import type { Context, Ref } from "./contracts.ts";
import { canonical, digest, invariant, nonempty, requireScope, DomainError } from "./contracts.ts";

type Dossier = Awaited<ReturnType<IdentityClaimDossierReader["read"]>>;
type Observation = Readonly<{ citationSet: Ref; claim: Ref; link: EvidenceLink }>;

/** All disclosed source observations, including removed historical challenges, stay internal until guarded. */
export class CurrentClaimDossierReader {
  readonly #read: IdentityClaimDossierReader["read"];
  readonly #review: EvidenceService["reviewSelectorsForHuman"];
  readonly #authorize: CurrentEvidenceUse["authorize"];
  readonly #credential: EvidenceCredential;
  readonly #timeout: number;
  constructor(reader: IdentityClaimDossierReader, evidence: EvidenceService,
    credential: EvidenceCredential, permissions: CurrentEvidenceUse, timeoutMs = 10000) {
    invariant(reader instanceof IdentityClaimDossierReader && evidence instanceof EvidenceService &&
      permissions instanceof CurrentEvidenceUse && typeof credential === "function",
      "invalid_policy", "Actual current Identity, Evidence and use guard required");
    invariant(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000,
      "invalid_policy", "Bounded dossier source deadline required");
    this.#read = IdentityClaimDossierReader.prototype.read.bind(reader);
    this.#review = EvidenceService.prototype.reviewSelectorsForHuman.bind(evidence);
    this.#authorize = CurrentEvidenceUse.prototype.authorize.bind(permissions);
    this.#credential = credential; this.#timeout = timeoutMs;
  }
  async read(context: Context, selection: Readonly<{claim: Ref; links: Ref}>, signal?: AbortSignal): Promise<Dossier> {
    const started = performance.now(), owned = new AbortController(), abort = () => owned.abort();
    signal?.addEventListener("abort", abort, {once:true}); if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.#timeout);
    const gate = () => invariant(!owned.signal.aborted && performance.now()-started < this.#timeout,
      "dossier_unavailable", "Current dossier source review unavailable");
    try {
      gate();
      const c = copyJson(context), choice = copyJson(selection), principal = {...c,actor:{...c.actor,roles:[]}};
      // Actual Identity facade preflights the exact selection and checks current resource policy.
      const initial = await this.#read(principal,choice,owned.signal,() => gate()); gate();
      const observations: Observation[] = [
        ...initial.dossier.citations.links.map(link=>({citationSet:initial.dossier.citations.ref,claim:initial.dossier.citations.claim,link})),
        ...initial.dossier.historicalChallenges.map(item=>({citationSet:item.citationSet,claim:item.claim,link:item.link})),
      ];
      invariant(observations.length <= 256, "dossier_unavailable", "Whole disclosed source budget exceeded");
      invariant(canonical(initial.sourceObligations) === canonical(observations.map(({citationSet,link})=>({citationSet,linkId:link.id,selector:link.selector}))),
        "dossier_unavailable", "Complete owning source obligations required");
      // Historical claim editions are syntax-only inputs to CurrentEvidenceUse; no latest-claim substitution.
      const grouped = new Map<string, {claim:Ref;ref:Ref;links:EvidenceLink[]}>();
      for (const item of observations) {
        const key=canonical(item.citationSet), group=grouped.get(key);
        if (group) {
          invariant(canonical(group.claim)===canonical(item.claim),"dossier_unavailable","Historical claim binding differs");
          group.links.push(item.link);
        } else grouped.set(key,{claim:item.claim,ref:item.citationSet,links:[item.link]});
      }
      const commands: EvidenceLinksCommand[] = [...grouped.values()].map(group=>captureEvidenceLinksCommand(c,{
        claim:group.claim,expectedRevision:group.ref.revision,links:group.links.map(({id,relation,selector})=>({id,relation,selector})),
      }));
      // Bound every request before credentials; retain all observations, never truncate or inflate independence.
      const batches: Observation[][] = [];
      for (const item of observations) {
        const batch=batches.at(-1);
        if (batch && batch.length < 64 && Buffer.byteLength(canonical([...batch,item].map(x=>x.link.selector))) <= 64*1024) batch.push(item);
        else {
          invariant(Buffer.byteLength(canonical([item.link.selector])) <= 64*1024,"dossier_unavailable","Selector exceeds owning request budget");
          batches.push([item]);
        }
      }
      invariant(batches.length <= 16,"dossier_unavailable","Whole source batch budget exceeded"); gate();
      const authorizeAll = async () => {
        for (const command of commands) { gate(); await this.#authorize(principal,command,owned.signal); gate(); }
      };
      // Resolve EVERY explicit mapping and current same-human Identity/Consent before ANY credential callback.
      await authorizeAll(); gate();
      let edition: number | null = null;
      for (const [index,batch] of batches.entries()) {
        gate();
        let onAbort!: () => void;
        const cancelled = new Promise<never>((_,reject)=>{
          onAbort=()=>reject(Error("cancelled")); owned.signal.addEventListener("abort",onAbort,{once:true});
        });
        let token: string;
        try {
          gate();
          token=await Promise.race([this.#credential(structuredClone(principal),owned.signal),cancelled]);
        } finally { owned.signal.removeEventListener("abort",onAbort); }
        gate(); nonempty(token,"Credential",512);
        // Begun Evidence SQL is awaited. Expected ID is comparison, not human proofing.
        const reviewed=copyJson(await this.#review({token,purpose:c.purpose,
          requestId:`dossier:${digest({request:c.requestId,choice,index})}`},batch.map(x=>x.link.selector),c.actor.id));
        gate(); requireScope(c,reviewed);
        invariant(Buffer.byteLength(canonical(reviewed)) <= 256*1024 && reviewed.schemaVersion===1 && reviewed.purpose===c.purpose &&
          Number.isSafeInteger(reviewed.revision) && reviewed.revision>0 && Array.isArray(reviewed.selectors) && reviewed.selectors.length===batch.length,
          "dossier_unavailable","Exact owning selector review required");
        invariant(edition===null || edition===reviewed.revision,"dossier_unavailable","Evidence changed between observations");
        edition=reviewed.revision;
        for (const [i,item] of batch.entries()) {
          const actual=reviewed.selectors[i]!;
          invariant(canonical(actual.selector)===canonical(item.link.selector) && actual.fingerprint===item.link.fingerprint,
            "dossier_unavailable","Disclosed historical or current source dependency changed");
        }
        gate();
      }
      await authorizeAll(); gate();
      const expected=canonical({knowledgeRevision:initial.knowledgeStorage.revision,linksRevision:initial.linksStorage.revision,dossier:initial.dossier});
      const result=await this.#read(principal,choice,owned.signal,basis=>{
        gate(); invariant(canonical(basis)===expected,"dossier_unavailable","Complete owning dossier basis changed"); gate();
      });
      gate(); invariant(canonical(result)===canonical(initial),"dossier_unavailable","Whole owning dossier changed");
      invariant(Buffer.byteLength(canonical(result)) <= 512*1024,"dossier_unavailable","Whole dossier response exceeds budget");
      const output=structuredClone(result); gate(); return output;
    } catch {
      throw new DomainError("dossier_unavailable","Current dossier source review unavailable");
    } finally { clearTimeout(timer); signal?.removeEventListener("abort",abort); owned.abort(); }
  }
}
