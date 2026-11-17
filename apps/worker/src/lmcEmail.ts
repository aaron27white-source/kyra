import { EmailChannel, createLmcEmailModel, createLmcEmailResponder } from "@lobbystack/agent-core";
import { LmcEmailWorker } from "@lobbystack/domain";
import type { DomainContext } from "@lobbystack/domain";
import {
  FakeLmcEmailModel,
  FakeLmcEmailProvider,
  ResendLmcProvider,
  getLmcEnvironment,
} from "@lobbystack/providers";
import type { Database } from "@lobbystack/db";
import { classifyLmcJobFailure } from "@lobbystack/domain";

export function emailWorkerEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = env.LMC_EMAIL_WORKER_ENABLED;
  if (flag !== undefined && flag !== "true" && flag !== "false")
    throw new Error("INVALID_LMC_EMAIL_WORKER_ENABLED");
  return (
    flag === "true" || (flag === undefined && env.NODE_ENV !== "production")
  );
}

function wait(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    const timer = setTimeout(done, 500);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

/** Uses only the dedicated email queue. It owns no voice, Redis or calendar consumers. */
export function createLmcEmailRuntime(input: {
  database: Database;
  dispatcher: Database;
  domain?: DomainContext;
  environment?: Record<string, string | undefined>;
}) {
  const environment = input.environment ?? process.env;
  const config = getLmcEnvironment(environment);
  const model =
    config.mode === "fake"
      ? new FakeLmcEmailModel()
      : createLmcEmailModel(environment);
  const mail =
    config.mode === "fake"
      ? new FakeLmcEmailProvider()
      : new ResendLmcProvider({
          apiKey: environment.RESEND_API_KEY ?? "",
          webhookSecret: environment.RESEND_WEBHOOK_SECRET ?? "",
        });
  const worker = new LmcEmailWorker({
    database: input.database,
    dispatcher: input.dispatcher,
    now: () => new Date(),
    channel: new EmailChannel(model, input.domain ? createLmcEmailResponder(input.domain, environment) : undefined),
    mail,
    ...config,
    allowLocalHttp: config.mode === "fake",
    onJobFailure: (diagnostic) => console.error(JSON.stringify({ event: "lmc_email_job_failed", ...diagnostic })),
  });
  return {
    mode: config.mode,
    async run(
      signal: AbortSignal,
      status: (ready: boolean) => void = () => {},
    ) {
      while (!signal.aborted) {
        try {
          await worker.drain(1, signal);
          if (!signal.aborted) status(true);
        } catch (error) {
          console.error(JSON.stringify({ event: "lmc_email_worker_cycle_failed", code: classifyLmcJobFailure(error).code }));
          if (!signal.aborted) status(false);
        }
        if (!signal.aborted) await wait(signal);
      }
    },
  };
}
