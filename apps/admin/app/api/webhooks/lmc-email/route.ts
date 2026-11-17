import { handleLmcEmailWebhook } from "@lobbystack/domain";
import { getLmcInbound, getLmcServices } from "@/lib/lmc-runtime";
export async function POST(request: Request) {
  return handleLmcEmailWebhook(
    request,
    getLmcInbound(),
    getLmcServices().reception,
  );
}
