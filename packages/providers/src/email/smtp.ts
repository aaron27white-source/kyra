import { createHash } from "node:crypto";

import nodemailer, { type Transporter } from "nodemailer";
import { assertCertificationRecipient, brand } from "@lobbystack/shared";

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
  replyTo?: string;
};

type TemplateName = "existing_account" | "verify_email" | "password_reset" | "invitation" | "operator_alert" | "feedback_submission" | "onboarding_followup";

export class SmtpEmailProvider {
  private readonly transporter: Transporter;
  private readonly config: SmtpConfig;

  constructor(config: SmtpConfig, transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: config.password },
  })) {
    this.config = config;
    this.transporter = transporter;
  }

  async sendTemplate(input: { template: TemplateName; to: string; subject: string; variables: Record<string, string>; idempotencyKey?: string; from?: string; replyTo?: string }): Promise<{ messageId: string }> {
    assertCertificationRecipient("email", input.to);
    const email = renderTemplate(input.template, input.subject, input.variables);
    // A per-message sender (the founder check-in) replaces the default reply-to
    // too, so replies reach that sender rather than the shared inbox.
    const replyTo = input.from ? input.replyTo : input.replyTo ?? this.config.replyTo;
    const result = await this.transporter.sendMail({
      from: input.from ?? this.config.from,
      ...(replyTo ? { replyTo } : {}),
      to: input.to,
      subject: input.subject,
      text: email.text,
      ...(email.html ? { html: email.html } : {}),
      ...(input.idempotencyKey ? { messageId: `<${createHash("sha256").update(input.idempotencyKey).digest("hex")}@mail.lobbystack.internal>` } : {}),
    });
    return { messageId: result.messageId };
  }
}


/**
 * Transactional email over Resend HTTPS. Reuses the SMTP provider's templates
 * and stable outbox idempotency key, without opening blocked SMTP ports.
 */
export class ResendTransactionalEmailProvider {
  constructor(private readonly config: {
    apiKey: string;
    from: string;
    replyTo?: string;
    fetch?: typeof fetch;
  }) {
    if (!/^re_[A-Za-z0-9_-]{8,}$/.test(config.apiKey)) {
      throw new Error("RESEND_CONFIGURATION_REQUIRED");
    }
  }

