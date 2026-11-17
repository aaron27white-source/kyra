import { readLmcJson, withLmcApi } from "@/lib/lmc-api";
import { getLmcEnvironment } from "@/lib/lmc-runtime";
export async function GET(request: Request) {
  return withLmcApi(request, async ({ workspace, actor }) => ({
    ...(await workspace.settings(actor)),
    providerMode: getLmcEnvironment().mode,
  }));
}
export async function PUT(request: Request) {
  return withLmcApi(request, async ({ workspace, actor }) =>
    workspace.saveSettings(actor, await readLmcJson(request)),
  );
}
