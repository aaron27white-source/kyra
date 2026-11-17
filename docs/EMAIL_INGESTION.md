# Initial email and forwarded lead notifications

Initial messages use the existing signed provider webhook and durable email worker.
They do not use the browser form endpoint or a new unauthenticated email endpoint.
The default development/test providers remain fake. Voice sources are unchanged.

## Addresses and provisioning

For a tenant's current capture token `TOKEN` and `LMC_RECEIVING_DOMAIN`, use:

- `lead+TOKEN@LMC_RECEIVING_DOMAIN` for a new lead emailing the business.
- `forward+TOKEN@LMC_RECEIVING_DOMAIN` for an owner-forwarded contact-form notification.
- `reply+CONVERSATION_TOKEN@LMC_RECEIVING_DOMAIN` for subsequent replies. The worker
  generates and sets this private address automatically on outgoing mail.

The 43-character capture token is issued by the existing administrator-only token
rotation operation in email settings. The prefix routes a database transaction;
only its stored hash authorizes capture for that tenant. Rotation invalidates both
old form installations and these two intake addresses. Update forwarding rules and
published inbox addresses together when rotating. Intake addresses grant capture
only, never CRM reads, contact verification or booking authority. They are redacted
from CRM read responses and model inputs. Current UI token issuance/install-snippet
controls remain; a dedicated inbox-address setup panel is still to be added.

Enable receiving for the real domain at the provider and connect its signed webhook
to `/api/webhooks/lmc-email`. Follow EMAIL_RUNTIME.md for the explicit real-provider
flag and signing/API keys. DNS/MX/provider configuration and real delivery have not
been performed in the sandbox. Do not paste real tokens into logs or commit them.

## Supported forwarded notification format

The outer authenticated sender must equal the configured owner email. Normal
manual forwarding from that mailbox is supported, including plain text and HTML
notifications inside a blockquote. Automatic mailbox rules that preserve another
original From address are not accepted as owner authorization. Configure an
owner-sent notification/forward or use the direct lead address; do not disable the
authentication checks to accommodate an untrusted sender.

The notification must contain one explicit email before its message:

```text
Name: Ana Smith
Email: ana@example.invalid
Message: I need roof repair at my residential property in ZIP 33101.
```

`Name` is optional; `Full Name`, `Lead Name`, and `Customer Name` are accepted.
`Lead Email`/`E-mail` and `Lead Message` are also supported. `Message:` may have
its text on following lines. Ordinary forwarded From/Date/Subject headers and a
short introductory note are allowed before these fields. Multiple email/name
fields before Message, invalid addresses, missing/empty Message or unsupported
free-form formats are rejected rather than guessed. Email-like text after Message
remains untrusted message content and cannot change the reply recipient. Quoted
From/Reply-To headers, attachments, links and model output never select the contact.
Provider inbox review is required for rejected/unsupported notification formats;
there is no arbitrary-vendor template extractor or attachment parser.

Forwarded fields are plain untrusted lead data. They do not prove that the contact
owns the email address, grant calendar-change authority, or opt the lead into
follow-ups. The first reply goes to the explicit lead address and does not carry
the owner's notification Message-ID as a conversation reference. Subsequent lead
replies use the existing sender/token/thread verification and canonical booking.

## Authentication, safety and idempotency

The provider signature covers the exact webhook bytes. The Resend adapter loads
the message from its fixed receiving API origin and accepts only server-computed
SPF/DKIM/DMARC pass verdicts. Sender-supplied Authentication-Results is not trusted.
The [official receiving API reference](https://resend.com/docs/api-reference/emails/retrieve-received-email)
documents this authentication object; its `received_for` values come from Received
headers and are not used as an owner-identity proof. Missing historical verdicts
fail closed. No signing or sender-authentication requirement was relaxed.

The existing bounded webhook/envelope handling, loop prevention, HTML-to-text
sanitization and attachment ignoring apply. Only explicit forwarded-notification
mode preserves the quoted notification container; extracted Message still loses
old reply history/signatures. The normalized capture must meet its existing
32-KiB JSON / 16,000-character message limits; subjects are bounded to 200 characters.
Existing per-tenant/per-sender capture quotas apply atomically with persistence.

Both provider-event ID and RFC Message-ID are tenant-scoped idempotency claims.
Stable ordered advisory locks serialize their claims; a new delivery ID for the
same unchanged Message-ID adds an identity alias without creating another lead,
message or reply. Changed payloads or Message-IDs cannot reuse a claimed event.
Contact, lead, original inbound message, source metadata, identity aliases and job
are committed together. A conflicting existing message rolls the capture back.
Permanent invalid messages are acknowledged without a reply; infrastructure/quota
failures retain the existing retryable webhook 503 behavior.

Direct first mail retains its Message-ID for the outgoing In-Reply-To/References.
Untrusted sender display names, subjects and bodies keep the injection guard and
human fallback; attempts are logged through the actual worker path. Initial direct
and forwarded messages default to no follow-up consent and no booking verification.
Authenticated direct STOP suppresses that sender's existing conversations in the
same tenant, including queued/future follow-ups, without sending an acknowledgment
or creating a new lead. A quoted forwarded STOP does not establish recipient consent.

## Verification

`tests/lmc/initial-email.acceptance.ts` uses real HTTP, PostgreSQL/runtime roles,
the application worker, qualification and calendar booking; only external providers
and clock are fake. It covers direct-email-to-booking, owner-forwarded notifications,
concurrent/rekeyed re-deliveries, conflicts, STOP, HTML/scripts/attachments, injection,
capability redaction, A/B positive controls and forged tenant prefixes. A separate
case uses the real Resend adapter and a correctly signed webhook over HTTP, with
only its receiving API transport fake; a tampered signature performs no API fetch.
The original web-form/reply/voice assertions remain required.
