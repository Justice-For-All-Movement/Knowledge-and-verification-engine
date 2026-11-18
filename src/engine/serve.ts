// Standalone server for the knowledge engine: reads env, migrates, serves HTTP. The engine has no background jobs.
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import pg from 'pg';
import { DomainError, invariant } from '../contracts.ts';
import { createHttpHandler, createTokenVerifier, pgSql, serve } from '../service-kit.ts';
import type { EvidencePort, UseDecisionPort } from '../service-kit.ts';
import { httpEvidencePort, httpUseDecisionPort, serviceTokenScope } from './http-ports.ts';
export { httpEvidencePort, httpUseDecisionPort, serviceTokenScope } from './http-ports.ts';
import { createEngine, manifest, migrate, routes } from './index.ts';
import type { EngineConfig, EnginePorts, KnowledgeEngine } from './index.ts';

type Env = Readonly<Record<string, string | undefined>>;
export function publicKeysFromEnv(env: Env): Record<string, string> {
  const raw = env.IDENTITY_PUBLIC_KEYS ?? (env.IDENTITY_JWKS_FILE === undefined ? undefined : readFileSync(env.IDENTITY_JWKS_FILE, 'utf8'));
  invariant(raw !== undefined && raw !== '', 'invalid_config', 'IDENTITY_PUBLIC_KEYS (JSON map kid→PEM) or IDENTITY_JWKS_FILE is required');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new DomainError('invalid_config', 'Identity public keys must be JSON'); }
  invariant(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Object.values(parsed).every((v) => typeof v === 'string'), 'invalid_config', 'Identity public keys must be a JSON map of key id to PEM');
  return parsed as Record<string, string>;
}
/** `KNOWLEDGE_NAME_EQUIVALENCES`: a JSON list of [from, to] pairs of lowercase ASCII, for example [["kh","x"],["gh","q"]]. */
function equivalencesOf(v: string | undefined): (readonly [string, string])[] | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(v); } catch { throw new DomainError('invalid_config', 'KNOWLEDGE_NAME_EQUIVALENCES must be JSON'); }
  invariant(Array.isArray(parsed) && parsed.length <= 100 && parsed.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'string' && /^[A-Za-z]{0,4}$/.test(x)) && p[0] !== ''), 'invalid_config', 'KNOWLEDGE_NAME_EQUIVALENCES must be a list of [from, to] letter pairs');
  return parsed as [string, string][];
}
const listOf = (v: string | undefined): string[] | undefined => (v === undefined || v.trim() === '' ? undefined : v.split(',').map((x) => x.trim()).filter((x) => x !== ''));
export function configFromEnv(env: Env): EngineConfig {
  const pick = <K extends keyof EngineConfig>(k: K, v: EngineConfig[K] | undefined): Partial<EngineConfig> => (v === undefined ? {} : { [k]: v });
  return {
    ...pick('sourceTypes', listOf(env.KNOWLEDGE_SOURCE_TYPES)), ...pick('primarySourceTypes', listOf(env.KNOWLEDGE_PRIMARY_SOURCE_TYPES)),
    ...pick('proceduralVocabulary', listOf(env.KNOWLEDGE_PROCEDURAL_VOCABULARY)), ...pick('entityTypes', listOf(env.KNOWLEDGE_ENTITY_TYPES)),
    ...pick('searchConfig', env.KNOWLEDGE_SEARCH_CONFIG), ...pick('maxScanRecords', env.KNOWLEDGE_MAX_SCAN_RECORDS === undefined || env.KNOWLEDGE_MAX_SCAN_RECORDS === '' ? undefined : Number(env.KNOWLEDGE_MAX_SCAN_RECORDS)), ...pick('minRationaleLength', env.KNOWLEDGE_MIN_RATIONALE_LENGTH === undefined ? undefined : Number(env.KNOWLEDGE_MIN_RATIONALE_LENGTH)),
    ...pick('nameEquivalences', equivalencesOf(env.KNOWLEDGE_NAME_EQUIVALENCES)),
  };
}
/** The service token, from `KNOWLEDGE_SERVICE_TOKEN` or (re-read on every call, so rotation needs no restart) `KNOWLEDGE_SERVICE_TOKEN_FILE`. */
export function serviceTokenFromEnv(env: Env): (() => string) | null {
  if (env.KNOWLEDGE_SERVICE_TOKEN_FILE !== undefined && env.KNOWLEDGE_SERVICE_TOKEN_FILE !== '') {
    const file = env.KNOWLEDGE_SERVICE_TOKEN_FILE;
    const read = (): string => { const t = readFileSync(file, 'utf8').trim(); invariant(t !== '', 'invalid_config', 'KNOWLEDGE_SERVICE_TOKEN_FILE is empty'); return t; };
    read();
    return read;
  }
  const token = env.KNOWLEDGE_SERVICE_TOKEN ?? '';
  return token === '' ? null : () => token;
}
const httpUrl = (name: string, v: string): string => {
  let u: URL;
  try { u = new URL(v); } catch { throw new DomainError('invalid_config', `${name} must be an absolute http(s) URL`); }
  invariant(u.protocol === 'https:' || u.protocol === 'http:', 'invalid_config', `${name} must be an absolute http(s) URL`);
  return u.href;
};
/**
 * Optional HTTP ports to the evidence (E05) and consent (E11) engines for a standalone deployment (see `http-ports.ts`).
 * The caller's own bearer token is not forwarded; a service token scoped to one tenant/project is used instead.
 */
