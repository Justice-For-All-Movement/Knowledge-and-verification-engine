import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/contracts.ts';
import type { ServiceContext } from '../src/service-kit.ts';
import { httpEvidencePort, httpUseDecisionPort } from '../src/engine/http-ports.ts';

const token = `header.${Buffer.from(JSON.stringify({ tid: 't1', pid: 'p1' })).toString('base64url')}.signature`;
const context = (): ServiceContext => ({ tenantId: 't1', projectId: 'p1', purpose: 'research', requestId: 'r1',
  now: '2026-01-01T00:00:00.000Z', actor: { id: 'human-a', kind: 'human', roles: [] }, capabilities: [], compartments: [] });
const ref = 'E05:evidence_version:example@1';
const valid = { ref, evidenceId: 'example', revision: 1, sha256: 'a'.repeat(64), size: 1,
  mediaType: 'text/plain', filename: 'example.txt', compartment: null, available: true };
const unavailable = (e: unknown) => e instanceof DomainError && e.code === 'unavailable';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const block = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* synthetic blocked host */ } };
const invoke = (fetcher: typeof fetch, timeoutMs = 100) => httpEvidencePort({
  baseUrl: 'https://example.invalid', token: () => token, fetch: fetcher, timeoutMs,
}).describe(context(), ref);

test('late synchronous fetch and credential results fail the monotonic deadline even before its timer runs', async () => {
  for (const stage of ['fetch', 'credential']) {
    let called = false; let signal: AbortSignal | null = null;
    const port = httpEvidencePort({ baseUrl: 'https://example.invalid', timeoutMs: 100,
      token: () => { if (stage === 'credential') block(140); return token; },
      fetch: async (_url, init) => { called = true; signal = init?.signal ?? null; if (stage === 'fetch') block(140); return Response.json(valid); },
    });
    await assert.rejects(port.describe(context(), ref), unavailable);
    assert.equal(called, stage === 'fetch', 'late credential work cannot reach transport');
    if (stage === 'fetch') assert.equal((signal as AbortSignal | null)?.aborted, true);
  }
});

test('response bytes are bounded before JSON parsing, with and without advertised size', async () => {
  for (const advertised of [false, true]) {
    let cancelled = false;
    const bytes = new TextEncoder().encode(JSON.stringify(valid) + ' '.repeat(512 * 1024));
    const response = new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); }, cancel() { cancelled = true; } }),
      { headers: advertised ? { 'content-length': String(bytes.length) } : {} });
    const pending = invoke(async () => response);
    const result = await Promise.race([pending.then(() => 'accepted', e => e), sleep(250).then(() => 'still-reading')]);
    assert.ok(unavailable(result), 'oversize body must be rejected without waiting for EOF');
    assert.equal(cancelled, true);
  }
});

test('empty response chunks count toward the finite 4096-read budget', async () => {
  let count = 0; let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(c) {
    if (++count <= 4097) c.enqueue(new Uint8Array());
    else { c.enqueue(new TextEncoder().encode(JSON.stringify(valid))); c.close(); }
  }, cancel() { cancelled = true; } });
  await assert.rejects(invoke(async () => new Response(body), 1000), unavailable);
  assert.equal(cancelled, true); assert.ok(count <= 4098, 'no unbounded empty-chunk draining');
});

test('malformed UTF8 is rejected rather than replaced in Evidence or Consent strings', async () => {
  const bad = (s: string) => new Response(Buffer.concat([Buffer.from(s), Buffer.from([255]), Buffer.from('"}') ]));
  await assert.rejects(invoke(async () => bad(JSON.stringify(valid).slice(0, -1) + ',"extra":"')), unavailable);
  const port = httpUseDecisionPort({ baseUrl: 'https://example.invalid', token: () => token,
    fetch: async () => bad('{"decision":"allow","permissionRefs":[],"reasons":[],"decidedAt":"2026-01-01T00:00:00Z","extra":"'),
  });
  await assert.rejects(port.decide(context(), { subjects: ['E03:message:example'], action: 'investigate', purpose: 'research' }), unavailable);
});

test('stalled injected body is timed out and cancelled; callback diagnostics are sanitized', async () => {
  let cancelled = false; let signal: AbortSignal | null = null;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = invoke(async (_url, init) => { signal = init?.signal ?? null; return new Response(body); });
  const result = await Promise.race([pending.then(() => 'accepted', e => e), sleep(350).then(() => 'still-reading')]);
  assert.ok(unavailable(result)); assert.equal(cancelled, true); assert.equal((signal as AbortSignal | null)?.aborted, true);
  const secret = 'SYNTHETIC_PRIVATE_DIAGNOSTIC';
  await assert.rejects(invoke(async () => { throw new Error(secret); }), e => unavailable(e) && !String(e).includes(secret));
});

test('owned fetch signals close after success and rejection; late fetch bodies are cancelled', async () => {
  for (const response of [Response.json(valid), Response.json({}), new Response('{')]) {
    let signal: AbortSignal | null = null;
    await invoke(async (_url, init) => { signal = init?.signal ?? null; return response; }).catch(() => {});
    assert.equal((signal as AbortSignal | null)?.aborted, true);
  }
  let cancelled = false;
  const late = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
  const pending = invoke(async () => { await sleep(160); return late; });
  await assert.rejects(pending, unavailable); await sleep(180); assert.equal(cancelled, true);
});
