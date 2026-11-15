# E07 Knowledge and Verification — engine API

Service layer of the knowledge engine (schema `e07_knowledge`, capability prefix `knowledge`).
Vendored kit: `src/service-kit.ts` 1.0.1, sha256 `95475a907267ba1fdd54b557aabe5645c37add9788a5b2d0854d9accfd5d8ea5` (byte-identical to the Identity engine's copy). `src/contracts.ts` is the Identity version.

## Entry points

```ts
import { SCHEMA, manifest, migrations, migrate, createEngine, routes } from '@accountability/knowledge-verification/engine';
import { start } from '@accountability/knowledge-verification/serve';

createEngine({ sql: Sql, ports?: { evidence?: Pick<EvidencePort,'describe'>; useDecision?: UseDecisionPort; authorization?: AuthorizationPort },
               config?: { sourceTypes?, primarySourceTypes?, proceduralVocabulary?, entityTypes?, minRationaleLength?, searchConfig? } }): KnowledgeEngine
```

Standalone server: `npm run serve` (`node src/engine/serve.ts`). The engine has no background jobs.

| Env | Meaning |
|---|---|
| `DATABASE_URL` | PostgreSQL (required). Migrations run at start. |
| `PORT`, `HOST` | Listen address (default 8080, 127.0.0.1). |
| `IDENTITY_PUBLIC_KEYS` or `IDENTITY_JWKS_FILE` | JSON map kid→PEM of E01 token keys (required). `IDENTITY_ISSUER` optional. |
| `KNOWLEDGE_SOURCE_TYPES`, `KNOWLEDGE_PRIMARY_SOURCE_TYPES`, `KNOWLEDGE_PROCEDURAL_VOCABULARY`, `KNOWLEDGE_ENTITY_TYPES` | Comma-separated deployment vocabularies. |
| `KNOWLEDGE_SEARCH_CONFIG` | PostgreSQL text-search configuration (default `simple`). |
| `KNOWLEDGE_MIN_RATIONALE_LENGTH` | Minimum length of a documented rationale (default 40). |
| `EVIDENCE_URL`, `CONSENT_URL`, `KNOWLEDGE_SERVICE_TOKEN` | Optional HTTP ports to E05 / E11. **Implemented, not verified against live E05/E11**: the route paths used (`GET /v1/versions/describe?ref=`, `POST /v1/decisions`) are assumptions; in-process ports supplied by the host are the tested path. |

No object store is used. `OBJECT_STORE*` variables are ignored.

## Capabilities

| Capability | Grants |
|---|---|
| `knowledge:read` | Every read, search, graph, gap, chronology, impact and inspect call. |
| `knowledge:write` | Direct creation/revision of records. **Human actors only.** |
| `knowledge:propose` | Submitting untrusted proposals and assessment proposals (any actor kind, including agents). |
| `knowledge:review` | Accepting/rejecting proposals. Human only. |
| `knowledge:assess` | Recording the source-type dimension. Human only. |
| `knowledge:approve` | Recording factual, procedural and editorial assessments; rejecting assessment proposals; clearing stale/blocked flags. Human only; never granted by `knowledge:*`. |
| `knowledge:merge` | Merging and unmerging entities. Human only. |
| `knowledge:disclose_identity` | Seeing protected identities (also needs the identity compartment). Never granted by `knowledge:*`. |
| `knowledge:export` | `exportDossier`. Never granted by `knowledge:*`. |
| `knowledge:audit` | Audit feed. |
| `knowledge:events` | Outbox feed (tenant-wide, as the kit's `readEvents`). Never granted by `knowledge:*`. |
| `knowledge:upstream` | `applyUpstreamChange`. |

When an `AuthorizationPort` is supplied it is re-checked before approve, merge, export, flag resolution and identity disclosure; a denial or a port failure denies.

## Records

All records live in `objects` (current state) with an append-only `revisions` table (database triggers forbid update/delete of revisions, deletion of objects and assessments, and modification of assessment content). Universal references: `E07:<kind>:<id>@<revision>` with kinds
`entity, relationship, event, claim, statement, evidence_link, source_family, contradiction, alternative, proposal, entity_match, entity_merge`.

Every view (`ObjectView`) carries `ref, kind, id, revision, state, status, compartment, caseId, stale, blocked, flags[], createdAt, createdBy, updatedAt` plus the body fields. `status` is `blocked` > `needs_reverification` > `state` (entities merged into another show `merged`).

- **Entity**: `entityType, name, aliases[], description, attributes, protectedIdentity, identityCompartment, pseudonym, identityRefs[]`; views add `identityWithheld, mergedInto, mergedFrom[]`.
- **Relationship**: `relationshipType` (free lowercase token), `from` (entity), `to` (entity|event), `label, time, note`; needs ≥1 evidence link at creation and while active; always carries a notice that a relationship is not involvement. No assessment reads relationships.
- **Event**: `title, description, time {earliest, latest, precision, note?}, placeEntityId, participantEntityIds[], claimIds[]`.
- **Claim**: `text, claimType (allegation|attributed_statement|observation|inference|reconstruction_note), subjects[], time, derivedFrom[], statementId, question, language, provenance`. States `active|withdrawn|superseded`.
- **Statement** (attributed): `speakerEntityId|speakerLabel, text, saidAt, venue, sourceRef (uref, e.g. E03:message:…, E02:testimony:…, E06:representation:…), selector, permissionRefs[], identityRefs[], use`.
- **Evidence link**: `target {claim|relationship|event|alternative}, evidenceRef` (**must pin a version**, `…@<rev>`), `representationRef?, selector {kind: whole|page|text|time|segment|region …}, stance (supports|challenges|context), note, sourceType, validation {state: released|not_released|unvalidated}, similarity?`. States `active|retracted` (retraction keeps the record).
- **Source family**: `label, description, basis, members[{ref, basis, origin, addedBy, at}]`; a source (uref without revision) belongs to at most one family per project. Sources in no family count as one family each.
- **Contradiction**: `members[{claim|evidence_link}] (≥2), description, resolution`; states `open|resolved|unresolvable|dismissed`. Members are never removed or hidden.
- **Alternative explanation**: `claimId|question, text, note`; states `open|plausible|ruled_out|adopted`; its own evidence links target it.
- **Assessment** (table `assessments`, append-only): one record per decision in ONE dimension — `factual` (unassessed|supported|contested|refuted|unresolvable), `source_type` (config vocabulary), `procedural` (config vocabulary, never inferred), `editorial` (not_reviewed|approved|approved_with_conditions|rejected|withdrawn). Each has `rationale, basis, cites {linkIds, familyIds}, actorId, actorKind, at, claimRevision, status (proposed|final), decision, flags`. The current value of a dimension is its latest final record. Recording one dimension never reads or writes another (the editorial record stores the factual assessment id only as a trace).
- There is **no numeric guilt, credibility or confidence score** anywhere. `similarity` (0–1) exists only on links, entity matches and search hits, labelled `similarity`, and no assessment accepts it.

### Factual assessment rules
- `supported` requires a cited, active, non-stale **supporting link on this claim** whose `sourceType` is in `primarySourceTypes` and whose validation is `released` (basis `released_primary_source`), **or** `documentedRationale: true` with a rationale of at least `minRationaleLength` characters (basis `documented_rationale`). Without an `EvidencePort` no link is `released`, so only the documented-rationale path is available.
- `refuted` must cite a challenging link; `contested` must cite at least one link. Cited links must belong to the claim (a relationship's link or another claim's link is rejected).
- Editorial `approved*` is refused while the claim is stale or blocked.
- Agents and services get `forbidden` from `recordAssessment`; they use `proposeAssessment`.

### Protected identities
An entity with `protectedIdentity: true` is returned with `name = pseudonym`, no aliases, description, attributes or identity refs unless the caller holds `knowledge:disclose_identity` and the entity's `identityCompartment`. For such callers every string in every result (claims, statements, events, link notes, histories, graph, chronology, gaps, inspect, search, export, proposals) has the protected names and aliases replaced by the pseudonym (case-insensitive whole-word match), and search runs against an identity-safe index, so names cannot be probed through hits or counts. A merge group containing a protected entity is protected as a whole. Disclosed reads through `getEntity` are audited. **Limit**: redaction of free text is by known name/alias; identifying detail written into a claim's text that is not a recorded name or alias is not detected — use `compartment` for such records.

## Service methods

All take `ctx: ServiceContext` first. Mutations accept `idempotencyKey` in the input. `Placement = { compartment?, caseId? }`.

```ts
// entities, identity decisions, reversible merges
createEntity(ctx, input: EntityInput & Placement & Idem): Promise<ObjectView>
reviseEntity(ctx, id, input: Partial<EntityInput> & { expectedRevision: number; reason: string; state?: string }): Promise<ObjectView>
getEntity(ctx, id): Promise<ObjectView>
recordEntityMatch(ctx, { leftId, rightId, decision: 'same'|'different'|'unresolved', rationale, similarity?, expectedRevision? }): Promise<ObjectView>
mergeEntities(ctx, { survivorId, mergedId, rationale }): Promise<ObjectView>          // entity_merge record; originals untouched
unmergeEntities(ctx, mergeId, { reason }): Promise<ObjectView>
// claims, statements, evidence, relationships, events
createClaim(ctx, input: ClaimInput & Placement & Idem): Promise<ObjectView>            // returns the dossier
reviseClaim(ctx, id, input: Partial<ClaimInput> & { expectedRevision; reason; state?; compartment? }): Promise<ObjectView>
getClaim(ctx, id): Promise<ObjectView>   // + assessments{factual,source_type,procedural,editorial,pendingProposals}, evidence{supporting,challenging,context}, independence, contradictions, alternatives, statement
claimHistory(ctx, id): Promise<{ claim, revisions, assessments{current,history}, links[+revisions], flags, timeline[{at,actorId,actorKind,type,why,detail}] }>
createStatement(ctx, input: StatementInput & Placement & Idem): Promise<ObjectView>
reviseStatement(ctx, id, input & { expectedRevision; reason; state? }): Promise<ObjectView>
addEvidenceLink(ctx, input: LinkInput & { compartment? } & Idem): Promise<ObjectView>
reviseEvidenceLink(ctx, id, input: Partial<EvidenceInput> & { expectedRevision; reason }): Promise<ObjectView>
retractEvidenceLink(ctx, id, { expectedRevision, reason }): Promise<ObjectView>
createRelationship(ctx, input: RelationshipInput & Placement & Idem): Promise<ObjectView>   // evidence: EvidenceInput[] (≥1)
reviseRelationship(ctx, id, { relationshipType?, label?, time?, note?, state?, expectedRevision, reason }): Promise<ObjectView>
createEvent(ctx, input: EventInput & Placement & Idem): Promise<ObjectView>
reviseEvent(ctx, id, input & { expectedRevision; reason; state? }): Promise<ObjectView>
// source families, contradictions, alternatives
createSourceFamily(ctx, { label, description?, basis?, members: string[], caseId? }): Promise<ObjectView>
reviseSourceFamily(ctx, id, { label?, description?, addMembers?, removeMembers?, state?: 'active'|'dissolved', expectedRevision, reason }): Promise<ObjectView>
suggestSourceFamilies(ctx, { origin, hints: [{ refs: string[], basis?, label?, similarity? }] }): Promise<ObjectView[]>   // proposals
independence(ctx, claimId): Promise<{ supporting:{links,families}, challenging, context, families[], independentCorroboration, notice }>
recordContradiction(ctx, { members: ObjRef[], description } & Placement): Promise<ObjectView>
resolveContradiction(ctx, id, { state: 'open'|'resolved'|'unresolvable'|'dismissed', note, expectedRevision }): Promise<ObjectView>
addAlternativeExplanation(ctx, { claimId?, question?, text } & Placement): Promise<ObjectView>
reviseAlternativeExplanation(ctx, id, { text?, state?, note?, expectedRevision, reason }): Promise<ObjectView>
// assessments and proposals
proposeAssessment(ctx, claimId, input: Omit<AssessmentInput,'proposalId'>): Promise<AssessmentView>
recordAssessment(ctx, claimId, input: AssessmentInput): Promise<AssessmentView>   // { dimension, value, rationale, cites?, documentedRationale?, conditions?, proposalId? }
rejectAssessmentProposal(ctx, assessmentId, { reason }): Promise<AssessmentView>
assessments(ctx, claimId): Promise<{ current, history: AssessmentView[] }>
proposeClaims(ctx, { origin, items: (ClaimInput & { evidence?: (EvidenceInput & { excerpt? })[] })[] } & Placement): Promise<ObjectView[]>
proposeEntities(ctx, { origin, items: (EntityInput & { matchEntityId?, similarity? })[] } & Placement): Promise<ObjectView[]>
proposeLinks(ctx, { origin, items: (LinkInput & { excerpt? })[] } & Placement): Promise<ObjectView[]>
reviewProposal(ctx, id, { decision: 'accept'|'reject', reason, expectedRevision? }): Promise<ObjectView>
// queries
get(ctx, kind, id): Promise<ObjectView>;  list(ctx, kind, { caseId?, state?, limit? }): Promise<ObjectView[]>;  history(ctx, kind, id): Promise<{ ref, revisions, flags }>
evidenceGraph(ctx, { claimId } | { entityId } | { caseId }): Promise<Graph>   // { nodes, edges, table{columns,rows}, text, notices }
researchGaps(ctx, { caseId? }): Promise<{ gaps: [{ claim, title, status, gaps: [{ gap, detail }] }], counts, notice }>
chronology(ctx, { caseId?, entityId?, from?, to? }): Promise<{ entries: [{ event, title, time, uncertainty, label: 'established'|'disputed'|'unknown', labelBasis, needsReverification, participants, claims }], notice }>
impactOf(ctx, refs: string[]): Promise<Impact>   // { evidenceLinks, statements, claims, assessments, relationships, events, alternatives, contradictions, paths }
searchRecords(ctx, { q, limit?, kinds? }): Promise<{ hits: (SearchHit & { similarity })[], total, notice }>
usability(ctx, { claimIds, action: UseAction, audience? }): Promise<{ claim, decision: 'allow'|'deny'|'review'|'unchecked', reasons }[]>
exportDossier(ctx, { claimId } | { caseId }): Promise<{ format: 'e07-dossier/1', claims, entities, records, graph, ... }>
// corrections and flags
openCorrection(ctx, { refs, kind?, reason }): Promise<{ correctionId, affected, impact }>
resolveFlag(ctx, target: { kind, id }, { flag: 'stale'|'blocked', note }): Promise<ObjectView>
// standard surface
inspect, search, audit, events, applyUpstreamChange, health
```

`origin` = `{ kind: 'model'|'reply'|'extraction'|'import'|'discovery'|'human', ref?: uref, label? }`. Proposal items accept only the listed fields: anything else (assessment, approval, status, score, capability) is rejected. A proposed excerpt must be an exact span of the cited text selector's quote (rule ported from the earlier `claim-proposal-review` module). Accepting a proposal creates ordinary unassessed records with `provenance.proposalId`; a suggested entity match becomes an `unresolved` match record, never a merge.

Research-gap codes: `no_supporting_evidence, no_primary_support, single_family_support, unresolved_contradiction, unassessed, missing_alternative_explanations, stale_links, unvalidated_links, needs_reverification, blocked`.

## Propagation

`applyUpstreamChange(ctx, { eventId, kind, refs, reason })` (idempotent per project by `eventId`):
- `source_corrected | source_superseded | source_removed | content_changed | permission_changed`: every evidence link / statement whose stored uref matches a ref (`urefMatches`: same engine, kind and id; a pinned revision must match) is marked **stale**; everything depending on it transitively (claims, derived claims, relationships, events, alternatives) is marked stale (claims read `needs_reverification`). Current final assessments of affected claims get a `needs_reverification` flag — value, rationale and actor are not changed.
- `permission_withdrawn`: the same traversal marks records **blocked**.
- Other kinds are recorded and affect nothing.
- Returns `{ affected: urefs }` and emits `knowledge.<kind>_stale` / `knowledge.<kind>_blocked` per affected record (subject = its uref, payload `{ reason, cause: eventId, changeKind, refs: [uref], claims?: [uref] }`).

Also flagged internally: a substantive claim revision (derived claims, events; the claim itself if assessed), revision/retraction of a link cited by an assessment, a statement revision, and a source-family membership change under an assessed claim.

Recovery: re-pointing a stale link to another version clears the link's flag; a new final factual assessment clears the claim's stale flag when no stale link remains; otherwise `resolveFlag` (human, `knowledge:approve`), which refuses while a flagged upstream record still feeds the target. Cleared flags stay in the flag history.

## Events

Subject is always a uref. `knowledge.claim_created` (claim), `knowledge.claim_changed` (claim; payload `change: 'revised'|'assessment'` — downstream engines consume as `claim_changed`), `knowledge.claim_stale`, `knowledge.claim_blocked`, `knowledge.{evidence_link,statement,relationship,event,alternative}_{stale,blocked}`, `knowledge.assessment_proposed`, `knowledge.assessment_recorded` (claim), `knowledge.evidence_link_changed`, `knowledge.source_family_changed`, `knowledge.entity_changed`, `knowledge.entity_merged`, `knowledge.entity_unmerged` (survivor entity), `knowledge.entity_match_recorded`, `knowledge.relationship_changed`, `knowledge.event_changed`, `knowledge.statement_changed`, `knowledge.contradiction_changed`, `knowledge.alternative_changed`, `knowledge.proposal_submitted`, `knowledge.proposal_reviewed`, `knowledge.correction_opened` (first source ref), `knowledge.flag_resolved`.
Catalog names map as: claim.revised → `knowledge.claim_changed`; assessment.recorded → `knowledge.assessment_recorded`; source.dependence.changed → `knowledge.source_family_changed`; correction.opened → `knowledge.correction_opened`; impact.invalidated → `knowledge.*_stale` / `*_blocked`. Payloads carry ids, never names or text.

## HTTP

Standard: `GET /healthz`, `GET /v1/manifest`, `GET /v1/inspect?ref=`, `GET /v1/search?q=`, `GET /v1/audit`, `GET /v1/events`, `POST /v1/upstream-changes`.
Bodies are the service inputs; `Idempotency-Key` header is accepted. Creation returns 201.

| Route | Method |
|---|---|
| `POST /v1/entities`, `GET|PATCH /v1/entities/:id` | createEntity, getEntity, reviseEntity |
| `POST /v1/entity-matches` | recordEntityMatch |
| `POST /v1/entity-merges`, `POST /v1/entity-merges/:id/reverse` | mergeEntities, unmergeEntities |
| `POST /v1/claims`, `GET|PATCH /v1/claims/:id`, `GET /v1/claims/:id/history`, `GET /v1/claims/:id/independence` | createClaim, getClaim, reviseClaim, claimHistory, independence |
| `GET|POST /v1/claims/:id/assessments`, `POST /v1/claims/:id/assessment-proposals`, `POST /v1/assessment-proposals/:id/reject` | assessments, recordAssessment, proposeAssessment, rejectAssessmentProposal |
| `POST /v1/statements`, `PATCH /v1/statements/:id` | createStatement, reviseStatement |
| `POST /v1/evidence-links`, `PATCH /v1/evidence-links/:id`, `POST /v1/evidence-links/:id/retract` | addEvidenceLink, reviseEvidenceLink, retractEvidenceLink |
| `POST /v1/relationships`, `PATCH /v1/relationships/:id`, `POST /v1/events`, `PATCH /v1/events/:id` | relationships, events |
| `POST /v1/source-families`, `PATCH /v1/source-families/:id`, `POST /v1/source-family-suggestions` | source families |
| `POST /v1/contradictions`, `POST /v1/contradictions/:id/resolution`, `POST /v1/alternatives`, `PATCH /v1/alternatives/:id` | contradictions, alternatives |
| `POST /v1/proposals/{claims,entities,links}`, `POST /v1/proposals/:id/review` | proposals |
| `GET /v1/records/:kind`, `GET /v1/records/:kind/:id`, `GET /v1/records/:kind/:id/history` | list, get, history |
| `GET /v1/graphs/evidence?claimId=|entityId=|caseId=[&format=text]` | evidenceGraph (JSON with table, or plain text) |
| `GET /v1/research-gaps`, `GET /v1/chronology`, `POST /v1/impact`, `GET /v1/search/records`, `POST /v1/usability`, `GET /v1/exports/dossier` | queries |
| `POST /v1/corrections`, `POST /v1/flags/resolve` (`{ target, flag, note }`) | openCorrection, resolveFlag |

## Ports

- `EvidencePort.describe` (optional): checks that a cited E05 version exists and is released. Absent → links are accepted with `validation.state = 'unvalidated'`. Present and the version is unknown → `invalid_reference`; port failure → `unavailable` (the link is not created).
- `UseDecisionPort` (optional): consulted when a statement is created/revised (`investigate`; `deny` → `consent_denied`) and by `usability`. Absent → statements record `use.decision = 'unchecked'` and `usability` answers `unchecked` for attributed claims. Permission refs returned by the port are stored so that their withdrawal blocks the statement.
- `AuthorizationPort` (optional): see Capabilities.

## Status

Implemented and tested locally on real PostgreSQL 16 (`tests/engine.test.ts`, `tests/engine-http.test.ts`): everything above, including catalog acceptance, tenant/project isolation, fail-closed authorization, idempotent replay, protected-identity withholding, reversible merges, transitive stale/blocked propagation and the HTTP server.

Not implemented / not verified:
- No vector search and no graph database projection; search is PostgreSQL full-text only.
- The `EVIDENCE_URL` / `CONSENT_URL` HTTP adapters in `serve.ts` are not verified against the real E05/E11 services. Port behaviour is tested with in-process stand-ins, not with those engines.
- Queries that scan a project (graph, gaps, chronology, family-change impact) load at most 5000 records per kind; there is no pagination beyond `limit` on `list`.
- Gaps, graphs and independence are computed over the records the caller may see; material in compartments the caller lacks is not counted.
- Free-text redaction is name/alias based (see Protected identities).
- The earlier foundation modules (`src/index.ts`, `evidence-links.ts`, `verification-*.ts`, `claim-proposal*.ts` …) remain exported and tested but are not used by the service layer, because they import other engines' packages; only the proposal excerpt guard was ported.
- No hosted deployment; no independent security review.
