import { lmcHumanReplySchema } from "@lobbystack/contracts";
import { readLmcJson, withLmcApi } from "@/lib/lmc-api";
export async function POST(
  request: Request,
  context: { params: Promise<{ leadId: string }> },
) {
  const { leadId } = await context.params;
  return withLmcApi(request, async ({ human, actor }) =>
    human.reply(
      { ...actor, leadId },
      lmcHumanReplySchema.parse(await readLmcJson(request)),
    ),
  );
}
