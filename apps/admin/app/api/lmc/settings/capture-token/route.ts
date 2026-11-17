import { withLmcApi } from "@/lib/lmc-api";
export async function POST(request: Request) {
  return withLmcApi(request, ({ workspace, actor }) =>
    workspace.rotateCaptureToken(actor),
  );
}
