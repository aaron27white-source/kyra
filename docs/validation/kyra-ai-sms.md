# Kyra: AI SMS

Upstream LobbyStack lists AI-generated SMS (`billing.ai_sms`) as intentionally excluded. Kyra adds it on purpose: replying to a missed caller by text is the core of missed-call recovery.

What keeps it in bounds:

- It's gated on the server. `smsAssistant.ts` returns early unless the business has `smsAiEnabled` on and its tier allows `sms_ai`.
- Emergency replies use fixed, pre-approved wording, never generated text.
- Every outbound message is logged in `outreach_sends`, scoped by `business_id` under `FORCE ROW LEVEL SECURITY`.
- A2P 10DLC registration is still out of scope (`compliance.twilio_a2p`). Each business has to send from a number that is already compliant.

Evidence: `packages/domain/src/server/assistant/assistant.test.ts` and `assistant.integration.test.ts`, including the cross-business probe on all six Kyra tables.
