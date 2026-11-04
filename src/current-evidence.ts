import type {EvidenceService, SelectorReview} from '@accountability/evidence/service';
import type {SourceAnalysis} from '@accountability/evidence';
import type {IdentityKnowledgeRepository} from './identity-repository.ts';
import {canonical, digest, invariant, nonempty, requireScope} from './contracts.ts';
import type {Context, Ref} from './contracts.ts';
const relations = ['supports','challenges','quotes'] as const;
type Relation = typeof relations[number];
export type CurrentEvidenceReview = Readonly<{
  knowledgeRevision:number; linksRevision:number;
  revision:Awaited<ReturnType<IdentityKnowledgeRepository['prepareEvidenceReview']>>['revision'];
  evidenceRevision:number|null; sources:Readonly<Record<Relation,SourceAnalysis|null>>;
}>;
/** Trusted host releases a current Evidence credential for this human/delegation; incoming roles are stripped. */
export type EvidenceCredential = (context:Context, signal:AbortSignal)=>Promise<string>;
function analysis(value:SourceAnalysis, selected:readonly Ref[]) {
  const keys=['groups','sourceGroupCount','uniqueByteCount','unknownFamilyRefs','allGroupsIndependentlyAssessed','independentFamilyCount','basisDigest'];
  invariant(value && Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k)), 'source_unavailable','Exact source analysis required');
  const refs=new Set(selected.map(canonical));
  invariant(Array.isArray(value.groups) && value.groups.length===value.sourceGroupCount && value.groups.length>0,
    'source_unavailable','Bounded source groups required');
  const flattened=value.groups.flat().map(canonical);
  invariant(value.groups.every(g=>g.length>0) && flattened.length===refs.size && new Set(flattened).size===refs.size && flattened.every(r=>refs.has(r)),
    'source_unavailable','Exact selected source partition required');
  invariant(Number.isSafeInteger(value.uniqueByteCount) && value.uniqueByteCount>0 && value.uniqueByteCount<=refs.size &&
    Array.isArray(value.unknownFamilyRefs) && value.unknownFamilyRefs.length<=refs.size && value.unknownFamilyRefs.every(r=>refs.has(canonical(r))) &&
    typeof value.allGroupsIndependentlyAssessed==='boolean' && /^[a-f0-9]{64}$/.test(value.basisDigest) &&
    (value.independentFamilyCount===null || (value.allGroupsIndependentlyAssessed && value.unknownFamilyRefs.length===0 && value.independentFamilyCount===value.groups.length)),
    'source_unavailable','Invalid source analysis');
}
/** Opt-in read-only composition. Own histories are observed before and after sequential Evidence observations. */
export class CurrentEvidenceKnowledgeReview {
  readonly #basis:IdentityKnowledgeRepository['prepareEvidenceReview'];
  readonly #review:EvidenceService['reviewSelectors'];
  readonly #credential:EvidenceCredential;
  readonly #timeout:number;
  constructor(repository:IdentityKnowledgeRepository, evidence:EvidenceService, credential:EvidenceCredential, timeoutMs=10000) {
    this.#basis=repository.prepareEvidenceReview.bind(repository);
    this.#review=evidence.reviewSelectors.bind(evidence);
    this.#credential=credential;
    invariant(typeof credential==='function' && Number.isSafeInteger(timeoutMs) && timeoutMs>=1 && timeoutMs<=30000,
      'invalid_policy','Credential provider and bounded acceptance budget required');
    this.#timeout=timeoutMs;
  }
  async review(context:Context, selected:Ref, signal?:AbortSignal):Promise<CurrentEvidenceReview> {
    const started=performance.now(), c=structuredClone(context), choice=structuredClone(selected), owned=new AbortController();
    // Roles are never forwarded as credential-release authority.
    const principal={...c,actor:{...c.actor,roles:[]}};
    const abort=()=>owned.abort(); signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted) abort();
    const timer=setTimeout(abort,this.#timeout);
    const gate=()=>invariant(!owned.signal.aborted && performance.now()-started<this.#timeout,'source_unavailable','Current source review unavailable');
    try {
      gate(); const before=await this.#basis(principal,choice,owned.signal); gate();
      const sources:Record<Relation,SourceAnalysis|null>={supports:null,challenges:null,quotes:null};
      let edition:number|null=null;
      for(const relation of relations) {
        const links=before.revision.links.filter(l=>l.relation===relation);
        if(!links.length) continue;
        let token:string;
        try {
          let rejectAbort!:()=>void;
          const cancelled=new Promise<never>((_,reject)=>{rejectAbort=()=>reject(Error('cancelled'));owned.signal.addEventListener('abort',rejectAbort,{once:true});});
          try {gate();token=await Promise.race([this.#credential(structuredClone(principal),owned.signal),cancelled]);}
          finally {owned.signal.removeEventListener('abort',rejectAbort);}
          gate(); nonempty(token,'Credential',512);
        } catch {invariant(false,'source_unavailable','Current source credential unavailable');}
        let result:SelectorReview;
        try {
          // Await begun Evidence SQL; budget/cancellation fence acceptance, never claim rollback or termination.
          result=structuredClone(await this.#review({token,purpose:c.purpose,requestId:`knowledge:${digest({request:c.requestId,choice,relation})}`},links.map(l=>l.selector)));
          gate(); invariant(Buffer.byteLength(canonical(result))<=256*1024,'source_unavailable','Bounded source response required');
          requireScope(c,result);
          invariant(result.schemaVersion===1 && result.purpose===c.purpose && Number.isSafeInteger(result.revision) && result.revision>0 &&
            Array.isArray(result.selectors) && result.selectors.length===links.length,'source_unavailable','Source observation binding differs');
          analysis(result.sources,links.map(l=>l.selector.evidence));
        } catch {invariant(false,'source_unavailable','Current Evidence observation unavailable');}
        for(const [i,l] of links.entries()) {
          const r=result.selectors[i]!;
          invariant(canonical(r.selector)===canonical(l.selector) && r.fingerprint===l.fingerprint,
            'stale_evidence_links','Stored Evidence dependency changed; explicitly revise links');
        }
        invariant(edition===null || edition===result.revision,'source_changed','Evidence edition changed between relation observations');
        edition=result.revision; sources[relation]=result.sources;
      }
      gate(); const after=await this.#basis(principal,choice,owned.signal); gate();
      invariant(canonical(before)===canonical(after),'knowledge_changed','Knowledge histories changed during source observation');
      const result={...after,evidenceRevision:edition,sources};
      invariant(Buffer.byteLength(canonical(result))<=512*1024,'review_full','Review output budget exceeded');
      gate();return structuredClone(result);
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);owned.abort();}
  }
}