export function portsFromEnv(env: Env): EnginePorts {
  const out: { evidence?: Pick<EvidencePort, 'describe'>; useDecision?: UseDecisionPort } = {};
  const evidenceUrl = env.EVIDENCE_URL ?? '', consentUrl = env.CONSENT_URL ?? '';
  if (evidenceUrl === '' && consentUrl === '') return out;
  const token = serviceTokenFromEnv(env);
  invariant(token !== null, 'invalid_config', 'KNOWLEDGE_SERVICE_TOKEN or KNOWLEDGE_SERVICE_TOKEN_FILE is required when EVIDENCE_URL or CONSENT_URL is set');
  serviceTokenScope(token());
  const timeoutMs = env.KNOWLEDGE_PORT_TIMEOUT_MS === undefined || env.KNOWLEDGE_PORT_TIMEOUT_MS === '' ? undefined : Number(env.KNOWLEDGE_PORT_TIMEOUT_MS);
  invariant(timeoutMs === undefined || (Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 120_000), 'invalid_config', 'KNOWLEDGE_PORT_TIMEOUT_MS must be an integer between 100 and 120000');
  const options = { token, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  if (evidenceUrl !== '') out.evidence = httpEvidencePort({ ...options, baseUrl: httpUrl('EVIDENCE_URL', evidenceUrl) });
  if (consentUrl !== '') out.useDecision = httpUseDecisionPort({ ...options, baseUrl: httpUrl('CONSENT_URL', consentUrl) });
  return out;
}
export type Running = Readonly<{ server: Server; engine: KnowledgeEngine; port: number; close(): Promise<void> }>;

export async function start(env: Env = process.env): Promise<Running> {
  invariant(typeof env.DATABASE_URL === 'string' && env.DATABASE_URL !== '', 'invalid_config', 'DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(env.DATABASE_POOL_MAX ?? 10) });
  try {
    const sql = pgSql(pool);
    await migrate(sql);
    const engine = createEngine({ sql, ports: portsFromEnv(env), config: configFromEnv(env) });
    const handler = createHttpHandler({
      name: manifest.name, version: manifest.version, routes: routes(engine), maxBodyBytes: 4 * 1024 * 1024, health: () => engine.health(),
      verify: createTokenVerifier({ publicKeys: publicKeysFromEnv(env), ...(env.IDENTITY_ISSUER === undefined ? {} : { issuer: env.IDENTITY_ISSUER }) }),
      onError: (error, info) => { console.error(JSON.stringify({ level: 'error', requestId: info.requestId, method: info.method, path: info.path, error: error instanceof Error ? error.name : 'unknown' })); },
    });
    const server = await serve(handler, Number(env.PORT ?? 8080), env.HOST ?? '127.0.0.1');
    const address = server.address();
    return { server, engine, port: typeof address === 'object' && address !== null ? address.port : Number(env.PORT ?? 8080), async close() { await new Promise<void>((r) => server.close(() => r())); await pool.end(); } };
  } catch (error) { await pool.end(); throw error; }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  start().then((running) => {
    console.log(JSON.stringify({ level: 'info', message: 'knowledge engine listening', port: running.port }));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void running.close().then(() => process.exit(0)); });
  }).catch((error: unknown) => { console.error(JSON.stringify({ level: 'fatal', error: error instanceof Error ? error.message : 'startup failed' })); process.exit(1); });
}
