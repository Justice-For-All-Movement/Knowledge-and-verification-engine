// Standalone server for the knowledge engine: reads env, migrates, serves HTTP. The engine has no background jobs.
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import pg from 'pg';
import { DomainError, invariant } from '../contracts.ts';
import { createHttpHandler, createTokenVerifier, engineClient, pgSql, serve } from '../service-kit.ts';
import type { EvidencePort, EvidenceVersionInfo, ServiceContext, UseDecision, UseDecisionPort } from '../service-kit.ts';
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
const listOf = (v: string | undefined): string[] | undefined => (v === undefined || v.trim() === '' ? undefined : v.split(',').map((x) => x.trim()).filter((x) => x !== ''));
export function configFromEnv(env: Env): EngineConfig {
  const pick = <K extends keyof EngineConfig>(k: K, v: EngineConfig[K] | undefined): Partial<EngineConfig> => (v === undefined ? {} : { [k]: v });
  return {
    ...pick('sourceTypes', listOf(env.KNOWLEDGE_SOURCE_TYPES)), ...pick('primarySourceTypes', listOf(env.KNOWLEDGE_PRIMARY_SOURCE_TYPES)),
    ...pick('proceduralVocabulary', listOf(env.KNOWLEDGE_PROCEDURAL_VOCABULARY)), ...pick('entityTypes', listOf(env.KNOWLEDGE_ENTITY_TYPES)),
    ...pick('searchConfig', env.KNOWLEDGE_SEARCH_CONFIG), ...pick('minRationaleLength', env.KNOWLEDGE_MIN_RATIONALE_LENGTH === undefined ? undefined : Number(env.KNOWLEDGE_MIN_RATIONALE_LENGTH)),
  };
}
/**
 * Optional HTTP ports to the evidence (E05) and consent (E11) engines. The caller's own bearer token is not available
 * here, so a service token is used: implemented, not verified against live E05/E11 deployments.
 */
export function portsFromEnv(env: Env): EnginePorts {
  const token = env.KNOWLEDGE_SERVICE_TOKEN ?? '';
  const out: { evidence?: Pick<EvidencePort, 'describe'>; useDecision?: UseDecisionPort } = {};
  if (env.EVIDENCE_URL !== undefined && env.EVIDENCE_URL !== '') {
    invariant(token !== '', 'invalid_config', 'KNOWLEDGE_SERVICE_TOKEN is required when EVIDENCE_URL is set');
    const client = engineClient(env.EVIDENCE_URL, () => token);
    out.evidence = { async describe(_ctx: ServiceContext, ref: string): Promise<EvidenceVersionInfo | null> {
      try { return await client.call<EvidenceVersionInfo>('GET', `/v1/versions/describe?ref=${encodeURIComponent(ref)}`); }
      catch (error) { if (error instanceof DomainError && error.code === 'not_found') return null; throw error; }
    } };
  }
  if (env.CONSENT_URL !== undefined && env.CONSENT_URL !== '') {
    invariant(token !== '', 'invalid_config', 'KNOWLEDGE_SERVICE_TOKEN is required when CONSENT_URL is set');
    const client = engineClient(env.CONSENT_URL, () => token);
    out.useDecision = { decide: (_ctx, request) => client.call<UseDecision>('POST', '/v1/decisions', request) };
  }
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
