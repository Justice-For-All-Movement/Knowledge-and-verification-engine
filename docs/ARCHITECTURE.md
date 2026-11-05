# Private Knowledge foundation (partial AM-05.01)

This E07 package separates knowledge records from the E08 investigation workflow. It reuses the accepted suite contracts unchanged and adapts revision/lineage patterns from recovered unqualified shared investigation source. The archived module imports monorepo Evidence internals which are not a qualified standalone API; it is not blindly promoted or treated as accepted implementation. Recovery source hash:0c55fa67b854b2793e23cb6a83634673720bbcd00cbeca11f8fe3a391f5fcc8e. Shared contracts SHA256:d86141cb7546a723f837a298e4ea6fef62692918f78f5aab2d72d6639987fcc5.

createKnowledgeState, reviseKnowledge, assertKnowledgeState and inspectKnowledge form an in-memory, serializable, pure library. Records are always private. Exact fields/bounded UTF8 history are validated; each logical kind/ID has contiguous positive revisions and exact predecessor links. Appends use the expected current logical revision; prior state is copied and retained. Inspection revalidates and returns detached data. Hard caps2048 revisions/2MiB reject without eviction. Host input/CPU/heap limits remain required; parsing/cloning/validation is not a sandbox. No SQL durability, transaction contention, request idempotency, audit ledger or crash recovery is claimed.

Entities have explicit categories; ambiguity/aliases/reversible identity matches remain pending. Events and claims use nullable earliest/latest UTC instants: null stays unknown, never replaced by a date guess. Reversed/noncalendar/non-UTC values fail. New event/claim subject links require existing exact current local subject editions; earlier historical records keep their original links as subjects change. This is local referential consistency, not provenance/evidence verification or automatic correction-impact invalidation.

Claims explicitly label attributed testimony/document assertion/observation/research inference, with bounded limitations. Assessment, procedural posture and editorial approval are separate null fields in this foundation. They cannot become supported/guilty/liable/publishable by intake, task success or an injected numerical score. Source selectors/source families, counterevidence, independent verification assessments and cross-engine consent/rights/source authorization are pending; don't use these records as verified findings. No evidence citation API is exposed until exact authoritative selectors and source independence can be validated.

Context roles/scope/purpose/time are TRUSTED HOST INPUT, not authentication. The library permits explicitly supplied research/owner roles and refuses cross-scope writes/inspection. Host current Identity/session/action policy integration is required; historical Context, request ID and snapshots are not grants. Direct access to a serialized state already exposes its private content, so the host must provide storage/access controls. No endpoint/model/worker/database/provider/credential/send/publication/payment/export service is included.

The four original public-neutral approved design JSON files are retained byte-for-byte, including their historical proposed/planned status fields; the owner's approval supplies their authority as the design, not runtime acceptance. Original122 task IDs/dependencies and15 engines are preserved. The owning registry maps E07's joint M05 requirements without claiming E08 implementation. AM-05.01's dependencies on source families/selectors/OCR and its visual acceptance remain integration prerequisites; a pure model is only partial progress, not their completion. Durable adapters must use the stable pinned Evidence SQL SDK in their OWN Knowledge database, never another engine's DB.

All twelve neutral domain groups/typecheck/build/registry pass after a clean normal npm install. Actual2048-revision no-eviction and aggregate UTF8 byte caps, preserved historical subject links and hostile profiles are covered. Initial CI40797317206/job123196826801 failed during npm ci because a symlink-generated lockfile recorded workspace paths; no tests ran there. The lockfile was regenerated from a clean install with registry dependencies only. All twelve groups also pass freshly packed installed compiled public exports; index JS byte-matches build. Expanded source5594de30fe5a1b1029243256398b596231a1efa9 CI40797547980/check123197575447 passed clean npm ci and12 tests/typecheck/build/registry, logs inspected. Final-head CI/reviewed normal merge remains required after evidence update. Source/adversarial review checked exact profiles/scope/roles/references/lineage, uncertainty dimensions/private defaults/immutable copies/caps/calendar validity and no effects; no unresolved finding. Unknown dates, private immutable revisions, stale/foreign/missing references, role/scope denial, malformed calendar values, assessment-track separation, detached copies, tampered lineage and bounded inputs are exercised. Further capacity/rollback/real DB/network/browser/AT/deployment qualification is pending. No legal/jurisdiction/country research or private deployment policy is committed. PAM remains stopped at its accepted foundation; operational orchestration comes after dependencies.

The partial AM-05.02 adapter is documented in EVIDENCE_LINKS.md. It supplies exact claim-bound private link histories and explicit pinned-Evidence snapshot revalidation, with separate support/challenge/quotation source analyses. It does not authenticate snapshots or promote claims to verified findings. Historical source/selector pending notes above describe the foundation checkpoint; the adapter advances those integrations only within its documented pure-memory limits.

