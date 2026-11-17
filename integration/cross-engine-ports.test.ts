// Cross-engine verification of the standalone server's HTTP ports against the REAL evidence (E05) and consent (E11)
// engines, started from their own checkouts (pinned in CI) with their own `src/engine/serve.ts`, on real PostgreSQL.
// No other engine's package is imported: they run as separate processes reached only over HTTP.
//
//   KVE_E05_DIR, KVE_E11_DIR   paths to installed checkouts (npm ci done) of the two engines
//   TEST_DATABASE_URL          PostgreSQL admin URL (disposable databases are created and dropped)
// Skipped visibly when any of them is unset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { generateSigningKey, signAccessToken } from '../src/service-kit.ts';
import { start } from '../src/engine/serve.ts';
import { verifyLive } from '../scripts/verify-live-ports.ts';

const ADMIN = process.env.TEST_DATABASE_URL ?? '';
const E05 = process.env.KVE_E05_DIR ?? '', E11 = process.env.KVE_E11_DIR ?? '';
const missing = [ADMIN === '' ? 'TEST_DATABASE_URL' : '', E05 === '' ? 'KVE_E05_DIR' : '', E11 === '' ? 'KVE_E11_DIR' : ''].filter((x) => x !== '');
const gate = missing.length > 0 ? { skip: `${missing.join(', ')} not set; cross-engine port verification not executed` } : {};

