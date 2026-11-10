// Service-layer tests on real PostgreSQL. Fixtures are fictional; the evidence and consent ports are controlled
// in-process stand-ins (test infrastructure), not the real E05/E11 engines.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { DomainError } from '../src/contracts.ts';
import { withDisposableDatabase } from '../src/service-kit.ts';
import type { EvidenceVersionInfo, ServiceContext, Sql, UseDecision } from '../src/service-kit.ts';
import { createEngine, migrate, SCHEMA } from '../src/engine/index.ts';
import type { KnowledgeEngine } from '../src/engine/index.ts';

const ADMIN = process.env.TEST_DATABASE_URL ?? '';
const needsPg = ADMIN === '' ? { skip: 'TEST_DATABASE_URL is not set; real-PostgreSQL test not executed' } : {};

export const HUMAN_CAPS = ['knowledge:read', 'knowledge:write', 'knowledge:propose', 'knowledge:review', 'knowledge:assess', 'knowledge:approve', 'knowledge:merge', 'knowledge:audit'];
let seq = 0;
export const mkCtx = (over: Partial<ServiceContext> = {}): ServiceContext => ({ tenantId: 't1', projectId: 'p1', purpose: 'research', requestId: `r${++seq}`, now: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), actor: { id: 'researcher-1', kind: 'human', roles: ['researcher'] }, capabilities: HUMAN_CAPS, compartments: [], ...over });
const code = (c: string) => (e: unknown): boolean => e instanceof DomainError && e.code === c;
const ev = (id: string, rev = 1): string => `E05:evidence_version:${id}@${rev}`;
const page = (n: number) => ({ kind: 'page' as const, page: n });

function fakePorts() {
  const versions = new Map<string, EvidenceVersionInfo | null>();
  const denied = new Set<string>();
  return {
    versions, denied,
    release(ref: string, available = true): string { versions.set(ref, { ref, evidenceId: ref, revision: 1, sha256: 'a'.repeat(64), size: 10, mediaType: 'application/pdf', filename: 'f.pdf', compartment: null, available }); return ref; },
    ports: {
      evidence: { describe: async (_c: ServiceContext, ref: string) => versions.get(ref) ?? null },
      useDecision: { decide: async (_c: ServiceContext, r: { subjects: readonly string[] }): Promise<UseDecision> => ({ decision: r.subjects.some((s) => denied.has(s)) ? 'deny' : 'allow', reasons: [], permissionRefs: ['E11:permission:perm-1'], restrictions: [], decidedAt: '2026-01-01T00:00:00.000Z' }) },
    },
  };
}
async function suite(fn: (x: { sql: Sql; engine: KnowledgeEngine; fake: ReturnType<typeof fakePorts>; standalone: KnowledgeEngine }) => Promise<void>): Promise<void> {
  await withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
    assert.deepEqual(await migrate(sql), ['001_knowledge_core']);
    assert.deepEqual(await migrate(sql), []);
    const fake = fakePorts();
    await fn({ sql, fake, engine: createEngine({ sql, ports: fake.ports }), standalone: createEngine({ sql }) });
  });
}
/** Waits for the outbox feed, which withholds rows while other transactions are open on the shared server. */
async function eventsOf(engine: KnowledgeEngine, ctx: ServiceContext, want: (types: string[]) => boolean): Promise<any[]> {
  const c = { ...ctx, capabilities: ['knowledge:events'], actor: { id: 'router', kind: 'service' as const, roles: [] } };
  for (let i = 0; ; i++) { const all = (await engine.events(c, { limit: 1000 })).filter((e) => e.projectId === ctx.projectId); if (want(all.map((e) => e.type)) || i > 100) return all; await new Promise((r) => setTimeout(r, 100)); }
}
const noScoreKeys = (value: unknown, path = ''): void => {
  if (Array.isArray(value)) { value.forEach((v, i) => noScoreKeys(v, `${path}[${i}]`)); return; }
  if (value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) { assert.doesNotMatch(k, /guilt|culpab|credib|score|probab|confidence|involve/i, `forbidden key ${path}.${k}`); noScoreKeys(v, `${path}.${k}`); }
};

