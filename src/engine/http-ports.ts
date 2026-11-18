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

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RESPONSE_CHUNKS = 4096;

async function call(o: HttpPortOptions, ctx: ServiceContext, engine: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const timeoutMs = o.timeoutMs ?? 15_000;
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 120_000,
    'invalid_config', 'HTTP port timeout must be an integer from 100 to 120000 milliseconds');
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const failed = () => new DomainError('unavailable', `The ${engine} engine request could not be completed`);
  const check = () => {
    if (controller.signal.aborted || performance.now() >= deadline) throw failed();
  };
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  // A synchronous credential or transport callback can expire before the first race is installed.
  void aborted.catch(() => {});
  const onAbort = () => rejectAbort(failed());
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const wait = async <T>(pending: Promise<T>): Promise<T> => {
    // A read is already begun when passed here; observe its eventual rejection even if admission expired.
    void pending.catch(() => {});
    check();
    const value = await Promise.race([pending, aborted]);
    check();
    return value;
  };
  const cancelBody = (response: Response) => {
    try { void response.body?.cancel().catch(() => {}); } catch { /* best-effort, never await a host cancel hook */ }
  };
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    check();
    // Rotation is observed once per request. The checked credential must also be sent below.
    const token = o.token();
    check();
    checkScope(ctx, token, engine);
    const url = new URL(path, o.baseUrl);
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    check();
    const transport = Promise.resolve().then(() => {
      check();
      return (o.fetch ?? fetch)(url, {
        method, redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(encoded === undefined ? {} : { body: encoded }),
      });
    });
    // An injected/noncooperative fetch may settle after this call has already timed out.
    void transport.then(late => {
      if (controller.signal.aborted || performance.now() >= deadline) cancelBody(late);
    }, () => {});
    response = await wait(transport);
    const status = response.status;
    const advertised = response.headers.get('content-length');
    if (advertised !== null && (!/^\d+$/.test(advertised) || !Number.isSafeInteger(Number(advertised)) || Number(advertised) > MAX_RESPONSE_BYTES)) throw failed();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (response.body !== null) {
      reader = response.body.getReader();
      for (;;) {
        const part = await wait(reader.read());
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || chunks.length >= MAX_RESPONSE_CHUNKS || part.value.byteLength > MAX_RESPONSE_BYTES - bytes) throw failed();
        bytes += part.value.byteLength;
        // Buffer is a Uint8Array subclass whose slice() aliases the producer's backing storage.
        chunks.push(new Uint8Array(part.value));
        check();
      }
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    check();
    const json: unknown = text === '' ? null : JSON.parse(text);
    check();
    complete = true;
    return { status, json };
  } catch {
    // Host credential/fetch/stream/parse diagnostics may contain private data.
    throw failed();
  } finally {
    clearTimeout(timer);
    controller.abort();
    controller.signal.removeEventListener('abort', onAbort);
    if (reader !== undefined) {
      if (!complete) { try { void reader.cancel().catch(() => {}); } catch { /* best-effort */ } }
      try { reader.releaseLock(); } catch { /* a noncooperative host may still own a read */ }
    } else if (response !== undefined && !complete) cancelBody(response);
  }
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
      const r = await call(o, ctx, 'evidence', 'GET', `/v1/evidence/describe?ref=${encodeURIComponent(ref)}`);
      if (r.status === 404 || (r.status === 403 && errorCode(r.json) !== 'unauthenticated')) return null;
      if (r.status !== 200) throw new DomainError('unavailable', `The evidence engine answered ${r.status}`);
      const v = r.json;
      const requestedRevision = /@([1-9]\d*)$/.exec(ref)?.[1];
      if (!isObj(v) || typeof v.ref !== 'string' || typeof v.evidenceId !== 'string'
        || typeof v.revision !== 'number' || !Number.isSafeInteger(v.revision) || v.revision < 1
        || requestedRevision === undefined || Number(requestedRevision) !== v.revision
        || typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(v.sha256)
        || typeof v.size !== 'number' || !Number.isSafeInteger(v.size) || v.size < 0
        || typeof v.mediaType !== 'string' || typeof v.filename !== 'string' || !(v.compartment === null || typeof v.compartment === 'string') || typeof v.available !== 'boolean') {
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
      const r = await call(o, ctx, 'consent', 'POST', '/v1/use-decisions', request);
      if (r.status !== 200 && r.status !== 201) throw new DomainError('unavailable', `The consent engine answered ${r.status}`);
      const d = r.json;
      if (!isObj(d) || !['allow', 'deny', 'review'].includes(d.decision as string) || !strings(d.reasons) || !strings(d.permissionRefs) || !strings(d.restrictions ?? []) || typeof d.decidedAt !== 'string') {
        throw new DomainError('unavailable', 'The consent engine returned an invalid decision');
      }
      return { decision: d.decision as UseDecision['decision'], reasons: d.reasons, permissionRefs: d.permissionRefs, restrictions: (d.restrictions ?? []) as string[], decidedAt: d.decidedAt };
    },
  };
}