  async sendTemplate(input: Parameters<SmtpEmailProvider["sendTemplate"]>[0]): Promise<{ messageId: string }> {
    assertCertificationRecipient("email", input.to);
    const email = renderTemplate(input.template, input.subject, input.variables);
    // An explicit sender must not inherit the application's default reply-to.
    const replyTo = input.from ? input.replyTo : input.replyTo ?? this.config.replyTo;
    const payload = {
      from: input.from ?? this.config.from,
      to: [input.to],
      subject: input.subject,
      text: email.text,
      ...(email.html ? { html: email.html } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
    };

    try {
      const response = await (this.config.fetch ?? fetch)("https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          ...(input.idempotencyKey ? { "Idempotency-Key": createHash("sha256").update(input.idempotencyKey).digest("hex") } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("EMAIL_PROVIDER_UNAVAILABLE");
      const result: unknown = await response.json();
      const messageId = result !== null && typeof result === "object" && "id" in result
        ? (result as { id: unknown }).id
        : undefined;
      if (typeof messageId !== "string" || messageId.length === 0) {
        throw new Error("EMAIL_PROVIDER_UNAVAILABLE");
      }
      return { messageId };
    } catch {
      // Do not leak credentials, recipients or provider responses into job logs.
      throw new Error("EMAIL_PROVIDER_UNAVAILABLE");
    }
  }
}

function renderTemplate(template: TemplateName, subject: string, variables: Record<string, string>): { text: string; html?: string } {
  const text = templateBody(template, variables);

  if (template !== "verify_email" || !variables.code) {
    return { text };
  }

  const code = escapeHtml(variables.code);
  return {
    text,
    html: renderEmailLayout({
      previewText: subject,
      content: [
        '<h1 style="margin:0 0 24px;font-size:28px;font-weight:600;line-height:1.25;color:#0B0B0D;text-align:center;">Verify your email address</h1>',
        `<p style="margin:0 0 24px;font-size:16px;line-height:1.6;color:#3D3D3D;text-align:center;">Enter this verification code to finish setting up your ${brand.name} account.</p>`,
        `<p style="margin:0 0 24px;padding:16px 24px;background-color:#F3F4F6;border-radius:16px;font-size:32px;font-weight:600;line-height:1.25;letter-spacing:8px;color:#0B0B0D;text-align:center;">${code}</p>`,
        '<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#6B7280;text-align:center;">This code expires in 10 minutes.</p>',
        '<p style="margin:0;font-size:14px;line-height:1.5;color:#6B7280;text-align:center;">If you did not request this code, you can safely ignore this email.</p>',
      ].join(""),
    }),
  };
}

function templateBody(template: TemplateName, variables: Record<string, string>): string {
  switch (template) {
    case "existing_account":
      return variables.locale === "fr"
        ? `Vous avez déjà un compte ${brand.name}. Connectez-vous pour continuer : ${variables.signInUrl}. Mot de passe oublié ? ${variables.resetUrl}. Si vous n’avez pas demandé la création d’un compte, ignorez cet e-mail.`
        : `You already have a ${brand.name} account. Sign in to continue: ${variables.signInUrl}. Forgot your password? ${variables.resetUrl}. If you did not request an account, ignore this email.`;
    case "verify_email":
      return variables.code
        ? `Your ${brand.name} email verification code is: ${variables.code}. It expires in 10 minutes.`
        : `Verify your ${brand.name} email address using this link: ${variables.url ?? ""}`;
    case "password_reset":
      return variables.code
        ? `Your ${brand.name} password reset code is: ${variables.code}. It expires in 10 minutes.`
        : `Reset your ${brand.name} password using this link: ${variables.url ?? ""}`;
    case "invitation":
      return `You have been invited to join ${brand.name}. Accept the invitation here: ${variables.url ?? ""}`;
    case "operator_alert":
      return variables.message ?? `${brand.name} operator notification`;
    case "feedback_submission":
      return variables.body ?? `${brand.name} dashboard feedback`;
    case "onboarding_followup":
      return onboardingFollowupBody(variables);
  }
}

function onboardingFollowupBody(variables: Record<string, string>): string {
  const sender = variables.senderName ?? "";
  const business = variables.businessName ?? "";
  if (variables.locale === "fr") {
    return [
      variables.firstName ? `Bonjour ${variables.firstName},` : "Bonjour,",
      "",
      `Je suis ${sender}, le fondateur de ${brand.name}. Vous avez configuré une réceptionniste pour ${business} hier. Merci de l'avoir essayée.`,
      "",
      "J'aimerais savoir ce que vous en avez pensé :",
      "",
      "1. Avez-vous aimé l'expérience ? Qu'est-ce qui a bien fonctionné, et qu'est-ce qui clochait ?",
      "2. Que devrions-nous améliorer ?",
      "3. Comptez-vous l'utiliser pour vrai, avec votre propre numéro de téléphone ? Sinon, qu'est-ce qui vous en empêche ?",
      "",
      "Vous pouvez répondre à ce courriel, et deux lignes suffiraient !",
      "",
      "Merci encore,",
      sender,
      `Fondateur, ${brand.name}`,
    ].join("\n");
  }
  return [
    variables.firstName ? `Hi ${variables.firstName},` : "Hi,",
    "",
    `I'm ${sender}, the founder of ${brand.name}. You set up a receptionist for ${business} yesterday. Thanks for giving it a try.`,
    "",
    "I'd love to hear what you thought:",
    "",
    "1. Did you like it? What worked, and what felt off?",
    "2. What should we improve?",
    "3. Do you plan to use it for real, with your own phone number? If not, what's stopping you?",
    "",
    "You can reply to this email, and two lines would be plenty!",
    "",
    "Thanks again,",
    sender,
    `Founder, ${brand.name}`,
  ].join("\n");
}

function renderEmailLayout({ previewText, content }: { previewText: string; content: string }): string {
  const escapedPreviewText = escapeHtml(previewText);
  const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 64 64" role="img" aria-label="${brand.name}"><rect width="64" height="64" rx="12" fill="${brand.colors.primary}"/><path d="M18 16v32h28v-8H26V16z" fill="${brand.colors.onPrimary}"/></svg>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${escapedPreviewText}</title>
    <style>
      :root { color-scheme: light; }
      @media only screen and (max-width: 620px) {
        .email-container { width: 100% !important; padding: 24px 16px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background-color:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%">
      <tr>
        <td align="center" style="padding:48px 16px;">
          <table role="presentation" class="email-container" border="0" cellspacing="0" cellpadding="0" width="600" style="width:600px;max-width:600px;background-color:#FFFFFF;border-radius:24px;padding:48px;">
            <tr>
              <td align="center" style="padding-bottom:32px;">
                ${logoSvg}
              </td>
            </tr>
            <tr>
              <td>
                ${content}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