function dbUrl(name: string): string { const u = new URL(ADMIN); u.pathname = `/${name}`; return u.href; }
async function waitUp(port: number, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`engine on port ${port} exited with ${child.exitCode}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`engine on port ${port} did not become healthy`);
}

test('HTTP ports against the real E05 and E11 engines', { ...gate, timeout: 180_000 }, async () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const names = { e05: `kve_x05_${suffix}`, e11: `kve_x11_${suffix}`, e07: `kve_x07_${suffix}` };
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  const children: ChildProcess[] = [];
  try {
    for (const n of Object.values(names)) await admin.query(`create database ${n}`);
    const key = generateSigningKey('xk');
    const keys = JSON.stringify({ xk: key.publicKeyPem });
    const now = Math.floor(Date.now() / 1000);
    const token = (caps: string[], sub: string, kind: 'human' | 'service', tid = 't1'): string => signAccessToken({ iss: 'iap', sub, kind, tid, pid: 'p1', roles: [], caps, cmp: [], purpose: 'research', pv: '1', iat: now, exp: now + 1800, jti: `${sub}-${tid}` }, key);
    const run = (dir: string, port: number, env: Record<string, string>): ChildProcess => {
      const child = spawn(process.execPath, ['src/engine/serve.ts'], { cwd: dir, env: { PATH: process.env.PATH ?? '', ...env, PORT: String(port), HOST: '127.0.0.1', IDENTITY_PUBLIC_KEYS: keys, IDENTITY_ISSUER: 'iap' }, stdio: ['ignore', 'ignore', 'inherit'] });
      children.push(child); return child;
    };
    const p05 = 19105 + (process.pid % 300), p11 = p05 + 1;
    const c05 = run(E05, p05, { DATABASE_URL: dbUrl(names.e05), EVIDENCE_ALLOW_PLAINTEXT: '1', EVIDENCE_SCAN_POLICY: 'structural_only', OBJECT_STORE_PATH: mkdtempSync(join(tmpdir(), 'kve-e05-')) });
    const c11 = run(E11, p11, { DATABASE_URL: dbUrl(names.e11) });
    await waitUp(p05, c05); await waitUp(p11, c11);
    const evidenceUrl = `http://127.0.0.1:${p05}`, consentUrl = `http://127.0.0.1:${p11}`;

    // A curator stores one original in E05; its structural scan releases it.
    const curator = token(['evidence:read', 'evidence:write'], 'curator', 'human');
    const accepted = await (await fetch(`${evidenceUrl}/v1/evidence/accept`, { method: 'POST', headers: { authorization: `Bearer ${curator}`, 'content-type': 'application/json' },
      body: JSON.stringify({ contentBase64: Buffer.from('Inspection report: the valve was replaced on 3 March.').toString('base64'), mediaType: 'text/plain', filename: 'report.txt', origin: { kind: 'test' } }) })).json() as { ref: string; sha256: string };
    assert.match(accepted.ref, /^E05:evidence_version:[0-9a-f-]+@1$/);
    let released = false;
    for (let i = 0; i < 80 && !released; i++) {
      const d = await (await fetch(`${evidenceUrl}/v1/evidence/describe?ref=${encodeURIComponent(accepted.ref)}`, { headers: { authorization: `Bearer ${curator}` } })).json() as { available?: boolean };
      released = d.available === true; if (!released) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(released, 'E05 released the stored original');

    const service = token(['evidence:read', 'consent:decide'], 'knowledge-service', 'service');
    const outcomes = await verifyLive({ EVIDENCE_URL: evidenceUrl, CONSENT_URL: consentUrl, KNOWLEDGE_SERVICE_TOKEN: service, KNOWLEDGE_LIVE_EVIDENCE_REF: accepted.ref });
    assert.deepEqual(outcomes.filter((o) => o.status === 'failed'), []);
    assert.deepEqual(outcomes.filter((o) => o.status === 'passed').map((o) => o.check), ['service token', 'evidence describe: unknown version reads as absent', 'evidence describe: known version', 'consent use-decision']);

    const running = await start({ DATABASE_URL: dbUrl(names.e07), PORT: '0', HOST: '127.0.0.1', IDENTITY_PUBLIC_KEYS: keys, IDENTITY_ISSUER: 'iap', EVIDENCE_URL: evidenceUrl, CONSENT_URL: consentUrl, KNOWLEDGE_SERVICE_TOKEN: service, KNOWLEDGE_PRIMARY_SOURCE_TYPES: 'official_record' });
    try {
      const call = async (method: string, path: string, body?: unknown, tid = 't1'): Promise<{ status: number; json: any }> => {
        const r = await fetch(`http://127.0.0.1:${running.port}${path}`, { method, headers: { authorization: `Bearer ${token(['knowledge:read', 'knowledge:write', 'knowledge:approve'], 'researcher', 'human', tid)}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: r.status, json: await r.json() };
      };
      const claim = await call('POST', '/v1/claims', { text: 'The valve was replaced in March.', claimType: 'observation' });
      const target = { kind: 'claim', id: claim.json.id };
      const link = await call('POST', '/v1/evidence-links', { target, evidenceRef: accepted.ref, selector: { kind: 'whole' }, stance: 'supports', sourceType: 'official_record' });
      assert.equal(link.status, 201);
      assert.equal(link.json.validation.state, 'released'); assert.equal(link.json.validation.sha256, accepted.sha256);
      const unknown = await call('POST', '/v1/evidence-links', { target, evidenceRef: 'E05:evidence_version:00000000-0000-4000-8000-000000000000@1', selector: { kind: 'whole' }, stance: 'supports' });
      assert.equal(unknown.status, 400); assert.equal(unknown.json.error.code, 'invalid_reference');
      const assessed = await call('POST', `/v1/claims/${claim.json.id}/assessments`, { dimension: 'factual', value: 'supported', rationale: 'Released primary record.', cites: { linkIds: [link.json.id] } });
      assert.equal(assessed.status, 201); assert.equal(assessed.json.basis, 'released_primary_source', 'a released E05 version satisfies the primary-source rule');
      const statement = await call('POST', '/v1/statements', { speakerLabel: 'Witness A', text: 'I saw the valve being replaced.', sourceRef: 'E03:message:m1' });
      assert.equal(statement.status, 201); assert.ok(['allow', 'review'].includes(statement.json.use.decision), 'decided by the real E11 policy, not unchecked');
      const foreign = await call('POST', '/v1/claims', { text: 'Other tenant claim.', claimType: 'observation' }, 't9');
      assert.equal((await call('POST', '/v1/evidence-links', { target: { kind: 'claim', id: foreign.json.id }, evidenceRef: accepted.ref, selector: { kind: 'whole' }, stance: 'supports' }, 't9')).status, 500, 'the t1 service credential is never used for tenant t9');
    } finally { await running.close(); }
  } finally {
    for (const c of children) c.kill('SIGTERM');
    await Promise.all(children.map((c) => (c.exitCode !== null ? Promise.resolve() : new Promise((r) => c.once('exit', r)))));
    for (const n of Object.values(names)) await admin.query(`drop database if exists ${n} with (force)`).catch(() => undefined);
    await admin.end();
  }
});
