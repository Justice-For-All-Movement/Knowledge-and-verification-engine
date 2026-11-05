import test from "node:test";
import assert from "node:assert/strict";
import { createVerificationWriteHandler } from "../src/verification-write-http.ts";
import { CurrentVerificationReviewWriter } from "../src/verification-writer.ts";
import { HumanConsentEvidenceKnowledgeReview } from "../src/consent-links.ts";
import { VERIFICATION_REVIEWS_KIND } from "../src/repository.ts";
import {
  writeFixture,
  verificationInput,
  c,
} from "./verification-write-fixture.ts";

async function setup(t: test.TestContext) {
  const f = await writeFixture(t);
  const writer = new CurrentVerificationReviewWriter(
    f.facade,
    new HumanConsentEvidenceKnowledgeReview(
      f.facade,
      f.service,
      f.credential,
      f.makeGuard(),
    ),
  );
  const signals: AbortSignal[] = [];
  const handler = createVerificationWriteHandler(
    writer,
    f.membership,
    {
      authenticate: async (_m, s) => {
        signals.push(s);
        return {
          actorId: "owner",
          requestId: "http",
          csrfToken: "s".repeat(32),
        };
      },
    },
    { ...f.fixed, origin: "https://private.invalid" },
    () => c.now,
  );
  const command = {
    commandId: "record",
    expectedStorageRevision: 0,
    input: verificationInput(f),
  };
  const request = (
    body: unknown = command,
    headers: Record<string, string> = {},
  ) =>
    new Request("https://private.invalid/private/verification-write/record", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://private.invalid",
        "sec-fetch-site": "same-origin",
        "x-csrf-token": "s".repeat(32),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { ...f, writer, handler, signals, command, request };
}
test("protected write records one unresolved observation and exact replay requires current Consent", async (t) => {
  const f = await setup(t);
  const first = await f.handler(f.request());
  assert.equal(first.status, 200);
  const ack = await first.json();
  assert.equal(ack.record.kind, "knowledge-verification-review");
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 1);
  assert.deepEqual(await (await f.handler(f.request())).json(), ack);
  await f.permissions.withdraw(c, "consent", "consent", 1, "withdraw");
  const denied = await f.handler(f.request());
  assert.equal(denied.status, 503);
  assert.deepEqual(await denied.json(), {
    error: "verification_write_unknown",
  });
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 1);
  assert.ok(f.signals.every((s) => s.aborted));
});

test("outer gate denies new and cached records after the actual locked review read", async (t) => {
  const f = await setup(t),
    original = f.knowledge.transaction.bind(f.knowledge);
  let observed = false;
  f.knowledge.transaction = (fn) =>
    original((tx) =>
      fn({
        query: async <T>(sql: string, values?: unknown[]) => {
          const result = await tx.query<T>(sql, values);
          if (
            sql.includes("SELECT") &&
            sql.includes("public.evidence_record") &&
            values?.includes(VERIFICATION_REVIEWS_KIND)
          )
            observed = true;
          return result;
        },
      }),
    );
  const admit = () => {
    if (observed) throw Error("outer deadline");
  };
  await assert.rejects(
    f.writer.record(c, 0, f.command.input, "locked", undefined, admit),
    { code: "verification_commit_unknown" },
  );
  assert.equal(observed, true);
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 0);
  await f.writer.record(c, 0, f.command.input, "locked");
  observed = false;
  await assert.rejects(
    f.writer.record(c, 0, f.command.input, "locked", undefined, admit),
    { code: "verification_commit_unknown" },
  );
  assert.equal(observed, true);
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 1);
});

test("blocked HTTP authentication cannot enter the writer after the monotonic deadline", async (t) => {
  const f = await setup(t);
  let signal: AbortSignal | undefined;
  const handler = createVerificationWriteHandler(
    f.writer,
    f.membership,
    {
      authenticate: async (_m, s) => {
        signal = s;
        const until = performance.now() + 100;
        while (performance.now() < until) {}
        return {
          actorId: "owner",
          requestId: "late",
          csrfToken: "s".repeat(32),
        };
      },
    },
    { ...f.fixed, origin: "https://private.invalid", timeoutMs: 50 },
    () => c.now,
  );
  assert.equal((await handler(f.request())).status, 503);
  assert.equal(signal!.aborted, true);
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 0);
});
test("HTTP admission denies forged authority, CSRF and extra commands before any review effect", async (t) => {
  const f = await setup(t);
  for (const request of [
    f.request(f.command, { origin: "https://foreign.invalid" }),
    f.request(f.command, { "x-csrf-token": "wrong" }),
    f.request({ ...f.command, roles: ["owner"] }),
    f.request({
      ...f.command,
      input: { ...f.command.input, assessment: "verified" },
    }),
  ]) {
    assert.notEqual((await f.handler(request)).status, 200);
  }
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 0);
  const session = await f.handler(
    new Request("https://private.invalid/private/verification-write/session"),
  );
  assert.equal(session.status, 200);
});
test("writer's synchronous outer admission cannot be bypassed by async/value hooks before SQL", async (t) => {
  const f = await setup(t);
  for (const admit of [
    () => true,
    async () => {},
    () => {
      throw Error("private diagnostic");
    },
  ])
    await assert.rejects(
      f.writer.record(
        c,
        0,
        f.command.input,
        "bad",
        undefined,
        admit as () => void,
      ),
    );
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 0);
});

