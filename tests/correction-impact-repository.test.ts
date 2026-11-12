import test from "node:test";
import assert from "node:assert/strict";
import { ready, c } from "./dossier-owning-fixture.ts";
import {
  KnowledgeRepository,
  KNOWLEDGE_KIND,
  KNOWLEDGE_KEY,
} from "../src/repository.ts";
import { scoped } from "@accountability/evidence-sql/database";
import type { Database } from "@accountability/evidence-sql/database";
async function fixture(t: test.TestContext) {
  const f = await ready(t),
    before = f.d.knowledge.records[0]!.ref;
  const after = await f.repo.append(
    c,
    1,
    {
      id: before.id,
      expectedRevision: 1,
      value: f.d.knowledge.records[0]!.value,
    },
    "correction",
  );
  return { ...f, before, after };
}
const audits = (f: Awaited<ReturnType<typeof fixture>>) =>
  scoped(f.db, c, async (tx) =>
    (await tx.audits()).filter(
      (a) => a.type === "knowledge.correction-impact.read_checked",
    ),
  );
test("actual restricted owning history includes every historical/unplanned claim and actual containing storage without mutations", async (t) => {
  const f = await fixture(t),
    before = await f.repo.load(c),
    r = await f.repo.loadCorrectionImpact(c, f.before, f.after.record);
  assert.deepEqual(r.knowledgeStorage, f.after.storage);
  assert.equal(r.impact.claims.length, 2);
  assert.deepEqual(
    r.impact.claims.map((x) => x.status),
    ["review-required", "no-captured-dependency"],
  );
  assert.deepEqual(await f.repo.load(c), before);
  assert.equal((await audits(f)).length, 1);
  Object.assign(r.impact.claims[0]!.claim, { id: "mutated" });
  assert.equal(
    (await f.repo.loadCorrectionImpact(c, f.before, f.after.record)).impact
      .claims[0]!.claim.id,
    "claim",
  );
});
test("invalid selection and host authority deny without read audit; stale actual successor rolls back checked audit", async (t) => {
  const f = await fixture(t);
  for (const ctx of [
    { ...c, purpose: "foreign" },
    { ...c, actor: { ...c.actor, id: "unlisted" } },
    { ...c, actor: { ...c.actor, roles: ["viewer"] } },
  ])
    await assert.rejects(
      f.repo.loadCorrectionImpact(ctx, f.before, f.after.record),
    );
  for (const after of [
    { ...f.after.record, projectId: "foreign" },
    { ...f.after.record, revision: 0 },
    { ...f.after.record, allowed: true },
  ])
    await assert.rejects(f.repo.loadCorrectionImpact(c, f.before, after));
  await f.repo.append(
    c,
    2,
    {
      id: "claim",
      expectedRevision: 2,
      value: f.d.knowledge.records[0]!.value,
    },
    "later",
  );
  await assert.rejects(
    f.repo.loadCorrectionImpact(c, f.before, f.after.record),
    { code: "stale_reference" },
  );
  assert.equal((await audits(f)).length, 0);
});
test("actual checked lock precedes history; caller context and refs are captured before held SQL", async (t) => {
  const f = await fixture(t);
  let release!: () => void, locked!: () => void;
  const hold = new Promise<void>((r) => (release = r)),
    began = new Promise<void>((r) => (locked = r));
  const sqls: string[] = [];
  const db: Database = {
    ...f.db,
    transaction: (fn) =>
      f.db.transaction((tx) =>
        fn({
          query: async <T>(sql: string, args?: unknown[]) => {
            sqls.push(sql);
            const r = await tx.query<T>(sql, args);
            if (args?.includes("knowledge.correction-impact.read_checked")) {
              locked();
              await hold;
            }
            return r;
          },
        }),
      ),
  };
  const context = structuredClone(c),
    before = structuredClone(f.before),
    after = structuredClone(f.after.record);
  const pending = new KnowledgeRepository(db, f.policy).loadCorrectionImpact(
    context,
    before,
    after,
  );
  await began;
  Object.assign(context.actor, { id: "changed" });
  Object.assign(before, { id: "changed" });
  release();
  const r = await pending;
  assert.deepEqual(r.impact.before, f.before);
  const a = sqls.findIndex((x) =>
      x.includes("INSERT INTO public.evidence_audit"),
    ),
    q = sqls.findIndex((x) => x.includes("FROM public.evidence_record"));
  assert(a >= 0 && q > a);
});
test("outer predicate under actual lock, native rejected/nonvoid admission, pre-cancel and blocked-JS deadline fail without audit", async (t) => {
  const f = await fixture(t),
    ac = new AbortController();
  ac.abort();
  await assert.rejects(
    f.repo.loadCorrectionImpact(c, f.before, f.after.record, ac.signal),
  );
  for (const hook of [
    () => true,
    () => Promise.reject(Error("private diagnostic")),
    () => {
      throw Error("private diagnostic");
    },
  ])
    await assert.rejects(
      f.repo.loadCorrectionImpact(
        c,
        f.before,
        f.after.record,
        undefined,
        10000,
        hook as any,
      ),
      (e) => {
        assert(!String(e).includes("private diagnostic"));
        return (e as any).code === "impact_unavailable";
      },
    );
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
  await assert.rejects(
    new KnowledgeRepository(db, f.policy).loadCorrectionImpact(
      c,
      f.before,
      f.after.record,
      undefined,
      10000,
      () => {
        if (locked) throw Error("private locked predicate");
      },
    ),
    { code: "impact_unavailable" },
  );
  locked = false;
  await assert.rejects(
    new KnowledgeRepository(db, f.policy).loadCorrectionImpact(
      c,
      f.before,
      f.after.record,
      undefined,
      100,
      () => {
        if (locked) {
          const end = performance.now() + 150;
          while (performance.now() < end) {}
        }
      },
    ),
    { code: "impact_unavailable" },
  );
  assert(locked);
  assert.equal((await audits(f)).length, 0);
});
test("lost read COMMIT remains unknown; fresh explicit read retains both checked audits with unchanged history", async (t) => {
  const f = await fixture(t),
    before = await f.repo.load(c);
  f.hooks.lost = true;
  await assert.rejects(
    f.repo.loadCorrectionImpact(c, f.before, f.after.record),
  );
  const r = await new KnowledgeRepository(f.db, f.policy).loadCorrectionImpact(
    c,
    f.before,
    f.after.record,
  );
  assert.deepEqual(r.knowledgeStorage, f.after.storage);
  assert.equal((await audits(f)).length, 2);
  assert.deepEqual(await f.repo.load(c), before);
});
test("post-COMMIT cancellation withholds result but preserves audit; corrupt owning state remains retained and denied", async (t) => {
  const f = await fixture(t),
    ac = new AbortController();
  const db: Database = {
    ...f.db,
    transaction: async (fn) => {
      const r = await f.db.transaction(fn);
      ac.abort();
      return r;
    },
  };
  await assert.rejects(
    new KnowledgeRepository(db, f.policy).loadCorrectionImpact(
      c,
      f.before,
      f.after.record,
      ac.signal,
    ),
    { code: "impact_unavailable" },
  );
  assert.equal((await audits(f)).length, 1);
  await scoped(f.db, c, async (tx) => {
    const old = await tx.get(KNOWLEDGE_KIND, KNOWLEDGE_KEY);
    assert(old);
    await tx.put(KNOWLEDGE_KIND, KNOWLEDGE_KEY, 2, old.value);
  });
  await assert.rejects(
    f.repo.loadCorrectionImpact(c, f.before, f.after.record),
  );
  await scoped(f.db, c, async (tx) =>
    assert.equal((await tx.get(KNOWLEDGE_KIND, KNOWLEDGE_KEY))?.revision, 3),
  );
  assert.equal((await audits(f)).length, 1);
});
