import { randomUUID } from "node:crypto";
import type { LmcProviderEvent } from "@lobbystack/contracts";
import { redactLmcCapabilities } from "../../packages/domain/src/server/lmc/redaction";
import { createLmcHarness } from "../../tests/lmc/support/harness";
import { openLmcTestDatabase } from "../../tests/lmc/support/database";

export class LmcDemoError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function requireProof(value: unknown, code: string): asserts value {
  if (!value) throw new LmcDemoError(code);
}
export type LmcDemoStep =
  | "initial_email"
  | "first_reply"
  | "qualification"
  | "booking"
  | "owner_summary"
  | "consenting_lead"
  | "followup"
  | "opt_out";
export type LmcDemoReport = {
  schemaVersion: 1;
  mode: "fake";
  persistence: "postgresql";
  demoTime: string;
  firstReplyMs: number;
  steps: Array<{ name: LmcDemoStep; detail: string }>;
  booking: {
    count: number;
    startsAt: string;
    calendarSynced: boolean;
    verifiedRequester: boolean;
  };
  followups: {
    touches: number;
    optedOut: boolean;
    futureSends: number;
    bookedLeadTouches: number;
  };
  ownerSummary: string;
  transcript: Array<{
    lead: "booked" | "unanswered";
    direction: string;
    kind: string;
    subject: string;
    text: string;
  }>;
  cleanup: { businessRemoved: boolean; outboxRemoved: boolean };
};

