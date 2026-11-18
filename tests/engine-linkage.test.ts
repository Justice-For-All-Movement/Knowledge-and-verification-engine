// Record linkage across sources on real PostgreSQL. All names, places and dates are fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { DomainError } from '../src/contracts.ts';
import { withDisposableDatabase } from '../src/service-kit.ts';
import type { EvidenceVersionInfo, ServiceContext } from '../src/service-kit.ts';
import { createEngine, migrate } from '../src/engine/index.ts';
import { nameKey, nameVariants, bestNameSimilarity } from '../src/engine/names.ts';
import { toGregorian, monthNames } from '../src/engine/calendar.ts';

const ADMIN = process.env.TEST_DATABASE_URL ?? '';
const needsPg = ADMIN === '' ? { skip: 'TEST_DATABASE_URL is not set; real-PostgreSQL test not executed' } : {};
const CAPS = ['knowledge:read', 'knowledge:write', 'knowledge:propose', 'knowledge:review', 'knowledge:assess', 'knowledge:approve', 'knowledge:merge', 'knowledge:audit'];
let seq = 0;
const mkCtx = (over: Partial<ServiceContext> = {}): ServiceContext => ({ tenantId: 't1', projectId: 'p1', purpose: 'research', requestId: `l${++seq}`, now: new Date(Date.UTC(2026, 2, 1, 0, 0, seq)).toISOString(), actor: { id: 'researcher-1', kind: 'human', roles: ['researcher'] }, capabilities: CAPS, compartments: [], ...over });
const agent = (over: Partial<ServiceContext> = {}): ServiceContext => mkCtx({ actor: { id: 'agent-1', kind: 'agent', roles: [] }, capabilities: ['knowledge:read', 'knowledge:propose'], ...over });
const code = (c: string) => (e: unknown): boolean => e instanceof DomainError && e.code === c;
const sim = (a: string, b: string): number => bestNameSimilarity(nameVariants(a).map((n) => nameKey(n)), nameVariants(b).map((n) => nameKey(n))).similarity;

test('names compare across romanizations, hyphenation, parenthesised alternatives and Arabic script', () => {
  assert.equal(sim('Dariush Feyzabadi', 'Darioush Feizabadi'), 1);
  assert.equal(sim('Taro Ahmadpourani', 'Taro Ahmad Pourani'), 1);
  assert.equal(sim('Kaveh Khosh-Sokhan', 'Kaveh Khoshsokhan'), 1);
  assert.equal(sim('Nima (Arash) Qolami', 'Arash Gholami'), 1, 'a parenthesised name is an alternative given name');
  assert.equal(sim('سامان فتاحی', 'Saman Fatahi'), 1, 'Arabic-script and Latin forms share one skeleton');
  assert.equal(sim('علي كريمي', 'علی کریمی'), 1, 'Arabic and Persian letter variants fold together');
  assert.ok(sim('Mehrdad Validoust', 'Mehrdad Qorbandoust') < 0.85, 'a shared given name alone does not make a candidate');
  assert.ok(sim('Lale Nouri', 'Pari Sadeghzadeh') < 0.6);
});