test('catalog acceptance: families, contradicted claims keep contrary material, assessments need primary support', needsPg, async () => {
  await suite(async ({ engine, fake }) => {
    const ctx = mkCtx({ projectId: 'acceptance' });
    const org = await engine.createEntity(ctx, { entityType: 'organization', name: 'Harbour Works Cooperative', aliases: ['HWC'], caseId: 'case-1' });
    const claim = await engine.createClaim(ctx, { text: 'The cooperative closed the east gate on the night of the flood.', claimType: 'allegation', subjects: [{ kind: 'entity', id: org.id }], caseId: 'case-1' });
    assert.equal(claim.assessments.factual.value, 'unassessed'); assert.equal(claim.assessments.editorial.value, 'not_reviewed'); assert.equal(claim.assessments.procedural.value, 'not_recorded');

    // Ten copies of one wire report plus one challenging log entry.
    const copies: string[] = [];
    for (let i = 0; i < 10; i++) copies.push(fake.release(ev(`wire-copy-${i}`)));
    const links = [];
    for (const ref of copies) links.push(await engine.addEvidenceLink(ctx, { target: { kind: 'claim', id: claim.id }, evidenceRef: ref, selector: { kind: 'text', quote: 'gate was closed' }, stance: 'supports', sourceType: 'secondary' }));
    const before = await engine.independence(ctx, claim.id);
    assert.equal(before.supporting.families, 10, 'ungrouped sources are counted separately until a family is recorded');
    const family = await engine.createSourceFamily(ctx, { label: 'Wire report of 3 March', members: copies, basis: 'identical text' });
    const after = await engine.independence(ctx, claim.id);
    assert.deepEqual(after.supporting, { links: 10, families: 1 });
    assert.equal(after.independentCorroboration, false, 'ten copies of one report are not independent corroboration');
    assert.equal(after.families[0].copies, 10);
    await assert.rejects(engine.createSourceFamily(ctx, { label: 'dup', members: [copies[0] as string] }), code('conflict'));

    const log = fake.release(ev('gate-log'));
    const against = await engine.addEvidenceLink(ctx, { target: { kind: 'claim', id: claim.id }, evidenceRef: log, selector: page(4), stance: 'challenges', sourceType: 'official_record', note: 'Log shows gate open at 23:10' });
    const other = await engine.createClaim(ctx, { text: 'The east gate stayed open all night.', claimType: 'observation', caseId: 'case-1' });
    const contra = await engine.recordContradiction(ctx, { members: [{ kind: 'claim', id: claim.id }, { kind: 'claim', id: other.id }], description: 'Gate closed vs gate open', caseId: 'case-1' });

    // "supported" without a released primary supporting link or documented rationale is refused.
    await assert.rejects(engine.recordAssessment(ctx, claim.id, { dimension: 'factual', value: 'supported', rationale: 'Many outlets repeat it.', cites: { linkIds: links.map((l) => l.id) } }), code('invalid_state'));
    await assert.rejects(engine.recordAssessment(ctx, claim.id, { dimension: 'factual', value: 'refuted', rationale: 'Feels wrong.', cites: { linkIds: [links[0]!.id] } }), code('invalid_state'));
    await assert.rejects(engine.recordAssessment(ctx, claim.id, { dimension: 'factual', value: 'supported', rationale: 'x', score: 0.9 } as never), code('invalid_input'));
    const contested = await engine.recordAssessment(ctx, claim.id, { dimension: 'factual', value: 'contested', rationale: 'One report family against an official log.', cites: { linkIds: [links[0]!.id, against.id], familyIds: [family.id] } });
    assert.equal(contested.status, 'final');

    // The contradicted claim remains visible with its contrary material, before and after the contradiction is resolved.
    await engine.resolveContradiction(ctx, contra.id, { state: 'resolved', note: 'Log covers a different gate.', expectedRevision: 1 });
    const dossier = await engine.getClaim(ctx, claim.id);
    assert.equal(dossier.evidence.supporting.length, 10); assert.equal(dossier.evidence.challenging.length, 1);
    assert.equal(dossier.evidence.challenging[0].note, 'Log shows gate open at 23:10');
    assert.equal(dossier.contradictions.length, 1); assert.equal(dossier.contradictions[0].state, 'resolved');
    assert.equal(dossier.assessments.factual.value, 'contested');
    // Retraction keeps the challenging link in history.
    await engine.retractEvidenceLink(ctx, against.id, { expectedRevision: 1, reason: 'Wrong gate' });
    const hist = await engine.claimHistory(ctx, claim.id);
    assert.ok(hist.links.some((l: any) => l.id === against.id && l.state === 'retracted' && l.revisions.length === 2));
    assert.ok(hist.timeline.some((t: any) => t.type === 'link_retracted' && t.why === 'Wrong gate'));
    assert.ok(hist.timeline.some((t: any) => t.type === 'assessment_recorded' && t.actorId === 'researcher-1'));
    assert.equal((await engine.getClaim(ctx, claim.id)).status, 'needs_reverification', 'retracting a cited link flags the assessment for re-verification');

    // A released primary supporting link allows "supported"; an unreleased one does not.
    const c2 = await engine.createClaim(ctx, { text: 'The pump station lost power at 22:40.', claimType: 'observation', caseId: 'case-1' });
    const held = await engine.addEvidenceLink(ctx, { target: { kind: 'claim', id: c2.id }, evidenceRef: fake.release(ev('held'), false), selector: page(1), stance: 'supports', sourceType: 'primary' });
    assert.equal(held.validation.state, 'not_released');
    await assert.rejects(engine.recordAssessment(ctx, c2.id, { dimension: 'factual', value: 'supported', rationale: 'Primary but unreleased.', cites: { linkIds: [held.id] } }), code('invalid_state'));
    const prim = await engine.addEvidenceLink(ctx, { target: { kind: 'claim', id: c2.id }, evidenceRef: fake.release(ev('scada')), selector: { kind: 'time', start: 12, end: 20 }, stance: 'supports', sourceType: 'primary' });
    assert.equal((await engine.recordAssessment(ctx, c2.id, { dimension: 'factual', value: 'supported', rationale: 'Control-room record.', cites: { linkIds: [prim.id] } })).basis, 'released_primary_source');
    await assert.rejects(engine.addEvidenceLink(ctx, { target: { kind: 'claim', id: c2.id }, evidenceRef: ev('missing'), selector: page(1), stance: 'supports' }), code('invalid_reference'));
    await assert.rejects(engine.addEvidenceLink(ctx, { target: { kind: 'claim', id: c2.id }, evidenceRef: 'E05:evidence_version:scada', selector: page(1), stance: 'supports' }), code('invalid_reference'));

    // Suggested family (for example a mirror hint from discovery) changes nothing until a human accepts it.
    const [hint] = await engine.suggestSourceFamilies({ ...ctx, actor: { id: 'discovery', kind: 'service', roles: [] }, capabilities: ['knowledge:propose'] }, { origin: { kind: 'discovery', ref: 'E04:source:s-9' }, hints: [{ refs: [ev('scada'), ev('scada-mirror')], basis: 'mirror', similarity: 0.97 }] });
    assert.equal(hint!.state, 'pending'); assert.equal(hint!.item.similarity.label, 'similarity');
    const scadaFamily = async () => (await engine.independence(ctx, c2.id)).families.find((f: any) => f.sources.includes('E05:evidence_version:scada')).familyId;
    assert.equal(await scadaFamily(), null);
    await engine.reviewProposal(ctx, hint!.id, { decision: 'accept', reason: 'Same file hash' });
    assert.notEqual(await scadaFamily(), null);
    assert.equal((await engine.getClaim(ctx, c2.id)).status, 'needs_reverification', 'a change in source dependence flags the assessed claim');
    assert.equal((await engine.getClaim(ctx, c2.id)).assessments.factual.value, 'supported', 'the recorded value is retained');

    // Graph: JSON plus accessible table and text.
    const g = await engine.evidenceGraph(ctx, { caseId: 'case-1' });
    assert.ok(g.nodes.some((n) => n.type === 'source_family') && g.edges.some((e) => e.type === 'supports') && g.edges.some((e) => e.type === 'in_tension'));
    assert.equal(g.table.rows.length, g.edges.length); assert.match(g.text, /supporting links: 10 from 1 source family/);
    const gaps = await engine.researchGaps(ctx, { caseId: 'case-1' });
    const mine = gaps.gaps.find((x) => x.claim.startsWith(`E07:claim:${claim.id}`))!;
    assert.deepEqual(mine.gaps.map((x) => x.gap).sort(), ['missing_alternative_explanations', 'needs_reverification', 'no_primary_support', 'single_family_support']);
    assert.ok(gaps.gaps.find((x) => x.claim.startsWith(`E07:claim:${other.id}`))!.gaps.some((x) => x.gap === 'unassessed'));
    noScoreKeys(dossier); noScoreKeys(g); noScoreKeys(gaps); noScoreKeys(hist);
  });
});

test('entity merge is reversible and restores both originals exactly; aliases are preserved', needsPg, async () => {
  await suite(async ({ engine, fake }) => {
    const ctx = mkCtx({ projectId: 'merge' });
    const a = await engine.createEntity(ctx, { entityType: 'person', name: 'Ilse Varga', aliases: ['I. Varga'] });
    const b = await engine.createEntity(ctx, { entityType: 'person', name: 'Ilsa Vargha', aliases: ['Vargha I.'], description: 'Clerk named in the minutes' });
    const org = await engine.createEntity(ctx, { entityType: 'organization', name: 'Riverside Board' });
    const rel = await engine.createRelationship(ctx, { relationshipType: 'membership', fromEntityId: b.id, to: { kind: 'entity', id: org.id }, evidence: [{ evidenceRef: fake.release(ev('minutes')), selector: page(2), stance: 'supports' }] });
    const claim = await engine.createClaim(ctx, { text: 'The clerk signed the minutes.', claimType: 'observation', subjects: [{ kind: 'entity', id: b.id }] });
    const snap = async () => ({ a: await engine.getEntity(ctx, a.id), b: await engine.getEntity(ctx, b.id), rel: await engine.get(ctx, 'relationship', rel.id), claim: await engine.getClaim(ctx, claim.id), ha: await engine.history(ctx, 'entity', a.id), hb: await engine.history(ctx, 'entity', b.id) });
    const before = await snap();

    await engine.recordEntityMatch(ctx, { leftId: a.id, rightId: b.id, decision: 'different', rationale: 'Different birth years in register' });
    await assert.rejects(engine.mergeEntities(ctx, { survivorId: a.id, mergedId: b.id, rationale: 'same' }), code('conflict'));
    const match = await engine.recordEntityMatch(ctx, { leftId: b.id, rightId: a.id, decision: 'same', rationale: 'Register entry was a transcription error', similarity: 0.8 });
    assert.equal(match.revision, 2, 'the disputed decision stays in history');
    await assert.rejects(engine.mergeEntities({ ...ctx, actor: { id: 'bot', kind: 'agent', roles: [] } }, { survivorId: a.id, mergedId: b.id, rationale: 'same' }), code('forbidden'));
    await assert.rejects(engine.mergeEntities({ ...ctx, capabilities: ['knowledge:read', 'knowledge:write', 'knowledge:approve'] }, { survivorId: a.id, mergedId: b.id, rationale: 'same' }), code('forbidden'));
    const merge = await engine.mergeEntities(ctx, { survivorId: a.id, mergedId: b.id, rationale: 'Same person, two spellings' });
    const merged = await engine.getEntity(ctx, a.id);
    assert.deepEqual(merged.aliases.sort(), ['I. Varga', 'Ilsa Vargha', 'Vargha I.']);
    assert.deepEqual(merged.mergedFrom, [{ entityId: b.id, mergeId: merge.id }]);
    assert.equal((await engine.getEntity(ctx, b.id)).mergedInto, a.id);
    assert.equal((await engine.getEntity(ctx, b.id)).name, 'Ilsa Vargha', 'the merged original is untouched');
    assert.equal((await engine.get(ctx, 'relationship', rel.id)).from.resolvedId, a.id, 'links are re-pointed virtually');
    assert.equal((await engine.getClaim(ctx, claim.id)).subjects[0].resolvedId, a.id);
    assert.ok((await engine.evidenceGraph(ctx, { entityId: a.id })).nodes.some((n) => n.type === 'claim'), 'the survivor graph includes the merged record’s claims');
    await assert.rejects(engine.mergeEntities(ctx, { survivorId: b.id, mergedId: a.id, rationale: 'loop' }), code('conflict'));

    await engine.unmergeEntities(ctx, merge.id, { reason: 'Second register confirms two people' });
    await assert.rejects(engine.unmergeEntities(ctx, merge.id, { reason: 'again' }), code('invalid_state'));
    assert.deepEqual(await snap(), before, 'unmerge restores every view exactly');
    const record = await engine.get(ctx, 'entity_merge', merge.id);
    assert.equal(record.state, 'reversed'); assert.equal(record.reversal.reason, 'Second register confirms two people');
    assert.equal((await engine.history(ctx, 'entity_merge', merge.id)).revisions.length, 2);
  });
});

