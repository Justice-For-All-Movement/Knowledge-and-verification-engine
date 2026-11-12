import type test from 'node:test';
import {writeFixture,c} from './verification-write-fixture.ts';
import {scoped} from '@accountability/evidence-sql/database';
import type {EvidenceState} from '@accountability/evidence';
import {CurrentEvidenceUse,evidenceUseResourceId} from '../src/consent-links.ts';
import {IdentityClaimDossierReader} from '../src/dossier-identity.ts';
import {CurrentClaimDossierReader} from '../src/dossier-source.ts';
import type {EvidenceCredential} from '../src/current-evidence.ts';
export {c};
export async function sourceFixture(t:test.TestContext) {
 const f=await writeFixture(t);
 const next=await f.service.acquire(f.req,{id:'current-source',acquisitionId:'current-source',bytes:Buffer.from('Other neutral original fixture'),
  mediaType:'text/plain',capturedAt:c.now,originalLanguage:'und',supersedes:null,expectedRevision:f.metadata.revision,idempotencyKey:'current-acquire'});
 await f.service.runNextScan({...f.req,token:'w'.repeat(32)});
 const current=await f.service.inspect(f.req,next.ref);
 const selector={kind:'whole' as const,evidence:next.ref,sha256:current.version.sha256};
 const stored=await scoped(f.evidence,c,tx=>tx.get<{domain:EvidenceState}>('evidence.aggregate','project'));
 const command={...f.linkCommand,expectedRevision:1,links:[{id:'current-support',relation:'supports' as const,selector}]};
 const links=await f.facade.recordEvidenceLinks(c,1,stored!.value.domain,command,'current-links');
 const terms={...f.terms,resource:{ref:next.ref,digest:selector.sha256}};
 await f.permissions.registerResource(c,{...terms.resource,requiredConsentSubjects:['subject']},0);
 await f.permissions.grantRights(c,{...terms,id:'current-rights',holderId:'fictional-owner',attribution:null,noDerivatives:false},'current-rights');
 await f.permissions.recordConsent(c,{...terms,id:'current-consent',subjectId:'subject'},'current-consent');
 await f.membership.setResourcePolicy(c,2,{...f.usePolicy,resourceId:evidenceUseResourceId(next.ref)},'current-policy');
 const config={...f.config,bindings:[...f.config.bindings,{resource:terms.resource,rights:['current-rights'],consents:['current-consent'],attribution:null}]};
 const makeUse=()=>new CurrentEvidenceUse(f.membership,f.permissions,config,()=>f.time.now);
 const identityReader=new IdentityClaimDossierReader(f.repo,f.membership,f.fixed);
 const selected={claim:f.linkCommand.claim,links:links.record};
 let credentials=0;
 const hooks:{credential:null|(()=>Promise<void>)}={credential:null};
 const credential:EvidenceCredential=async(ctx,signal)=>{credentials++;await hooks.credential?.();return f.credential(ctx,signal);};
 const makeReader=(use=makeUse(),timeout=10000)=>new CurrentClaimDossierReader(identityReader,f.service,credential,use,timeout);
 return {...f,next,selector,stored,command,links,terms,config,makeUse,identityReader,selected,hooks,credential,count:()=>credentials,makeReader};
}
