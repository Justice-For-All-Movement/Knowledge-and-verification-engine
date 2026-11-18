import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceContext } from '../src/service-kit.ts';
import { httpEvidencePort } from '../src/engine/http-ports.ts';

const token = `header.${Buffer.from(JSON.stringify({ tid: 't1', pid: 'p1' })).toString('base64url')}.signature`;
const context: ServiceContext = { tenantId: 't1', projectId: 'p1', purpose: 'research', requestId: 'r1',
  now: '2026-01-01T00:00:00Z', actor: { id: 'reviewer', kind: 'human', roles: [] }, capabilities: [], compartments: [] };
const ref = 'E05:evidence_version:example@1';
const description = { ref, evidenceId: 'example', revision: 1, sha256: 'a'.repeat(64), size: 1,
  mediaType: 'text/plain', filename: 'first.txt', compartment: null, available: true };

for (const kind of ['Buffer', 'Uint8Array']) {
  test(`HTTP response owns ${kind} chunk bytes before the producer reuses its storage on the next read`, async () => {
    const encoded = Buffer.from(JSON.stringify(description));
    const chunk = kind === 'Buffer' ? encoded : Uint8Array.from(encoded);
    const position = encoded.indexOf('first.txt');
    let reads = 0;
    // Zero buffering makes the reuse occur only after the consumer explicitly asks for its next chunk.
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (++reads === 1) controller.enqueue(chunk);
      else {
        chunk.set(Buffer.from('other.txt'), position);
        controller.enqueue(new Uint8Array([32]));
        controller.close();
      }
    } }, { highWaterMark: 0 });
    const port = httpEvidencePort({ baseUrl: 'https://example.invalid', token: () => token,
      fetch: async () => new Response(body) });
    const actual = await port.describe(context, ref);
    assert.equal(reads, 2);
    assert.equal(Buffer.from(chunk).toString().includes('other.txt'), true, 'the fixture really reuses its source bytes');
    assert.deepEqual(actual, description, 'later source reuse cannot rewrite an earlier observed chunk');
  });
}
