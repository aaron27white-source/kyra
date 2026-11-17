import { asApiResponse, requireOperatorBusiness } from "./api-helpers";
import { getLmcServices } from "./lmc-runtime";

export class LmcRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export async function readLmcJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new LmcRequestError(400, "INVALID_JSON");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32_768) {
        await reader.cancel();
        throw new LmcRequestError(413, "REQUEST_TOO_LARGE");
      }
      chunks.push(part.value);
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      throw new LmcRequestError(400, "INVALID_JSON");
    }
  } finally {
    reader.releaseLock();
  }
}
type Services = ReturnType<typeof getLmcServices>;
export async function withLmcApi(
  request: Request,
  operation: (
    context: Services & { actor: { tenantId: string; userId: string } },
  ) => Promise<unknown>,
): Promise<Response> {
  try {
    const { session, businessId } = await requireOperatorBusiness(request);
    const result = await operation({
      ...getLmcServices(),
      actor: { tenantId: businessId, userId: session.user.id },
    });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof Error && error.name === "ZodError")
      return Response.json({ error: "INVALID_INPUT" }, { status: 400 });
    if (error instanceof LmcRequestError)
      return Response.json({ error: error.code }, { status: error.status });
    return asApiResponse(error);
  }
}
