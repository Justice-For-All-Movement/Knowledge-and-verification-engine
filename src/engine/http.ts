// E07 HTTP surface: the kit's standard routes plus the `/v1/...` API. Every handler delegates to one service method,
// so authorization, tenancy, compartments and identity withholding are exactly those of the service layer.
import { DomainError } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { standardRoutes } from '../service-kit.ts';
import type { HttpRequest, Route } from '../service-kit.ts';
import type { KnowledgeEngine } from './service.ts';

type Handler = (r: HttpRequest, body: any) => Promise<unknown>;
/** The idempotency key may come from the `Idempotency-Key` header instead of the body. */
function body(r: HttpRequest): Record<string, unknown> {
  const b = r.body === undefined || r.body === null ? {} : r.body;
  if (typeof b !== 'object' || Array.isArray(b)) throw new DomainError('invalid_input', 'A JSON object body is required');
  const key = r.headers['idempotency-key'];
  return typeof key === 'string' && key !== '' && (b as Record<string, unknown>).idempotencyKey === undefined ? { ...(b as Record<string, unknown>), idempotencyKey: key } : (b as Record<string, unknown>);
}
const q = (r: HttpRequest, ...names: string[]): Record<string, string> => Object.fromEntries(names.flatMap((n) => { const v = r.query.get(n); return v === null || v === '' ? [] : [[n, v]]; }));

