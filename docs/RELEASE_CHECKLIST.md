# SettleX Release Checklist

Date: 2026-11-24

## Pre-release Quality Gate (Run & Verify in CI)

- [ ] Clean dependency installation succeeds: `npm ci`
- [ ] Frontend lint passes: `npm run lint`
- [ ] Frontend test suites pass: `npm test -- --runInBand`
- [ ] Production build succeeds: `npm run build`
- [ ] Contract tests pass: `cd contract && cargo test`

## Contract and Deployment

- [x] Settlement contract deployed to testnet
- [ ] Confirm no pool contract is referenced in configuration or docs (removed in Issue #178)
- [x] `NEXT_PUBLIC_CONTRACT_ID` updated in `.env.local`
- [x] Explorer links documented in README

## CI/CD

- [x] CI workflow defined in `.github/workflows/ci.yml`
- [x] Production check workflow defined in `.github/workflows/production-check.yml`
- [x] CI badge added to README

## Documentation

- [x] README includes live demo link
- [x] README includes contract IDs and transaction proofs
- [x] README includes deployment screenshot (`public/deployment.png`)
- [x] README includes submission checklist evidence section
- [x] Final docs package added under `docs/`

## Auth Shared State (required before any multi-instance deploy)

- [ ] `supabase-setup.sql` re-applied so `auth_nonces` and `auth_rate_limits`
      exist (section 5.7)
- [ ] `SUPABASE_SERVICE_ROLE_KEY` set as a server-only env var (never
      `NEXT_PUBLIC_`) in every deployment environment
- [ ] Verified a signed challenge cannot be replayed: post the same
      `/api/auth/verify` body twice and confirm the second attempt is rejected
- [ ] Confirmed `CHALLENGE_TTL_SECONDS` is 60 — it is the replay window whenever
      the shared store is unavailable

## Submission Gate

- [x] Public GitHub repository ready
- [x] Commit history exceeds minimum requirement (44 commits)
- [ ] Add one explicit mobile viewport screenshot (phone-sized capture) and reference it in README before final submission

Notes:
- All automated verification gates must be confirmed passing via GitHub Actions CI (`.github/workflows/ci.yml`) prior to cutting a release, rather than relying on static checked boxes.
- One manual evidence item remains: a dedicated phone viewport screenshot.