test("lost actual write COMMIT stays unknown; explicit replay and acknowledged cancellation never add a second effect", async (t) => {
  const f = await setup(t),
    original = f.knowledge.transaction.bind(f.knowledge),
    control = new AbortController();
  let mode: "lose" | "normal" | "cancel" = "lose",
    effects = 0;
  f.knowledge.transaction = async (fn) => {
    let wrote = false;
    const value = await original((tx) =>
      fn({
        query: async <T>(sql: string, values?: unknown[]) => {
          const r = await tx.query<T>(sql, values);
          if (
            sql.includes("INSERT INTO public.evidence_record") &&
            values?.includes(VERIFICATION_REVIEWS_KIND)
          )
            wrote = true;
          return r;
        },
      }),
    );
    if (wrote) {
      effects++;
      if (mode === "lose") {
        mode = "normal";
        throw Error("private lost COMMIT");
      }
      if (mode === "cancel") control.abort();
    }
    return value;
  };
  const unknown = await f.handler(f.request());
  assert.equal(unknown.status, 503);
  assert.deepEqual(await unknown.json(), {
    error: "verification_write_unknown",
  });
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 1);
  assert.equal(effects, 1);
  const replay = await f.handler(f.request());
  assert.equal(replay.status, 200);
  assert.equal(effects, 1);
  mode = "cancel";
  const next = {
    ...f.command,
    commandId: "next",
    expectedStorageRevision: 1,
    input: { ...f.command.input, expectedRevision: 1 },
  };
  const request = new Request(f.request(next), { signal: control.signal });
  assert.equal((await f.handler(request)).status, 200);
  assert.equal(control.signal.aborted, true);
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 2);
  assert.equal(effects, 2);
});

test("body chunk byte UTF8 and cancellation admission finishes before authentication or any review effect", async (t) => {
  const f = await setup(t);
  let auth = 0;
  const handler = createVerificationWriteHandler(
    f.writer,
    f.membership,
    {
      authenticate: async () => {
        auth++;
        return {
          actorId: "owner",
          requestId: "http",
          csrfToken: "s".repeat(32),
        };
      },
    },
    { ...f.fixed, origin: "https://private.invalid", timeoutMs: 1000 },
    () => c.now,
  );
  const streamed = (body: ReadableStream<Uint8Array>, signal?: AbortSignal) =>
    new Request("https://private.invalid/private/verification-write/record", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://private.invalid",
      },
      body,
      duplex: "half",
      ...(signal ? { signal } : {}),
    } as RequestInit);
  for (const bytes of [
    Uint8Array.of(0xc3, 0x28),
    new Uint8Array(128 * 1024 + 1),
  ]) {
    assert.equal(
      (
        await handler(
          streamed(
            new ReadableStream({
              start(c) {
                c.enqueue(bytes);
                c.close();
              },
            }),
          ),
        )
      ).status,
      503,
    );
  }
  assert.equal(
    (
      await handler(
        streamed(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 4097; i++) c.enqueue(Uint8Array.of(32));
              c.close();
            },
          }),
        ),
      )
    ).status,
    503,
  );
  const control = new AbortController();
  let cancelled = false;
  const pending = handler(
    streamed(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      control.signal,
    ),
  );
  control.abort();
  assert.equal((await pending).status, 503);
  assert.equal(cancelled, true);
  assert.equal(auth, 0);
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 0);
});

test("HTTP monotonic deadline is checked after the real locked review read even when JS blocks timers", async (t) => {
  const f = await setup(t),
    original = f.knowledge.transaction.bind(f.knowledge);
  let blocked = false;
  f.knowledge.transaction = (fn) =>
    original((tx) =>
      fn({
        query: async <T>(sql: string, values?: unknown[]) => {
          const r = await tx.query<T>(sql, values);
          if (
            sql.includes("SELECT") &&
            sql.includes("public.evidence_record") &&
            values?.includes(VERIFICATION_REVIEWS_KIND)
          ) {
            blocked = true;
            const until = performance.now() + 1100;
            while (performance.now() < until) {}
          }
          return r;
        },
      }),
    );
  const handler = createVerificationWriteHandler(
    f.writer,
    f.membership,
    {
      authenticate: async () => ({
        actorId: "owner",
        requestId: "http",
        csrfToken: "s".repeat(32),
      }),
    },
    { ...f.fixed, origin: "https://private.invalid", timeoutMs: 1000 },
    () => c.now,
  );
  assert.equal((await handler(f.request())).status, 503);
  assert.equal(blocked, true);
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 0);
});
