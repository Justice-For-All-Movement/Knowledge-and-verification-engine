// HTTP adapters for the optional EvidencePort (E05) and UseDecisionPort (E11) of the standalone server.
// Route paths and response shapes follow the E05 / E11 engines' own route tables:
//   E05 `GET  /v1/evidence/describe?ref=<E05:evidence_version:…@rev>` → VersionDetail (superset of EvidenceVersionInfo); 404 `not_found`
//   E11 `POST /v1/use-decisions` { subjects, action, purpose, audience?, … }  → RecordedDecision (superset of UseDecision)
// Under PAM the host passes in-process ports instead; these adapters are for a standalone deployment.
//
// The bearer token is a service credential that E01 issued for ONE tenant/project. A request whose context names a
// different tenant or project is refused here (fail closed) rather than answered from another scope's records.
import { DomainError, invariant } from '../contracts.ts';
import type { EvidencePort, EvidenceVersionInfo, ServiceContext, UseDecision, UseDecisionPort } from '../service-kit.ts';

export type HttpPortOptions = Readonly<{
  baseUrl: string;
  /** Called per request so that a rotated token file is picked up. */
  token: () => string;
  timeoutMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}>;

type Scope = { tid: string; pid: string; exp: number | null };
/** Reads the tenant/project/expiry claims of the service token. The receiving engine verifies the signature. */
export function serviceTokenScope(token: string): Scope {
  const body = token.split('.')[1];
  invariant(typeof body === 'string' && body !== '', 'invalid_config', 'The service token is not a signed access token');
  let claims: Record<string, unknown>;
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>; } catch { throw new DomainError('invalid_config', 'The service token is not a signed access token'); }
  invariant(typeof claims.tid === 'string' && typeof claims.pid === 'string', 'invalid_config', 'The service token carries no tenant/project scope');
  return { tid: claims.tid, pid: claims.pid, exp: typeof claims.exp === 'number' ? claims.exp : null };
}

function checkScope(ctx: ServiceContext, token: string, engine: string): void {
  const s = serviceTokenScope(token);
  if (s.tid !== ctx.tenantId || s.pid !== ctx.projectId) throw new DomainError('unavailable', `The ${engine} service credential is scoped to a different tenant or project`);
}

async function call(o: HttpPortOptions, engine: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const token = o.token();
  let response: Response;
  try {
    response = await (o.fetch ?? fetch)(new URL(path, o.baseUrl), {
      method, redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new DomainError('unavailable', `The ${engine} engine could not be reached`); }
  let json: unknown = null;
  try { json = await response.json(); } catch { /* non-JSON body */ }
  return { status: response.status, json };
}
const errorCode = (json: unknown): string | null => {
  const e = (json as { error?: { code?: unknown } } | null)?.error;
  return typeof e?.code === 'string' ? e.code : null;
};
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** EvidencePort.describe over E05 HTTP. Unknown or inaccessible versions read as null; anything else that fails is `unavailable`. */
export function httpEvidencePort(o: HttpPortOptions): Pick<EvidencePort, 'describe'> {
  return {
    async describe(ctx: ServiceContext, ref: string): Promise<EvidenceVersionInfo | null> {
      checkScope(ctx, o.token(), 'evidence');
      const r = await call(o, 'evidence', 'GET', `/v1/evidence/describe?ref=${encodeURIComponent(ref)}`);
      if (r.status === 404 || (r.status === 403 && errorCode(r.json) !== 'unauthenticated')) return null;
      if (r.status !== 200) throw new DomainError('unavailable', `The evidence engine answered ${r.status}`);
      const v = r.json;
      if (!isObj(v) || typeof v.ref !== 'string' || typeof v.evidenceId !== 'string' || !Number.isSafeInteger(v.revision) || typeof v.sha256 !== 'string'
        || typeof v.size !== 'number' || typeof v.mediaType !== 'string' || typeof v.filename !== 'string' || !(v.compartment === null || typeof v.compartment === 'string') || typeof v.available !== 'boolean') {
        throw new DomainError('unavailable', 'The evidence engine returned an invalid version description');
      }
      // The answer must describe the version that was asked for, not, for example, the current one.
      if (v.ref !== ref) throw new DomainError('unavailable', 'The evidence engine described a different version than the one cited');
      return { ref: v.ref, evidenceId: v.evidenceId, revision: v.revision as number, sha256: v.sha256, size: v.size, mediaType: v.mediaType, filename: v.filename, compartment: v.compartment as string | null, available: v.available };
    },
  };
}

/** UseDecisionPort over E11 HTTP. Any failure or malformed answer is `unavailable` (never a silent allow). */
export function httpUseDecisionPort(o: HttpPortOptions): UseDecisionPort {
  return {
    async decide(ctx, request): Promise<UseDecision> {
      checkScope(ctx, o.token(), 'consent');
      const r = await call(o, 'consent', 'POST', '/v1/use-decisions', request);
      if (r.status !== 200 && r.status !== 201) throw new DomainError('unavailable', `The consent engine answered ${r.status}`);
      const d = r.json;
      if (!isObj(d) || !['allow', 'deny', 'review'].includes(d.decision as string) || !strings(d.reasons) || !strings(d.permissionRefs) || !strings(d.restrictions ?? []) || typeof d.decidedAt !== 'string') {
        throw new DomainError('unavailable', 'The consent engine returned an invalid decision');
      }
      return { decision: d.decision as UseDecision['decision'], reasons: d.reasons, permissionRefs: d.permissionRefs, restrictions: (d.restrictions ?? []) as string[], decidedAt: d.decidedAt };
    },
  };
}
