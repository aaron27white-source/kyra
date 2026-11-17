import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";

/** Privacy-safe, locally annotated call facts. Do not put transcripts, phone numbers, addresses, or names here. */
export const voiceEvalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
  greetingCount: z.number().int().nonnegative(),
  repeatedOpeningQuestionCount: z.number().int().nonnegative(),
  questionCount: z.number().int().nonnegative(),
  unnecessaryQuestionCount: z.number().int().nonnegative(),
  serviceLookupCount: z.number().int().nonnegative(),
  availabilityLookupCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
  delegationLatencyMs: z.array(z.number().finite().nonnegative()),
  firstUsefulResponseMs: z.number().finite().nonnegative().nullable(),
  bookingAttempted: z.boolean(),
  bookingSucceeded: z.boolean(),
  bookingDurationMs: z.number().finite().nonnegative().nullable(),
  intakeRequired: z.boolean(),
  intakeComplete: z.boolean().nullable(),
  addressRequired: z.boolean(),
  addressCaptured: z.boolean().nullable(),
  addressCorrect: z.boolean().nullable(),
  serviceAreaExpectedEligible: z.boolean().nullable(),
  serviceAreaAccepted: z.boolean().nullable(),
  confirmationWithoutCommit: z.boolean(),
  callerClearlyEnded: z.boolean(),
  hangupRequested: z.boolean(),
  callDurationMs: z.number().finite().nonnegative(),
  billedSeconds: z.number().finite().nonnegative(),
  estimatedCostUsd: z.number().finite().nonnegative().nullable(),
}).strict().superRefine((call, ctx) => {
  if (!call.bookingAttempted && call.bookingSucceeded) ctx.addIssue({ code: "custom", message: "A successful booking must have an attempt.", path: ["bookingSucceeded"] });
  if (call.bookingSucceeded && call.bookingDurationMs === null) ctx.addIssue({ code: "custom", message: "A successful booking needs bookingDurationMs.", path: ["bookingDurationMs"] });
  if (call.intakeRequired && call.intakeComplete === null) ctx.addIssue({ code: "custom", message: "Required intake must be scored.", path: ["intakeComplete"] });
  if (call.addressRequired && (call.addressCaptured === null || call.addressCorrect === null)) ctx.addIssue({ code: "custom", message: "Required address capture and accuracy must be scored.", path: ["addressCaptured"] });
  if ((call.serviceAreaExpectedEligible === null) !== (call.serviceAreaAccepted === null)) ctx.addIssue({ code: "custom", message: "Service-area expectation and result must both be present or absent.", path: ["serviceAreaAccepted"] });
  if (call.unnecessaryQuestionCount > call.questionCount) ctx.addIssue({ code: "custom", message: "Unnecessary questions cannot exceed all questions.", path: ["unnecessaryQuestionCount"] });
});

export const voiceEvalDatasetSchema = z.array(voiceEvalCaseSchema).min(1).superRefine((calls, ctx) => {
  const ids = new Set<string>();
  calls.forEach((call, index) => {
    if (ids.has(call.id)) ctx.addIssue({ code: "custom", message: "Call IDs must be unique within a dataset.", path: [index, "id"] });
    ids.add(call.id);
  });
});

export type VoiceEvalCase = z.infer<typeof voiceEvalCaseSchema>;

function average(values: number[]): number | null {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function percentile95(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.ceil(sorted.length * 0.95) - 1]!);
}

function rate(numerator: number, denominator: number): number | null {
  return denominator ? round(numerator / denominator, 4) : null;
}

function round(value: number, places = 2): number {
  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
}

