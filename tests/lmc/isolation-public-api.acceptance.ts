import { expect, it } from "vitest";
import { probePublicApiResources } from "./support/isolation-public-api";

it("audits real API-key management and public resource boundaries over HTTP", async () => {
  const report = await probePublicApiResources(
    process.env.LMC_TEST_HTTP_BASE_URL ?? "http://localhost:3000",
  );
  expect(report.failures).toEqual([]);
  const publicMethods = [
    "GET",
    "HEAD",
    "POST",
    "PATCH",
    "PUT",
    "DELETE",
    "OPTIONS",
  ];
  expect(report.probed.sort()).toEqual(
    [
      ...[
        "/api/v1/contacts",
        "/api/v1/contacts/[contact_id]",
        "/api/v1/services",
        "/api/v1/staff",
        "/api/v1/me",
        "/api/v1/business",
      ].flatMap((path) => publicMethods.map((method) => `${method} ${path}`)),
      ...["GET", "HEAD", "POST", "OPTIONS"].map(
        (method) => `${method} /api/api-keys`,
      ),
      "DELETE /api/api-keys/[apiKeyId]",
      "OPTIONS /api/api-keys/[apiKeyId]",
    ].sort(),
  );
}, 120_000);
