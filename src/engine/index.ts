// E07 Knowledge and Verification — service-layer entry point (package export `./engine`).
export { SCHEMA, manifest, migrations, migrate, CAPABILITIES, EVENTS, DEFAULTS, RELATIONSHIP_NOTICE, SIMILARITY_NOTICE, PROPOSAL_NOTICE } from './model.ts';
export type { EngineConfig, EngineDeps, EnginePorts, Flag, Kind, ObjRef, Selector, TimeInterval, Dimension } from './model.ts';
export { createEngine } from './service.ts';
export type { KnowledgeEngine, ObjectView, AssessmentView, AssessmentInput, ClaimInput, EntityInput, EventInput, EvidenceInput, LinkInput, RelationshipInput, StatementInput, ProposalOrigin, Graph, Impact, Idem, Placement } from './service.ts';
export { routes } from './http.ts';
