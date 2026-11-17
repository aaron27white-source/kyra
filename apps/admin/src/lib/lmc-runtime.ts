import {
  LmcHumanReplies,
  LmcLeadCapture,
  LmcEmailReception,
  LmcWorkspace,
} from "@lobbystack/domain";
import {
  FakeLmcInboundProvider,
  ResendLmcProvider,
} from "@lobbystack/providers";
import { getDatabase } from "./databases";
import { getLmcEnvironment } from "./lmc-env";

let services: ReturnType<typeof createServices> | undefined;
let inbound: FakeLmcInboundProvider | ResendLmcProvider | undefined;
export { getLmcEnvironment } from "./lmc-env";

function createServices() {
  const config = getLmcEnvironment(),
    now = () => new Date();
  const database = getDatabase("lobbystack_app").db,
    worker = getDatabase("lobbystack_worker").db;
  return {
    workspace: new LmcWorkspace({
      database,
      now,
      senderEmail: config.senderEmail,
    }),
    human: new LmcHumanReplies({ database, now, ...config }),
    capture: new LmcLeadCapture({ database: worker, now }),
    reception: new LmcEmailReception({ database: worker, now, ...config }),
  };
}
export function getLmcServices() {
  return (services ??= createServices());
}
export function getLmcInbound() {
  if (inbound) return inbound;
  const config = getLmcEnvironment();
  return (inbound =
    config.mode === "fake"
      ? new FakeLmcInboundProvider()
      : new ResendLmcProvider({
          apiKey: process.env.RESEND_API_KEY ?? "",
          webhookSecret: process.env.RESEND_WEBHOOK_SECRET ?? "",
        }));
}
