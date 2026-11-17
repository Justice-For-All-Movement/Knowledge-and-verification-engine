// HTTP EvidencePort / UseDecisionPort adapters, standalone-server port configuration, list pagination and
// complete (paged, fail-closed) project scans. The E05 / E11 servers here are local stand-ins that reproduce the
// real engines' route paths, status codes and response shapes; they are test infrastructure, not those engines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { DomainError } from '../src/contracts.ts';
import { generateSigningKey, signAccessToken, withDisposableDatabase } from '../src/service-kit.ts';
import type { ServiceContext, TokenClaims } from '../src/service-kit.ts';
import { createEngine, migrate, SCHEMA } from '../src/engine/index.ts';
import { verifyLive } from '../scripts/verify-live-ports.ts';
import { httpEvidencePort, httpUseDecisionPort, portsFromEnv, configFromEnv, serviceTokenScope, start } from '../src/engine/serve.ts';

const ADMIN = process.env.TEST_DATABASE_URL ?? '';
const needsPg = ADMIN === '' ? { skip: 'TEST_DATABASE_URL is not set; real-PostgreSQL test not executed' } : {};
const CAPS = ['knowledge:read', 'knowledge:write', 'knowledge:propose', 'knowledge:review', 'knowledge:assess', 'knowledge:approve', 'knowledge:merge', 'knowledge:audit'];
const key = generateSigningKey('svc');
const now = Math.floor(Date.now() / 1000);
const tokenFor = (over: Partial<TokenClaims> = {}): string => signAccessToken({ iss: 'iap', sub: 'knowledge-service', kind: 'service', tid: 't1', pid: 'p1', roles: [], caps: ['evidence:read', 'consent:decide'], cmp: [], purpose: 'research', pv: '1', iat: now, exp: now + 600, jti: 'j', ...over }, key);
let seq = 0;
const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({ tenantId: 't1', projectId: 'p1', purpose: 'research', requestId: `r${++seq}`, now: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), actor: { id: 'researcher-1', kind: 'human', roles: [] }, capabilities: CAPS, compartments: [], ...over });
const code = (c: string) => (e: unknown): boolean => e instanceof DomainError && e.code === c;

type Seen = { method: string; path: string; auth: string | undefined; body: unknown };
type Reply = (req: Seen) => { status: number; json?: unknown; headers?: Record<string, string>; delayMs?: number };
async function fakeServer(reply: Reply): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const s: Seen = { method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, body: raw === '' ? undefined : JSON.parse(raw) };
      seen.push(s);
      const r = reply(s);
      setTimeout(() => { res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) }); res.end(r.json === undefined ? '' : JSON.stringify(r.json)); }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** Mirrors E05 `GET /v1/evidence/describe` (VersionDetail, a superset of EvidenceVersionInfo) and its 404 error body. */
const versionDetail = (ref: string, available: boolean) => {
  const m = /^E05:evidence_version:([^@]+)@(\d+)$/.exec(ref) as RegExpExecArray;
  return { ref, evidenceId: m[1], revision: Number(m[2]), sha256: 'b'.repeat(64), size: 42, mediaType: 'application/pdf', filename: 'report.pdf', compartment: null, available,
    evidenceRef: `E05:evidence:${m[1]}`, kind: 'original', title: 'report', isCurrent: true, currentRef: ref, state: available ? 'released' : 'quarantined', bytesState: 'present', restricted: false };
};
function e05(store: Map<string, boolean>): Reply {
  return (s) => {
    const u = new URL(s.path, 'http://x');
    if (s.method !== 'GET' || u.pathname !== '/v1/evidence/describe') return { status: 404, json: { error: { code: 'not_found', message: 'No route' } } };
    if (s.auth !== `Bearer ${tokenFor()}`) return { status: 401, json: { error: { code: 'unauthenticated', message: 'Invalid or expired credentials' } } };
    const ref = u.searchParams.get('ref') ?? '';
    return store.has(ref) ? { status: 200, json: versionDetail(ref, store.get(ref) as boolean) } : { status: 404, json: { error: { code: 'not_found', message: 'Not found' } } };
  };
}
/** Mirrors E11 `POST /v1/use-decisions` (RecordedDecision, a superset of UseDecision). */
function e11(denied: Set<string>): Reply {
  return (s) => {
    if (s.method !== 'POST' || s.path !== '/v1/use-decisions') return { status: 404, json: { error: { code: 'not_found', message: 'No route' } } };
    const b = s.body as { subjects: string[]; action: string };
    const deny = b.subjects.some((x) => denied.has(x));
    return { status: 200, json: { decision: deny ? 'deny' : 'allow', reasons: deny ? ['withdrawn'] : [], permissionRefs: ['E11:permission:perm-7'], restrictions: [], decidedAt: '2026-01-01T00:00:00.000Z', decisionRef: 'E11:use_decision:d1', policyVersion: '1' } };
  };
}

