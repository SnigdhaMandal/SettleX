/**
 * GET /api/health
 * Checks runtime env configuration (var names only, never secret values).
 * Returns 200 when usable, 503 when required vars are missing.
 */
import { NextResponse } from "next/server";
import { checkConfig } from "@/lib/config/requirements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const report = checkConfig();

  const isOnlyServiceRoleMissing =
    !report.ok &&
    report.problems.length === 1 &&
    report.problems[0].name === "SUPABASE_SERVICE_ROLE_KEY";

  const status = report.ok ? "ok" : isOnlyServiceRoleMissing ? "degraded" : "misconfigured";
  const statusCode = report.ok || isOnlyServiceRoleMissing ? 200 : 503;

  return NextResponse.json(
    {
      status,
      // only expose var names, never values
      missingRequired: report.problems.map((problem) => problem.name),
      missingRecommended: report.warnings.map((problem) => problem.name),
      inactiveControls: isOnlyServiceRoleMissing
        ? [
            "cross-instance nonce replay protection",
            "cross-instance rate limiting",
            "token revocation",
          ]
        : undefined,
      checkedAt: new Date().toISOString(),
    },
    {
      status: statusCode,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
