/**
 * Env vars required for a production deployment.
 *
 * Kept in one place so CI scripts (`scripts/`) and runtime checks
 * (`/api/health`, `checkProductionConfig`) stay in sync. Nothing here reads
 * secret values; callers decide whether to report presence or fail.
 */

/** Whether a missing variable breaks the deployment or only degrades it. */
export type Requirement = "required" | "recommended";

export interface ConfigRequirement {
  name: string;
  requirement: Requirement;
  /** True when inlined into the browser bundle at build time (must be set in the build env). */
  buildTime: boolean;
  /** Operator-facing summary of what breaks when missing. */
  impact: string;
}

export const CONFIG_REQUIREMENTS: readonly ConfigRequirement[] = [
  {
    name: "NEXT_PUBLIC_SUPABASE_URL",
    requirement: "required",
    buildTime: true,
    impact: "No Supabase project to talk to; every query fails.",
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    requirement: "required",
    buildTime: true,
    impact: "Supabase rejects every request as unauthenticated.",
  },
  {
    name: "SUPABASE_JWT_SECRET",
    requirement: "required",
    buildTime: false,
    impact:
      "/api/auth/challenge and /api/auth/verify both return 503 — nobody can sign in at all.",
  },
  {
    name: "AUTH_CHALLENGE_SECRET",
    requirement: "required",
    buildTime: false,
    impact:
      "Sign-in returns 503 in production, where reusing SUPABASE_JWT_SECRET is refused.",
  },
  {
    name: "NEXT_PUBLIC_CONTRACT_ID",
    requirement: "required",
    buildTime: true,
    impact: "No settlement contract to call; on-chain settlement is unavailable.",
  },
  {
    name: "NEXT_PUBLIC_SITE_URL",
    requirement: "required",
    buildTime: true,
    impact:
      "OpenGraph, Twitter and PWA URLs fall back to a hardcoded domain that may not be this deployment.",
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    requirement: "recommended",
    buildTime: false,
    impact:
      "Replay guard and rate limiter fall back to per-process memory, which does not hold across instances; sign-out cannot revoke.",
  },
];

// Pairs that must not share the same value (checked only when both are set).
const MUST_DIFFER = [
  {
    a: "AUTH_CHALLENGE_SECRET",
    b: "SUPABASE_JWT_SECRET",
    reason:
      "one key serving two cryptographic purposes means a leak in either path compromises both",
  },
];

export interface ConfigProblem {
  name: string;
  requirement: Requirement;
  message: string;
}

export interface ConfigReport {
  ok: boolean; // false if any required var is missing or a rule fails
  problems: ConfigProblem[];
  warnings: ConfigProblem[]; // missing recommended vars
}

function isBlank(value: string | undefined) {
  return value === undefined || value.trim() === "";
}

/**
 * Checks `env` against `CONFIG_REQUIREMENTS`.
 * Accepts `env` as a parameter so CI scripts and `/api/health` share one code path.
 */
export function checkConfig(env: NodeJS.ProcessEnv = process.env): ConfigReport {
  const problems: ConfigProblem[] = [];
  const warnings: ConfigProblem[] = [];

  for (const entry of CONFIG_REQUIREMENTS) {
    if (!isBlank(env[entry.name])) continue;

    const problem: ConfigProblem = {
      name: entry.name,
      requirement: entry.requirement,
      message: `${entry.name} is not set. ${entry.impact}`,
    };

    if (entry.requirement === "required") problems.push(problem);
    else warnings.push(problem);
  }

  for (const pair of MUST_DIFFER) {
    const left = env[pair.a];
    const right = env[pair.b];
    if (isBlank(left) || isBlank(right)) continue;
    if (left !== right) continue;

    problems.push({
      name: pair.a,
      requirement: "required",
      message: `${pair.a} must not be the same value as ${pair.b} — ${pair.reason}.`,
    });
  }

  return { ok: problems.length === 0, problems, warnings };
}