export function routes(engine: KnowledgeEngine): Route[] {
  const e = engine as any;
  const route = (method: Route['method'], path: string, fn: Handler, status?: number): Route => ({ method, path, handler: async (r) => { const out = await fn(r, method === 'GET' ? undefined : body(r)); return status === undefined ? (out as Json) : { status, json: out }; } });
  const post = (path: string, fn: Handler): Route => route('POST', path, fn, 201);
  return [
    ...standardRoutes(engine),
    // entities
    post('/v1/entities', (r, b) => e.createEntity(r.ctx, b)),
    route('GET', '/v1/entities/:id', (r) => e.getEntity(r.ctx, r.params.id)),
    route('PATCH', '/v1/entities/:id', (r, b) => e.reviseEntity(r.ctx, r.params.id, b)),
    post('/v1/entity-matches', (r, b) => e.recordEntityMatch(r.ctx, b)),
    post('/v1/entity-merges', (r, b) => e.mergeEntities(r.ctx, b)),
    route('POST', '/v1/entity-merges/:id/reverse', (r, b) => e.unmergeEntities(r.ctx, r.params.id, b)),
    // claims and assessments
    post('/v1/claims', (r, b) => e.createClaim(r.ctx, b)),
    route('GET', '/v1/claims/:id', (r) => e.getClaim(r.ctx, r.params.id)),
    route('PATCH', '/v1/claims/:id', (r, b) => e.reviseClaim(r.ctx, r.params.id, b)),
    route('GET', '/v1/claims/:id/history', (r) => e.claimHistory(r.ctx, r.params.id)),
    route('GET', '/v1/claims/:id/independence', (r) => e.independence(r.ctx, r.params.id)),
    route('GET', '/v1/claims/:id/assessments', (r) => e.assessments(r.ctx, r.params.id)),
    post('/v1/claims/:id/assessments', (r, b) => e.recordAssessment(r.ctx, r.params.id, b)),
    post('/v1/claims/:id/assessment-proposals', (r, b) => e.proposeAssessment(r.ctx, r.params.id, b)),
    route('POST', '/v1/assessment-proposals/:id/reject', (r, b) => e.rejectAssessmentProposal(r.ctx, r.params.id, b)),
    // statements, evidence links, relationships, events
    post('/v1/statements', (r, b) => e.createStatement(r.ctx, b)),
    route('PATCH', '/v1/statements/:id', (r, b) => e.reviseStatement(r.ctx, r.params.id, b)),
    post('/v1/evidence-links', (r, b) => e.addEvidenceLink(r.ctx, b)),
    route('PATCH', '/v1/evidence-links/:id', (r, b) => e.reviseEvidenceLink(r.ctx, r.params.id, b)),
    route('POST', '/v1/evidence-links/:id/retract', (r, b) => e.retractEvidenceLink(r.ctx, r.params.id, b)),
    post('/v1/relationships', (r, b) => e.createRelationship(r.ctx, b)),
    route('PATCH', '/v1/relationships/:id', (r, b) => e.reviseRelationship(r.ctx, r.params.id, b)),
    post('/v1/events', (r, b) => e.createEvent(r.ctx, b)),
    route('PATCH', '/v1/events/:id', (r, b) => e.reviseEvent(r.ctx, r.params.id, b)),
    // source families, contradictions, alternative explanations
    post('/v1/source-families', (r, b) => e.createSourceFamily(r.ctx, b)),
    route('PATCH', '/v1/source-families/:id', (r, b) => e.reviseSourceFamily(r.ctx, r.params.id, b)),
    post('/v1/source-family-suggestions', (r, b) => e.suggestSourceFamilies(r.ctx, b)),
    post('/v1/contradictions', (r, b) => e.recordContradiction(r.ctx, b)),
    route('POST', '/v1/contradictions/:id/resolution', (r, b) => e.resolveContradiction(r.ctx, r.params.id, b)),
    post('/v1/alternatives', (r, b) => e.addAlternativeExplanation(r.ctx, b)),
    route('PATCH', '/v1/alternatives/:id', (r, b) => e.reviseAlternativeExplanation(r.ctx, r.params.id, b)),
    // proposals (untrusted input)
    post('/v1/proposals/claims', (r, b) => e.proposeClaims(r.ctx, b)),
    post('/v1/proposals/entities', (r, b) => e.proposeEntities(r.ctx, b)),
    post('/v1/proposals/links', (r, b) => e.proposeLinks(r.ctx, b)),
    route('POST', '/v1/proposals/:id/review', (r, b) => e.reviewProposal(r.ctx, r.params.id, b)),
    // queries
    route('GET', '/v1/records/:kind', (r) => { const f = q(r, 'caseId', 'state', 'limit'); return e.list(r.ctx, r.params.kind, { ...f, ...(f.limit === undefined ? {} : { limit: Number(f.limit) }) }); }),
    route('GET', '/v1/records/:kind/:id', (r) => e.get(r.ctx, r.params.kind, r.params.id)),
    route('GET', '/v1/records/:kind/:id/history', (r) => e.history(r.ctx, r.params.kind, r.params.id)),
    route('GET', '/v1/graphs/evidence', async (r) => {
      const g = await e.evidenceGraph(r.ctx, q(r, 'claimId', 'entityId', 'caseId'));
      // `format=text` returns the accessible plain-text equivalent of the graph.
      return r.query.get('format') === 'text' ? { text: g.text } : g;
    }),
    route('GET', '/v1/research-gaps', (r) => e.researchGaps(r.ctx, q(r, 'caseId'))),
    route('GET', '/v1/chronology', (r) => e.chronology(r.ctx, q(r, 'caseId', 'entityId', 'from', 'to'))),
    route('POST', '/v1/impact', (r, b) => e.impactOf(r.ctx, b.refs)),
    route('GET', '/v1/search/records', (r) => { const f = q(r, 'q', 'limit', 'kinds'); return e.searchRecords(r.ctx, { q: f.q ?? '', ...(f.limit === undefined ? {} : { limit: Number(f.limit) }), ...(f.kinds === undefined ? {} : { kinds: f.kinds.split(',') }) }); }),
    route('POST', '/v1/usability', (r, b) => e.usability(r.ctx, b)),
    route('GET', '/v1/exports/dossier', (r) => e.exportDossier(r.ctx, q(r, 'claimId', 'caseId'))),
    // corrections and flags
    post('/v1/corrections', (r, b) => e.openCorrection(r.ctx, b)),
    route('POST', '/v1/flags/resolve', (r, b) => { const { target, ...rest } = b; return e.resolveFlag(r.ctx, target, rest); }),
  ];
}
