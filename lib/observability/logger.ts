/**
 * Structured JSON logging and error reporting.
 *
 * Uses `console.error`/`warn`/`info` as the transport (`next.config.mjs` strips
 * `console.log` in prod, so debug/info both go through `console.info`), redacts
 * payloads before emit, and routes errors through a swappable reporter hook.
 */
import { redact, redactText } from "@/lib/observability/redact";

export type Level = "debug" | "info" | "warn" | "error";

/** Structured fields attached to a log line. Redacted before emit. */
export type Fields = Record<string, unknown>;

export interface LogRecord {
  level: Level;
  /** Stable `area.thing_that_happened` key for alerts (no dynamic values). */
  event: string;
  /** Ties log lines from one request together. */
  correlationId?: string;
  message?: string;
  fields?: Fields;
  timestamp: string;
}

export interface ErrorReport {
  event: string;
  correlationId?: string;
  error?: unknown;
  fields?: Fields;
}

export type ErrorReporter = (report: ErrorReport) => void;

let reporter: ErrorReporter | null = null;

/**
 * Installs an error reporter (call once at startup from `instrumentation.ts` or
 * a client provider). Failures inside the reporter are caught by `reportError`.
 */
export function setErrorReporter(next: ErrorReporter | null): void {
  reporter = next;
}

export function getErrorReporter(): ErrorReporter | null {
  return reporter;
}

/** Header used to pass the correlation id between client, server, and log drains. */
export const CORRELATION_HEADER = "x-request-id";

/** Short collision-resistant correlation id. */
export function newCorrelationId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    }
  } catch {
    // fall back to Date/Math.random on older runtimes
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Grabs the inbound correlation id from request headers if it looks valid,
 * otherwise generates a fresh one. Strips non-alphanumeric chars to prevent
 * log injection or oversized headers.
 */
export function correlationIdFrom(headers: Headers | null | undefined): string {
  const raw = headers?.get(CORRELATION_HEADER);
  if (raw) {
    const cleaned = raw.trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    if (cleaned.length >= 8) return cleaned;
  }
  return newCorrelationId();
}

// Test hook so tests can capture records without spying on console.
let sink: ((record: LogRecord) => void) | null = null;

export function setLogSink(next: ((record: LogRecord) => void) | null): void {
  sink = next;
}

function consoleFor(level: Level): (message?: unknown, ...rest: unknown[]) => void {
  switch (level) {
    case "error":
      return console.error;
    case "warn":
      return console.warn;
    // next.config.mjs strips console.log in prod builds, so use console.info for debug/info
    default:
      return console.info;
  }
}

function emit(record: LogRecord): void {
  if (sink) {
    sink(record);
    return;
  }

  // Fallback in case a BigInt or circular ref slips past redaction
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({
      level: record.level,
      event: record.event,
      correlationId: record.correlationId,
      message: "[log serialisation failed]",
      timestamp: record.timestamp,
    });
  }

  consoleFor(record.level)(line);
}

export interface LogOptions {
  correlationId?: string;
  message?: string;
  fields?: Fields;
}

export function log(level: Level, event: string, options: LogOptions = {}): LogRecord {
  const record: LogRecord = {
    level,
    event,
    correlationId: options.correlationId,
    message: options.message ? redactText(options.message) : undefined,
    fields: options.fields ? (redact(options.fields) as Fields) : undefined,
    timestamp: new Date().toISOString(),
  };

  emit(record);
  return record;
}

export const logDebug = (event: string, options?: LogOptions) => log("debug", event, options);
export const logInfo = (event: string, options?: LogOptions) => log("info", event, options);
export const logWarn = (event: string, options?: LogOptions) => log("warn", event, options);

/**
 * Logs an error and forwards it to the installed reporter (if any).
 * Wraps the reporter call so a broken provider won't mask the original error.
 */
export function reportError(
  event: string,
  error?: unknown,
  options: LogOptions = {},
): LogRecord {
  const record = log("error", event, {
    ...options,
    fields: { ...options.fields, error: error === undefined ? undefined : redact(error) },
  });

  if (reporter) {
    try {
      reporter({
        event,
        correlationId: options.correlationId,
        error,
        fields: record.fields, // already redacted
      });
    } catch (reporterError) {
      // Log via `log` instead of `reportError` to avoid infinite recursion
      log("warn", "observability.reporter_failed", {
        correlationId: options.correlationId,
        fields: { error: redact(reporterError) },
      });
    }
  }

  return record;
}

/**
 * Emits a countable metric log line (`event: "metric.count"`).
 * Using log lines instead of in-memory counters keeps counts across serverless scale-downs.
 */
export function countMetric(name: string, fields: Fields = {}, value = 1): void {
  log("info", "metric.count", { fields: { metric: name, value, ...fields } });
}
