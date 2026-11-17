# Super Admin operator workflow

This is the founder/operator runbook for concierge onboarding. It preserves the
customer as the business owner and never adds the platform administrator as a
tenant member or changes the administrator's active workspace.

## Lifecycle

| State | Entered when | Admin action | Customer experience |
| --- | --- | --- | --- |
| `draft` | A validated managed client is created | Complete business, service, hours and policy fields | No access before invitation |
| `needs_connection` | The verified owner accepts the invitation | Monitor the activation checklist | `/setup-required` offers owner-bound Google authorization and calendar selection |
| `ready_for_test` | Owner, writable calendar, fresh sync and approved Resend sender are ready | Review configuration and run the safe smoke test | Setup page confirms that the administrator is completing activation |
| `active` | The administrator explicitly activates after every prerequisite passes | Deliver `/leads` and capture installation details | CRM and email settings become available |
| `paused` | The administrator pauses a client | Resolve the issue and reactivate through the same readiness gate | History remains available; automated LMC processing is disabled |
| `error` | A tenant job or provider prerequisite fails | Inspect the sanitized failure, repair and retry | No provider secret or cross-tenant detail is exposed |

## First client sequence

1. Open `/internal/clients/new` with a verified platform-admin session and MFA.
2. Create the draft. This operation is idempotent and creates no founder
   membership in the tenant.
3. Review the client page and send the owner invitation. Invitation delivery is
   queued and repeated clicks do not create multiple valid invitations.
4. The owner signs in with the exact invited email, verifies it and accepts the
   invitation. They remain on `/setup-required`; they do not create another
   workspace or account.
5. On `/setup-required`, the owner authorizes Google Calendar. OAuth state is
   signed, session-bound, expires after ten minutes and is consumed once. The
   callback returns to the same setup page.
6. The owner selects a writable calendar. Selection clears old freshness and
   queues reconciliation. A successful worker sync is required; the UI never
   manufactures freshness.
7. The administrator refreshes the client's activation checklist. Activation
   remains disabled until all of the following are true:
   - the saved draft validates;
   - the exact invited owner is verified and active;
   - that owner authorized Google;
   - a writable calendar is selected;
   - synchronization completed in the last 24 hours;
   - the configured Resend HTTPS provider and approved sender match the draft.
8. The administrator activates. In one transaction Kyra writes canonical
   services/hours/settings, assigns the selected calendar to the default staff,
   enables LMC, advances the business state, queues a snapshot refresh and
   records a sanitized platform audit event.
9. A newly created capture token is shown once. Store it in the approved private
   operator system and install the capture endpoint; the database keeps only its
   hash. A repeated activation with the same idempotency key confirms the state
   without returning or storing the bearer token again.
10. Confirm that the owner can open `/leads` and `/settings/email`. Run the
    controlled activation smoke sequence before routing live traffic: capture,
    qualification, reply, verified booking, owner summary, consented follow-up
    and STOP.

## Pause and recovery

Pause disables LMC and changes the business lifecycle without deleting leads,
messages, appointments, configuration or provider history. Reactivation must
pass the current checklist again. A paused managed client can return to the
owner-bound setup page to repair or replace its calendar connection. Calendar
failures are exposed only as a sanitized status. Provider credentials, refresh
tokens and raw failure payloads never enter the Super Admin response or audit
event.

## Authorization boundaries

- `/internal` and its APIs require platform role, verified email and MFA on the
  server. Tenant membership and request headers cannot grant platform access.
- Customer setup APIs require the active `business_owner` membership and only
  operate on that user's active managed draft. A tenant ID from the request
  cannot select another workspace.
- Google OAuth is completed by the customer account that owns the connection,
  never by the founder impersonating the customer.
- Every new production route is explicitly allowlisted by exact path and method;
  unsupported methods and Server Actions remain closed.
- Activation and pause use the trusted System database identity only after
  platform authorization, retain FORCE RLS and emit sanitized audit records.

## Remaining operator surfaces

Subsequent reviewable phases add the same client-scoped navigation without
weakening this activation boundary:

- Knowledge and grounded answer simulation (PR4).
- Tenant-specific delivery/job operations, safe retry and commercial records
  (PR5).
- Accessibility, responsive browser certification and the complete no-skip
  pilot release gate before any production deployment.
