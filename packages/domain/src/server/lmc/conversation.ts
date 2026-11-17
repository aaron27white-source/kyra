import type { LmcBusinessSettings, LmcQualification } from "@lobbystack/contracts";

/** Builds a tenant-neutral clarification from configured services only. */
export function buildEmailQualificationPrompt(
  settings: Pick<LmcBusinessSettings, "services">,
  qualification: LmcQualification,
  serviceRecognized: boolean,
): string {
  const questions: string[] = [];
  if (!serviceRecognized) questions.push(`Which service do you need: ${settings.services.map((item) => item.name).join(" or ")}?`);
  if (!qualification.zip) questions.push("What is your ZIP code?");
  if (!qualification.propertyType) questions.push("Is the property residential or commercial?");
  return questions[0] || "Could you clarify what you would like help with?";
}
