// Opt-in live verification of the standalone server's HTTP ports against running E05 / E11 engines.
//
//   EVIDENCE_URL, CONSENT_URL           base URLs of the deployed evidence / consent engines (either or both)
//   KNOWLEDGE_SERVICE_TOKEN(_FILE)      E01-issued service token for one tenant/project (caps: evidence:read, consent:decide)
//   KNOWLEDGE_LIVE_EVIDENCE_REF         optional: a pinned E05 version ref that exists in that scope (E05:evidence_version:<id>@<rev>)
//   KNOWLEDGE_LIVE_CONSENT_SUBJECT      optional: subject ref for the consent probe (default: a synthetic, unknown E03 message ref)
//   KNOWLEDGE_URL + KNOWLEDGE_TOKEN     optional: a deployed knowledge engine whose /healthz and /v1/manifest are checked
//
// Without any of the URLs every check is reported as SKIPPED and the script exits 0, so it is safe in CI without secrets.
// Read-only except for the consent probe, which records one use decision about a synthetic subject in E11.
// Prints names and outcomes only; never prints tokens.
import { readFileSync } from 'node:fs';
import { httpEvidencePort, httpUseDecisionPort, serviceTokenScope } from '../src/engine/http-ports.ts';
import type { ServiceContext } from '../src/service-kit.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type Outcome = { check: string; status: 'passed' | 'failed' | 'skipped'; detail: string };

const set = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';
function tokenOf(env: Env): string | null {
  if (set(env.KNOWLEDGE_SERVICE_TOKEN_FILE)) return readFileSync(env.KNOWLEDGE_SERVICE_TOKEN_FILE, 'utf8').trim();
  return set(env.KNOWLEDGE_SERVICE_TOKEN) ? env.KNOWLEDGE_SERVICE_TOKEN.trim() : null;
}
const message = (e: unknown): string => (e instanceof Error ? `${(e as { code?: string }).code ?? e.name}: ${e.message}` : 'error');

export async function verifyLive(env: Env = process.env): Promise<Outcome[]> {
  const out: Outcome[] = [];
  const add = (check: string, status: Outcome['status'], detail: string): void => { out.push({ check, status, detail }); };

  if (set(env.KNOWLEDGE_URL)) {
    try {
      const h = await fetch(new URL('/healthz', env.KNOWLEDGE_URL), { redirect: 'error', signal: AbortSignal.timeout(90_000) });
      const body = await h.json() as { ok?: boolean; engine?: string };
      add('knowledge /healthz', h.ok && body.ok === true ? 'passed' : 'failed', `HTTP ${h.status}`);
      const m = await fetch(new URL('/v1/manifest', env.KNOWLEDGE_URL), { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      const manifest = await m.json() as { id?: string };
      add('knowledge /v1/manifest', manifest.id === 'E07' ? 'passed' : 'failed', `id=${String(manifest.id)}`);
      if (set(env.KNOWLEDGE_TOKEN)) {
        const r = await fetch(new URL('/v1/research-gaps', env.KNOWLEDGE_URL), { headers: { authorization: `Bearer ${env.KNOWLEDGE_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
        add('knowledge authenticated read', r.status === 200 ? 'passed' : 'failed', `HTTP ${r.status}`);
      } else add('knowledge authenticated read', 'skipped', 'KNOWLEDGE_TOKEN not set');
    } catch (e) { add('knowledge reachability', 'failed', message(e)); }
  } else add('knowledge deployment', 'skipped', 'KNOWLEDGE_URL not set');

  if (!set(env.EVIDENCE_URL) && !set(env.CONSENT_URL)) {
    add('evidence port', 'skipped', 'EVIDENCE_URL not set'); add('consent port', 'skipped', 'CONSENT_URL not set');
    return out;
  }
  const token = tokenOf(env);
  if (token === null) { add('service token', 'failed', 'KNOWLEDGE_SERVICE_TOKEN or KNOWLEDGE_SERVICE_TOKEN_FILE is required when EVIDENCE_URL or CONSENT_URL is set'); return out; }
  let scope: ReturnType<typeof serviceTokenScope>;
  try { scope = serviceTokenScope(token); } catch (e) { add('service token', 'failed', message(e)); return out; }
  const expired = scope.exp !== null && scope.exp * 1000 <= Date.now();
  add('service token', expired ? 'failed' : 'passed', expired ? 'token has expired' : 'tenant/project scope present');
  const ctx: ServiceContext = { tenantId: scope.tid, projectId: scope.pid, purpose: 'verification', requestId: `live-${Date.now()}`, now: new Date().toISOString(), actor: { id: 'knowledge-live-verification', kind: 'service', roles: [] }, capabilities: [], compartments: [] };
  const options = { token: () => token, timeoutMs: 90_000 };

  if (set(env.EVIDENCE_URL)) {
    const port = httpEvidencePort({ ...options, baseUrl: env.EVIDENCE_URL });
    try {
      const missing = await port.describe(ctx, `E05:evidence_version:knowledge-live-probe-${Date.now()}@1`);
      add('evidence describe: unknown version reads as absent', missing === null ? 'passed' : 'failed', missing === null ? 'null' : 'unexpected description');
    } catch (e) { add('evidence describe: unknown version reads as absent', 'failed', message(e)); }
    if (set(env.KNOWLEDGE_LIVE_EVIDENCE_REF)) {
      try {
        const info = await port.describe(ctx, env.KNOWLEDGE_LIVE_EVIDENCE_REF);
        add('evidence describe: known version', info !== null && info.ref === env.KNOWLEDGE_LIVE_EVIDENCE_REF ? 'passed' : 'failed', info === null ? 'not found in the token scope' : `available=${info.available}`);
      } catch (e) { add('evidence describe: known version', 'failed', message(e)); }
    } else add('evidence describe: known version', 'skipped', 'KNOWLEDGE_LIVE_EVIDENCE_REF not set');
  } else add('evidence port', 'skipped', 'EVIDENCE_URL not set');

  if (set(env.CONSENT_URL)) {
    const port = httpUseDecisionPort({ ...options, baseUrl: env.CONSENT_URL });
    const subject = set(env.KNOWLEDGE_LIVE_CONSENT_SUBJECT) ? env.KNOWLEDGE_LIVE_CONSENT_SUBJECT : `E03:message:knowledge-live-probe-${Date.now()}`;
    try {
      const d = await port.decide(ctx, { subjects: [subject], action: 'investigate', purpose: 'verification' });
      add('consent use-decision', 'passed', `decision=${d.decision}`);
    } catch (e) { add('consent use-decision', 'failed', message(e)); }
  } else add('consent port', 'skipped', 'CONSENT_URL not set');
  return out;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  verifyLive().then((outcomes) => {
    for (const o of outcomes) console.log(`${o.status.toUpperCase().padEnd(7)} ${o.check} — ${o.detail}`);
    const failed = outcomes.filter((o) => o.status === 'failed').length;
    console.log(failed === 0 ? (outcomes.every((o) => o.status === 'skipped') ? 'All live checks SKIPPED (no endpoints configured).' : 'Live verification passed.') : `${failed} live check(s) FAILED.`);
    process.exit(failed === 0 ? 0 : 1);
  }).catch((e: unknown) => { console.error(message(e)); process.exit(1); });
}
