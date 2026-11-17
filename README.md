# Knowledge and verification engine

Country-neutral private knowledge primitives for the accountability engine suite. The initial package records bounded entity/event/unassessed-claim revisions and preserves unknown dates, explicit attribution and immutable in-memory history. It does not verify evidence, authenticate users, infer guilt, produce legal findings or authorize publication.

`npm ci && npm run check` runs typecheck, meaningful neutral domain tests, build and plan-registry validation. Public exports are the root model API and `./contracts`.

See [architecture](docs/ARCHITECTURE.md) and [registry](registry/prs.json). The full approved15-engine/122-task source plan is retained in docs/approved-design. Operational PAM remains deferred; its separately accepted foundation is not implemented here.

## Service layer

The engine's completed service lives in `src/engine/` (package exports `./engine` and `./serve`) and is documented in [docs/ENGINE_API.md](docs/ENGINE_API.md): entities with protected identities and reversible merges, relationships, events, claims, attributed statements, evidence links, source families, contradictions, alternative explanations, four separate assessment dimensions, untrusted proposals, evidence graphs, claim histories, research gaps, chronology, correction impact and upstream stale/blocked propagation.

- Run: `DATABASE_URL=postgresql://… IDENTITY_PUBLIC_KEYS='{"kid":"-----BEGIN PUBLIC KEY-----…"}' PORT=8080 npm run serve`
- Test: `TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/postgres npm run check` (service tests create and drop their own databases and are skipped visibly when the variable is unset).
- Use: `createEngine({ sql: pgSql(pool), ports, config })` after `migrate(sql)`; every method takes a `ServiceContext` first.
- Cross-engine: `KVE_E05_DIR=… KVE_E11_DIR=… TEST_DATABASE_URL=… npm run test:cross-engine` runs the HTTP ports against the real evidence and consent engines (CI job `cross-engine`).
- Live: `npm run verify:live` (and the manually dispatched **Live verification** workflow) checks deployed engines; it reports SKIPPED without endpoints.

**Status: complete** against the E07 catalog entry and `docs/ENGINE_API.md`; a standalone hosted deployment is pending owner credentials (env var names in [ENGINE_API.md → Owner-only steps](docs/ENGINE_API.md#owner-only-steps-complete-pending-owner-credentials)). PAM composes this engine in-process.

The earlier statement that this package does not verify evidence or hold assessments describes the foundation modules only; the service layer records human verification assessments. It still infers nothing: no guilt, no legal finding, no numeric score.
