import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceFixture,c} from './dossier-source-fixture.ts';
import {CurrentEvidenceUse} from '../src/consent-links.ts';
import {scoped} from '@accountability/evidence-sql/database';

test('actual four-database dossier retains historical removed challenge and checks every disclosed source',async t=>{
 const f=await sourceFixture(t),reader=f.makeReader();
 const result=await reader.read({...c,actor:{...c.actor,roles:[]}},f.selected);
 assert.equal(result.dossier.citations.links.length,1);assert.equal(result.dossier.historicalChallenges.length,1);
 assert.equal(result.dossier.historicalChallenges[0]!.link.id,'contrary');assert.equal(result.sourceObligations.length,2);
 assert.equal(f.count(),1);assert.equal(f.signal()?.aborted,true);
 await scoped(f.evidence,c,async tx=>assert.equal((await tx.audits()).filter(e=>e.type==='evidence.selectors.review_checked').length,1));
 (result.dossier.historicalChallenges as unknown[]).length=0;
 assert.equal((await reader.read(c,f.selected)).dossier.historicalChallenges.length,1);
});
test('missing historical mapping and withdrawn historical Consent deny before ANY source credential',async t=>{
 const f=await sourceFixture(t);
 const latestOnly=new CurrentEvidenceUse(f.membership,f.permissions,{...f.config,bindings:f.config.bindings.slice(1)},()=>f.time.now);
 await assert.rejects(f.makeReader(latestOnly).read(c,f.selected),{code:'dossier_unavailable'});assert.equal(f.count(),0);
 await f.permissions.withdraw(c,'consent','consent',1,'withdraw-historical');
 await assert.rejects(f.makeReader().read(c,f.selected),{code:'dossier_unavailable'});assert.equal(f.count(),0);
});
test('historical Evidence quarantine is denied even though latest citations remain usable',async t=>{
 const f=await sourceFixture(t);
 const old=await f.service.inspect(f.req,f.source.ref);
 await f.service.quarantine(f.req,f.source.ref,old.revision,'quarantine-old');
 await assert.rejects(f.makeReader().read(c,f.selected),{code:'dossier_unavailable'});assert.equal(f.count(),1);assert.equal(f.signal()?.aborted,true);
});
test('Consent withdrawal during authenticated Evidence work is denied by the post-observation use check',async t=>{
 const f=await sourceFixture(t);
 f.hooks.credential=async()=>{await f.permissions.withdraw(c,'consent','consent',1,'withdraw-during');};
 await assert.rejects(f.makeReader().read(c,f.selected),{code:'dossier_unavailable'});assert.equal(f.count(),1);assert.equal(f.signal()?.aborted,true);
});
