export type LmcProcessingFailureCode = "MODEL_UNAVAILABLE";

export function classifyLmcProcessingError(error: unknown): LmcProcessingFailureCode | undefined {
  return error instanceof Error && error.message === "LMC_MODEL_UNAVAILABLE"
    ? "MODEL_UNAVAILABLE"
    : undefined;
}
