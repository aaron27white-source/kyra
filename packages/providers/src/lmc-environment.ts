import { lmcEmailAddressSchema } from "@lobbystack/contracts";
import { lmcProviderMode } from "./lmc-fakes";

export function getLmcEnvironment(
  env: Record<string, string | undefined> = process.env,
) {
  const mode = lmcProviderMode(env);
  const signingSecret =
    env.LMC_SIGNING_SECRET?.trim() ||
    (mode === "fake" ? "lmc-local-demo-only-never-use-in-production" : "");
  if (
    signingSecret.trim().length < 32 ||
    (mode === "real" &&
      /change.?me|placeholder|example|local-demo|replace|development|test-secret|^(.)\1+$/i.test(
        signingSecret,
      ))
  )
    throw new Error("LMC_SIGNING_SECRET_REQUIRED");
  const baseUrl = (
    env.LMC_PUBLIC_BASE_URL ??
    env.APP_BASE_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
  const url = new URL(baseUrl);
  const localHttp =
    mode === "fake" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("LMC_PUBLIC_BASE_URL_INVALID");
  const receivingDomain =
    env.LMC_RECEIVING_DOMAIN ??
    (mode === "fake" ? "inbound.example.invalid" : "");
  if (
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(receivingDomain) ||
    (mode === "real" && /\.invalid$/i.test(receivingDomain))
  )
    throw new Error("LMC_RECEIVING_DOMAIN_REQUIRED");
  const email = lmcEmailAddressSchema.safeParse(
    env.LMC_EMAIL_FROM ?? (mode === "fake" ? "team@example.invalid" : ""),
  );
  if (!email.success || (mode === "real" && /\.invalid$/i.test(email.data)))
    throw new Error("LMC_EMAIL_FROM_REQUIRED");
  return {
    mode,
    signingSecret,
    baseUrl,
    receivingDomain: receivingDomain.toLowerCase(),
    senderEmail: email.data.toLowerCase(),
  };
}
