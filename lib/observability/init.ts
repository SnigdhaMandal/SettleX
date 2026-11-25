/**
 * Installs the default error reporter.
 *
 * No error-tracking SDK is bundled by default — structured JSON logs already
 * give log drains a stable `event` field to alert on. To forward errors to
 * Sentry or another provider, swap `defaultReporter` or call `setErrorReporter`
 * (see `docs/OBSERVABILITY.md`).
 */
import { setErrorReporter, type ErrorReport } from "@/lib/observability/logger";

let warnedNoProvider = false;
let installed = false;

// Report once per process that no external error tracker is wired up, instead
// of re-logging every error (reportError already wrote the structured line).
function defaultReporter(report: ErrorReport): void {
  if (warnedNoProvider) return;
  warnedNoProvider = true;

  // Use console.warn directly rather than logWarn so we don't re-enter the logger mid-report.
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "observability.no_error_provider",
      message:
        "Errors are being logged as structured JSON but not sent to an error " +
        "tracker. Wire one up in lib/observability/init.ts — see docs/OBSERVABILITY.md.",
      firstEvent: report.event,
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * Registers the error reporter once per process (guards against Next
 * evaluating the module multiple times across bundles or hot reloads).
 */
export function initObservability(): void {
  if (installed) return;
  installed = true;
  setErrorReporter(defaultReporter);
}

/** Resets install state for tests. */
export function resetObservabilityForTests(): void {
  installed = false;
  warnedNoProvider = false;
  setErrorReporter(null);
}
