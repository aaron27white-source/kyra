"use client";

import { useQuery } from "@tanstack/react-query";

import { Surface } from "@/components/ui/surface";
import { requestJson } from "@/lib/request-json";

type InboundNumberResponse = { phoneNumber: { e164: string; status: string; voiceEnabled: boolean; voiceWebhookStatus: string | null } | null };

export function LmcInboundNumberCard() {
  const number = useQuery({ queryKey: ["lmc-inbound-number"], queryFn: () => requestJson<InboundNumberResponse>("/api/lmc/voice/number") });
  return <Surface className="p-5 sm:p-6"><h2 className="font-semibold">Inbound phone number</h2>{number.isPending ? <p className="mt-2 text-sm text-muted-foreground">Loading assigned number…</p> : number.data?.phoneNumber ? <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="font-mono">{number.data.phoneNumber.e164}</p><p className="text-sm text-muted-foreground">{number.data.phoneNumber.status} · voice {number.data.phoneNumber.voiceEnabled ? "enabled" : "disabled"} · SIP {number.data.phoneNumber.voiceWebhookStatus ?? "not checked"}</p></div> : <p className="mt-2 text-sm text-muted-foreground">No active number is assigned. Ask the pilot operator to attach an existing number to this workspace and route it through the configured Twilio SIP trunk.</p>}</Surface>;
}