test('calendar conversion is deterministic, rejects impossible dates and reports weekday disagreement', () => {
  assert.deepEqual(monthNames('persian', 'en').slice(9, 11), ['Dey', 'Bahman']);
  assert.equal(toGregorian({ calendar: 'persian', year: 1404, month: 'Dey', day: 18 }).gregorian, '2026-01-08');
  assert.equal(toGregorian({ calendar: 'persian', year: 1404, month: 'دی', day: 18, locales: ['fa'] }).gregorian, '2026-01-08');
  assert.equal(toGregorian({ calendar: 'persian', year: 1399, month: 1, day: 1 }).gregorian, '2020-03-20');
  assert.equal(toGregorian({ calendar: 'islamic-civil', year: 1445, month: 9, day: 1 }).gregorian, '2024-03-11');
  const wrong = toGregorian({ calendar: 'gregory', year: 2026, month: 1, day: 7, weekday: 'Thursday' });
  assert.equal(wrong.weekday, 'wednesday'); assert.equal(wrong.weekdayMatches, false);
  assert.equal(toGregorian({ calendar: 'gregory', year: 2026, month: 1, day: 8, weekday: 'thursday' }).weekdayMatches, true);
  assert.throws(() => toGregorian({ calendar: 'persian', year: 1404, month: 7, day: 31 }), (e) => e instanceof DomainError && e.code === 'invalid_date');
  assert.throws(() => toGregorian({ calendar: 'persian', year: 1404, month: 'Nowhere', day: 1 }), (e) => e instanceof DomainError && e.code === 'invalid_input');
  assert.throws(() => toGregorian({ calendar: 'chinese', year: 1, month: 1, day: 1 }), (e) => e instanceof DomainError && e.code === 'invalid_input');
});

