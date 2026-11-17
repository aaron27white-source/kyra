import { expect, it } from "vitest";
import { createLmcFormSnippet } from "./lmc-form-snippet";
it("generates a copyable snippet for a capture capability at the serving origin", () => {
  expect(
    createLmcFormSnippet("https://app.example/settings/email", "A".repeat(43)),
  ).toBe(
    `<script src="https://app.example/lmc-form.js" data-capture-token="${"A".repeat(43)}" defer></script>`,
  );
});
it("rejects attribute injection and insecure or credential-bearing script origins", () => {
  expect(() =>
    createLmcFormSnippet("https://app.example", '" onload="alert(1)'),
  ).toThrow();
  for (const origin of [
    "javascript:alert(1)",
    "http://remote.example",
    "https://user:password@app.example",
  ])
    expect(() => createLmcFormSnippet(origin, "A".repeat(43))).toThrow();
  expect(
    createLmcFormSnippet("http://localhost:3000", "A".repeat(43)),
  ).toContain("http://localhost:3000/lmc-form.js");
});
