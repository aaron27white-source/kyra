import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Database } from "@lobbystack/db";
const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  drain: vi.fn(),
  realModel: vi.fn(),
  classifyFailure: vi.fn(() => ({ code: "LMC_JOB_FAILED" })),
}));
vi.mock("@lobbystack/domain", () => ({
  classifyLmcJobFailure: mocks.classifyFailure,
  LmcEmailWorker: class {
    constructor(input: unknown) {
      mocks.construct(input);
    }
    drain = mocks.drain;
  },
}));
vi.mock("@lobbystack/agent-core", () => ({
  EmailChannel: class {
    readonly kind = "email";
    constructor(readonly model: unknown) {}
  },
  createLmcEmailModel: mocks.realModel,
}));
import { createLmcEmailRuntime, emailWorkerEnabled } from "./lmcEmail";
const db = {} as Database;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.drain.mockResolvedValue({ completed: 0, failed: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("defaults to fakes even with real keys present and permits only explicit real production providers", () => {
  const runtime = createLmcEmailRuntime({
    database: db,
    dispatcher: db,
    environment: {
      NODE_ENV: "test",
      RESEND_API_KEY: "present-but-unused",
      OPENAI_API_KEY: "present-but-unused",
    },
  });
  expect(runtime.mode).toBe("fake");
  expect(mocks.realModel).not.toHaveBeenCalled();
  expect(mocks.construct.mock.calls[0]![0]).toMatchObject({
    allowLocalHttp: true,
    baseUrl: "http://localhost:3000",
    channel: { kind: "email" },
  });
  expect(() =>
    createLmcEmailRuntime({
      database: db,
      dispatcher: db,
      environment: { NODE_ENV: "production" },
    }),
  ).toThrow();
});
it("serializes iterations, recovers from queue failure and stops when aborted", async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const status = vi.fn();
  const log = vi.spyOn(console,"error").mockImplementation(() => {});
  let release!: () => void;
  mocks.drain
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ completed: 1, failed: 0 });
        }),
    )
    .mockRejectedValueOnce(new Error("private SQL and credentials"));
  const runtime = createLmcEmailRuntime({
    database: db,
    dispatcher: db,
    environment: { NODE_ENV: "test" },
  });
  const running = runtime.run(abort.signal, status);
  await vi.advanceTimersByTimeAsync(3000);
  expect(mocks.drain).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(1000);
  expect(status).toHaveBeenCalledWith(false);
  expect(log).toHaveBeenCalledWith(JSON.stringify({event:"lmc_email_worker_cycle_failed",code:"LMC_JOB_FAILED"}));
  expect(log.mock.calls.flat().join(" ")).not.toContain("private SQL");
  abort.abort();
  await running;
  const calls = mocks.drain.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3000);
  expect(mocks.drain).toHaveBeenCalledTimes(calls);
});
it("logs only sanitized structured diagnostics for durable email job failures",()=>{
  const log=vi.spyOn(console,"error").mockImplementation(()=>{});
  createLmcEmailRuntime({database:db,dispatcher:db,environment:{NODE_ENV:"test"}});
  const options=mocks.construct.mock.calls[0]![0] as {onJobFailure:(value:{kind:string;code:string;category:string;attempts:number;terminal:boolean})=>void};
  options.onJobFailure({kind:"send",code:"EMAIL_PROVIDER_UNAVAILABLE",category:"sending",attempts:3,terminal:false});
  expect(log).toHaveBeenCalledWith(JSON.stringify({event:"lmc_email_job_failed",kind:"send",code:"EMAIL_PROVIDER_UNAVAILABLE",category:"sending",attempts:3,terminal:false}));
});
it("does not consume when already aborted and preserves opt-out of email startup", async () => {
  const runtime = createLmcEmailRuntime({
    database: db,
    dispatcher: db,
    environment: { NODE_ENV: "test" },
  });
  const abort = new AbortController();
  abort.abort();
  await runtime.run(abort.signal);
  expect(mocks.drain).not.toHaveBeenCalled();
  expect(emailWorkerEnabled({ NODE_ENV: "development" })).toBe(true);
  expect(emailWorkerEnabled({ NODE_ENV: "production" })).toBe(false);
  expect(emailWorkerEnabled({ LMC_EMAIL_WORKER_ENABLED: "true" })).toBe(true);
  expect(emailWorkerEnabled({ LMC_EMAIL_WORKER_ENABLED: "false" })).toBe(false);
  expect(() =>
    emailWorkerEnabled({ LMC_EMAIL_WORKER_ENABLED: "invalid" }),
  ).toThrow();
});

it("constructs real adapters only for explicit real configuration without making a startup request", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const environment = {
    NODE_ENV: "production",
    LMC_PROVIDER_MODE: "real",
    LMC_PUBLIC_BASE_URL: "https://app.example.org",
    LMC_RECEIVING_DOMAIN: "inbound.example.org",
    LMC_EMAIL_FROM: "team@example.org",
    LMC_SIGNING_SECRET: randomBytes(32).toString("hex"),
    RESEND_API_KEY: "re_12345678",
    RESEND_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 1).toString("base64")}`,
  };
  mocks.realModel.mockReturnValue({ analyze: vi.fn() });
  const runtime = createLmcEmailRuntime({
    database: db,
    dispatcher: db,
    environment,
  });
  expect(runtime.mode).toBe("real");
  expect(mocks.realModel).toHaveBeenCalledWith(environment);
  expect(mocks.construct.mock.calls[0]![0]).toMatchObject({
    allowLocalHttp: false,
  });
  expect(fetcher).not.toHaveBeenCalled();
});
