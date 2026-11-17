/* Public, dependency-free capture form. Capture tokens grant intake access only. */
(() => {
  "use strict";
  const script = document.currentScript;
  if (!script || script.dataset.lmcMounted) return;
  const token = script.getAttribute("data-capture-token") || "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  let source;
  try {
    source = new URL(script.src);
  } catch {
    return;
  }
  if (
    source.protocol !== "https:" &&
    !(
      source.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(source.hostname)
    )
  )
    return;
  script.dataset.lmcMounted = "true";

  function uuid() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function mount() {
    const host = document.createElement("div");
    host.setAttribute("data-lmc-form", "");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    if (script.nonce) style.nonce = script.nonce;
    style.textContent = `
      :host { display:block; max-width:32rem; font:inherit; color:var(--lmc-form-foreground,CanvasText); }
      * { box-sizing:border-box; }
      form { padding:1.5rem; border:1px solid var(--lmc-form-border,#a3a3a3); border-radius:12px; background:var(--lmc-form-background,Canvas); }
      h2 { margin:0 0 1rem; font-size:1.25em; }
      fieldset { border:0; padding:0; margin:0; min-width:0; display:grid; gap:1rem; }
      label { display:grid; gap:.5rem; }
      input:not([type=checkbox]),textarea { width:100%; padding:.75rem; border:1px solid var(--lmc-form-border,#a3a3a3); border-radius:12px; font:inherit; color:inherit; background:inherit; }
      textarea { resize:vertical; min-height:8rem; }
      .consent { display:flex; align-items:flex-start; gap:.5rem; font-size:.875em; }
      .consent input { margin-top:.25rem; flex:none; }
      button { justify-self:start; padding:.75rem 1.25rem; border:1px solid; border-radius:12px; font:inherit; cursor:pointer; color:var(--lmc-form-button-text,ButtonText); background:var(--lmc-form-button,ButtonFace); }
      button:disabled { cursor:wait; opacity:.6; }
      :focus-visible { outline:3px solid Highlight; outline-offset:3px; }
      p { font-size:.875em; margin:1rem 0 0; line-height:1.5; }
    `;
    const form = document.createElement("form");
    form.setAttribute("aria-label", "Request service");
    const title = document.createElement("h2");
    title.textContent = "Request service";
    const fields = document.createElement("fieldset");
    function field(name, labelText, options) {
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement(
        options.multiline ? "textarea" : "input",
      );
      input.name = name;
      if (!options.multiline) input.type = options.type || "text";
      input.required = Boolean(options.required);
      input.maxLength = options.maxLength;
      if (options.autocomplete) input.autocomplete = options.autocomplete;
      label.append(input);
      fields.append(label);
      return input;
    }
    const name = field("name", "Name (optional)", {
      maxLength: 160,
      autocomplete: "name",
    });
    const email = field("email", "Email", {
      type: "email",
      required: true,
      maxLength: 320,
      autocomplete: "email",
    });
    const message = field("message", "How can we help?", {
      multiline: true,
      required: true,
      maxLength: 16000,
    });
    const consentLabel = document.createElement("label");
    consentLabel.className = "consent";
    const consent = document.createElement("input");
    consent.type = "checkbox";
    consent.name = "consentToFollowUp";
    consent.checked = false;
    consentLabel.append(
      consent,
      document.createTextNode(
        "I agree to receive up to 3 follow-up emails about this request. I can unsubscribe at any time.",
      ),
    );
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Send request";
    fields.append(consentLabel, button);
    const privacy = document.createElement("p");
    privacy.textContent = "We’ll use your email to respond to this request.";
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    form.append(title, fields, privacy, status);
    root.append(style, form);
    let busy = false,
      request = null;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || !form.reportValidity()) return;
      if (!message.value.trim()) {
        status.textContent = "Please describe your request.";
        message.focus();
        return;
      }
      const payload = {
        email: email.value.trim(),
        name: name.value.trim(),
        subject: "",
        message: message.value.trim(),
        consentToFollowUp: consent.checked,
      };
      const fingerprint = JSON.stringify(payload);
      let body;
      try {
        if (!request || request.fingerprint !== fingerprint)
          request = { fingerprint, id: uuid() };
        body = JSON.stringify({ requestId: request.id, ...payload });
      } catch {
        status.textContent =
          "Your browser cannot submit this form. Please contact the business directly.";
        return;
      }
      if (new Blob([body]).size > 32768) {
        status.textContent =
          "Your message is too long. Please shorten it and try again.";
        return;
      }
      busy = true;
      fields.disabled = true;
      button.disabled = true;
      form.setAttribute("aria-busy", "true");
      status.textContent = "Sending your request…";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(
          `${source.origin}/api/lmc/capture/${token}`,
          {
            method: "POST",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            headers: { "Content-Type": "application/json" },
            body,
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          status.textContent =
            response.status === 429
              ? "Too many requests. Please try again later."
              : response.status === 404
                ? "This form is unavailable. Please contact the business directly."
                : "We couldn’t confirm your request. Please try again.";
          return;
        }
        form.reset();
        request = null;
        status.textContent = "Thank you. Your request was received.";
      } catch {
        status.textContent =
          "We couldn’t confirm your request. Please try again.";
      } finally {
        clearTimeout(timeout);
        busy = false;
        fields.disabled = false;
        button.disabled = false;
        form.removeAttribute("aria-busy");
      }
    });
    if (script.parentNode && script.parentNode !== document.head)
      script.after(host);
    else document.body.append(host);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
