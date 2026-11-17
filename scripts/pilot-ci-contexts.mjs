const legacySources = [
  "isolation-public-api", "isolation-worker-attach", "isolation-worker-attach-runner", "isolation-worker-health",
].map(name => `tests/lmc/${name}.acceptance.ts`);
const exhaustiveSource = "tests/lmc/isolation.acceptance.ts";
const authSource = "tests/lmc/isolation-pilot-auth.acceptance.ts";

/** Only the four explicitly approved development controls use the legacy surface. */
export function pilotAcceptanceContexts(files) {
  if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== "string" || !/^tests\/lmc\/.+\.acceptance\.ts$/.test(file) || file.split("/").some(part => part === "." || part === ".."))) throw new Error("PILOT_CI_CONTEXT_INVALID_INVENTORY");
  if (new Set(files).size !== files.length) throw new Error("PILOT_CI_CONTEXT_DUPLICATE_SOURCE");
  const required = [...legacySources, exhaustiveSource, authSource];
  if (required.some(file => !files.includes(file))) throw new Error("PILOT_CI_CONTEXT_REQUIRED_SOURCE");
  const contexts = [
    { name: "exhaustive", pilot: true, files: [exhaustiveSource] },
    { name: "auth", pilot: true, files: [authSource] },
    { name: "pilot", pilot: true, files: files.filter(file => !required.includes(file)).toSorted() },
    { name: "legacy", pilot: false, files: legacySources.toSorted() },
  ];
  if (contexts.some(context => !context.files.length)) throw new Error("PILOT_CI_CONTEXT_EMPTY");
  const actual = contexts.flatMap(context => context.files).toSorted();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(files.toSorted())) throw new Error("PILOT_CI_CONTEXT_SOURCE_EQUALITY");
  return contexts;
}