export function summarizeVoiceEval(calls: VoiceEvalCase[]) {
  const bookings = calls.filter((call) => call.bookingAttempted);
  const completed = bookings.filter((call) => call.bookingSucceeded);
  const intakeScored = calls.filter((call) => call.intakeRequired);
  const addressScored = calls.filter((call) => call.addressRequired);
  const areaScored = calls.filter((call) => call.serviceAreaExpectedEligible !== null);
  const questions = calls.reduce((sum, call) => sum + call.questionCount, 0);
  const delegations = calls.flatMap((call) => call.delegationLatencyMs);
  const usefulResponseTimes = calls.flatMap((call) => call.firstUsefulResponseMs === null ? [] : [call.firstUsefulResponseMs]);
  const bookingTimes = completed.flatMap((call) => call.bookingDurationMs === null ? [] : [call.bookingDurationMs]);
  const durations = calls.map((call) => call.callDurationMs);
  const costs = calls.flatMap((call) => call.estimatedCostUsd === null ? [] : [call.estimatedCostUsd]);
  const addressCaptured = addressScored.filter((call) => call.addressCaptured).length;
  const areaCorrect = areaScored.filter((call) => call.serviceAreaExpectedEligible === call.serviceAreaAccepted).length;
  return {
    callCount: calls.length,
    greetingRepetitionRate: rate(calls.filter((call) => call.greetingCount > 1).length, calls.length),
    repeatedOpeningQuestionRate: rate(calls.filter((call) => call.repeatedOpeningQuestionCount > 0).length, calls.length),
    unnecessaryQuestionRate: rate(calls.reduce((sum, call) => sum + call.unnecessaryQuestionCount, 0), questions),
    serviceLookupsPerCompletedBooking: completed.length ? round(completed.reduce((sum, call) => sum + call.serviceLookupCount, 0) / completed.length) : null,
    availabilityLookupsPerCompletedBooking: completed.length ? round(completed.reduce((sum, call) => sum + call.availabilityLookupCount, 0) / completed.length) : null,
    toolCallsPerCompletedBooking: completed.length ? round(completed.reduce((sum, call) => sum + call.toolCallCount, 0) / completed.length) : null,
    delegationLatencyMs: { mean: average(delegations), p95: percentile95(delegations), sampleCount: delegations.length },
    timeToFirstUsefulResponseMs: { mean: average(usefulResponseTimes), p95: percentile95(usefulResponseTimes), sampleCount: usefulResponseTimes.length },
    bookingDurationMs: { mean: average(bookingTimes), p95: percentile95(bookingTimes), sampleCount: bookingTimes.length },
    bookingSuccessRate: rate(completed.length, bookings.length),
    requiredIntakeCompletionRate: rate(intakeScored.filter((call) => call.intakeComplete).length, intakeScored.length),
    addressCaptureRate: rate(addressCaptured, addressScored.length),
    addressAccuracyRate: rate(addressScored.filter((call) => call.addressCorrect).length, addressScored.length),
    serviceAreaValidationAccuracy: rate(areaCorrect, areaScored.length),
    automaticHangupRate: rate(calls.filter((call) => call.callerClearlyEnded && call.hangupRequested).length, calls.filter((call) => call.callerClearlyEnded).length),
    falseBookingConfirmationCount: calls.filter((call) => call.confirmationWithoutCommit).length,
    callDurationMs: { mean: average(durations), p95: percentile95(durations) },
    billedSeconds: calls.reduce((sum, call) => sum + call.billedSeconds, 0),
    estimatedCostUsd: costs.length ? round(costs.reduce((sum, value) => sum + value, 0)) : null,
    estimatedCostSampleCount: costs.length,
  };
}

export function compareVoiceEval(baseline: VoiceEvalCase[] | null, candidate: VoiceEvalCase[]) {
  return {
    version: "kyra-voice-v2-eval-1",
    baseline: baseline ? summarizeVoiceEval(baseline) : null,
    candidate: summarizeVoiceEval(candidate),
    comparison: baseline ? "measured" : "baseline_not_supplied",
    note: "Human conversation labels and address-accuracy grades are provided by the local evaluator; this report does not infer them from audio or claim geographic verification.",
  };
}

async function readDataset(path: string): Promise<VoiceEvalCase[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("VOICE_EVAL_INVALID_JSON");
  }
  const result = voiceEvalDatasetSchema.safeParse(parsed);
  if (!result.success) throw new Error("VOICE_EVAL_INVALID_DATASET");
  return result.data;
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const result = args[index + 1];
    if (!result || result.startsWith("--")) throw new Error(`VOICE_EVAL_MISSING_${flag.slice(2).toUpperCase()}`);
    return result;
  };
  const candidatePath = value("--candidate");
  if (!candidatePath) throw new Error("VOICE_EVAL_CANDIDATE_REQUIRED");
  const baselinePath = value("--baseline");
  const outputPath = value("--output");
  const report = compareVoiceEval(baselinePath ? await readDataset(baselinePath) : null, await readDataset(candidatePath));
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, rendered, { flag: "wx" });
  process.stdout.write(rendered);
}

if (process.argv[1] && basename(process.argv[1]) === "voice-v2-evaluation.ts") {
  runCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "VOICE_EVAL_FAILED"}\n`);
    process.exitCode = 1;
  });
}