test('record proposals, bulk review, candidate matches, roster conflicts and incidents', needsPg, async () => {
  await withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
    await migrate(sql);
    const versions = new Map<string, EvidenceVersionInfo>();
    const release = (ref: string): string => { versions.set(ref, { ref, evidenceId: ref, revision: 1, sha256: 'b'.repeat(64), size: 10, mediaType: 'text/plain', filename: 'list.txt', compartment: null, available: true }); return ref; };
    const engine = createEngine({ sql, ports: { evidence: { describe: async (_c, ref) => versions.get(ref) ?? null } } });
    const ctx = mkCtx();
    const listA = release('E05:evidence_version:list-a@1'), listB = release('E05:evidence_version:list-b@1'), listC = release('E05:evidence_version:list-c@1');
    const quoteA = 'Dariush Feyzabadi, 24, killed on 12 Arin in Harbourtown';
    const quoteB = 'Darioush Feizabadi (25) was shot in Harbor Town on 12 Arin';
    const rec = (name: string, attributes: Record<string, string | number>, ref: string, quote: string) => ({
      entity: { entityType: 'person', name, attributes },
      claims: [{ text: `${name} was killed (as stated by the source).`, claimType: 'allegation' as const, evidence: [{ evidenceRef: ref, selector: { kind: 'text' as const, quote }, stance: 'supports' as const, sourceType: 'secondary', excerpt: { start: 0, end: quote.indexOf(',') > 0 ? quote.indexOf(',') : 5, quote: quote.slice(0, quote.indexOf(',') > 0 ? quote.indexOf(',') : 5) } }] }],
    });
    const qC = 'Mina Sadeghzadeh, 31, Harbourtown';
    const proposals = [
      ...(await engine.proposeRecords(agent(), { origin: { kind: 'extraction', ref: listA }, caseId: 'roster-1', items: [rec('Dariush Feyzabadi', { age: 24, placeOfDeath: 'Harbourtown', dateOfDeath: '2031-04-02' }, listA, quoteA)] })),
      ...(await engine.proposeRecords(agent(), { origin: { kind: 'extraction', ref: listB }, caseId: 'roster-1', items: [rec('Darioush Feizabadi', { age: 25, placeOfDeath: 'Harbourtown', dateOfDeath: '2031-04-02' }, listB, 'Darioush Feizabadi (25) was shot')] })),
      ...(await engine.proposeRecords(agent(), { origin: { kind: 'extraction', ref: listC }, caseId: 'roster-1', items: [rec('Mina Sadeghzadeh', { age: 31, placeOfDeath: 'harbourtown', dateOfDeath: '2031-04-02' }, listC, qC)] })),
    ];
    assert.equal(proposals.length, 3);
    assert.equal(proposals[0]?.state, 'pending');

    // An excerpt that is not an exact span of the quotation is refused before anything is stored.
    await assert.rejects(engine.proposeRecords(agent(), { origin: { kind: 'model' }, items: [{ entity: { entityType: 'person', name: 'X Y' }, claims: [{ text: 'x', claimType: 'allegation', evidence: [{ evidenceRef: listA, selector: { kind: 'text', quote: 'abc' }, stance: 'supports', excerpt: { start: 0, end: 2, quote: 'zz' } }] }] }] }), code('invalid_proposal'));
    // A proposal cannot smuggle an assessment or a score.
    await assert.rejects(engine.proposeRecords(agent(), { origin: { kind: 'model' }, items: [{ entity: { entityType: 'person', name: 'X Y' }, claims: [], score: 1 } as any] }), code('invalid_input'));
    // Agents cannot review, in bulk or singly.
    await assert.rejects(engine.reviewProposals(agent({ capabilities: ['knowledge:review'] }), { ids: proposals.map((p) => p.id), decision: 'accept', reason: 'x' }), code('forbidden'));

    const reviewed = await engine.reviewProposals(ctx, { ids: [...proposals.map((p) => p.id), 'no-such-proposal'], decision: 'accept', reason: 'Rows checked against the source lists' });
    assert.equal(reviewed.reviewed, 3); assert.equal(reviewed.failed, 1);
    const entities = (await engine.list(ctx, 'entity', { caseId: 'roster-1' }));
    assert.equal(entities.length, 3);
    const byName = new Map(entities.map((e) => [e.name, e]));
    const darius = byName.get('Dariush Feyzabadi')!, darioush = byName.get('Darioush Feizabadi')!, mina = byName.get('Mina Sadeghzadeh')!;
    const claims = await engine.list(ctx, 'claim', { caseId: 'roster-1' });
    assert.ok(claims.every((c) => c.subjects.some((s: any) => s.kind === 'entity')), 'each accepted claim names its new entity as a subject');
    assert.ok(claims.every((c) => c.assessments === undefined || c.assessments.factual.value === 'unassessed'));

    // Candidates: the two spellings are suggested; the different person is not; nothing is recorded by suggesting.
    const sug = await engine.suggestEntityMatches(agent(), { caseId: 'roster-1' });
    assert.equal(sug.total, 1);
    const cand = sug.candidates[0];
    assert.deepEqual(new Set([cand.left.id, cand.right.id]), new Set([darius.id, darioush.id]));
    assert.equal(cand.similarity.label, 'similarity');
    assert.deepEqual(cand.attributes.differ.map((d: any) => d.key), ['age']);
    assert.deepEqual(cand.attributes.agree.sort(), ['dateOfDeath', 'placeOfDeath']);
    assert.equal((await engine.list(ctx, 'entity_match', {})).length, 0, 'suggesting records nothing');

    // Only a human records identity decisions; the batch is one transaction.
    await assert.rejects(engine.recordEntityMatches(agent({ capabilities: ['knowledge:write'] }), { decisions: [{ leftId: darius.id, rightId: darioush.id, decision: 'same', rationale: 'x' }] }), code('forbidden'));
    await assert.rejects(engine.recordEntityMatches(ctx, { decisions: [{ leftId: darius.id, rightId: darioush.id, decision: 'same', rationale: 'ok' }, { leftId: darius.id, rightId: 'missing', decision: 'different', rationale: 'bad' }] }), code('not_found'));
    assert.equal((await engine.list(ctx, 'entity_match', {})).length, 0, 'a failed batch records nothing');
    await engine.recordEntityMatches(ctx, { decisions: [{ leftId: darius.id, rightId: darioush.id, decision: 'same', rationale: 'Same age band, place and date; spelling variants', similarity: cand.similarity.value }] });
    assert.equal((await engine.suggestEntityMatches(ctx, { caseId: 'roster-1' })).total, 0, 'decided pairs are not suggested again');

    // Roster: one group with both records, the age disagreement listed with every value, nothing chosen.
    const r = await engine.roster(ctx, { caseId: 'roster-1', expect: ['age', 'dateOfDeath', 'placeOfDeath', 'hometown'] });
    assert.equal(r.counts.groups, 2); assert.equal(r.counts.records, 3); assert.equal(r.counts.withConflicts, 1);
    const g = r.groups.find((x: any) => x.members.length === 2);
    assert.deepEqual(g.conflicts, ['age']);
    assert.deepEqual(g.attributes.age.map((v: any) => v.value).sort(), [24, 25]);
    assert.deepEqual(g.missing, ['hometown']);
    assert.ok(g.members.every((m: any) => m.claims.length === 1 && m.claims[0].evidenceRefs.length === 1), 'each record keeps its own claim and source');
    assert.deepEqual(new Set(g.names), new Set(['Dariush Feyzabadi', 'Darioush Feizabadi']));
    assert.equal((await engine.roster(ctx, { caseId: 'roster-1', only: 'conflicts' })).total, 1);

    // Incidents: equal place (case-folded) and day; the merged person appears once.
    const inc = await engine.incidents(ctx, { caseId: 'roster-1', placeAttribute: 'placeOfDeath', dateAttribute: 'dateOfDeath' });
    assert.equal(inc.total, 1);
    assert.equal(inc.incidents[0].size, 2);
    assert.ok(inc.incidents[0].people.some((p: any) => p.name === 'Mina Sadeghzadeh'));
    assert.ok(inc.incidents[0].people.some((p: any) => p.records === 2), 'the two records of one person count once');

    // A 'different' decision keeps two groups and is counted, not hidden.
    const extra = await engine.createEntity(ctx, { entityType: 'person', name: 'Mina Sadegh-Zadeh', attributes: { age: 52 }, caseId: 'roster-1' });
    await engine.recordEntityMatch(ctx, { leftId: mina.id, rightId: extra.id, decision: 'different', rationale: 'Ages 31 and 52; different hometowns' });
    const r2 = await engine.roster(ctx, { caseId: 'roster-1' });
    assert.equal(r2.counts.groups, 3);
    assert.ok(r2.groups.some((x: any) => x.differentDecisions === 1));

    // Withheld identities contribute nothing to suggestions or the roster for a caller without disclosure.
    await engine.createEntity(ctx, { entityType: 'person', name: 'Dariush Feyzabady', protectedIdentity: true, identityCompartment: 'family', caseId: 'roster-1' });
    const plain = mkCtx({ capabilities: ['knowledge:read'] });
    const s2 = await engine.suggestEntityMatches(plain, { caseId: 'roster-1', includeDecided: true });
    assert.ok(!JSON.stringify(s2).includes('Feyzabady'));
    assert.ok(!JSON.stringify(await engine.roster(plain, { caseId: 'roster-1' })).includes('Feyzabady'));

    // Date conversion through the service requires read access.
    assert.equal(engine.convertDate(plain, { calendar: 'persian', year: 1404, month: 'Dey', day: 18 }).gregorian, '2026-01-08');
    assert.throws(() => engine.convertDate(mkCtx({ capabilities: [] }), { calendar: 'persian', year: 1404, month: 10, day: 18 }), code('forbidden'));

    // Tenancy: another project sees none of it.
    assert.equal((await engine.roster(mkCtx({ projectId: 'other' }), { caseId: 'roster-1' })).counts.groups, 0);
  });
});

