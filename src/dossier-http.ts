import { timingSafeEqual } from "node:crypto";
import { MembershipRegistry } from "@accountability/identity-policy/membership";
import { createMembershipSessionAuthentication } from "@accountability/identity-policy/membership-session";
import type { HumanSessionProvider } from "@accountability/identity-policy/membership-session";
import { CurrentClaimDossierReader } from "./dossier-source.ts";
import { invariant, nonempty, requireScope, validateRef } from "./contracts.ts";
import type { Scope } from "./contracts.ts";

/** Private read-only native Fetch adapter. Host provides independently authenticated human sessions and TLS. */
export function createDossierReadHandler(
  reader: CurrentClaimDossierReader,
  membership: MembershipRegistry,
  provider: HumanSessionProvider,
  configuration: Scope & { origin: string; purpose: string; timeoutMs?: number },
  clock: () => string,
) {
  invariant(reader instanceof CurrentClaimDossierReader && membership instanceof MembershipRegistry,
    "invalid_policy", "Owning dossier reader and membership registry required");
  const policy = structuredClone(configuration), origin = new URL(policy.origin);
  invariant(Object.keys(policy).every(k=>["tenantId","projectId","origin","purpose","timeoutMs"].includes(k)),
    "invalid_policy", "Exact dossier HTTP configuration required");
  for (const value of [policy.tenantId,policy.projectId,policy.purpose]) nonempty(value,"Fixed dossier policy",128);
  invariant(origin.protocol === "https:" && origin.origin === policy.origin,
    "invalid_policy", "Exact HTTPS origin required");
  const timeout = policy.timeoutMs ?? 10000;
  invariant(Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= 30000,
    "invalid_policy", "Bounded dossier HTTP deadline required");
  const auth = createMembershipSessionAuthentication(membership, provider,
    { ...policy, action: "investigate", timeoutMs: timeout }, clock);
  const read = CurrentClaimDossierReader.prototype.read.bind(reader);
  const base = "/private/dossier";
  const response = (status: number, value: unknown) => {
    const body = JSON.stringify(value);
    invariant(Buffer.byteLength(body) <= 512 * 1024, "dossier_unavailable", "Response exceeds budget");
    return new Response(body, { status, headers: {
      "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    } });
  };
  return async (request: Request): Promise<Response> => {
    const started = performance.now(), owned = new AbortController(), abort = () => owned.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(abort, timeout);
    const gate = () => invariant(!owned.signal.aborted && performance.now() - started < timeout,
      "dossier_unavailable", "Dossier HTTP unavailable");
    let stream: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      gate();
      const url = new URL(request.url), method = request.method;
      if (url.origin !== policy.origin || url.search || url.hash ||
          !((method === "GET" && url.pathname === base + "/session") ||
            (method === "POST" && url.pathname === base + "/read")))
        return response(404, { error: "not_found" });
      const metadata = { url: url.href, method, headers: new Headers(request.headers) };
      const site = metadata.headers.get("sec-fetch-site");
      if (site && site !== "same-origin" && !(method === "GET" && site === "none"))
        return response(403, { error: "request_denied" });
      if ((metadata.headers.has("origin") && metadata.headers.get("origin") !== policy.origin) ||
          (method === "POST" && metadata.headers.get("origin") !== policy.origin))
        return response(403, { error: "request_denied" });
      let selected: Readonly<{claim:ReturnType<typeof validateRef>;links:ReturnType<typeof validateRef>}> | undefined;
      if (method === "POST") {
        if (metadata.headers.get("content-type") !== "application/json")
          return response(400, { error: "invalid_request" });
        const length = metadata.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > 1024))
          return response(400, { error: "invalid_request" });
        const pieces: Uint8Array[] = [];
        let bytes = 0, chunks = 0;
        stream = request.body?.getReader();
        if (!stream) return response(400, { error: "invalid_request" });
        while (true) {
          gate();
          const item = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
            const interrupted = () => reject(Error("cancelled"));
            owned.signal.addEventListener("abort", interrupted, { once: true });
            if (owned.signal.aborted) interrupted();
            stream!.read().then(resolve, reject).finally(() => owned.signal.removeEventListener("abort", interrupted));
          });
          gate();
          if (item.done) break;
          bytes += item.value.byteLength;
          invariant(++chunks <= 4096 && bytes <= 1024, "invalid_request", "Body exceeds budget");
          pieces.push(Uint8Array.from(item.value));
        }
        const data = new Uint8Array(bytes);
        let offset = 0;
        for (const piece of pieces) { data.set(piece, offset); offset += piece.length; }
        const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
        gate();
        invariant(input && typeof input === "object" && !Array.isArray(input) &&
          Object.keys(input).length === 1 && Object.hasOwn(input, "selected"),
          "invalid_request", "Exact selected reference required");
        const choice = input.selected;
        invariant(choice && typeof choice === "object" && !Array.isArray(choice) &&
          Object.keys(choice).length === 2 && Object.hasOwn(choice,"claim") && Object.hasOwn(choice,"links"),
          "invalid_request", "Exact claim and citation selection required");
        selected = {claim:validateRef(choice.claim),links:validateRef(choice.links)};
        requireScope(policy,selected.claim); requireScope(policy,selected.links);
        invariant(selected.claim.kind === "claim" && selected.links.kind === "knowledge-evidence-links",
          "invalid_request", "Positive typed dossier selection required");
      }
      gate();
      // Body admission precedes fresh stored membership observation. Begun Identity SQL is awaited.
      const session = await auth.authenticate(metadata, owned.signal);
      gate();
      if (!session) return response(401, { error: "authentication_required" });
      requireScope(policy, session.context);
      if (method === "GET") {
        const result = response(200, { actorId: session.context.actor.id, csrfToken: session.csrfToken });
        gate();
        return result;
      }
      const token = metadata.headers.get("x-csrf-token");
      if (!token || token.length > 256) return response(403, { error: "request_denied" });
      const supplied = Buffer.from(token), expected = Buffer.from(session.csrfToken);
      if (!supplied.length || supplied.length > 256 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        return response(403, { error: "request_denied" });
      const value = await read(session.context, selected!, owned.signal, gate);
      gate();
      const result = response(200, value);
      gate();
      return result;
    } catch {
      return response(503, { error: "dossier_unavailable" });
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      owned.abort();
      if (stream) void stream.cancel().catch(() => {});
    }
  };
}
