/**
 * Kyra doesn't run LobbyStack's affiliate program. The upstream code stays in
 * place for a future Key 20 referral program, but it's off unless this flag is
 * set. NEXT_PUBLIC_ so the dashboard link and the server routes agree.
 */
export function affiliateProgramEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AFFILIATE_PROGRAM_ENABLED === "true";
}