test('no path derives culpability from employment, association, repetition or a score', needsPg, async () => {
  await suite(async ({ engine, fake, sql }) => {
    const ctx = mkCtx({ projectId: 'no-guilt' });
    const person = await engine.createEntity(ctx, { entityType: 'person', name: 'Tomas Reuel' });
    const firm = await engine.createEntity(ctx, { entityType: 'organization', name: 'Quarry Logistics' });
    const claim = await engine.createClaim(ctx, { text: 'Quarry Logistics dumped waste at the old pit.', claimType: 'allegation', subjects: [{ kind: 'entity', id: firm.id }] });
    const support = await engine.addEvidenceLink(ctx, { target: { kind: 'claim', id: claim.id }, evidenceRef: fake.release(ev('survey')), selector: page(3), stance: 'supports', sourceType: 'primary' });
    await engine.recordAssessment(ctx, claim.id, { dimension: 'factual', value: 'supported', rationale: 'Survey record.', cites: { linkIds: [support.id] } });
    const aboutPerson = await engine.createClaim(ctx, { text: 'Tomas Reuel ordered the dumping.', claimType: 'allegation', subjects: [{ kind: 'entity', id: person.id }] });

    // Relationships require evidence and carry no involvement, guilt or score field.
    await assert.rejects(engine.createRelationship(ctx, { relationshipType: 'employment', fromEntityId: person.id, to: { kind: 'entity', id: firm.id }, evidence: [] }), code('invalid_input'));
    for (const extra of [{ involved: true }, { culpability: 'high' }, { score: 0.9 }, { assessment: 'supported' }]) await assert.rejects(engine.createRelationship(ctx, { relationshipType: 'employment', fromEntityId: person.id, to: { kind: 'entity', id: firm.id }, evidence: [{ evidenceRef: ev('survey'), selector: page(1), stance: 'supports' }], ...extra } as never), code('invalid_input'));
    const emp = await engine.createRelationship(ctx, { relationshipType: 'employment', fromEntityId: person.id, to: { kind: 'entity', id: firm.id }, label: 'site manager', time: { earliest: '2019-01-01T00:00:00Z', latest: null, precision: 'year' }, evidence: [{ evidenceRef: fake.release(ev('payroll')), selector: page(7), stance: 'supports', sourceType: 'official_record' }] });
    assert.match(emp.notice, /not an assessment of involvement/);
    await engine.createRelationship(ctx, { relationshipType: 'association', fromEntityId: person.id, to: { kind: 'entity', id: firm.id }, evidence: [{ evidenceRef: ev('payroll'), selector: page(8), stance: 'context' }] });
    const empLink = (await engine.list(ctx, 'evidence_link')).find((l) => l.target.id === emp.id)!;
    await assert.rejects(engine.retractEvidenceLink(ctx, empLink.id, { expectedRevision: 1, reason: 'x' }), code('invalid_state'));

    // Repetition: twenty copies of the same accusation.
    const repeats: string[] = [];
    for (let i = 0; i < 20; i++) repeats.push(fake.release(ev(`repost-${i}`)));
    const ids: string[] = [];
    for (const r of repeats) ids.push((await engine.addEvidenceLink(ctx, { target: { kind: 'claim', id: aboutPerson.id }, evidenceRef: r, selector: { kind: 'whole' }, stance: 'supports', sourceType: 'secondary', similarity: 0.99 })).id);

    const d = await engine.getClaim(ctx, aboutPerson.id);
    for (const dim of ['factual', 'source_type', 'procedural', 'editorial'] as const) assert.equal(d.assessments[dim].recorded, false, `${dim} is untouched by employment, association and repetition`);
    assert.equal(d.assessments.factual.value, 'unassessed'); assert.equal(d.assessments.procedural.value, 'not_recorded');
    assert.equal((await sql.query(`select 1 from ${SCHEMA}.assessments where claim_id=$1`, [aboutPerson.id])).length, 0);
    // The relationship link and the firm's supported claim cannot be cited for the claim about the person.
    await assert.rejects(engine.recordAssessment(ctx, aboutPerson.id, { dimension: 'factual', value: 'supported', rationale: 'He worked there.', cites: { linkIds: [empLink.id] } }), code('invalid_input'));
    await assert.rejects(engine.recordAssessment(ctx, aboutPerson.id, { dimension: 'factual', value: 'supported', rationale: 'The firm did it.', cites: { linkIds: [support.id] } }), code('invalid_input'));
    await assert.rejects(engine.recordAssessment(ctx, aboutPerson.id, { dimension: 'factual', value: 'supported', rationale: 'Twenty posts say so.', cites: { linkIds: ids } }), code('invalid_state'));
    // Similarity is only ever carried under its label and is not accepted by an assessment.
    assert.equal(d.evidence.supporting[0].similarity.label, 'similarity');
    await assert.rejects(engine.recordAssessment(ctx, aboutPerson.id, { dimension: 'factual', value: 'contested', rationale: 'r', cites: { linkIds: [ids[0]!] }, similarity: 0.99 } as never), code('invalid_input'));
    const found = await engine.searchRecords(ctx, { q: 'dumping' });
    assert.ok(found.hits.length === 1 && typeof found.hits[0]!.similarity === 'number'); assert.match(found.notice, /not factual verification/);
    assert.equal((await engine.getClaim(ctx, aboutPerson.id)).assessments.factual.value, 'unassessed', 'searching changes nothing');
    const gaps = (await engine.researchGaps(ctx)).gaps.find((g) => g.claim.startsWith(`E07:claim:${aboutPerson.id}`))!;
    assert.ok(gaps.gaps.some((g) => g.gap === 'unassessed') && gaps.gaps.some((g) => g.gap === 'no_primary_support'));
    const columns = await sql.query<{ column_name: string }>(`select column_name from information_schema.columns where table_schema=$1`, [SCHEMA]);
    for (const c of columns) assert.doesNotMatch(c.column_name, /guilt|culpab|credib|score|probab/);
    noScoreKeys(await engine.evidenceGraph(ctx, { entityId: person.id })); noScoreKeys(await engine.get(ctx, 'relationship', emp.id));
  });
});

