# Kyra Voice V2 — rollout and evaluation

## Code-level findings

- Phone startup injected the configured greeting and treated any reflected audio delta as evidence that startup was ready. It did not wait for Live's `session.commentary.appended` acknowledgement for the greeting's `event_id`; the log label could therefore overstate what had happened. Startup now waits for both the matching context acknowledgement and output audio transport, and logs explicitly say that audibility is unverified. A SIP-sideband reflection still cannot prove what the caller heard.
- The voice tool set exposed `getBusinessServices` even though the same service facts were already included in the per-call snapshot and instructions. Phone and browser voice no longer expose this redundant delegated tool; chat and non-voice channels retain it.
- Availability results were already cached for exact repeated arguments. Different preferred times remain separate requests because they can correctly produce different slots; tests protect both behaviors.
- A missing or malformed `callerPhone` in the trusted attach request had no call-record fallback. Phone calls now recover a valid E.164 value from the tenant-scoped call/contact record only when the attach value is absent or invalid. This does not authenticate the caller or reveal contact details.
- Booking previously had no service-location input, required-field policy, or durable appointment location. Configured policies are now validated again inside the booking transaction before contact or appointment writes.

The supplied incident reports a 217-second call, seven delegations, `missing_phone`, and `slot_not_offered`. No production database or raw call event record was available in this implementation environment, so those events were not independently queried. The code findings above are reproducible from the repository; the precise production sequence remains unverified.

## Intake policy and compatibility

Business defaults live on `receptionist_profiles.intake_policy`; per-service rules live on `services.intake_policy`. Service settings override business field requirements. New on-site configurations default to requiring a service address. Remote and in-office services do not acquire that requirement by default. Existing rows remain `NULL`, interpreted as `unspecified` with no new required fields, until an operator configures a policy.

The appointment stores the work location separately from the contact and stores permitted intake answers as structured JSON. Customer name and callback number remain in existing contact fields rather than being copied into appointment answer JSON. The transaction rejects missing fields, invalid address structure, and configured exact city/postal-code mismatches before it inserts a contact, appointment, notification, or calendar job. Postal syntax checks do not claim that an address exists or has been geocoded.

When a caller declines required details, Kyra must not call the booking successful. With caller permission, it creates the existing tenant-scoped inbox follow-up with `requestKind=appointment_request`; the dashboard labels it “Appointment follow-up (not booked).” It is not an appointment or a reserved calendar slot. Staff may complete or correct an existing service location through the appointment endpoint, restricted to scheduler-or-higher membership and tenant scope.

Calendar events intentionally do not receive service addresses in this release. The existing synchronization path does not have an explicit address-sharing consent setting, and service addresses can be sensitive. An operator correction updates the appointment and dashboard, not external calendar recipients.

Contacts currently have no structured default-address field. Voice therefore asks for the appointment's service location rather than guessing from caller ID or reusing an address. A future saved-address flow needs verified customer identity, explicit confirmation of the selected address, and a correction path before it is safe to add.

## Local regression harness and baseline

Run the repeatable deterministic tests:

```sh
pnpm --filter @lobbystack/agent-core exec vitest run src/live/callController.test.ts src/live/session.test.ts src/instructions.test.ts src/tools.test.ts
pnpm --filter @lobbystack/domain exec vitest run src/server/service-intake.test.ts src/server/booking.availability.test.ts
```

These verify opening acknowledgement/audio ordering, duplicate delegation suppression, no voice service-discovery tool, exact duplicate availability caching, business/service policy overrides, address and area checks, backend rejection before writes, normalized address persistence, and appointment idempotency.

For PostgreSQL commit-time verification, apply migrations to a dedicated local test database and run the `configured onsite intake` case in `packages/domain/src/server/reliability.integration.test.ts` with `LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL` set to that database. It confirms missing-address rejection, one successful appointment, one idempotent retry, and structured persisted location.

The local aggregate evaluator is:

```sh
pnpm voice-v2:evaluate -- --candidate /path/to/candidate-eval.json --baseline /path/to/baseline-eval.json
```

`--baseline` is optional; if omitted the report explicitly says `baseline_not_supplied`. The strict, PII-free input schema is exported as `voiceEvalCaseSchema` from `scripts/voice-v2-evaluation.ts`. It summarizes repeated greetings/questions, unnecessary questions, service and availability lookup counts, tool calls per completed booking, mean/p95 delegation and first-useful-response latency, booking and intake success, annotated address/service-area accuracy, hangup rate, call duration, billed seconds, and estimated cost. A human or deterministic simulated test must provide the conversational and address-accuracy annotations; the tool does not infer words from audio, accept transcripts/addresses/phone numbers, or claim an address was geographically verified. Its aggregation and validation behavior is covered by `scripts/voice-v2-evaluation.test.ts`.

The incident-provided baseline is 217 billed seconds and seven delegations for one HVAC booking, with two failed booking tool results. This is an incident report, not a fresh database measurement. The repository does not contain the exact production transcript/event fixture or per-call cost/latency/address annotations, so no full baseline dataset or numerical before/after improvement is claimed. Preserve sanitized annotations separately and compare them with the same evaluator after rollout. Production performance can also be reviewed using `voice.delegation_completed`, `voice.call_latency_recorded`, and call billing events.

## Pilot release checklist

1. Apply migration `0080_voice_intake.sql` using the normal migration workflow. It adds nullable policy columns and nullable appointment JSON fields; it does not backfill new requirements onto existing services.
2. Confirm the demo tenant's Voice feature and number routing are enabled. This code does not enable voice for any tenant or purchase numbers.
3. Configure an explicit business default only if appropriate, then configure each on-site service's required fields and any exact allowed city/postal-code lists. Never copy an assumed coverage area from another customer.
4. Place a non-billable/local simulated inbound test where available: ask for an on-site service without address; verify no appointment is created. Supply a syntactically valid location and consent; verify exactly one booking and the location in the operator dashboard.
5. Test remote/in-office services do not prompt for a home address. Test an outside-area location becomes a follow-up only after the caller agrees.
6. Verify the configured greeting's acknowledgement and audio-transport logs. They do not establish that the carrier delivered audible audio.
7. Verify no service address appears in application logs or calendar event details. Calendar sync deliberately excludes it until explicit sharing controls exist.
8. Review production call duration, delegation count/latency, incomplete-intake follow-ups, confirmed bookings, and billing before enabling other pilot tenants.
