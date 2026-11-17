import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { canAttachLiveCall, type DomainContext } from "@lobbystack/domain";
import type { ExtraRouteHandler } from "./health";
import {
  isLivePrototypeEnabled,
  LIVE_ATTACH_PATH,
  parseAttachRequest,
} from "./liveCalls";

const MAX_BODY_BYTES = 16 * 1024;
type IncomingRequest = Parameters<ExtraRouteHandler>[0];
function authorized(request: IncomingRequest): boolean {
  const expected = process.env.INTERNAL_SERVICE_TOKEN,
    presented = request.headers["x-internal-service-token"];
  if (!expected || typeof presented !== "string") return false;
  const a = Buffer.from(expected),
    b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Bounded collection without destroying the request socket before sending 413. */
function bodyBytes(request: IncomingRequest): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    function cleanup() {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    }
    function onData(chunk: Buffer) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        cleanup();
        request.resume();
        resolve(undefined);
      } else chunks.push(chunk);
    }
    function onEnd() {
      cleanup();
      resolve(Buffer.concat(chunks));
    }
    function onError(error: Error) {
      cleanup();
      reject(error);
    }
    function onAborted() {
      onError(new Error("ATTACH_REQUEST_ABORTED"));
    }
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

export function createVerifiedLiveAttachHandler(input: {
  domain: DomainContext;
  handle: ExtraRouteHandler;
}): ExtraRouteHandler {
  return async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const reply = (status: number, error: string) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error }));
      return true;
    };
    // Preserve legacy handling for unrelated routes and the disabled feature,
    // but make the sole pilot exception fail closed before reaching it.
    if (path !== LIVE_ATTACH_PATH || !isLivePrototypeEnabled()) return input.handle(request, response);
    if (request.method !== "POST") return reply(405, "Method not allowed.");
    if (!authorized(request)) return reply(401, "Unauthorized.");
    let raw: Buffer | undefined;
    try {
      raw = await bodyBytes(request);
    } catch {
      return reply(400, "Invalid attach request.");
    }
    if (raw === undefined) return reply(413, "Attach request is too large.");
    let body: ReturnType<typeof parseAttachRequest>;
    try {
      body = parseAttachRequest(raw.toString("utf8"));
    } catch {
      return reply(400, "Invalid attach request.");
    }
    if (!body) return reply(400, "Invalid attach request.");
    try {
      if (!(await canAttachLiveCall(input.domain, body)))
        return reply(404, "Call unavailable.");
    } catch {
      return reply(503, "Attach temporarily unavailable.");
    }
    // Replay exactly the validated bytes to the unchanged voice handler.
    const replay = Object.assign(Readable.from([raw]), {
      url: request.url,
      method: request.method,
      headers: request.headers,
    }) as IncomingRequest;
    return input.handle(replay, response);
  };
}
