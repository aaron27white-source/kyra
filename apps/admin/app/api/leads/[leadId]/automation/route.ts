import { lmcPauseSchema } from "@lobbystack/contracts";
import { readLmcJson, withLmcApi } from "@/lib/lmc-api";
export async function PATCH(
  request: Request,
  context: { params: Promise<{ leadId: string }> },
) {
  const { leadId } = await context.params;
  return withLmcApi(request, async ({ workspace, actor }) =>
    workspace.pause(
      actor,
      leadId,
      lmcPauseSchema.parse(await readLmcJson(request)).paused,
    ),
  );
}
