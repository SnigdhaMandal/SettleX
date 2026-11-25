/**
 * Per-request logging helper for API routes.
 *
 * Binds a correlation id to every log line for a request and returns it in the
 * `x-request-id` header so user-reported failures can be traced in server logs.
 */
import { NextResponse } from "next/server";
import {
  CORRELATION_HEADER,
  correlationIdFrom,
  logInfo,
  logWarn,
  reportError,
  type Fields,
} from "@/lib/observability/logger";

export interface RequestLogger {
  correlationId: string;
  /** Merges the correlation header into a response's headers. */
  headers(extra?: Record<string, string>): Record<string, string>;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, error?: unknown, fields?: Fields): void;
  /** Logs the final outcome once per response so every request is countable. */
  finish(event: string, status: number, fields?: Fields): void;
}

/** Builds a logger bound to a single request and route name. */
export function requestLogger(route: string, request: Request): RequestLogger {
  const correlationId = correlationIdFrom(request.headers);
  const startedAt = Date.now();
  const base = { route };

  return {
    correlationId,

    headers(extra = {}) {
      return { ...extra, [CORRELATION_HEADER]: correlationId };
    },

    info(event, fields) {
      logInfo(event, { correlationId, fields: { ...base, ...fields } });
    },

    warn(event, fields) {
      logWarn(event, { correlationId, fields: { ...base, ...fields } });
    },

    error(event, error, fields) {
      reportError(event, error, { correlationId, fields: { ...base, ...fields } });
    },

    finish(event, status, fields) {
      const durationMs = Date.now() - startedAt;
      const record = { ...base, status, durationMs, ...fields };
      // 5xx is on us (warn), 4xx/2xx stays info so both remain countable
      if (status >= 500) logWarn(event, { correlationId, fields: record });
      else logInfo(event, { correlationId, fields: record });
    },
  };
}

/** Returns a JSON NextResponse with the correlation id header attached. */
export function jsonWithCorrelation(
  logger: RequestLogger,
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): NextResponse {
  return NextResponse.json(body as Record<string, unknown>, {
    status: init.status ?? 200,
    headers: logger.headers(init.headers),
  });
}