test('agents and services only propose; a human finalises; the four dimensions are separate', needsPg, async () => {
  await suite(async ({ engine, fake }) => {
    const ctx = mkCtx({ projectId: 'dims' });
    const agent: ServiceContext = { ...ctx, actor: { id: 'model-run-7', kind: 'agent', roles: [] }, capabilities: ['knowledge:*', 'knowledge:approve'] };
    const src = fake.release(ev('ledger'));
    // Direct writes by an agent are refused in every write path.
    await assert.rejects(engine.createClaim(agent, { text: 'x', claimType: 'observation' }), code('forbidden'));
    await assert.rejects(engine.createEntity(agent, { entityType: 'person', name: 'X Y' }), code('forbidden'));
    // Proposals cannot smuggle an assessment, approval or capability.
    for (const extra of [{ assessment: 'supported' }, { editorialApproval: 'approved' }, { proceduralStatus: 'charged' }, { capabilities: ['knowledge:approve'] }, { state: 'verified' }])
      await assert.rejects(engine.proposeClaims(agent, { origin: { kind: 'model' }, items: [{ text: 'x', claimType: 'observation', ...extra } as never] }), code('invalid_input'));
    await assert.rejects(engine.proposeClaims(agent, { origin: { kind: 'model' }, items: [{ text: 'q', claimType: 'observation', evidence: [{ evidenceRef: src, selector: { kind: 'text', quote: 'paid 400 to the yard' }, stance: 'supports', excerpt: { start: 0, end: 4, quote: 'PAID' } }] }] }), code('invalid_proposal'));
    const [p] = await engine.proposeClaims(agent, { origin: { kind: 'extraction', ref: 'E06:representation:rep-1@1' }, caseId: 'c', items: [{ text: 'The ledger records a payment of 400 to the yard.', claimType: 'observation', evidence: [{ evidenceRef: src, representationRef: 'E06:representation:rep-1@1', selector: { kind: 'text', quote: 'paid 400 to the yard' }, stance: 'supports', sourceType: 'primary', excerpt: { start: 0, end: 8, quote: 'paid 400' } }] }] });
    assert.equal(p!.state, 'pending'); assert.match(p!.notice, /Untrusted proposal/);
    assert.equal((await engine.list(ctx, 'claim')).length, 0, 'a proposal is not a claim');
    await assert.rejects(engine.reviewProposal(agent, p!.id, { decision: 'accept', reason: 'self' }), code('forbidden'));
    await assert.rejects(engine.reviewProposal({ ...ctx, capabilities: ['knowledge:read', 'knowledge:write'] }, p!.id, { decision: 'accept', reason: 'no cap' }), code('forbidden'));
    const reviewed = await engine.reviewProposal(ctx, p!.id, { decision: 'accept', reason: 'Checked against the scan' });
    assert.equal(reviewed.review.results.length, 2);
    await assert.rejects(engine.reviewProposal(ctx, p!.id, { decision: 'reject', reason: 'twice' }), code('invalid_state'));
    const [claim] = await engine.list(ctx, 'claim');
    const cid = claim!.id;
    let d = await engine.getClaim(ctx, cid);
    assert.equal(d.provenance.proposalId, p!.id); assert.equal(d.caseId, 'c');
    assert.equal(d.assessments.factual.recorded, false, 'acceptance is not verification');
    const link = d.evidence.supporting[0];
    assert.match(link.note, /Excerpt: “paid 400”/);

    // Agent: proposal only.
    await assert.rejects(engine.recordAssessment(agent, cid, { dimension: 'factual', value: 'supported', rationale: 'Ledger entry.', cites: { linkIds: [link.id] } }), code('forbidden'));
    await assert.rejects(engine.recordAssessment({ ...agent, actor: { id: 'svc', kind: 'service', roles: [] } }, cid, { dimension: 'editorial', value: 'approved', rationale: 'ok' }), code('forbidden'));
    const prop = await engine.proposeAssessment(agent, cid, { dimension: 'factual', value: 'supported', rationale: 'Ledger entry matches.', cites: { linkIds: [link.id] } });
    assert.equal(prop.status, 'proposed');
    d = await engine.getClaim(ctx, cid);
    assert.equal(d.assessments.factual.value, 'unassessed'); assert.equal(d.assessments.pendingProposals.length, 1);
    // Human without knowledge:approve (wildcard does not grant it) cannot finalise.
    await assert.rejects(engine.recordAssessment({ ...ctx, capabilities: ['knowledge:*'] }, cid, { dimension: 'factual', value: 'supported', rationale: 'r', cites: { linkIds: [link.id] } }), code('forbidden'));
    const fin = await engine.recordAssessment(ctx, cid, { dimension: 'factual', value: 'supported', rationale: 'Confirmed against the scan of the ledger.', cites: { linkIds: [link.id] }, proposalId: prop.id! });
    assert.equal(fin.actorKind, 'human'); assert.equal(fin.proposalId, prop.id);
    await assert.rejects(engine.recordAssessment(ctx, cid, { dimension: 'factual', value: 'supported', rationale: 'again', cites: { linkIds: [link.id] }, proposalId: prop.id! }), code('invalid_state'));
    const p2 = await engine.proposeAssessment(agent, cid, { dimension: 'procedural', value: 'charged', rationale: 'inferred from tone' });
    await engine.rejectAssessmentProposal(ctx, p2.id!, { reason: 'Procedural status is never inferred' });

    // Dimension separation, every direction.
    const state = async () => { const a = (await engine.getClaim(ctx, cid)).assessments; return { factual: a.factual.id, source_type: a.source_type.id, procedural: a.procedural.id, editorial: a.editorial.id, values: [a.factual.value, a.source_type.value, a.procedural.value, a.editorial.value] }; };
    let s0 = await state();
    assert.deepEqual(s0.values, ['supported', 'unclassified', 'not_recorded', 'not_reviewed']);
    const ed = await engine.recordAssessment({ ...ctx, actor: { id: 'editor-1', kind: 'human', roles: ['editor'] } }, cid, { dimension: 'editorial', value: 'approved_with_conditions', rationale: 'Usable with attribution.', conditions: 'Attribute to the ledger' });
    let s1 = await state();
    assert.equal(s1.factual, s0.factual, 'editorial approval does not touch the factual assessment'); assert.equal(s1.editorial, ed.id); assert.equal(ed.actorId, 'editor-1');
    const f2 = await engine.recordAssessment(ctx, cid, { dimension: 'factual', value: 'contested', rationale: 'A second ledger differs.', cites: { linkIds: [link.id] } });
    s0 = s1; s1 = await state();
    assert.equal(s1.editorial, s0.editorial, 'a factual change does not touch editorial approval'); assert.equal(s1.values[3], 'approved_with_conditions'); assert.equal(s1.factual, f2.id);
    await assert.rejects(engine.recordAssessment(ctx, cid, { dimension: 'procedural', value: 'convicted_by_rumour', rationale: 'x' }), code('invalid_input'));
    await engine.recordAssessment(ctx, cid, { dimension: 'procedural', value: 'complaint_filed', rationale: 'Registry entry 12/26 seen by reviewer.' });
    await engine.recordAssessment({ ...ctx, capabilities: ['knowledge:read', 'knowledge:assess'] }, cid, { dimension: 'source_type', value: 'official_record', rationale: 'Statutory ledger.' });
    const s2 = await state();
    assert.deepEqual(s2.values, ['contested', 'official_record', 'complaint_filed', 'approved_with_conditions']);
    assert.equal(s2.factual, s1.factual); assert.equal(s2.editorial, s1.editorial);
    const all = await engine.assessments(ctx, cid);
    assert.equal(all.history.length, 7, 'every proposal and decision is kept');
    assert.deepEqual(all.history.filter((a) => a.dimension === 'factual' && a.status === 'final').map((a) => a.value), ['supported', 'contested']);
    assert.equal(all.history.find((a) => a.id === p2.id)!.decision, 'rejected');
    // Entity and link proposals.
    const [pe] = await engine.proposeEntities(agent, { origin: { kind: 'model' }, items: [{ entityType: 'organization', name: 'Yard Supplies' }] });
    const e1 = await engine.reviewProposal(ctx, pe!.id, { decision: 'accept', reason: 'ok' });
    const yard = e1.review.results[0] as string;
    const [pm] = await engine.proposeEntities(agent, { origin: { kind: 'model' }, items: [{ entityType: 'organization', name: 'Yard Supplies Ltd', matchEntityId: yard.split(':')[2]!.split('@')[0]!, similarity: 0.93 }] });
    const e2 = await engine.reviewProposal(ctx, pm!.id, { decision: 'accept', reason: 'new record; match left open' });
    assert.equal(e2.review.results.length, 2);
    const m = (await engine.list(ctx, 'entity_match'))[0]!;
    assert.equal(m.decision, 'unresolved'); assert.equal(m.similarity.label, 'similarity');
    assert.equal((await engine.list(ctx, 'entity_merge')).length, 0, 'a suggested match never merges');
    const [pl] = await engine.proposeLinks(agent, { origin: { kind: 'reply', ref: 'E03:message:m-1' }, items: [{ target: { kind: 'claim', id: cid }, evidenceRef: src, selector: page(2), stance: 'challenges' }] });
    await engine.reviewProposal(ctx, pl!.id, { decision: 'reject', reason: 'Wrong page' });
    assert.equal((await engine.getClaim(ctx, cid)).evidence.challenging.length, 0);
    const audit = await engine.audit(ctx, { limit: 1000 });
    assert.ok(audit.some((a) => a.action === 'knowledge.assessment_recorded' && a.actorKind === 'human') && audit.some((a) => a.action === 'knowledge.assessment_proposed' && a.actorKind === 'agent'));
  });
});