test('E05 adapter: real route path and shape, unknown → null, failures and malformed answers fail closed', async () => {
  const store = new Map([['E05:evidence_version:rep@2', true], ['E05:evidence_version:q@1', false]]);
  const srv = await fakeServer(e05(store));
  try {
    const port = httpEvidencePort({ baseUrl: srv.url, token: () => tokenFor() });
    const info = await port.describe(ctx(), 'E05:evidence_version:rep@2');
    assert.deepEqual(info, { ref: 'E05:evidence_version:rep@2', evidenceId: 'rep', revision: 2, sha256: 'b'.repeat(64), size: 42, mediaType: 'application/pdf', filename: 'report.pdf', compartment: null, available: true });
    assert.equal(srv.seen[0]?.path, '/v1/evidence/describe?ref=E05%3Aevidence_version%3Arep%402');
    assert.equal((await port.describe(ctx(), 'E05:evidence_version:q@1'))?.available, false);
    assert.equal(await port.describe(ctx(), 'E05:evidence_version:missing@1'), null);
    const before = srv.seen.length;
    await assert.rejects(port.describe(ctx({ tenantId: 't2' }), 'E05:evidence_version:rep@2'), code('unavailable'), 'foreign tenant');
    await assert.rejects(port.describe(ctx({ projectId: 'p9' }), 'E05:evidence_version:rep@2'), code('unavailable'), 'foreign project');
    assert.equal(srv.seen.length, before, 'a scope mismatch never reaches the evidence engine');
    await assert.rejects(httpEvidencePort({ baseUrl: srv.url, token: () => tokenFor({ jti: 'other' }) }).describe(ctx(), 'E05:evidence_version:rep@2'), code('unavailable'), '401 is not "unknown"');
  } finally { await srv.close(); }

  const odd = async (reply: ReturnType<Reply>, timeoutMs?: number): Promise<unknown> => {
    const s = await fakeServer(() => reply);
    try { return await httpEvidencePort({ baseUrl: s.url, token: () => tokenFor(), ...(timeoutMs === undefined ? {} : { timeoutMs }) }).describe(ctx(), 'E05:evidence_version:rep@2'); } finally { await s.close(); }
  };
  await assert.rejects(odd({ status: 500, json: { error: { code: 'internal', message: 'x' } } }), code('unavailable'));
  await assert.rejects(odd({ status: 200, json: { ref: 'E05:evidence_version:rep@2', available: 'yes' } }), code('unavailable'));
  await assert.rejects(odd({ status: 200, json: versionDetail('E05:evidence_version:rep@3', true) }), code('unavailable'), 'a different version is not the cited one');
  await assert.rejects(odd({ status: 302, headers: { location: 'http://127.0.0.1:1/' } }), code('unavailable'), 'redirects are refused');
  await assert.rejects(odd({ status: 200, json: versionDetail('E05:evidence_version:rep@2', true), delayMs: 500 }, 100), code('unavailable'), 'timeout');
  assert.equal(await odd({ status: 404, json: { error: { code: 'scope_denied', message: 'x' } } }), null);
  assert.equal(await odd({ status: 403, json: { error: { code: 'forbidden', message: 'x' } } }), null);
  await assert.rejects(httpEvidencePort({ baseUrl: 'http://127.0.0.1:1', token: () => tokenFor() }).describe(ctx(), 'E05:evidence_version:rep@2'), code('unavailable'), 'unreachable');
});

