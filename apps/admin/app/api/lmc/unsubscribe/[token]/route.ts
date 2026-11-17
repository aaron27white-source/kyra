import { handleLmcUnsubscribe } from "@lobbystack/domain";
import { getLmcServices } from "@/lib/lmc-runtime";
async function handle(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  return handleLmcUnsubscribe(
    request,
    (await context.params).token,
    getLmcServices().reception,
  );
}
export const GET = handle;
export const POST = handle;
