"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

function safeReturnTo(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export function SuperAdminMfaChallenge() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (useBackupCode ? code.trim().length < 6 : !/^\d{6}$/.test(code)) return;
    setLoading(true); setError(null);
    const response = await fetch(`/api/auth/two-factor/${useBackupCode ? "verify-backup-code" : "verify-totp"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(useBackupCode ? { code: code.trim(), trustDevice: false } : { code, trustDevice: false }) });
    if (!response.ok) { setError(useBackupCode ? "The recovery code is invalid or has already been used." : "The authenticator code is invalid or expired."); setLoading(false); return; }
    router.push(safeReturnTo(new URLSearchParams(window.location.search).get("returnTo")));
  }
  return <MfaFrame title="Confirm it’s you" description={useBackupCode ? "Enter one of your single-use recovery codes." : "Enter the current code from your authenticator app."}><form className="space-y-4" onSubmit={submit}><Field data-invalid={error ? true : undefined}><FieldLabel htmlFor="totp-code">{useBackupCode ? "Recovery code" : "Authenticator code"}</FieldLabel><Input autoComplete="one-time-code" id="totp-code" inputMode={useBackupCode ? "text" : "numeric"} maxLength={useBackupCode ? 64 : 6} onChange={(event) => setCode(useBackupCode ? event.target.value.slice(0, 64) : event.target.value.replace(/\D/g, "").slice(0, 6))} value={code} />{error && <FieldError>{error}</FieldError>}</Field><Button className="w-full" disabled={loading || (useBackupCode ? code.trim().length < 6 : code.length !== 6)} type="submit">{loading ? "Verifying…" : "Continue"}</Button><Button className="w-full" onClick={() => { setCode(""); setError(null); setUseBackupCode((value) => !value); }} type="button" variant="link">{useBackupCode ? "Use authenticator app" : "Use a recovery code"}</Button></form></MfaFrame>;
}

export function SuperAdminMfaSetup() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function begin(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError(null);
    const response = await fetch("/api/auth/two-factor/enable", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password, method: "totp" }) });
    const body = await response.json().catch(() => null) as { totpURI?: string; backupCodes?: string[] } | null;
    if (!response.ok || !body?.totpURI) { setError("We could not enable MFA. Check your password and try again."); setLoading(false); return; }
    setTotpUri(body.totpURI); setBackupCodes(body.backupCodes ?? []); setPassword(""); setLoading(false);
  }
  async function confirm(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError(null);
    const response = await fetch("/api/auth/two-factor/verify-totp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, trustDevice: false }) });
    if (!response.ok) { setError("The authenticator code is invalid or expired."); setLoading(false); return; }
    router.push("/internal");
  }
  if (!totpUri) return <MfaFrame title="Secure your admin account" description="Super Admin access requires a verified authenticator app. Confirm your password to begin."><form className="space-y-4" onSubmit={begin}><Field data-invalid={error ? true : undefined}><FieldLabel htmlFor="password">Password</FieldLabel><Input autoComplete="current-password" id="password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} />{error && <FieldError>{error}</FieldError>}</Field><Button className="w-full" disabled={loading || !password} type="submit">{loading ? "Preparing…" : "Set up authenticator"}</Button></form></MfaFrame>;
  const secret = new URL(totpUri).searchParams.get("secret") ?? "";
  return <MfaFrame title="Verify your authenticator" description="Add this account to your authenticator app, save the recovery codes, then enter a code."><div className="space-y-4"><div className="rounded-lg bg-muted p-3"><p className="text-xs font-medium text-muted-foreground">Manual setup key</p><code className="mt-1 block break-all text-sm">{secret}</code></div><div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10"><p className="text-sm font-medium text-amber-950 dark:text-amber-100">Recovery codes — save once</p><div className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs text-amber-900 dark:text-amber-200">{backupCodes.map((backup) => <span key={backup}>{backup}</span>)}</div></div><form className="space-y-4" onSubmit={confirm}><Field data-invalid={error ? true : undefined}><FieldLabel htmlFor="setup-code">Authenticator code</FieldLabel><Input autoComplete="one-time-code" id="setup-code" inputMode="numeric" maxLength={6} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} value={code} />{error && <FieldError>{error}</FieldError>}</Field><Button className="w-full" disabled={loading || code.length !== 6} type="submit">{loading ? "Verifying…" : "Finish setup"}</Button></form></div></MfaFrame>;
}

function MfaFrame({ children, title, description }: { children: React.ReactNode; title: string; description: string }) {
  return <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-foreground"><Card className="w-full max-w-md shadow-xl"><CardHeader><div className="mb-2 flex size-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">{title.includes("Confirm") ? <KeyRound className="size-5" /> : <ShieldCheck className="size-5" />}</div><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent>{children}</CardContent></Card></main>;
}
