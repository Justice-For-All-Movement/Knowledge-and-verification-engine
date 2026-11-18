// Synthetic token payloads exercise credential selection, not signature verification.
// The receiving E05/E11 engine remains responsible for verifying the signed token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/contracts.ts';
import type { ServiceContext } from '../src/service-kit.ts';
import { httpEvidencePort, httpUseDecisionPort } from '../src/engine/http-ports.ts';

const token = (tid: string, pid: string, label: string) =>
  `header.${Buffer.from(JSON.stringify({ tid, pid, label })).toString('base64url')}.signature`;
const scope = (): ServiceContext => ({
  tenantId: 'tenant-a', projectId: 'project-a', purpose: 'research',
  requestId: 'request-a', now: '2026-01-01T00:00:00.000Z',
  actor: { id: 'reviewer-a', kind: 'human', roles: [] },
  capabilities: ['knowledge:read'], compartments: [],
});
const ref = 'E05:evidence_version:example@1';
const adapters = [
  {
    name: 'Evidence',
    response: { ref, evidenceId: 'example', revision: 1, sha256: 'a'.repeat(64), size: 1,
      mediaType: 'text/plain', filename: 'example.txt', compartment: null, available: true },
    create: (options: Parameters<typeof httpEvidencePort>[0]) => {
      const port = httpEvidencePort(options);
      return () => port.describe(scope(), ref);
    },
  },
  {
    name: 'Consent',
    response: { decision: 'allow', reasons: [], permissionRefs: [], restrictions: [], decidedAt: '2026-01-01T00:00:00.000Z' },
    create: (options: Parameters<typeof httpUseDecisionPort>[0]) => {
      const port = httpUseDecisionPort(options);
      return () => port.decide(scope(), {
        subjects: ['E03:message:example'], action: 'investigate', purpose: 'research',
      });
    },
  },
];

for (const adapter of adapters) {
  test(`${adapter.name} sends the exact credential whose scope was checked, reading the provider once`, async () => {
    const first = token('tenant-a', 'project-a', 'first');
    const foreign = token('tenant-b', 'project-b', 'rotated');
    let reads = 0;
    const sent: string[] = [];
    const result = await adapter.create({
      baseUrl: 'https://example.invalid', token: () => ++reads === 1 ? first : foreign,
      fetch: async (_url, init) => {
        sent.push(new Headers(init?.headers).get('authorization') ?? '');
        return Response.json(adapter.response);
      },
    })();
    assert.ok(result);
    assert.deepEqual(sent, [`Bearer ${first}`]);
    assert.equal(reads, 1);
  });

  test(`${adapter.name} refreshes the credential on the next call and denies changed tenant or project before transport`, async () => {
    let current = token('tenant-a', 'project-a', 'first');
    let reads = 0;
    const sent: string[] = [];
    const options = {
      baseUrl: 'https://example.invalid', token: () => { reads++; return current; },
      fetch: (async (_url, init) => {
        sent.push(new Headers(init?.headers).get('authorization') ?? '');
        return Response.json(adapter.response);
      }) as typeof fetch,
    };
    const invoke = adapter.create(options);
    await invoke();
    current = token('tenant-a', 'project-a', 'second');
    await invoke();
    assert.deepEqual(sent, [
      `Bearer ${token('tenant-a', 'project-a', 'first')}`, `Bearer ${current}`,
    ]);
    for (const [tid, pid] of [['tenant-b', 'project-a'], ['tenant-a', 'project-b']]) {
      current = token(tid!, pid!, 'foreign');
      await assert.rejects(invoke(), (e: unknown) => e instanceof DomainError && e.code === 'unavailable');
    }
    assert.equal(reads, 4);
    assert.equal(sent.length, 2, 'foreign credentials must never authorize a request');
  });
}
