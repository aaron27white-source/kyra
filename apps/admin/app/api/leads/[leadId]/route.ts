import { withLmcApi } from "@/lib/lmc-api";
export async function GET(
  request: Request,
  context: { params: Promise<{ leadId: string }> },
) {
  const { leadId } = await context.params,
    before = new URL(request.url).searchParams.get("before");
  return withLmcApi(request, ({ workspace, actor }) =>
    workspace.detail(actor, leadId, before ? { before } : {}),
  );
}
