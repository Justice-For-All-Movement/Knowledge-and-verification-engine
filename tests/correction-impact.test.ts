import test from "node:test";
import assert from "node:assert/strict";
import { inspectCapturedKnowledgeCorrectionImpact as impact } from "../src/correction-impact.ts";
import { createKnowledgeState, reviseKnowledge } from "../src/index.ts";
import type { Context, Ref } from "../src/contracts.ts";
import type { KnowledgeValue } from "../src/index.ts";
const c: Context = {
  tenantId: "fiction",
  projectId: "knowledge",
  purpose: "review",
  actor: { id: "human", kind: "human", roles: ["researcher"] },
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
const entity: KnowledgeValue = {
  type: "entity",
  label: "Fictional person",
  category: "unknown",
  description: "Unassessed",
};
const claim = (refs: readonly Ref[]): KnowledgeValue => ({
  type: "claim",
  text: "Unverified fictional account",
  subjectRefs: refs,
  time: { earliest: null, latest: null },
  accountType: "observation",
  limitations: ["Unverified"],
  assessment: null,
  proceduralPosture: null,
  editorialApproval: null,
});
function fixture() {
  let state = createKnowledgeState(c);
  const append = (
    id: string,
    expectedRevision: number,
    value: KnowledgeValue,
  ) => {
    state = reviseKnowledge(c, state, { id, expectedRevision, value });
    return state.records.at(-1)!.ref;
  };
  const person = append("person", 0, entity);
  const event = append("event", 0, {
    type: "event",
    label: "Fictional event",
    description: "Unknown time",
    time: { earliest: null, latest: null },
    entityRefs: [person],
  });
  const role = append("role", 0, {
    type: "relationship",
    relationshipType: "role_assertion",
    label: "Reported attendee",
    from: person,
    to: event,
    time: { earliest: null, latest: null },
    limitations: ["Unverified"],
    assessment: null,
    proceduralPosture: null,
    editorialApproval: null,
  });
  const unplanned = append("unplanned-claim", 0, claim([role]));
  const unrelated = append("unrelated-claim", 0, claim([]));
  const after = append("event", 1, {
    type: "event",
    label: "Fictional event",
    description: "Corrected captured time",
    time: { earliest: "2026-01-02T00:00:00Z", latest: null },
    entityRefs: [person],
  });
  const successorOnly = append("successor-claim", 0, claim([after]));
  const laterUnplanned = append("unplanned-claim", 1, claim([]));
  return {
    state,
    person,
    event,
    after,
    role,
    unplanned,
    unrelated,
    successorOnly,
    laterUnplanned,
  };
}
test("all captured claims including unplanned historical editions retain exact transitive corrected-date impact", () => {
  const f = fixture(),
    r = impact(c, JSON.stringify(f.state), f.event, f.after);
  assert.deepEqual(
    r.claims.map((x) => x.status),
    [
      "review-required",
      "no-captured-dependency",
      "no-captured-dependency",
      "no-captured-dependency",
    ],
  );
  assert.deepEqual(r.claims[0]!.claim, f.unplanned);
  assert.deepEqual(r.claims[0]!.latestClaim, f.laterUnplanned);
  assert(
    r.edges.some((e) => e.kind === "relationship-to" && e.to.revision === 1),
  );
  assert.equal(
    r.nodes.find((n) => n.ref.id === "event" && n.ref.revision === 1)!.status,
    "changed-edition",
  );
  assert.equal(Object.hasOwn(r, "allowed"), false);
  assert(r.unloaded.includes("findings"));
});
test("all older entity editions propagate through actual historical edges while successor-only claims remain separate", () => {
  const f = fixture();
  let state = reviseKnowledge(c, f.state, {
    id: "person",
    expectedRevision: 1,
    value: entity,
  });
  const before = state.records.at(-1)!.ref;
  state = reviseKnowledge(c, state, {
    id: "person",
    expectedRevision: 2,
    value: entity,
  });
  const after = state.records.at(-1)!.ref;
  state = reviseKnowledge(c, state, {
    id: "current-person-only",
    expectedRevision: 0,
    value: claim([after]),
  });
  const r = impact(c, JSON.stringify(state), before, after);
  assert.equal(
    r.claims.find(
      (x) => x.claim.id === "unplanned-claim" && x.claim.revision === 1,
    )!.status,
    "review-required",
  );
  assert.equal(r.claims.at(-1)!.status, "no-captured-dependency");
  assert.equal(
    r.nodes.filter(
      (n) => n.ref.id === "person" && n.impact === "review-required",
    ).length,
    2,
  );
});
test("missing captured dependencies and malformed histories fail whole rather than inventing unaffected rows", () => {
  const f = fixture();
  const missing = {
    ...f.state,
    records: f.state.records.filter((r) => r.ref.id !== "person"),
  };
  assert.throws(() => impact(c, JSON.stringify(missing), f.event, f.after));
  for (const edit of [
    (s: any) => (s.allowed = true),
    (s: any) => (s.records[0].visibility = "public"),
    (s: any) => (s.records[1].value.entityRefs[0].projectId = "foreign"),
  ]) {
    const s = structuredClone(f.state);
    edit(s);
    assert.throws(() => impact(c, JSON.stringify(s), f.event, f.after));
  }
});
test("wrong roles scope purpose actor and nonconsecutive extra missing stale refs deny with no partial result", () => {
  const f = fixture(),
    json = JSON.stringify(f.state);
  for (const ctx of [
    { ...c, actor: { ...c.actor, roles: ["viewer"] } },
    { ...c, purpose: "elsewhere" },
    { ...c, projectId: "foreign" },
    { ...c, actor: { ...c.actor, kind: "agent" as const } },
  ])
    assert.throws(() => impact(ctx, json, f.event, f.after));
  for (const after of [
    { ...f.after, revision: 3 },
    { ...f.after, id: "missing" },
    { ...f.after, revision: 0 },
    { ...f.after, allowed: true },
  ])
    assert.throws(() => impact(c, json, f.event, after));
  const state = reviseKnowledge(c, f.state, {
    id: "event",
    expectedRevision: 2,
    value: f.state.records.find((r) => r.ref.id === "event")!.value,
  });
  assert.throws(() => impact(c, JSON.stringify(state), f.event, f.after), {
    code: "stale_reference",
  });
});
test("result detaches all graph and claim refs without changing captured records or null assessment dimensions", () => {
  const f = fixture(),
    before = JSON.stringify(f.state),
    r = impact(c, before, f.event, f.after);
  Object.assign(r.nodes[0]!.ref, { id: "changed" });
  Object.assign(r.claims[0]!.claim, { id: "changed" });
  assert.equal(JSON.stringify(f.state), before);
  assert.equal(
    f.state.records.find((x) => x.ref.id === "unplanned-claim")!.value.type ===
      "claim" &&
      (
        f.state.records.find((x) => x.ref.id === "unplanned-claim")!
          .value as any
      ).assessment,
    null,
  );
});
test("5MiB UTF8 input boundary is whole and exact; oversized or invalid JSON cannot truncate a report", () => {
  const f = fixture(),
    text = JSON.stringify(f.state),
    padded = text + " ".repeat(5 * 1024 * 1024 - Buffer.byteLength(text));
  assert.equal(impact(c, padded, f.event, f.after).claims.length, 4);
  assert.throws(() => impact(c, padded + " ", f.event, f.after), {
    code: "impact_full",
  });
  for (const s of ["{", "null", "[]"])
    assert.throws(() => impact(c, s, f.event, f.after));
});