test('protected identities are withheld in every read, search, graph, history, inspect and export path', needsPg, async () => {
  await suite(async ({ engine, fake }) => {
    const ctx = mkCtx({ projectId: 'protect' });
    const discloser: ServiceContext = { ...ctx, actor: { id: 'lead-1', kind: 'human', roles: [] }, capabilities: [...HUMAN_CAPS, 'knowledge:disclose_identity', 'knowledge:export'], compartments: ['witness'] };
    const noCompartment: ServiceContext = { ...discloser, compartments: [] };
    const wildcard: ServiceContext = { ...ctx, capabilities: ['knowledge:*', 'knowledge:export'] };
    const NAME = 'Marisol Etxeberria', ALIAS = 'Mari Etxe', ADDRESS = 'Lives at 14 Quay Lane';
    const claim0 = await engine.createClaim(discloser, { text: `${NAME} saw the trucks leave at dawn.`, claimType: 'observation', caseId: 'k' });
    const w = await engine.createEntity(discloser, { entityType: 'person', name: NAME, aliases: [ALIAS], description: ADDRESS, attributes: { phone: '555-0100' }, protectedIdentity: true, identityCompartment: 'witness', pseudonym: 'Witness A', identityRefs: ['E02:identity:id-1'], caseId: 'k' });
    assert.equal(w.name, NAME);
    const st = await engine.createStatement(discloser, { speakerEntityId: w.id, speakerLabel: NAME, text: `I, ${NAME}, counted six trucks.`, sourceRef: 'E02:testimony:t-1', venue: 'interview', caseId: 'k' });
    const claim = await engine.createClaim(discloser, { text: `According to ${ALIAS.toUpperCase()}, six trucks left the yard.`, claimType: 'attributed_statement', statementId: st.id, subjects: [{ kind: 'entity', id: w.id }], caseId: 'k' });
    await engine.addEvidenceLink(discloser, { target: { kind: 'claim', id: claim.id }, evidenceRef: fake.release(ev('interview')), selector: { kind: 'time', start: 30 }, stance: 'supports', note: `Recording of ${NAME}` });
    const event = await engine.createEvent(discloser, { title: `Trucks seen by ${NAME}`, time: { earliest: '2025-05-01T04:00:00Z', latest: '2025-05-01T06:00:00Z', precision: 'hour' }, participantEntityIds: [w.id], claimIds: [claim.id], caseId: 'k' });
    await engine.reviseEntity(discloser, w.id, { expectedRevision: 1, reason: 'add alias', aliases: [ALIAS, 'M. Etxeberria'] });
    const [prop] = await engine.proposeEntities({ ...ctx, actor: { id: 'bot', kind: 'agent', roles: [] } }, { origin: { kind: 'model' }, items: [{ entityType: 'person', name: 'Second Protected Name', protectedIdentity: true, identityCompartment: 'witness' }] });

    const leak = /Marisol|Etxeberria|Mari Etxe|Quay Lane|555-0100|Second Protected Name|id-1/i;
    const everything = async (c: ServiceContext): Promise<string> => JSON.stringify([
      await engine.getEntity(c, w.id), await engine.list(c, 'entity'), await engine.history(c, 'entity', w.id), await engine.get(c, 'statement', st.id), await engine.history(c, 'statement', st.id),
      await engine.getClaim(c, claim.id), await engine.getClaim(c, claim0.id), await engine.claimHistory(c, claim.id), await engine.list(c, 'claim'), await engine.list(c, 'event'), await engine.list(c, 'evidence_link'),
      await engine.list(c, 'proposal'), await engine.get(c, 'proposal', prop!.id), await engine.evidenceGraph(c, { caseId: 'k' }), await engine.evidenceGraph(c, { entityId: w.id }), await engine.evidenceGraph(c, { claimId: claim.id }),
      await engine.chronology(c, { caseId: 'k' }), await engine.researchGaps(c, { caseId: 'k' }), await engine.impactOf(c, ['E02:testimony:t-1']),
      await engine.inspect(c, `E07:entity:${w.id}`), await engine.inspect(c, `E07:claim:${claim.id}`), await engine.inspect(c, `E07:statement:${st.id}`), await engine.inspect(c, `E07:event:${event.id}`),
      await engine.searchRecords(c, { q: 'trucks' }), await engine.search(c, { q: 'Witness' }), await engine.audit(c, { limit: 1000 }),
      c.capabilities.includes('knowledge:export') ? await engine.exportDossier(c, { caseId: 'k' }) : null,
    ]);
    for (const [who, c] of [['no capability', ctx], ['wildcard does not grant disclosure', wildcard], ['capability without the identity compartment', noCompartment]] as const) {
      const out = await everything(c);
      assert.doesNotMatch(out, leak, who);
      assert.match(out, /Witness A/, who);
      const e = await engine.getEntity(c, w.id);
      assert.deepEqual([e.name, e.aliases, e.description, e.attributes, e.identityWithheld, e.identityRefs], ['Witness A', [], null, {}, true, []]);
      // Names cannot be probed through search hits or counts.
      for (const q of ['Marisol', 'Etxeberria', 'Quay', 'Mari Etxe']) { const r = await engine.searchRecords(c, { q }); assert.deepEqual([r.hits.length, r.total], [0, 0], `${who}: ${q}`); }
      const r = await engine.searchRecords(c, { q: 'Witness A' });
      assert.ok(r.total >= 3 && r.hits.every((h) => !leak.test(JSON.stringify(h))));
      await assert.rejects(engine.reviseEntity(c, w.id, { expectedRevision: 2, reason: 'peek', description: 'x' }), code('forbidden'));
    }
    const full = await everything(discloser);
    assert.match(full, /Marisol Etxeberria/); assert.match(full, /Quay Lane/);
    assert.equal((await engine.searchRecords(discloser, { q: 'Marisol' })).total >= 3, true);
    assert.ok((await engine.audit(discloser, { limit: 1000 })).some((a) => a.action === 'knowledge.identity_disclosed' && a.actorId === 'lead-1'), 'disclosure is audited');

    // Merging a protected record into an unprotected one protects the whole merged identity.
    const plain = await engine.createEntity(discloser, { entityType: 'person', name: 'Dockside Caller', caseId: 'k' });
    await engine.createClaim(discloser, { text: 'Dockside Caller phoned the hotline.', claimType: 'observation', caseId: 'k' });
    assert.equal((await engine.searchRecords(ctx, { q: 'Dockside' })).total, 2);
    const merge = await engine.mergeEntities(discloser, { survivorId: plain.id, mergedId: w.id, rationale: 'Same person' });
    assert.equal((await engine.getEntity(ctx, plain.id)).name, 'Witness A');
    assert.equal((await engine.searchRecords(ctx, { q: 'Dockside' })).total, 0);
    assert.doesNotMatch(JSON.stringify([await engine.list(ctx, 'claim'), await engine.evidenceGraph(ctx, { entityId: plain.id })]), /Dockside|Marisol/);
    await engine.unmergeEntities(discloser, merge.id, { reason: 'Not the same person' });
    assert.equal((await engine.getEntity(ctx, plain.id)).name, 'Dockside Caller');
    assert.equal((await engine.searchRecords(ctx, { q: 'Dockside' })).total, 2);

    // Compartments hide whole records, including from counts, lists, graph and search.
    const secret = await engine.createClaim(discloser, { text: 'Sealed annex mentions a turquoise ledger.', claimType: 'observation', compartment: 'witness', caseId: 'k' });
    await assert.rejects(engine.getClaim(ctx, secret.id), code('not_found'));
    assert.equal(await engine.inspect(ctx, `E07:claim:${secret.id}`), null);
    assert.equal((await engine.searchRecords(ctx, { q: 'turquoise' })).total, 0);
    assert.equal((await engine.searchRecords(discloser, { q: 'turquoise' })).total, 1);
    assert.ok(!(await engine.list(ctx, 'claim')).some((c) => c.id === secret.id));
    assert.ok(!JSON.stringify(await engine.evidenceGraph(ctx, { caseId: 'k' })).includes(secret.id));
    await assert.rejects(engine.exportDossier(ctx, { caseId: 'k' }), code('forbidden'));
  });
});

