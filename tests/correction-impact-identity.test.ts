import { MembershipRegistry } from "@accountability/identity-policy/membership";
import test from "node:test";
import assert from "node:assert/strict";
import { setup, c } from "./correction-impact-identity-fixture.ts";
import { IdentityKnowledgeCorrectionImpactReader } from "../src/correction-impact-identity.ts";
import { KnowledgeRepository } from "../src/repository.ts";
import { scoped } from "@accountability/evidence-sql/database";
import type { Database } from "@accountability/evidence-sql/database";
test("actual stored Identity roles replace incoming roles and withdrawal denies subsequent historical impact reads", async (t) => {
  const f = await setup(t),
    q = f.selected;
  const r = await f.reader.read(
    { ...c, actor: { ...c.actor, roles: [] } },
    q.before,
    q.after,
  );
  assert.equal(r.knowledgeStorage.revision, 2);
  assert.equal(r.impact.claims.length, 2);
  await f.membership.setResourcePolicy(
    f.owner,
    1,
    { ...f.policy, memberIds: [] },
    "withdraw",
  );
  await assert.rejects(
    f.reader.read(
      { ...c, actor: { ...c.actor, roles: ["owner"] } },
      q.before,
      q.after,
    ),
    { code: "impact_unavailable" },
  );
});
test("withdrawal during actual own checked read is rechecked after COMMIT and withholds frame while retaining audit", async (t) => {
  const f = await setup(t),
    q = f.selected;
  let withdrawn = false;
  const db: Database = {
    ...f.db,
    transaction: (fn) =>
      f.db.transaction((tx) =>
        fn({
          query: async <T>(sql: string, args?: unknown[]) => {
            const r = await tx.query<T>(sql, args);
            if (
              !withdrawn &&
              args?.includes("knowledge.correction-impact.read_checked")
            ) {
              withdrawn = true;
              await f.membership.setResourcePolicy(
                f.owner,
                1,
                { ...f.policy, memberIds: [] },
                "withdraw",
              );
            }
            return r;
          },
        }),
      ),
  };
  await assert.rejects(
    new IdentityKnowledgeCorrectionImpactReader(
      new KnowledgeRepository(db, f.owningPolicy),
      f.membership,
      f.fixed,
    ).read(c, q.before, q.after),
    { code: "impact_unavailable" },
  );
  await scoped(f.db, c, async (tx) =>
    assert.equal(
      (await tx.audits()).filter(
        (x) => x.type === "knowledge.correction-impact.read_checked",
      ).length,
      1,
    ),
  );
});
test("own and Identity lost COMMIT acknowledgements are sanitized unknown; explicit later read retains history", async (t) => {
  const f = await setup(t),
    q = f.selected;
  f.hooks.lost = true;
  await assert.rejects(f.reader.read(c, q.before, q.after), (e) => {
    assert(!String(e).includes("COMMIT"));
    return (e as any).code === "impact_unavailable";
  });
  f.identity.hooks.lost = true;
  await assert.rejects(f.reader.read(c, q.before, q.after), {
    code: "impact_unavailable",
  });
  const r = await f.reader.read(c, q.before, q.after);
  assert.equal(r.knowledgeStorage.revision, 2);
  await scoped(f.db, c, async (tx) =>
    assert.equal(
      (await tx.audits()).filter(
        (x) => x.type === "knowledge.correction-impact.read_checked",
      ).length,
      2,
    ),
  );
});
test("exact positive consecutive scope-kind-purpose admission and pre-cancel deny before Identity SQL", async (t) => {
  const f = await setup(t),
    q = f.selected,
    n = f.count(),
    ac = new AbortController();
  ac.abort();
  for (const pair of [
    [{ ...q.before, projectId: "other" }, q.after],
    [{ ...q.before, allowed: true }, q.after],
    [{ ...q.before, revision: 0 }, q.after],
    [q.before, { ...q.after, revision: 3 }],
    [
      { ...q.before, kind: "case" },
      { ...q.after, kind: "case" },
    ],
  ])
    await assert.rejects(f.reader.read(c, pair[0]!, pair[1]!));
  await assert.rejects(
    f.reader.read({ ...c, purpose: "other" }, q.before, q.after),
  );
  await assert.rejects(f.reader.read(c, q.before, q.after, ac.signal));
  assert.equal(f.count(), n);
});
test("prototype-bound methods ignore forged instance overrides; fake services cannot construct usable reader", async (t) => {
  const f = await setup(t),
    q = f.selected;
  let forged = 0;
  Object.assign(f.repo, {
    loadCorrectionImpact: async () => {
      forged++;
      return {};
    },
  });
  Object.assign(f.membership, {
    resolveResource: async () => {
      forged++;
      return {};
    },
  });
  const reader = new IdentityKnowledgeCorrectionImpactReader(
    f.repo,
    f.membership,
    f.fixed,
  );
  assert.equal(
    (await reader.read(c, q.before, q.after)).impact.claims.length,
    2,
  );
  assert.equal(forged, 0);
  assert.throws(
    () =>
      new IdentityKnowledgeCorrectionImpactReader(
        {} as any,
        f.membership,
        f.fixed,
      ),
  );
});
test("one outer deadline reaches actual owning lock and async/nonvoid predicates cannot admit read audits", async (t) => {
  const f = await setup(t),
    q = f.selected;
  let locked = false;
  const db: Database = {
    ...f.db,
    transaction: (fn) =>
      f.db.transaction((tx) =>
        fn({
          query: async <T>(sql: string, args?: unknown[]) => {
            const r = await tx.query<T>(sql, args);
            if (args?.includes("knowledge.correction-impact.read_checked"))
              locked = true;
            return r;
          },
        }),
      ),
  };
  const reader = new IdentityKnowledgeCorrectionImpactReader(
    new KnowledgeRepository(db, f.owningPolicy),
    f.membership,
    f.fixed,
    500,
  );
  await assert.rejects(
    reader.read(c, q.before, q.after, undefined, () => {
      if (locked) {
        const end = performance.now() + 600;
        while (performance.now() < end) {}
      }
    }),
    { code: "impact_unavailable" },
  );
  assert(locked);
  for (const hook of [
    () => true,
    () => Promise.reject(Error("private admission")),
  ])
    await assert.rejects(
      f.reader.read(c, q.before, q.after, undefined, hook as any),
      { code: "impact_unavailable" },
    );
  await scoped(f.db, c, async (tx) =>
    assert.equal(
      (await tx.audits()).filter(
        (x) => x.type === "knowledge.correction-impact.read_checked",
      ).length,
      0,
    ),
  );
});
test("captured request inputs remain fixed while an actual Identity read acknowledgement is held", async (t) => {
  const f = await setup(t),
    q = structuredClone(f.selected),
    ctx = structuredClone(c);
  let release!: () => void,
    began!: () => void,
    once = true;
  const held = new Promise<void>((r) => (began = r)),
    wait = new Promise<void>((r) => (release = r));
  const db: Database = {
    ...f.identity.db,
    transaction: async (fn) => {
      const result = await f.identity.db.transaction(fn);
      if (once) {
        once = false;
        began();
        await wait;
      }
      return result;
    },
  };
  const membership = new MembershipRegistry(
    db,
    {
      tenantId: c.tenantId,
      projectId: c.projectId,
      bootstrapOwnerIds: [c.actor.id],
    },
    () => c.now,
  );
  const reader = new IdentityKnowledgeCorrectionImpactReader(
    f.repo,
    membership,
    f.fixed,
  );
  const pending = reader.read(ctx, q.before, q.after);
  await held;
  Object.assign(ctx.actor, { id: "changed", roles: ["owner"] });
  Object.assign(q.before, { id: "changed" });
  release();
  const r = await pending;
  assert.equal(r.impact.before.id, f.selected.before.id);
});
