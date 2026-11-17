import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { lmcEmailAddressSchema, lmcRawEmailSchema } from "@lobbystack/contracts";

export const MAX_INBOUND_EMAIL_BYTES = 64 * 1024;

export type NormalizedInboundEmail = {
  kind: "message";
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  attachmentsIgnored: number;
  optOut: boolean;
  injectionDetected: boolean;
};
export type InboundEmailResult = NormalizedInboundEmail | { kind: "reject" | "ignore"; reason: string };

export function normalizeInboundRecipient(value:string):string|null {return address(value,true);}

function address(value: string, preserveLocalPart = false): string | null {
  if (/[\r\n\0]/.test(value)) return null;
  const match = value.trim().match(/^(?:[^<>\r\n]*<([^<>\r\n]+)>|([^<>\s]+))$/);
  const raw = (match?.[1] ?? match?.[2] ?? "").trim();
  const at = raw.lastIndexOf("@");
  const candidate = preserveLocalPart && at>0 ? `${raw.slice(0,at)}@${raw.slice(at+1).toLowerCase()}` : raw.toLowerCase();
  const parsed = lmcEmailAddressSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function messageIds(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/<[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9.\-]+>/g)]
    .map(([id]) => id).filter((id) => id.length <= 255).slice(-20);
}

const hiddenElements = new Set(["script", "style", "head", "template", "blockquote", "svg", "noscript"]);
const blockElements = new Set(["p", "div", "br", "li", "tr", "section", "h1", "h2", "h3", "hr"]);
function htmlText(node: DefaultTreeAdapterMap["node"], preserveForwarded=false): string {
  if (node.nodeName === "#text" && "value" in node) return node.value;
  if (!("childNodes" in node)) return "";
  if ("tagName" in node) {
    if (hiddenElements.has(node.tagName) && !(preserveForwarded&&node.tagName==="blockquote")) return "";
    if (node.attrs.some((attr) => attr.name === "hidden" || (attr.name === "aria-hidden" && attr.value === "true"))) return "";
  }
  const text = node.childNodes.map(child=>htmlText(child,preserveForwarded)).join("");
  return "tagName" in node && blockElements.has(node.tagName) ? `\n${text}\n` : text;
}

export function stripEmailHistory(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const current: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line) || /^--\s*$/.test(line)
      || /^\s*On .{1,500}wrote:\s*$/i.test(line)
      || /^\s*Le .{1,500}(?:écrit|ecrit)\s*:\s*$/i.test(line)
      || /^\s*-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}\s*$/i.test(line)) break;
    current.push(line);
  }
  return current.join("\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function normalizeInboundEmail(input: unknown,options:{preserveForwardedNotification?:boolean}={}): InboundEmailResult {
  let encoded: string;
  try { encoded = JSON.stringify(input); } catch { return { kind: "reject", reason: "invalid_envelope" }; }
  if (typeof encoded !== "string") return { kind: "reject", reason: "invalid_envelope" };
  if (Buffer.byteLength(encoded, "utf8") > MAX_INBOUND_EMAIL_BYTES) return { kind: "reject", reason: "message_too_large" };
  const parsed = lmcRawEmailSchema.safeParse(input);
  if (!parsed.success) return { kind: "reject", reason: "invalid_envelope" };
  const email = parsed.data;
  const from = address(email.from);
  const to = address(email.to,true);
  if (!from || !to || /[\r\n\0]/.test(email.subject) || Object.keys(email.headers).length > 100
    || Object.entries(email.headers).some(([key, value]) => !/^[A-Za-z0-9-]{1,80}$/.test(key) || value.length > 4_096 || /[\r\n\0]/.test(value))) {
    return { kind: "reject", reason: "invalid_envelope" };
  }
  const auth = email.authentication;
  if (!auth || auth.spf !== "pass" || auth.dkim !== "pass" || auth.dmarc !== "pass" || !auth.aligned) {
    return { kind: "reject", reason: "authentication_failed" };
  }
  const headers = Object.fromEntries(Object.entries(email.headers).map(([key, value]) => [key.toLowerCase(), value.trim()]));
  if ((headers["auto-submitted"] && headers["auto-submitted"].toLowerCase() !== "no")
    || /^(?:bulk|list|junk)$/i.test(headers.precedence ?? "")
    || headers["x-autoreply"] || headers["x-autorespond"] || headers["list-id"]
    || headers["return-path"] === "<>"
    || /^(?:no[._-]?reply|do[._-]?not[._-]?reply|mailer-daemon|postmaster)(?:[+._-]|@)/i.test(from)
    || /^(?:automatic reply|auto(?:matic)?[- ]?response|out of office|undeliverable|delivery (?:status|failure))/i.test(email.subject)) {
    return { kind: "ignore", reason: "automatic_email" };
  }
  const body = email.text?.trim() ? email.text : htmlText(parseFragment(email.html ?? ""),options.preserveForwardedNotification);
  const text = options.preserveForwardedNotification ? body.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "").trim() : stripEmailHistory(body);
  if (!text) return { kind: "ignore", reason: "empty_message" };
  const untrustedFields = `${email.from}\n${email.subject}\n${text}`;
  return {
    kind: "message", from, to, subject: email.subject.trim(), text,
    messageId: messageIds(headers["message-id"])[0] ?? null,
    inReplyTo: messageIds(headers["in-reply-to"]).at(-1) ?? null,
    references: messageIds(headers.references),
    attachmentsIgnored: email.attachments.length,
    optOut: /^(?:stop|unsubscribe|opt[ -]?out|remove me|cancel emails)[.!\s]*$/i.test(text),
    injectionDetected: /ignore\s+(?:all\s+)?(?:your|previous|system)\s+(?:rules|instructions)|\bsystem\s*:|\b(?:give|apply)\s+\d{1,3}\s*%\s*(?:off|discount)|another\s+tenant/i.test(untrustedFields),
  };
}