test('linkage over HTTP: record proposals, bulk review, suggestions, batches, roster, incidents, dates', needsPg, async () => {
  const { generateSigningKey, signAccessToken } = await import('../src/service-kit.ts');
  const { start } = await import('../src/engine/serve.ts');
  await withDisposableDatabase(pg, ADMIN, async (url) => {
    const key = generateSigningKey('k1');
    const running = await start({ DATABASE_URL: url, PORT: '0', HOST: '127.0.0.1', IDENTITY_PUBLIC_KEYS: JSON.stringify({ k1: key.publicKeyPem }), IDENTITY_ISSUER: 'iap', KNOWLEDGE_NAME_EQUIVALENCES: '[["kh","x"],["gh","q"],["sh","S"],["w","v"]]' });
    try {
      const base = `http://127.0.0.1:${running.port}`;
      const now = Math.floor(Date.now() / 1000);
      const token = (over: Record<string, unknown> = {}): string => signAccessToken({ iss: 'iap', sub: 'researcher-1', kind: 'human', tid: 't1', pid: 'p1', roles: [], caps: CAPS, cmp: [], purpose: 'research', pv: '1', iat: now, exp: now + 600, jti: 'j', ...over } as any, key);
      const call = async (method: string, path: string, body?: unknown, t = token(), headers: Record<string, string> = {}): Promise<{ status: number; json: any }> => {
        const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* none */ }
        return { status: r.status, json };
      };
      const agentToken = token({ sub: 'agent-2', kind: 'agent', caps: ['knowledge:read', 'knowledge:propose'] });
      const item = (name: string, attributes: Record<string, unknown>) => ({ entity: { entityType: 'person', name, attributes }, claims: [{ text: `${name} was killed (source statement).`, claimType: 'allegation', evidence: [{ evidenceRef: 'E05:evidence_version:bulletin@1', selector: { kind: 'text', quote: `${name} was killed` }, stance: 'supports' }] }] });
      const made = await call('POST', '/v1/proposals/records', { origin: { kind: 'extraction' }, caseId: 'c1', items: [item('Shirin Khodadadi', { dateOfDeath: '2031-04-02', placeOfDeath: 'Elmtown' }), item('Shirin Xodadadi', { dateOfDeath: '2031-04-03', placeOfDeath: 'Elmtown' })] }, agentToken);
      assert.equal(made.status, 201); assert.equal(made.json.length, 2);
      assert.equal((await call('POST', '/v1/proposal-reviews', { ids: made.json.map((p: any) => p.id), decision: 'accept', reason: 'checked' }, agentToken)).status, 403);
      const rev = await call('POST', '/v1/proposal-reviews', { ids: made.json.map((p: any) => p.id), decision: 'accept', reason: 'checked' }, token(), { 'idempotency-key': 'ignored-for-reads' });
      assert.equal(rev.status, 200); assert.equal(rev.json.reviewed, 2);
      const sug = await call('POST', '/v1/entity-match-suggestions', { caseId: 'c1' }, agentToken);
      assert.equal(sug.status, 200); assert.equal(sug.json.total, 1);
      assert.deepEqual(sug.json.candidates[0].attributes.differ.map((d: any) => d.key), ['dateOfDeath']);
      const c = sug.json.candidates[0];
      assert.equal((await call('POST', '/v1/entity-match-batches', { decisions: [{ leftId: c.left.id, rightId: c.right.id, decision: 'same', rationale: 'spelling variants' }] }, agentToken)).status, 403);
      assert.equal((await call('POST', '/v1/entity-match-batches', { decisions: [{ leftId: c.left.id, rightId: c.right.id, decision: 'same', rationale: 'spelling variants' }] })).status, 200);
      const roster = await call('POST', '/v1/roster', { caseId: 'c1', only: 'conflicts' });
      assert.equal(roster.json.total, 1); assert.deepEqual(roster.json.groups[0].conflicts, ['dateOfDeath']);
      const inc = await call('POST', '/v1/incidents', { caseId: 'c1', placeAttribute: 'placeOfDeath', dateAttribute: 'dateOfDeath', minSize: 1 });
      assert.equal(inc.json.total, 2, 'a person with two stated dates appears under each date');
      assert.ok(inc.json.incidents.every((x: any) => x.people[0].conflicting === true));
      const d = await call('POST', '/v1/dates/convert', { calendar: 'persian', year: 1404, month: 'Dey', day: 18, weekday: 'friday' });
      assert.equal(d.json.gregorian, '2026-01-08'); assert.equal(d.json.weekdayMatches, false);
      assert.equal((await call('POST', '/v1/dates/convert', { calendar: 'persian', year: 1404, month: 7, day: 31 })).status, 400);
    } finally { await running.close(); }
  });
});
