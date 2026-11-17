// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const waitFor = vi.waitFor;

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function mount(token = "A".repeat(43)) {
  document.body.insertAdjacentHTML(
    "beforeend",
    '<script src="https://lmc.example/lmc-form.js"></script>',
  );
  const dom = { window };
  const script = dom.window.document.querySelector("script:last-of-type")!;
  script.setAttribute("data-capture-token", token);
  Object.defineProperty(dom.window.document, "currentScript", {
    value: script,
    configurable: true,
  });
  const fetch = vi.fn(async () => new Response("", { status: 202 }));
  vi.stubGlobal("fetch", fetch);
  const code = readFileSync(resolve("public/lmc-form.js"), "utf8");
  dom.window.eval(code);
  const root = dom.window.document.querySelector("[data-lmc-form]")?.shadowRoot;
  const field = (name: string) =>
    root!.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  const change = (name: string, value: string) => {
    field(name).value = value;
    field(name).dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const submit = () =>
    root!
      .querySelector("form")!
      .dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
  return { dom, script, root, field, change, submit, fetch, code };
}
it("posts only capture fields without browser credentials and requires explicit follow-up consent", async () => {
  const form = mount();
  expect(form.field("consentToFollowUp").checked).toBe(false);
  form.change("email", "lead@example.invalid");
  form.change("message", '<img src=x onerror="alert(1)"> Roof repair');
  form.submit();
  await waitFor(() => expect(form.fetch).toHaveBeenCalledOnce());
  const [url, init] = form.fetch.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toBe(`https://lmc.example/api/lmc/capture/${"A".repeat(43)}`);
  expect(init.credentials).toBe("omit");
  expect(init.referrerPolicy).toBe("no-referrer");
  expect(JSON.parse(init.body as string)).toEqual({
    requestId: expect.any(String),
    email: "lead@example.invalid",
    name: "",
    subject: "",
    message: '<img src=x onerror="alert(1)"> Roof repair',
    consentToFollowUp: false,
  });
  expect(form.root!.querySelector("img")).toBeNull();
  await waitFor(() =>
    expect(form.root!.querySelector('[role="status"]')!.textContent).toContain(
      "received",
    ),
  );
});
it("reuses the same request ID after uncertain failures and never renders provider error HTML", async () => {
  const form = mount();
  form.fetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ error: '<img src=x onerror="alert(1)">' }),
        { status: 503 },
      ),
  );
  form.change("email", "lead@example.invalid");
  form.change("message", "Roof repair please");
  form.submit();
  await waitFor(() =>
    expect(form.root!.querySelector("button")!.disabled).toBe(false),
  );
  form.submit();
  await waitFor(() => expect(form.fetch).toHaveBeenCalledTimes(2));
  const bodies = (
    form.fetch.mock.calls as unknown as [string, RequestInit][]
  ).map(([, init]) => JSON.parse(init.body as string));
  expect(bodies[1]).toEqual(bodies[0]);
  expect(form.root!.querySelector("img")).toBeNull();
});
it("uses a new request ID when the submitted payload changes and records checked consent", async () => {
  const form = mount();
  form.fetch.mockImplementation(async () => new Response("", { status: 503 }));
  form.change("email", "lead@example.invalid");
  form.change("message", "First request");
  form.submit();
  await waitFor(() =>
    expect(form.root!.querySelector("button")!.disabled).toBe(false),
  );
  form.change("message", "Updated request");
  form.field("consentToFollowUp").checked = true;
  form.submit();
  await waitFor(() => expect(form.fetch).toHaveBeenCalledTimes(2));
  const bodies = (
    form.fetch.mock.calls as unknown as [string, RequestInit][]
  ).map(([, init]) => JSON.parse(init.body as string));
  expect(bodies[1].requestId).not.toBe(bodies[0].requestId);
  expect(bodies[1].consentToFollowUp).toBe(true);
});
it("ignores invalid tokens and does not mount twice for the same script", () => {
  const invalid = mount('" onload="alert(1)');
  expect(invalid.root).toBeUndefined();
  expect(invalid.fetch).not.toHaveBeenCalled();
  const form = mount();
  form.dom.window.eval(form.code);
  expect(
    form.dom.window.document.querySelectorAll("[data-lmc-form]"),
  ).toHaveLength(1);
});
