import { withLmcApi } from "@/lib/lmc-api";
export async function GET(request: Request) {
  const url = new URL(request.url),
    status = url.searchParams.get("status"),
    search = url.searchParams.get("search");
  return withLmcApi(request, ({ workspace, actor }) =>
    workspace.list(actor, {
      limit: Number(url.searchParams.get("limit") ?? 25),
      offset: Number(url.searchParams.get("offset") ?? 0),
      ...(status ? { status } : {}),
      ...(search ? { search } : {}),
    }),
  );
}
