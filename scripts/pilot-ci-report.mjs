import { relative, resolve } from "node:path";

const failureSuiteLimit = 20;
const failureAssertionLimit = 100;

/** Return only bounded, non-content identifiers for a failed Vitest report. */
export function summarizeVitestFailures(report, { root }) {
  if (!report || !root || !Array.isArray(report.testResults)) return [];
  const normalize = file => {
    if (typeof file !== "string") return "<invalid-test-path>";
    const path = relative(resolve(root), resolve(root, file)).replaceAll("\\", "/");
    return !path || path.startsWith("../") ? "<outside-test-root>" : path;
  };
  let remaining = failureAssertionLimit;
  const result = [];
  const boundedCode = value => {
    if (typeof value !== "string") return undefined;
    const explicit = value.match(/\b(?:FORM|LMC|EMAIL|MODEL|CAPTURE|PILOT)_[A-Z0-9_]+\b/)?.[0];
    if (explicit) return explicit;
    if (/hook timed out|beforeEach timed out|afterEach timed out/i.test(value)) return "LMC_ACCEPTANCE_HOOK_TIMEOUT";
    if (/test timed out|timeout of \d+ms exceeded/i.test(value)) return "LMC_ACCEPTANCE_TEST_TIMEOUT";
    if (/Capture failed:\s*5\d\d/i.test(value)) return "LMC_CAPTURE_HTTP_5XX";
    return undefined;
  };
  for (const file of report.testResults) {
    if (result.length >= failureSuiteLimit || remaining === 0) break;
    const tests = Array.isArray(file?.assertionResults)
      ? file.assertionResults
          .map((test, assertionIndex) => ({ test, assertionIndex }))
          .filter(({ test }) => test?.status !== "passed")
          .slice(0, remaining)
          .map(({ test, assertionIndex }) => ({
            assertionIndex,
            title: typeof test?.fullName === "string" ? test.fullName.slice(0, 300) : "<unnamed-test>",
            status: typeof test?.status === "string" ? test.status : "unknown",
            ...(() => {
              const message = Array.isArray(test?.failureMessages) ? test.failureMessages.find(value => typeof value === "string") : undefined;
              const failureCode = boundedCode(message) ?? boundedCode(file?.message) ?? boundedCode(file?.failureMessage);
              return failureCode ? { failureCode } : {};
            })(),
            ...(Number.isSafeInteger(test?.location?.line) && Number.isSafeInteger(test?.location?.column)
              ? { location: { line: test.location.line, column: test.location.column } }
              : {}),
          }))
      : [];
    if (tests.length > 0) {
      result.push({ path: normalize(file?.name), tests });
      remaining -= tests.length;
    }
  }
  return result;
}

/** Fail closed on skipped integration, omitted files and inconsistent producer metadata. */
export function verifyVitestReport(report, { root, expectedFiles, allowEmpty = false }) {
  const fail = code => { throw new Error(code); };
  if (!report || !root || !Array.isArray(expectedFiles) || !Array.isArray(report.testResults)) fail("PILOT_CI_INVALID_REPORT");
  for (const field of ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests", "numFailedTestSuites", "numPendingTestSuites"]) {
    if (!Number.isSafeInteger(report[field]) || report[field] < 0) fail("PILOT_CI_INVALID_COUNTERS");
  }
  if (report.success !== true || report.numFailedTests || report.numPendingTests || report.numTodoTests || report.numFailedTestSuites || report.numPendingTestSuites) fail("PILOT_CI_SKIPPED_OR_FAILED_TESTS");
  if (report.numPassedTests !== report.numTotalTests) fail("PILOT_CI_INCONSISTENT_COUNTERS");
  const normalize = file => {
    if (typeof file !== "string") fail("PILOT_CI_INVALID_TEST_PATH");
    const path = relative(resolve(root), resolve(root, file)).replaceAll("\\", "/");
    if (!path || path.startsWith("../")) fail("PILOT_CI_INVALID_TEST_PATH");
    return path;
  };
  const expected = expectedFiles.map(normalize).sort();
  const actual = report.testResults.map(file => normalize(file.name)).sort();
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) fail("PILOT_CI_TEST_FILE_COVERAGE");
  if (!report.numTotalTests && !(allowEmpty && expected.length === 0)) fail("PILOT_CI_EMPTY_REPORT");
  let assertions = 0;
  const files = report.testResults.map(file => {
    if (file.status !== "passed" || !Array.isArray(file.assertionResults) || file.assertionResults.some(test => test.status !== "passed")) fail("PILOT_CI_SKIPPED_OR_FAILED_ASSERTIONS");
    assertions += file.assertionResults.length;
    return { path: normalize(file.name), tests: file.assertionResults.length, passed: file.assertionResults.length };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (assertions !== report.numTotalTests) fail("PILOT_CI_INCONSISTENT_COUNTERS");
  return { tests: assertions, passed: assertions, skipped: 0, failed: 0, files };
}
