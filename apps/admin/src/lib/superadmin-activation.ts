import { getLmcEnvironment } from "@lobbystack/providers";

export function getManagedActivationEnvironment(env: Record<string, string | undefined> = process.env) {
  let lmc: ReturnType<typeof getLmcEnvironment>;
  try { lmc = getLmcEnvironment(env); }
  catch { return { senderEmail: env.LMC_EMAIL_FROM?.trim().toLowerCase() ?? "", emailProviderReady: false }; }
  const resendReady = /^re_[A-Za-z0-9_-]{8,}$/.test(env.RESEND_API_KEY ?? "")
    && /^whsec_[A-Za-z0-9+/]+={0,2}$/.test(env.RESEND_WEBHOOK_SECRET ?? "")
    && env.LMC_EMAIL_WORKER_ENABLED === "true";
  return {
    senderEmail: lmc.senderEmail,
    emailProviderReady: lmc.mode === "fake" ? env.NODE_ENV !== "production" : resendReady,
  };
}
