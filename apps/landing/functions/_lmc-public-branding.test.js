import { describe, expect, it } from "vitest"
import { brand } from "@lobbystack/shared/brand"
import { onRequest } from "./_middleware.js"
import { publicStatus } from "../src/lib/agent-discovery"

describe("LMC public deployment identity", () => {
  it.each([
    `www.${brand.domain}`,
    `${brand.domain.split(".")[0]}-landing.pages.dev`,
  ])("redirects %s to the configured product domain", async (hostname) => {
    const response = await onRequest({
      request: new Request(`https://${hostname}/pricing?source=demo`),
      env: {},
      next: async () => new Response("public asset"),
    })
    expect(response.status).toBe(301)
    expect(response.headers.get("Location")).toBe(
      `${brand.url}/pricing/?source=demo`
    )
  })
  it("uses the configured product identity in public operational discovery", () => {
    expect(publicStatus.service).toBe(`${brand.name} public discovery`)
    expect(publicStatus.documentation).toBe(`${brand.url}/docs/api/`)
  })
})