test('E11 adapter: real route path, request passthrough, invalid or failed answers fail closed', async () => {
  const srv = await fakeServer(e11(new Set(['E03:message:m2'])));
  try {
    const port = httpUseDecisionPort({ baseUrl: srv.url, token: () => tokenFor() });
    const ok = await port.decide(ctx(), { subjects: ['E03:message:m1'], action: 'investigate', purpose: 'research' });
    assert.deepEqual(ok, { decision: 'allow', reasons: [], permissionRefs: ['E11:permission:perm-7'], restrictions: [], decidedAt: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(srv.seen[0], { method: 'POST', path: '/v1/use-decisions', auth: `Bearer ${tokenFor()}`, body: { subjects: ['E03:message:m1'], action: 'investigate', purpose: 'research' } });
    assert.equal((await port.decide(ctx(), { subjects: ['E03:message:m2'], action: 'investigate', purpose: 'research' })).decision, 'deny');
    await assert.rejects(port.decide(ctx({ tenantId: 'other' }), { subjects: ['E03:message:m1'], action: 'investigate', purpose: 'research' }), code('unavailable'));
  } finally { await srv.close(); }
  for (const reply of [{ status: 503, json: { error: { code: 'unavailable', message: 'x' } } }, { status: 200, json: { decision: 'maybe', reasons: [], permissionRefs: [], decidedAt: 'x' } }, { status: 200, json: { decision: 'allow' } }]) {
    const s = await fakeServer(() => reply);
    try { await assert.rejects(httpUseDecisionPort({ baseUrl: s.url, token: () => tokenFor() }).decide(ctx(), { subjects: ['E03:message:m1'], action: 'investigate', purpose: 'research' }), code('unavailable')); } finally { await s.close(); }
  }
});

test('standalone port and scan configuration is validated', () => {
  assert.deepEqual(portsFromEnv({}), {});
  assert.throws(() => portsFromEnv({ EVIDENCE_URL: 'http://127.0.0.1:9' }), code('invalid_config'), 'token required');
  assert.throws(() => portsFromEnv({ CONSENT_URL: 'http://127.0.0.1:9', KNOWLEDGE_SERVICE_TOKEN: 'not-a-token' }), code('invalid_config'));
  assert.throws(() => portsFromEnv({ EVIDENCE_URL: 'ftp://x', KNOWLEDGE_SERVICE_TOKEN: tokenFor() }), code('invalid_config'));
  assert.throws(() => portsFromEnv({ EVIDENCE_URL: 'http://127.0.0.1:9', KNOWLEDGE_SERVICE_TOKEN: tokenFor(), KNOWLEDGE_PORT_TIMEOUT_MS: '5' }), code('invalid_config'));
  const both = portsFromEnv({ EVIDENCE_URL: 'http://127.0.0.1:9', CONSENT_URL: 'http://127.0.0.1:9', KNOWLEDGE_SERVICE_TOKEN: tokenFor() });
  assert.equal(typeof both.evidence?.describe, 'function'); assert.equal(typeof both.useDecision?.decide, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'kve-token-'));
  writeFileSync(join(dir, 'token'), `${tokenFor()}\n`);
  assert.equal(typeof portsFromEnv({ CONSENT_URL: 'http://127.0.0.1:9', KNOWLEDGE_SERVICE_TOKEN_FILE: join(dir, 'token') }).useDecision?.decide, 'function');
  writeFileSync(join(dir, 'empty'), '');
  assert.throws(() => portsFromEnv({ CONSENT_URL: 'http://127.0.0.1:9', KNOWLEDGE_SERVICE_TOKEN_FILE: join(dir, 'empty') }), code('invalid_config'));
  assert.deepEqual(serviceTokenScope(tokenFor()), { tid: 't1', pid: 'p1', exp: now + 600 });
  assert.equal(configFromEnv({ KNOWLEDGE_MAX_SCAN_RECORDS: '250' }).maxScanRecords, 250);
  assert.throws(() => createEngine({ sql: { query: async () => [], tx: async () => { throw new Error('unused'); } } as never, config: { maxScanRecords: 0 } }), code('invalid_config'));
});

test('standalone server validates links and consults consent through the HTTP ports', needsPg, async () => {
  const store = new Map([['E05:evidence_version:rep@2', true], ['E05:evidence_version:draft@1', false]]);
  const evidence = await fakeServer(e05(store)), consent = await fakeServer(e11(new Set(['E03:message:withdrawn'])));
  try {
    await withDisposableDatabase(pg, ADMIN, async (url) => {
      const ik = generateSigningKey('k1');
      const running = await start({ DATABASE_URL: url, PORT: '0', HOST: '127.0.0.1', IDENTITY_PUBLIC_KEYS: JSON.stringify({ k1: ik.publicKeyPem }), IDENTITY_ISSUER: 'iap', EVIDENCE_URL: evidence.url, CONSENT_URL: consent.url, KNOWLEDGE_SERVICE_TOKEN: tokenFor() });
      try {
        const user = (tid = 't1'): string => signAccessToken({ iss: 'iap', sub: 'researcher-1', kind: 'human', tid, pid: 'p1', roles: [], caps: CAPS, cmp: [], purpose: 'research', pv: '1', iat: now, exp: now + 600, jti: 'u' }, ik);
        const call = async (method: string, path: string, body?: unknown, t = user()): Promise<{ status: number; json: any }> => {
          const r = await fetch(`http://127.0.0.1:${running.port}${path}`, { method, headers: { authorization: `Bearer ${t}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
          return { status: r.status, json: await r.json() };
        };
        const health = await call('GET', '/healthz');
        assert.equal(health.json.detail.evidencePort, true); assert.equal(health.json.detail.useDecisionPort, true);
        const claim = await call('POST', '/v1/claims', { text: 'The valve report was altered.', claimType: 'allegation' });
        assert.equal(claim.status, 201);
        const target = { kind: 'claim', id: claim.json.id };
        const released = await call('POST', '/v1/evidence-links', { target, evidenceRef: 'E05:evidence_version:rep@2', selector: { kind: 'page', page: 1 }, stance: 'supports', sourceType: 'official_record' });
        assert.equal(released.status, 201); assert.equal(released.json.validation.state, 'released'); assert.equal(released.json.validation.sha256, 'b'.repeat(64));
        const quarantined = await call('POST', '/v1/evidence-links', { target, evidenceRef: 'E05:evidence_version:draft@1', selector: { kind: 'whole' }, stance: 'context' });
        assert.equal(quarantined.json.validation.state, 'not_released');
        assert.equal((await call('POST', '/v1/evidence-links', { target, evidenceRef: 'E05:evidence_version:ghost@1', selector: { kind: 'whole' }, stance: 'supports' })).status, 400);
        const other = await call('POST', '/v1/claims', { text: 'Other tenant claim.', claimType: 'observation' }, user('t2'));
        assert.equal((await call('POST', '/v1/evidence-links', { target: { kind: 'claim', id: other.json.id }, evidenceRef: 'E05:evidence_version:rep@2', selector: { kind: 'whole' }, stance: 'supports' }, user('t2'))).status, 500, 'the service credential does not cover tenant t2: unavailable, link not created (the kit reports 5xx domain errors as internal)');
        assert.deepEqual((await call('GET', `/v1/records/evidence_link`, undefined, user('t2'))).json, []);

        const ok = await call('POST', '/v1/statements', { speakerLabel: 'Witness A', text: 'I saw the report change.', sourceRef: 'E03:message:m1' });
        assert.equal(ok.status, 201); assert.equal(ok.json.use.decision, 'allow'); assert.deepEqual(ok.json.use.permissionRefs, ['E11:permission:perm-7']);
        assert.equal((await call('POST', '/v1/statements', { speakerLabel: 'Witness B', text: 'Withdrawn statement.', sourceRef: 'E03:message:withdrawn' })).status, 403);
        assert.deepEqual(consent.seen.map((s) => s.path).filter((p) => p !== '/v1/use-decisions'), []);
        assert.ok(evidence.seen.every((s) => s.path.startsWith('/v1/evidence/describe?ref=')));
      } finally { await running.close(); }
    });
  } finally { await evidence.close(); await consent.close(); }
});

test('list pages with `after`; project scans read past one page and fail closed above maxScanRecords', needsPg, async () => {
  await withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
    await migrate(sql);
    const engine = createEngine({ sql });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await engine.createClaim(ctx(), { text: `Claim number ${i} about the valve.`, claimType: 'observation', caseId: 'c1' } as never)).id);
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) { const page = await engine.list(ctx(), 'claim', { limit: 2, ...(after === undefined ? {} : { after }) }); if (page.length === 0) break; seen.push(...page.map((p) => p.id)); after = page[page.length - 1]?.id; }
    assert.deepEqual(seen, ids);
    assert.deepEqual(await engine.list(ctx(), 'claim', { after: 'no-such-id' }), []);
    await assert.rejects(engine.list(ctx(), 'claim', { after: 'bad id with spaces' }), code('invalid_input'));
    assert.deepEqual(await engine.list(ctx({ tenantId: 't2' }), 'claim', { after: ids[0] as string }), [], 'cursor ids are tenant-scoped');

    // A compartment-hidden cursor id yields nothing rather than revealing its position.
    const hidden = await engine.createClaim(ctx({ compartments: ['vault'] }), { text: 'Hidden claim text here.', claimType: 'observation', compartment: 'vault' } as never);
    assert.deepEqual(await engine.list(ctx(), 'claim', { after: hidden.id }), []);

    // Bulk rows beyond one 5000-row page: research gaps must count every claim, not the first page.
    await sql.query(`insert into ${SCHEMA}.objects (tenant_id, project_id, kind, id, revision, state, compartment, case_id, stale, blocked, flags, body, created_at, created_by, updated_at)
      select tenant_id, project_id, kind, id || '-bulk-' || g, revision, state, compartment, case_id, stale, blocked, flags, body, created_at + make_interval(secs => g), created_by, updated_at
      from ${SCHEMA}.objects cross join generate_series(1, 5100) g where kind = 'claim' and id = $1`, [ids[0]]);
    const gaps = await engine.researchGaps(ctx(), { caseId: 'c1' });
    assert.equal(gaps.gaps.length, 5 + 5100);
    assert.equal((await engine.list(ctx(), 'claim', { limit: 100000 })).length, 5000, 'list pages are capped at 5000');

    const capped = createEngine({ sql, config: { maxScanRecords: 5000 } });
    await assert.rejects(capped.researchGaps(ctx(), { caseId: 'c1' }), code('payload_too_large'));
    await assert.rejects(capped.chronology(ctx(), {}), code('payload_too_large'));
  });
});

test('live verification script skips without endpoints and passes against route-faithful stand-ins', async () => {
  const skipped = await verifyLive({});
  assert.ok(skipped.length > 0 && skipped.every((o) => o.status === 'skipped'));
  assert.ok((await verifyLive({ EVIDENCE_URL: 'http://127.0.0.1:9' })).some((o) => o.check === 'service token' && o.status === 'failed'));
  const evidence = await fakeServer(e05(new Map([['E05:evidence_version:rep@2', true]]))), consent = await fakeServer(e11(new Set()));
  try {
    const outcomes = await verifyLive({ EVIDENCE_URL: evidence.url, CONSENT_URL: consent.url, KNOWLEDGE_SERVICE_TOKEN: tokenFor(), KNOWLEDGE_LIVE_EVIDENCE_REF: 'E05:evidence_version:rep@2' });
    assert.deepEqual(outcomes.filter((o) => o.status === 'failed'), []);
    assert.deepEqual(outcomes.filter((o) => o.status === 'passed').map((o) => o.check), ['service token', 'evidence describe: unknown version reads as absent', 'evidence describe: known version', 'consent use-decision']);
    assert.ok(!JSON.stringify(outcomes).includes(tokenFor()), 'tokens are never echoed');
  } finally { await evidence.close(); await consent.close(); }
});