export async function runLmcDemo(): Promise<LmcDemoReport> {
  if (process.env.NODE_ENV === "production")
    throw new LmcDemoError("DEMO_PRODUCTION_FORBIDDEN");
  if (
    process.env.LMC_PROVIDER_MODE !== undefined &&
    process.env.LMC_PROVIDER_MODE !== "fake"
  )
    throw new LmcDemoError("DEMO_FAKE_PROVIDERS_REQUIRED");
  const targets = [
    process.env.LMC_TEST_DATABASE_URL ??
      process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL,
    ...["APP", "SYSTEM", "WORKER", "DISPATCHER"].map(
      (role) => process.env[`LOBBYSTACK_${role}_DATABASE_URL`],
    ),
  ];
  for (const raw of targets) {
    if (!raw) continue; // The shared opener reports missing mandatory settings.
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      throw new LmcDemoError("DEMO_LOCAL_TEST_DATABASE_REQUIRED");
    }
    let name: string;
    try {
      name = decodeURIComponent(target.pathname.slice(1));
    } catch {
      throw new LmcDemoError("DEMO_LOCAL_TEST_DATABASE_REQUIRED");
    }
    // A substring such as "latest" is not a test-database marker. Also disallow
    // query keys that could override the parsed network/database destination.
    if (
      !["postgres:", "postgresql:"].includes(target.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      !/(?:^|[_-])test(?:$|[_-])/i.test(name) ||
      target.hash ||
      [...target.searchParams.keys()].some((key) => key !== "sslmode") ||
      target.searchParams.getAll("sslmode").length > 1 ||
      (target.searchParams.has("sslmode") &&
        ![
          "disable",
          "prefer",
          "require",
          "verify-ca",
          "verify-full",
          "allow",
          "no-verify",
        ].includes(target.searchParams.get("sslmode")!))
    )
      throw new LmcDemoError("DEMO_LOCAL_TEST_DATABASE_REQUIRED");
  }
  const db = openLmcTestDatabase();
  let fixture: Awaited<ReturnType<typeof createLmcHarness>> | undefined,
    fixtureClosed = false;
  let releaseLock: (() => Promise<void>) | undefined,
    locked = false;
  try {
    const lock = await db.admin.pool.connect();
    releaseLock = async () => {
      try {
        if (locked)
          await lock.query(
            "select pg_advisory_unlock(hashtextextended('lmc:offline-demo',0))",
          );
      } finally {
        lock.release();
      }
    };
    locked =
      (
        await lock.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(hashtextextended('lmc:offline-demo',0)) as locked",
        )
      ).rows[0]?.locked === true;
    requireProof(locked, "DEMO_ALREADY_RUNNING");
    for (const client of [db.app, db.system, db.worker, db.dispatcher]) {
      const role = (
        await client.pool.query<{
          actual: string;
          superuser: boolean;
          bypass: boolean;
        }>(
          "select current_user as actual,rolsuper as superuser,rolbypassrls as bypass from pg_roles where rolname=current_user",
        )
      ).rows[0];
      requireProof(
        role?.actual === client.role && !role.superuser && !role.bypass,
        "DEMO_RUNTIME_ROLE_REQUIRED",
      );
    }
    const now = "2030-01-09T03:40:00.000Z";
    const busy = (
      await db.admin.pool.query<{ busy: boolean }>(
        "select exists(select 1 from lmc_jobs where status in ('pending','running') and available_at<=$1) as busy",
        [new Date(now)],
      )
    ).rows[0]?.busy;
    requireProof(busy === false, "DEMO_DATABASE_HAS_PENDING_WORK");
    const h = (fixture = await createLmcHarness({ now }));
    const steps: LmcDemoReport["steps"] = [];
    const bookedEmail = "ana.demo@example.invalid",
      unansweredEmail = "unanswered.demo@example.invalid";
    const token = h.captureUrl.split("/").at(-1)!;
    const inbound: Extract<LmcProviderEvent, { kind: "message" }> = {
      kind: "message",
      id: randomUUID(),
      email: {
        from: `Ana Demo <${bookedEmail}>`,
        to: `lead+${token}@inbound.example.invalid`,
        subject: "Roof help",
        text: "Can you help with my roof?",
        headers: { "Message-ID": `<demo-${randomUUID()}@example.invalid>` },
        authentication: {
          spf: "pass",
          dkim: "pass",
          dmarc: "pass",
          aligned: true,
        },
        attachments: [],
      },
    };
    const started = performance.now();
    await h.deliver(inbound);
    steps.push({
      name: "initial_email",
      detail: "A signed inbound email arrived at 22:40 Florida time.",
    });
    await h.work();
    const first = h.mail.lastTo(bookedEmail),
      firstReplyMs = Math.round(performance.now() - started);
    requireProof(
      firstReplyMs < 5000 &&
        (first.text.match(/\?/g)?.length ?? 0) === 1 &&
        /roof repair/i.test(first.text) &&
        !/roof replacement/i.test(first.text),
      "DEMO_FIRST_REPLY_NOT_PROVEN",
    );
    requireProof(
      first.headers["In-Reply-To"] === inbound.email.headers["Message-ID"],
      "DEMO_THREAD_NOT_PROVEN",
    );
    const bookedId = first.leadId;
    requireProof(
      (await h.lead(bookedId)).verifiedAt === null,
      "DEMO_PREMATURE_VERIFICATION",
    );
    steps.push({
      name: "first_reply",
      detail: `A threaded reply asked one configured qualification question in ${firstReplyMs} ms.`,
    });
    await h.reply(bookedId, "Roof repair, ZIP 33101, residential homeowner.");
    await h.work();
    const qualified = await h.lead(bookedId),
      slot = qualified.offeredSlots[0];
    requireProof(
      qualified.verifiedAt &&
        qualified.qualification.zip === "33101" &&
        qualified.qualification.serviceType === "roof repair" &&
        slot &&
        h.allowedSlots.includes(slot),
      "DEMO_QUALIFICATION_NOT_PROVEN",
    );
    steps.push({
      name: "qualification",
      detail:
        "The verified requester supplied roofing, ZIP 33101 and residential property; real scheduling offered a slot.",
    });
    await h.reply(bookedId, `Book ${slot}, please.`);
    await h.work();
    const bookings = await h.bookings(),
      calendarSynced = h.calendar.events.some(
        (event) => event.startsAt === slot,
      );
    requireProof(
      bookings.length === 1 &&
        bookings[0]?.startsAt === slot &&
        bookings[0]?.contactEmail === bookedEmail &&
        calendarSynced &&
        (await h.lead(bookedId)).status === "booked",
      "DEMO_BOOKING_NOT_PROVEN",
    );
    steps.push({
      name: "booking",
      detail: `One visit was booked for ${slot} and synchronized to the fake calendar transport.`,
    });
    const summary = h.mail.lastTo(h.ownerEmail).text;
    requireProof(
      summary.includes(bookedEmail) &&
        summary.includes("33101") &&
        summary.includes("Can you help with my roof?") &&
        summary.includes(`Book ${slot}`),
      "DEMO_OWNER_SUMMARY_NOT_PROVEN",
    );
    steps.push({
      name: "owner_summary",
      detail:
        "The owner received qualification, appointment details and full conversation history.",
    });
    const unanswered = await h.capture({
      name: "Alex Demo",
      email: unansweredEmail,
      message: "Can you help with my roof?",
      consentToFollowUp: true,
    });
    await h.work();
    steps.push({
      name: "consenting_lead",
      detail:
        "A separate unanswered form lead explicitly opted into follow-ups; the booked lead receives none.",
    });
    h.advanceDays(1);
    await h.work();
    const touches = h.mail
      .to(unansweredEmail)
      .filter((message) => message.kind === "followup");
    requireProof(
      touches.length === 1 &&
        touches.every(
          (message) =>
            message.headers["List-Unsubscribe"] && /STOP/.test(message.text),
        ),
      "DEMO_FOLLOWUP_NOT_PROVEN",
    );
    steps.push({
      name: "followup",
      detail:
        "After advancing the fake clock by one day, one consented follow-up included STOP and unsubscribe.",
    });
    await h.reply(unanswered.id, "STOP");
    const stopped = await h.lead(unanswered.id),
      sentAtOptOut = h.mail.to(unansweredEmail).length;
    requireProof(
      stopped.status === "opted_out" && stopped.aiPaused,
      "DEMO_OPT_OUT_NOT_PROVEN",
    );
    h.advanceDays(7);
    await h.work();
    const futureSends = h.mail.to(unansweredEmail).length - sentAtOptOut,
      bookedLeadTouches = h.mail
        .to(bookedEmail)
        .filter((message) => message.kind === "followup").length;
    requireProof(
      futureSends === 0 && bookedLeadTouches === 0,
      "DEMO_FOLLOWUP_STOP_NOT_PROVEN",
    );
    steps.push({
      name: "opt_out",
      detail:
        "STOP paused the unanswered lead; seven more simulated days produced no further sends and no booked-lead follow-ups.",
    });
    const transcript: LmcDemoReport["transcript"] = [];
    for (const [label, id] of [
      ["booked", bookedId],
      ["unanswered", unanswered.id],
    ] as const)
      for (const message of await h.history(id)) {
        if (message.kind === "owner_alert") continue;
        transcript.push({
          lead: label,
          direction: message.direction,
          kind: message.kind,
          subject: redactLmcCapabilities(message.subject),
          text: redactLmcCapabilities(message.body),
        });
      }
    const outboxIds = (
      await db.admin.pool.query<{ id: string }>(
        "select id from outbox_messages where business_id=$1",
        [h.tenantId],
      )
    ).rows.map((row) => row.id);
    requireProof(outboxIds.length > 0, "DEMO_OUTBOX_CONTROL_MISSING");
    await h.close();
    fixtureClosed = true;
    const businessRemoved =
      (
        await db.admin.pool.query("select id from businesses where id=$1", [
          h.tenantId,
        ])
      ).rowCount === 0;
    const outboxRemoved =
      (
        await db.admin.pool.query(
          "select id from outbox_messages where id=any($1::uuid[])",
          [outboxIds],
        )
      ).rowCount === 0;
    const ownerRemoved =
      (
        await db.admin.pool.query("select id from users where id=$1", [
          h.ownerId,
        ])
      ).rowCount === 0;
    requireProof(
      businessRemoved && outboxRemoved && ownerRemoved,
      "DEMO_CLEANUP_NOT_PROVEN",
    );
    return {
      schemaVersion: 1,
      mode: "fake",
      persistence: "postgresql",
      demoTime: now,
      firstReplyMs,
      steps,
      booking: {
        count: bookings.length,
        startsAt: slot,
        calendarSynced,
        verifiedRequester: true,
      },
      followups: {
        touches: touches.length,
        optedOut: true,
        futureSends,
        bookedLeadTouches,
      },
      ownerSummary: redactLmcCapabilities(summary),
      transcript,
      cleanup: { businessRemoved, outboxRemoved },
    };
  } finally {
    try {
      if (fixture && !fixtureClosed) await fixture.close();
    } finally {
      try {
        await releaseLock?.();
      } finally {
        await db.close();
      }
    }
  }
}
