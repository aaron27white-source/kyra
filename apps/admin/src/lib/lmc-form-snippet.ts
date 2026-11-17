/** A public intake token can be embedded, but must never become executable markup. */
export function createLmcFormSnippet(baseUrl: string, token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error("INVALID_CAPTURE_TOKEN");
  const url = new URL(baseUrl);
  const local =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password)
    throw new Error("INVALID_FORM_ORIGIN");
  return `<script src="${url.origin}/lmc-form.js" data-capture-token="${token}" defer></script>`;
}