test('upstream corrections propagate transitively; assessments are flagged, not rewritten; withdrawal blocks', needsPg, async () => {
  await suite(async ({ engine, fake, sql }) => {
    const ctx = mkCtx({ projectId: 'impact' });
    const router: ServiceContext = { ...ctx, actor: { id: 'pam-router', kind: 'service', roles: [] }, capabilities: ['knowledge:upstream'] };
    const scan = fake.release(ev('scan', 2)), other = fake.release(ev('other'));
    const base = await engine.createClaim(ctx, { text: 'The permit was issued on 2 June.', claimType: 'observation', caseId: 'i' });
    const link = await engine.addEvidenceLink(ctx, { target: { kind: 'claim', id: base.id }, evidenceRef: scan, representationRef: 'E06:representation:ocr-1@1', selector: page(1), stance: 'supports', sourceType: 'official_record' });
    const derived = await engine.createClaim(ctx, { text: 'Work began before the permit was issued.', claimType: 'inference', derivedFrom: [base.id], caseId: 'i' });
    const second = await engine.createClaim(ctx, { text: 'The contractor knew work was unpermitted.', claimType: 'reconstruction_note', derivedFrom: [derived.id], caseId: 'i' });
    const unrelated = await engine.createClaim(ctx, { text: 'The site is by the canal.', claimType: 'observation', caseId: 'i' });
    const uLink = await engine.addEvidenceLink(ctx, { target: { kind: 'claim', id: unrelated.id }, evidenceRef: other, selector: page(1), stance: 'supports', sourceType: 'primary' });
    const event = await engine.createEvent(ctx, { title: 'Work begins', time: { earliest: '2025-05-20T00:00:00Z', latest: '2025-05-31T00:00:00Z', precision: 'day' }, claimIds: [second.id], caseId: 'i' });
    const org = await engine.createEntity(ctx, { entityType: 'organization', name: 'Canal Build' }), office = await engine.createEntity(ctx, { entityType: 'organization', name: 'Permit Office' });
    const rel = await engine.createRelationship(ctx, { relationshipType: 'applicant', fromEntityId: org.id, to: { kind: 'entity', id: office.id }, evidence: [{ evidenceRef: scan, selector: page(2), stance: 'supports' }] });
    const alt = await engine.addAlternativeExplanation(ctx, { claimId: derived.id, text: 'Work was preparatory and needed no permit.' });
    await engine.addEvidenceLink(ctx, { target: { kind: 'alternative', id: alt.id }, evidenceRef: scan, selector: page(3), stance: 'supports' });
    await assert.rejects(engine.reviseClaim(ctx, base.id, { expectedRevision: 1, reason: 'loop', derivedFrom: [second.id] }), code('invalid_input'));
    const a0 = await engine.recordAssessment(ctx, base.id, { dimension: 'factual', value: 'supported', rationale: 'Official record.', cites: { linkIds: [link.id] } });
    const a1 = await engine.recordAssessment(ctx, derived.id, { dimension: 'factual', value: 'supported', rationale: 'Follows from the permit date and the dated site photographs on file.', documentedRationale: true });
    assert.equal(a1.basis, 'documented_rationale');
    const ed = await engine.recordAssessment(ctx, base.id, { dimension: 'editorial', value: 'approved', rationale: 'Cleared.' });
    let chrono = await engine.chronology(ctx, { caseId: 'i' });
    assert.equal(chrono.entries[0]!.label, 'unknown'); assert.match(chrono.entries[0]!.uncertainty, /between 2025-05-20/);

    // Read-only impact analysis.
    const impact = await engine.impactOf(ctx, ['E05:evidence_version:scan']);
    const has = (list: string[], id: string): boolean => list.some((r) => r.includes(id));
    assert.ok(has(impact.claims, base.id) && has(impact.claims, derived.id) && has(impact.claims, second.id) && !has(impact.claims, unrelated.id));
    assert.ok(has(impact.events, event.id) && has(impact.relationships, rel.id) && has(impact.alternatives, alt.id) && impact.evidenceLinks.length === 3);
    assert.deepEqual(impact.assessments.map((a) => a.id).sort(), [a0.id, a1.id, ed.id].sort());
    assert.equal((await engine.impactOf(ctx, [ev('scan', 1)])).claims.length, 0, 'a different pinned version does not match');
    assert.equal((await engine.impactOf(ctx, ['E06:representation:ocr-1'])).claims.length, 3);
    assert.equal((await engine.getClaim(ctx, base.id)).status, 'active', 'impactOf changes nothing');
    await assert.rejects(engine.applyUpstreamChange(ctx, { eventId: 'x', kind: 'source_corrected', refs: [scan], reason: 'no capability' }), code('forbidden'));

    const change = { eventId: 'E05:evt-41', kind: 'source_corrected' as const, refs: [scan], reason: 'Scan replaced: page 1 was misdated' };
    const { affected } = await engine.applyUpstreamChange(router, change);
    assert.equal(affected.length, 9); // 3 links, 3 claims, 1 event, 1 relationship, 1 alternative
    assert.ok(!affected.some((r) => r.includes(unrelated.id)));
    assert.deepEqual((await engine.applyUpstreamChange(router, change)).affected, affected, 'idempotent by eventId');
    for (const id of [base.id, derived.id, second.id]) {
      const c = await engine.getClaim(ctx, id);
      assert.equal(c.status, 'needs_reverification'); assert.equal(c.flags.length, 1, 'replay adds no second flag'); assert.equal(c.flags[0]!.cause, 'E05:evt-41');
    }
    const b = await engine.getClaim(ctx, base.id);
    assert.equal(b.assessments.factual.id, a0.id); assert.equal(b.assessments.factual.value, 'supported', 'the assessment is retained, not rewritten');
    assert.equal(b.assessments.factual.needsReverification, true); assert.equal(b.assessments.editorial.needsReverification, true); assert.equal(b.assessments.editorial.value, 'approved');
    assert.equal(b.evidence.supporting[0].stale, true);
    assert.equal((await engine.getClaim(ctx, unrelated.id)).status, 'active');
    assert.equal((await engine.get(ctx, 'evidence_link', uLink.id)).stale, false);
    const insp = (await engine.inspect(ctx, `E07:claim:${derived.id}`))!;
    assert.equal(insp.stale, true); assert.match(insp.staleReasons[0]!, /Scan replaced/); assert.ok(insp.sources.includes(`E07:claim:${base.id}`) && insp.dependents.some((d) => d.includes(second.id)));
    chrono = await engine.chronology(ctx, { caseId: 'i' });
    assert.equal(chrono.entries[0]!.needsReverification, true); assert.equal(chrono.entries[0]!.label, 'unknown');
    const evs = await eventsOf(engine, ctx, (t) => t.filter((x) => x === 'knowledge.claim_stale').length >= 3);
    const stale = evs.filter((e) => e.type === 'knowledge.claim_stale');
    assert.equal(stale.length, 3); assert.ok(stale.every((e) => e.payload.cause === 'E05:evt-41' && e.payload.claims.length === 1 && e.subject.startsWith('E07:claim:') && e.engine === 'E07'));
    assert.ok(evs.some((e) => e.type === 'knowledge.evidence_link_stale') && evs.some((e) => e.type === 'knowledge.event_stale') && evs.some((e) => e.type === 'knowledge.claim_changed' && e.payload.change === 'assessment'));

    // Guarded recovery: cannot approve or clear while the cause remains; re-pointing the link and re-assessing clears it.
    await assert.rejects(engine.recordAssessment(ctx, base.id, { dimension: 'factual', value: 'supported', rationale: 'same', cites: { linkIds: [link.id] } }), code('invalid_state'));
    await assert.rejects(engine.recordAssessment(ctx, base.id, { dimension: 'editorial', value: 'approved', rationale: 'again' }), code('invalid_state'));
    await assert.rejects(engine.resolveFlag(ctx, { kind: 'claim', id: base.id }, { flag: 'stale', note: 'looks fine' }), code('invalid_state'));
    await assert.rejects(engine.resolveFlag({ ...ctx, capabilities: ['knowledge:*'] }, { kind: 'evidence_link', id: link.id }, { flag: 'stale', note: 'x' }), code('forbidden'));
    const fixed = await engine.reviseEvidenceLink(ctx, link.id, { expectedRevision: 1, reason: 'Corrected scan', evidenceRef: fake.release(ev('scan', 3)) });
    assert.equal(fixed.stale, false); assert.equal(fixed.evidenceRef, ev('scan', 3));
    const a2 = await engine.recordAssessment(ctx, base.id, { dimension: 'factual', value: 'supported', rationale: 'Corrected scan confirms 2 June.', cites: { linkIds: [link.id] } });
    const b2 = await engine.getClaim(ctx, base.id);
    assert.equal(b2.status, 'active'); assert.equal(b2.assessments.factual.id, a2.id); assert.equal(b2.assessments.factual.needsReverification, false);
    assert.equal(b2.assessments.editorial.id, ed.id, 'editorial approval stays flagged until re-decided'); assert.equal(b2.assessments.editorial.needsReverification, true);
    const fh = (await engine.assessments(ctx, base.id)).history.filter((a) => a.dimension === 'factual');
    assert.deepEqual(fh.map((a) => [a.id, a.value]), [[a0.id, 'supported'], [a2.id, 'supported']]);
    assert.equal((await engine.claimHistory(ctx, base.id)).timeline.filter((t: any) => ['flagged_needs_reverification', 'flag_cleared', 'link_revised'].includes(t.type)).length, 5); // upstream flag + cited-link-revised flag, both cleared by the new assessment
    await engine.resolveFlag(ctx, { kind: 'claim', id: derived.id }, { flag: 'stale', note: 'Inference still holds with corrected date' });
    assert.equal((await engine.getClaim(ctx, derived.id)).assessments.factual.needsReverification, false);
    // History tables are append-only at the database level.
    await assert.rejects(sql.query(`update ${SCHEMA}.revisions set reason='x'`), /append-only/);
    await assert.rejects(sql.query(`update ${SCHEMA}.assessments set value='refuted'`), /immutable/);
    await assert.rejects(sql.query(`delete from ${SCHEMA}.objects`), /append-only/);

    // Claim text revision: emits claim_changed and flags derived claims.
    await engine.reviseClaim(ctx, derived.id, { expectedRevision: 1, reason: 'Narrowed wording', text: 'Groundwork began before the permit was issued.' });
    const s2 = await engine.getClaim(ctx, second.id);
    assert.ok(s2.flags.some((f: any) => f.changeKind === 'claim_changed'));
    assert.equal((await engine.getClaim(ctx, derived.id)).assessments.factual.needsReverification, true);
    assert.equal((await engine.history(ctx, 'claim', derived.id)).revisions[0]!.body.text, 'Work began before the permit was issued.');
    assert.ok((await eventsOf(engine, ctx, (t) => t.includes('knowledge.claim_changed'))).some((e) => e.type === 'knowledge.claim_changed' && e.payload.change === 'revised' && e.subject === `E07:claim:${derived.id}`));

    // permission_withdrawn → statements and dependent claims blocked.
    const st = await engine.createStatement(ctx, { speakerLabel: 'Site foreman', text: 'We started on the 20th.', sourceRef: 'E02:testimony:t-9', identityRefs: ['E02:identity:p-9'], caseId: 'i' });
    assert.equal(st.use.decision, 'allow'); assert.deepEqual(st.use.permissionRefs, ['E11:permission:perm-1']);
    const said = await engine.createClaim(ctx, { text: 'The foreman says work started on the 20th.', claimType: 'attributed_statement', statementId: st.id, caseId: 'i' });
    const onSaid = await engine.createClaim(ctx, { text: 'Work started on the 20th.', claimType: 'inference', derivedFrom: [said.id], caseId: 'i' });
    await assert.rejects(engine.createClaim(ctx, { text: 'no statement', claimType: 'attributed_statement' }), code('invalid_input'));
    assert.deepEqual((await engine.usability(ctx, { claimIds: [said.id], action: 'publish' })).map((u) => u.decision), ['allow']);
    const w = await engine.applyUpstreamChange(router, { eventId: 'E11:evt-7', kind: 'permission_withdrawn', refs: ['E11:permission:perm-1'], reason: 'Witness withdrew permission' });
    assert.equal(w.affected.length, 3);
    for (const id of [said.id, onSaid.id]) { const c = await engine.getClaim(ctx, id); assert.equal(c.status, 'blocked'); assert.equal(c.blocked, true); }
    assert.equal((await engine.get(ctx, 'statement', st.id)).status, 'blocked');
    assert.deepEqual((await engine.usability(ctx, { claimIds: [said.id], action: 'publish' }))[0]!.decision, 'deny');
    await assert.rejects(engine.recordAssessment(ctx, said.id, { dimension: 'editorial', value: 'approved', rationale: 'x' }), code('invalid_state'));
    const blocked = (await eventsOf(engine, ctx, (t) => t.filter((x) => x === 'knowledge.claim_blocked').length >= 2)).filter((e) => e.type === 'knowledge.claim_blocked');
    assert.equal(blocked.length, 2); assert.ok(blocked.every((e) => e.payload.cause === 'E11:evt-7' && e.payload.reason === 'Witness withdrew permission'));
    assert.ok((await engine.researchGaps(ctx, { caseId: 'i' })).gaps.find((g) => g.claim.includes(said.id))!.gaps.some((g) => g.gap === 'blocked'));
    assert.deepEqual((await engine.applyUpstreamChange(router, { eventId: 'E10:evt-1', kind: 'render_changed', refs: [scan], reason: 'not ours' })).affected, []);
    // Consent denial refuses a new statement; correction opened by a researcher uses the same marking.
    fake.denied.add('E02:testimony:t-denied');
    await assert.rejects(engine.createStatement(ctx, { speakerLabel: 'X', text: 'y', sourceRef: 'E02:testimony:t-denied' }), code('consent_denied'));
    const corr = await engine.openCorrection(ctx, { refs: [other], reason: 'Photograph was mirrored', kind: 'content_changed' });
    assert.ok(corr.affected.some((r) => r.includes(unrelated.id)) && corr.impact.claims.length === 1);
  });
});

