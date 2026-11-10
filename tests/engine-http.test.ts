// HTTP end-to-end on real PostgreSQL through the standalone server (`start`), with tokens signed by a test key.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { generateSigningKey, signAccessToken, withDisposableDatabase } from '../src/service-kit.ts';
import type { TokenClaims } from '../src/service-kit.ts';
import { start } from '../src/engine/serve.ts';

const ADMIN = process.env.TEST_DATABASE_URL ?? '';
const needsPg = ADMIN === '' ? { skip: 'TEST_DATABASE_URL is not set; real-PostgreSQL test not executed' } : {};
const CAPS = ['knowledge:read', 'knowledge:write', 'knowledge:propose', 'knowledge:review', 'knowledge:assess', 'knowledge:approve', 'knowledge:merge', 'knowledge:audit'];

test('HTTP end to end: claims, evidence, assessments, proposals, graph, corrections, isolation', needsPg, async () => {
  await withDisposableDatabase(pg, ADMIN, async (url) => {
    const key = generateSigningKey('k1');
    const running = await start({ DATABASE_URL: url, PORT: '0', HOST: '127.0.0.1', IDENTITY_PUBLIC_KEYS: JSON.stringify({ k1: key.publicKeyPem }), IDENTITY_ISSUER: 'iap', KNOWLEDGE_PROCEDURAL_VOCABULARY: 'not_recorded,alleged,adjudicated' });
    try {
      const base = `http://127.0.0.1:${running.port}`;
      const now = Math.floor(Date.now() / 1000);
      const token = (over: Partial<TokenClaims> = {}): string => signAccessToken({ iss: 'iap', sub: 'researcher-1', kind: 'human', tid: 't1', pid: 'p1', roles: [], caps: CAPS, cmp: [], purpose: 'research', pv: '1', iat: now, exp: now + 600, jti: 'j', ...over }, key);
      const call = async (method: string, path: string, body?: unknown, t: string | null = token(), headers: Record<string, string> = {}): Promise<{ status: number; json: any; text: string }> => {
        const r = await fetch(base + path, { method, headers: { ...(t === null ? {} : { authorization: `Bearer ${t}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* text response */ }
        return { status: r.status, json, text };
      };
      assert.equal((await call('GET', '/healthz', undefined, null)).json.ok, true);
      assert.equal((await call('GET', '/v1/manifest', undefined, null)).json.id, 'E07');
      assert.equal((await call('GET', '/v1/records/claim', undefined, null)).status, 401);
      assert.equal((await call('GET', '/v1/records/claim', undefined, token({ exp: now - 10 }))).status, 401);
      assert.equal((await call('POST', '/v1/claims', { text: 'x', claimType: 'observation' }, token({ caps: ['knowledge:read'] }))).status, 403);

      const ent = await call('POST', '/v1/entities', { entityType: 'person', name: 'Renata Okoro', protectedIdentity: true, pseudonym: 'Source R' });
      assert.equal(ent.status, 201); assert.equal(ent.json.name, 'Source R', 'no disclosure capability in the token');
      const made = await call('POST', '/v1/claims', { text: 'Renata Okoro says the valve report was altered.', claimType: 'allegation', subjects: [{ kind: 'entity', id: ent.json.id }], caseId: 'case-9' }, token(), { 'idempotency-key': 'claim-1' });
      assert.equal(made.status, 201); assert.doesNotMatch(made.text, /Renata|Okoro/); assert.match(made.json.text, /^Source R says/);
      const replay = await call('POST', '/v1/claims', { text: 'Renata Okoro says the valve report was altered.', claimType: 'allegation', subjects: [{ kind: 'entity', id: ent.json.id }], caseId: 'case-9' }, token(), { 'idempotency-key': 'claim-1' });
      assert.equal(replay.json.id, made.json.id);
      assert.equal((await call('POST', '/v1/claims', { text: 'different', claimType: 'allegation' }, token(), { 'idempotency-key': 'claim-1' })).status, 409);
      const id = made.json.id as string;
      assert.equal((await call('POST', '/v1/claims', { text: 'x', claimType: 'verdict' })).status, 400);
      assert.equal((await call('POST', '/v1/claims', { text: 'x', claimType: 'allegation', guiltScore: 0.8 })).status, 400);

      const link = await call('POST', '/v1/evidence-links', { target: { kind: 'claim', id }, evidenceRef: 'E05:evidence_version:valve-report@2', selector: { kind: 'page', page: 3 }, stance: 'supports', sourceType: 'official_record' });
      assert.equal(link.status, 201); assert.equal(link.json.validation.state, 'unvalidated');
      const against = await call('POST', '/v1/evidence-links', { target: { kind: 'claim', id }, evidenceRef: 'E05:evidence_version:audit@1', selector: { kind: 'text', quote: 'no alteration found' }, stance: 'challenges' });
      assert.equal((await call('POST', '/v1/evidence-links', { target: { kind: 'claim', id }, evidenceRef: 'E05:evidence_version:valve-report', selector: { kind: 'whole' }, stance: 'supports' })).status, 400);

      // Agent token: may propose, may not finalise.
      const agent = token({ sub: 'agent-3', kind: 'agent', caps: [...CAPS] });
      assert.equal((await call('POST', `/v1/claims/${id}/assessments`, { dimension: 'factual', value: 'contested', rationale: 'r', cites: { linkIds: [link.json.id] } }, agent)).status, 403);
      const prop = await call('POST', `/v1/claims/${id}/assessment-proposals`, { dimension: 'factual', value: 'contested', rationale: 'Report and audit disagree.', cites: { linkIds: [link.json.id, against.json.id] } }, agent);
      assert.equal(prop.status, 201); assert.equal(prop.json.status, 'proposed');
      assert.equal((await call('POST', `/v1/claims/${id}/assessments`, { dimension: 'factual', value: 'supported', rationale: 'short', cites: { linkIds: [link.json.id] } })).status, 409);
      const fin = await call('POST', `/v1/claims/${id}/assessments`, { dimension: 'factual', value: 'contested', rationale: 'Report and audit disagree.', cites: { linkIds: [link.json.id, against.json.id] }, proposalId: prop.json.id });
      assert.equal(fin.status, 201);
      assert.equal((await call('POST', `/v1/claims/${id}/assessments`, { dimension: 'procedural', value: 'charged', rationale: 'x' })).status, 400, 'vocabulary comes from deployment configuration');
      assert.equal((await call('POST', `/v1/claims/${id}/assessments`, { dimension: 'procedural', value: 'alleged', rationale: 'Complaint seen.' })).status, 201);
      const dossier = await call('GET', `/v1/claims/${id}`);
      assert.deepEqual([dossier.json.assessments.factual.value, dossier.json.assessments.procedural.value, dossier.json.assessments.editorial.value], ['contested', 'alleged', 'not_reviewed']);
      assert.equal(dossier.json.evidence.supporting.length, 1); assert.equal(dossier.json.evidence.challenging.length, 1);

      const proposals = await call('POST', '/v1/proposals/claims', { origin: { kind: 'reply', ref: 'E03:message:m-77' }, items: [{ text: 'The operator denies altering the report.', claimType: 'observation' }] }, agent);
      assert.equal(proposals.status, 201);
      assert.equal((await call('POST', `/v1/proposals/${proposals.json[0].id}/review`, { decision: 'accept', reason: 'x' }, agent)).status, 403);
      assert.equal((await call('POST', `/v1/proposals/${proposals.json[0].id}/review`, { decision: 'accept', reason: 'Reply read in full' })).json.state, 'accepted');
      assert.equal((await call('GET', '/v1/records/claim')).json.length, 2);

      const graph = await call('GET', `/v1/graphs/evidence?claimId=${id}`);
      assert.ok(graph.json.nodes.length >= 4 && graph.json.table.rows.length === graph.json.edges.length);
      const textGraph = await call('GET', `/v1/graphs/evidence?claimId=${id}&format=text`);
      assert.match(textGraph.text, /—\[supports\]→/); assert.doesNotMatch(textGraph.text + graph.text, /Renata|Okoro/);
      assert.equal((await call('GET', '/v1/graphs/evidence')).status, 400);
      assert.ok((await call('GET', '/v1/research-gaps?caseId=case-9')).json.gaps[0].gaps.some((g: any) => g.gap === 'unvalidated_links'));
      assert.equal((await call('GET', '/v1/search/records?q=valve')).json.total, 1);
      assert.equal((await call('GET', '/v1/search?q=Okoro')).json.length, 0);
      assert.equal((await call('GET', `/v1/claims/${id}/history`)).json.timeline.length >= 5, true);
      assert.equal((await call('GET', `/v1/inspect?ref=E07:claim:${id}`)).json.kind, 'claim');
      assert.equal((await call('GET', `/v1/exports/dossier?claimId=${id}`)).status, 403);
      assert.equal((await call('GET', `/v1/exports/dossier?claimId=${id}`, undefined, token({ caps: [...CAPS, 'knowledge:export'] }))).json.format, 'e07-dossier/1');

      // Upstream correction over HTTP, then claim history and impact.
      const impact = await call('POST', '/v1/impact', { refs: ['E05:evidence_version:valve-report'] });
      assert.equal(impact.json.claims.length, 1);
      assert.equal((await call('POST', '/v1/upstream-changes', { eventId: 'E05:1', kind: 'source_superseded', refs: ['E05:evidence_version:valve-report@2'], reason: 'New version' })).status, 403);
      const svc = token({ sub: 'pam', kind: 'service', caps: ['knowledge:upstream', 'knowledge:events'] });
      const applied = await call('POST', '/v1/upstream-changes', { eventId: 'E05:1', kind: 'source_superseded', refs: ['E05:evidence_version:valve-report@2'], reason: 'New version' }, svc);
      assert.equal(applied.json.affected.length, 2);
      const after = await call('GET', `/v1/claims/${id}`);
      assert.equal(after.json.status, 'needs_reverification'); assert.equal(after.json.assessments.factual.value, 'contested'); assert.equal(after.json.assessments.factual.needsReverification, true);
      let events: any[] = [];
      for (let i = 0; i < 100 && !events.some((e) => e.type === 'knowledge.claim_stale'); i++) { events = (await call('GET', '/v1/events?limit=500', undefined, svc)).json; if (!events.some((e) => e.type === 'knowledge.claim_stale')) await new Promise((r) => setTimeout(r, 100)); }
      assert.ok(events.some((e) => e.type === 'knowledge.claim_stale' && e.subject === `E07:claim:${id}`));
      assert.doesNotMatch(JSON.stringify(events) + JSON.stringify((await call('GET', '/v1/audit?limit=500')).json), /Renata|Okoro/);
      assert.equal((await call('GET', '/v1/events', undefined, token())).status, 403);
      const corr = await call('POST', '/v1/corrections', { refs: ['E05:evidence_version:audit@1'], reason: 'Audit withdrawn', kind: 'source_removed' });
      assert.equal(corr.status, 201); assert.equal(corr.json.affected.length, 2); // the link and its claim

      // Another tenant and another project see nothing, by any route.
      for (const other of [token({ tid: 't2' }), token({ pid: 'p2' })]) {
        for (const path of [`/v1/claims/${id}`, `/v1/claims/${id}/history`, `/v1/records/evidence_link/${link.json.id}`, `/v1/entities/${ent.json.id}`, `/v1/graphs/evidence?claimId=${id}`, `/v1/inspect?ref=E07:claim:${id}`]) {
          const r = await call('GET', path, undefined, other);
          assert.equal(r.status, 404, path); assert.deepEqual(r.json.error.code, 'not_found');
        }
        assert.deepEqual((await call('GET', '/v1/records/claim', undefined, other)).json, []);
        assert.equal((await call('GET', '/v1/search/records?q=valve', undefined, other)).json.total, 0);
        assert.equal((await call('PATCH', `/v1/claims/${id}`, { expectedRevision: 1, reason: 'x', text: 'y' }, other)).status, 404);
      }
      assert.equal((await call('PATCH', `/v1/claims/${id}`, { expectedRevision: 9, reason: 'x', text: 'y' })).status, 409);
      assert.equal((await call('GET', '/v1/records/nonsense')).status, 400);
      assert.equal((await call('GET', '/v1/nope')).status, 404);
    } finally { await running.close(); }
  });
});

test('serve refuses to start without identity keys or a database', async () => {
  await assert.rejects(start({}), /DATABASE_URL/);
});