Partial explicit reversible identity pair judgments are documented in ENTITY_IDENTITY.md; they do not merge IDs or authenticate real identities. Earlier identity-resolution pending notes describe the foundation checkpoint and still apply to automated/qualified matching and visual acceptance.

Partial versioned role/relationship assertions are documented in RELATIONSHIPS.md. The earlier entity/event/claim-only foundation descriptions remain historical; the additive profile keeps independent null assessment tracks and exact immutable subject links. No cross-engine pin is silently advanced.

Partial owning-database persistence of KnowledgeState is documented in REPOSITORY.md. Pure library notes above remain historical; EvidenceLinks/entity-identity persistence and current Identity integration are still pending.

Opt-in current stored Identity/resource-policy integration is documented in IDENTITY_REPOSITORY.md. Earlier host-roles-only limitations remain applicable to direct legacy repository access.

Durable reversible entity-pair judgments and their opt-in Identity methods are documented in ENTITY_IDENTITY_REPOSITORY.md. EvidenceLinks persistence remains pending; no inferred identity merging is added.

Partial own-DB evidence-link persistence and guarded Identity methods are documented in EVIDENCE_LINKS_REPOSITORY.md. Earlier link-persistence pending notes are historical; authenticated current source transport remains pending.

Owning checked evidence-link review is documented in EVIDENCE_LINK_REVIEW.md. It loads current actual claim/link histories together before invoking the accepted pure review, exposes observed containing revisions and is guarded by the opt-in Identity facade. Evidence delivery remains trusted host input; this is no source authentication, verified finding or external action fence.

The disposable owning-DB network fixture in POSTGRES_TESTS.md separately tests Knowledge append contention/lost acknowledgements, review ordering behind actual committed claim/link revisions and role/scope boundaries. Seven actual restricted PostgreSQL17 scenarios passed expanded-source CI40916138527/postgres123596748061, and69 ordinary tests passed check123596748563, with head/logs inspected; final-head CI remains a merge requirement; it does not authenticate Context or supplied Evidence, or qualify production deployment.

CURRENT_EVIDENCE.md documents explicit current owning selector review composition; earlier host-snapshot-only limitations still apply to legacy APIs. No authenticated full EvidenceState is constructed or returned.

SOURCE_LINK_WRITES.md documents the additive opt-in SourceEvidenceLinksWriter path through actual owning Evidence captures and current Identity/owning Knowledge SQL. Legacy snapshot APIs remain host-trust paths; source-backed metadata is historical, not atomic current source/consent/rights permission.

CONSENT_LINK_WRITES.md documents mandatory opt-in current Identity/Consent checks before and after owning Evidence capture for private source-backed link writes. Existing host-trust paths remain unchanged. Exact configured original-byte resource bindings and private metadata/reproduction actions are observed sequentially; they do not permanently authorize a stored link or atomically fence another engine's revocation.

CONSENT_LINK_REVIEW.md documents the corresponding opt-in current Consent guard on actual owning link review, before source access and before the final Knowledge basis/result. Earlier successful writes or reviews never substitute for current permission; returned metadata remains a sequential historical observation.

CLAIM_PROPOSALS.md documents mandatory current Consent-guarded exact-span private proposals, distinct from Knowledge revisions, verified findings and answers.

CLAIM_PROPOSAL_REVIEW.md describes owning captured proposal-bundle validation, distinct from current guarded service observations and authentication.

VERIFICATION_REVIEW.md documents private unresolved human observations tied to exact captured claim/citation editions, distinct from authenticated current source review, findings or approvals.

HUMAN_SOURCE_LINK_WRITES.md documents explicit same-human credential binding plus mandatory current Identity/Consent for private source-backed writes. Legacy writers/readers retain their own profiles.

HUMAN_SOURCE_LINK_REVIEW.md documents opt-in same-human owning review and its protected proposal-reader composition, retaining mandatory current Identity/Consent and legacy defaults.

VERIFICATION_REPOSITORY.md documents partial own-DB unresolved human observation history and optional actual current Identity methods; earlier pure-only persistence-pending notes are historical. Durability does not attest source checks or current Evidence/Consent permission.

CURRENT_VERIFICATION_WRITES.md documents the explicit same-human current Identity/Consent/source admission coordinator for unresolved own-DB observations, with under-lock deadline/cancellation gates and conservative unknown outcomes. It does not attest source truth/work or create findings/answers.

SELECTED_VERIFICATION_READ.md documents a narrow exact latest/current owning review read and its current Identity facade; source/use permission and protected interfaces are separate requirements.

VERIFICATION_HTTP.md records an explicitly incomplete private read-only selected verification Fetch adapter; operational host authentication/TLS/current policy/browser qualification remains separate.