test('tenant and project isolation, fail-closed authorization, idempotency and revision conflicts', needsPg, async () => {
  await suite(async ({ engine, standalone, sql }) => {
    const ctx = mkCtx({ projectId: 'iso' });
    const ent = await engine.createEntity(ctx, { entityType: 'organization', name: 'Lantern Freight', caseId: 'z' });
    // Standalone (no ports): links are accepted but marked unvalidated and cannot ground "supported" without a documented rationale.
    const claim = await standalone.createClaim(ctx, { text: 'Lantern Freight moved the containers.', claimType: 'allegation', subjects: [{ kind: 'entity', id: ent.id }], caseId: 'z' }, );
    const link = await standalone.addEvidenceLink(ctx, { target: { kind: 'claim', id: claim.id }, evidenceRef: ev('manifest'), selector: page(1), stance: 'supports', sourceType: 'primary', idempotencyKey: 'link-1' });
    assert.equal(link.validation.state, 'unvalidated');
    assert.equal((await standalone.addEvidenceLink(ctx, { target: { kind: 'claim', id: claim.id }, evidenceRef: ev('manifest'), selector: page(1), stance: 'supports', sourceType: 'primary', idempotencyKey: 'link-1' })).id, link.id, 'replay returns the same link');
    await assert.rejects(standalone.addEvidenceLink(ctx, { target: { kind: 'claim', id: claim.id }, evidenceRef: ev('manifest'), selector: page(2), stance: 'supports', idempotencyKey: 'link-1' }), code('idempotency_conflict'));
    assert.equal((await standalone.list(ctx, 'evidence_link')).length, 1);
    await assert.rejects(standalone.recordAssessment(ctx, claim.id, { dimension: 'factual', value: 'supported', rationale: 'Manifest.', cites: { linkIds: [link.id] } }), code('invalid_state'));
    const st = await standalone.createStatement(ctx, { speakerLabel: 'Dock clerk', text: 'They left at noon.', sourceRef: 'E03:message:m-4', caseId: 'z' });
    assert.equal(st.use.decision, 'unchecked');
    assert.equal((await standalone.usability(ctx, { claimIds: [claim.id], action: 'cite' }))[0]!.decision, 'allow');
    const a = await standalone.recordAssessment(ctx, claim.id, { dimension: 'factual', value: 'contested', rationale: 'Only one manifest.', cites: { linkIds: [link.id] }, idempotencyKey: 'a-1' });
    assert.equal((await standalone.recordAssessment(ctx, claim.id, { dimension: 'factual', value: 'contested', rationale: 'Only one manifest.', cites: { linkIds: [link.id] }, idempotencyKey: 'a-1' })).id, a.id);
    assert.equal((await standalone.assessments(ctx, claim.id)).history.length, 1);
    await assert.rejects(engine.reviseClaim(ctx, claim.id, { expectedRevision: 7, reason: 'stale editor', text: 'x' }), code('revision_conflict'));
    await assert.rejects(engine.reviseClaim(ctx, claim.id, { reason: 'no revision', text: 'x' } as never), code('invalid_input'));
    await engine.createEvent(ctx, { title: 'Containers moved', time: { earliest: null, latest: null, precision: 'unknown' }, claimIds: [claim.id], caseId: 'z' });
    await engine.createSourceFamily(ctx, { label: 'Manifest copies', members: [ev('manifest')] });
    await engine.applyUpstreamChange({ ...ctx, capabilities: ['knowledge:upstream'] }, { eventId: 'shared-id', kind: 'source_corrected', refs: [ev('manifest')], reason: 'r' });

    const flagsBefore = (await engine.getClaim(ctx, claim.id)).flags.length;
    for (const foreign of [mkCtx({ tenantId: 't2', projectId: 'iso' }), mkCtx({ tenantId: 't1', projectId: 'other' })]) {
      const f = { ...foreign, capabilities: [...HUMAN_CAPS, 'knowledge:disclose_identity', 'knowledge:export', 'knowledge:upstream', 'knowledge:events'], compartments: ['witness'] };
      for (const kind of ['entity', 'claim', 'evidence_link', 'statement', 'event', 'source_family', 'proposal', 'contradiction', 'alternative', 'relationship', 'entity_match', 'entity_merge'] as const) assert.deepEqual(await engine.list(f, kind), [], kind);
      for (const [n, p] of [() => engine.getClaim(f, claim.id), () => engine.getEntity(f, ent.id), () => engine.claimHistory(f, claim.id), () => engine.history(f, 'claim', claim.id), () => engine.independence(f, claim.id), () => engine.assessments(f, claim.id), () => engine.evidenceGraph(f, { claimId: claim.id }), () => engine.evidenceGraph(f, { entityId: ent.id }),
        () => engine.get(f, 'evidence_link', link.id), () => engine.reviseClaim(f, claim.id, { expectedRevision: 1, reason: 'x', text: 'y' }), () => engine.recordAssessment(f, claim.id, { dimension: 'editorial', value: 'approved', rationale: 'x' }), () => engine.proposeAssessment(f, claim.id, { dimension: 'factual', value: 'refuted', rationale: 'x' }),
        () => engine.addEvidenceLink(f, { target: { kind: 'claim', id: claim.id }, evidenceRef: ev('m'), selector: page(1), stance: 'challenges' }), () => engine.retractEvidenceLink(f, link.id, { expectedRevision: 1, reason: 'x' }), () => engine.exportDossier(f, { claimId: claim.id }), () => engine.usability(f, { claimIds: [claim.id], action: 'cite' }),
        () => engine.createClaim(f, { text: 'x', claimType: 'inference', derivedFrom: [claim.id] }), () => engine.recordContradiction(f, { members: [{ kind: 'claim', id: claim.id }, { kind: 'evidence_link', id: link.id }], description: 'x' }), () => engine.resolveFlag(f, { kind: 'claim', id: claim.id }, { flag: 'stale', note: 'x' })].entries()) await assert.rejects(p(), code('not_found'), `foreign call ${n}`);
      assert.equal(await engine.inspect(f, `E07:claim:${claim.id}`), null);
      assert.deepEqual([(await engine.searchRecords(f, { q: 'Lantern' })).total, (await engine.search(f, { q: 'containers' })).length], [0, 0]);
      assert.deepEqual((await engine.evidenceGraph(f, { caseId: 'z' })).nodes, []);
      assert.deepEqual([(await engine.researchGaps(f)).gaps, (await engine.chronology(f)).entries, (await engine.exportDossier(f, { caseId: 'z' })).claims], [[], [], []]);
      assert.deepEqual((await engine.impactOf(f, [ev('manifest')])).paths, []);
      // The same eventId and source in another scope marks nothing here and is tracked separately.
      assert.deepEqual((await engine.applyUpstreamChange(f, { eventId: 'shared-id', kind: 'source_removed', refs: [ev('manifest')], reason: 'r' })).affected, []);
      assert.ok((await engine.audit(f, { limit: 1000 })).every((r) => r.tenantId === f.tenantId && r.projectId === f.projectId && !JSON.stringify(r).includes(claim.id)));
      if (f.tenantId !== 't1') assert.ok((await engine.events(f, { limit: 1000 })).every((e) => e.tenantId === 't2'));
      // The same family member may be grouped independently in another scope.
      await engine.createSourceFamily(f, { label: 'Their own family', members: [ev('manifest')] });
    }
    assert.equal((await engine.getClaim(ctx, claim.id)).flags.length, flagsBefore, 'foreign changes did not touch this project');
    const rows = await sql.query<{ n: string }>(`select count(*)::text as n from ${SCHEMA}.objects where tenant_id is null or project_id is null`);
    assert.equal(rows[0]!.n, '0');

    // Fail closed: every method denies an empty capability set, a malformed context and read-only callers that write.
    const none = { ...ctx, capabilities: [] };
    const calls: ((c: ServiceContext) => Promise<unknown>)[] = [
      (c) => engine.getClaim(c, claim.id), (c) => engine.getEntity(c, ent.id), (c) => engine.list(c, 'claim'), (c) => engine.get(c, 'evidence_link', link.id), (c) => engine.history(c, 'claim', claim.id), (c) => engine.claimHistory(c, claim.id),
      (c) => engine.evidenceGraph(c, { claimId: claim.id }), (c) => engine.researchGaps(c), (c) => engine.chronology(c), (c) => engine.impactOf(c, [ev('manifest')]), (c) => engine.searchRecords(c, { q: 'x' }), (c) => engine.search(c, { q: 'x' }),
      (c) => engine.inspect(c, `E07:claim:${claim.id}`), (c) => engine.audit(c), (c) => engine.events(c), (c) => engine.applyUpstreamChange(c, { eventId: 'e', kind: 'source_removed', refs: [], reason: 'r' }), (c) => engine.exportDossier(c, { claimId: claim.id }),
      (c) => engine.independence(c, claim.id), (c) => engine.assessments(c, claim.id), (c) => engine.usability(c, { claimIds: [claim.id], action: 'cite' }), (c) => engine.createClaim(c, { text: 'x', claimType: 'observation' }), (c) => engine.createEntity(c, { entityType: 'person', name: 'A B' }),
      (c) => engine.addEvidenceLink(c, { target: { kind: 'claim', id: claim.id }, evidenceRef: ev('m'), selector: page(1), stance: 'supports' }), (c) => engine.createStatement(c, { speakerLabel: 'x', text: 'y', sourceRef: 'E03:message:m' }), (c) => engine.createEvent(c, { title: 'x', time: { earliest: null, latest: null, precision: 'unknown' } }),
      (c) => engine.createSourceFamily(c, { label: 'x', members: [ev('q')] }), (c) => engine.recordContradiction(c, { members: [{ kind: 'claim', id: claim.id }, { kind: 'evidence_link', id: link.id }], description: 'x' }), (c) => engine.addAlternativeExplanation(c, { claimId: claim.id, text: 'x' }),
      (c) => engine.proposeClaims(c, { origin: { kind: 'model' }, items: [{ text: 'x', claimType: 'observation' }] }), (c) => engine.proposeAssessment(c, claim.id, { dimension: 'factual', value: 'refuted', rationale: 'x' }), (c) => engine.recordAssessment(c, claim.id, { dimension: 'source_type', value: 'primary', rationale: 'x' }),
      (c) => engine.mergeEntities(c, { survivorId: ent.id, mergedId: ent.id, rationale: 'x' }), (c) => engine.openCorrection(c, { refs: [ev('manifest')], reason: 'x' }), (c) => engine.resolveFlag(c, { kind: 'claim', id: claim.id }, { flag: 'stale', note: 'x' }), (c) => engine.recordEntityMatch(c, { leftId: ent.id, rightId: ent.id, decision: 'same', rationale: 'x' }),
    ];
    for (const [n, call] of calls.entries()) {
      await assert.rejects(call(none), code('forbidden'), `call ${n} with no capabilities`);
      await assert.rejects(call(undefined as never), code('unauthenticated'), `call ${n} without context`);
      await assert.rejects(call({ ...ctx, tenantId: '' }), code('unauthenticated'), `call ${n} without tenant`);
    }
    const reader = { ...ctx, capabilities: ['knowledge:read'] };
    for (const [n, call] of calls.slice(20).entries()) await assert.rejects(call(reader), code('forbidden'), `write call ${n} with read only`);
    await assert.rejects(engine.audit(reader), code('forbidden')); await assert.rejects(engine.events({ ...ctx, capabilities: ['knowledge:*'] }), code('forbidden'));
    assert.deepEqual(await engine.health(), { ok: true, detail: { schema: SCHEMA, migrations: 1, evidencePort: true, useDecisionPort: true, authorizationPort: false } });

    // AuthorizationPort re-check before sensitive decisions: a denial (or failure) of the port denies.
    const guarded = createEngine({ sql, ports: { authorization: { authorize: async (_c, r) => { if (r.capability === 'knowledge:merge') throw new Error('down'); return { allowed: false, reason: 'revoked', policyVersion: '2' }; } } } });
    await assert.rejects(guarded.recordAssessment(ctx, claim.id, { dimension: 'editorial', value: 'rejected', rationale: 'x' }), code('forbidden'));
    await assert.rejects(guarded.mergeEntities(ctx, { survivorId: ent.id, mergedId: ent.id, rationale: 'x' }), code('forbidden'));
    assert.equal((await engine.assessments(ctx, claim.id)).current.editorial.recorded, false);
  });
});
