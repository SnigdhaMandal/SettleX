-- ============================================================================
-- SettleX - Supabase Database Setup
-- ============================================================================
-- ✅ SAFE TO RUN MULTIPLE TIMES - This script is fully idempotent
-- It will create new objects or update existing ones without errors
--
-- Instructions:
-- 1. Go to: Supabase Dashboard → SQL Editor → New Query
-- 2. Copy & paste this entire file
-- 3. Click "Run" or press Ctrl+Enter
-- ============================================================================

-- ============================================================================
-- 1. CREATE TABLES
-- ============================================================================

-- Create users table (for wallet-based authentication)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    wallet_address TEXT UNIQUE NOT NULL, -- Stellar wallet address (primary identifier)
    display_name TEXT NOT NULL, -- User's display name (required)
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    last_login_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Create expenses table
CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid (),
    title TEXT NOT NULL,
    description TEXT,
    total_amount TEXT NOT NULL,
    currency TEXT DEFAULT 'XLM' NOT NULL,
    split_mode TEXT NOT NULL CHECK (
        split_mode IN ('equal', 'custom')
    ),
    paid_by_member_id TEXT NOT NULL,
    members JSONB NOT NULL DEFAULT '[]',
    shares JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    settled BOOLEAN DEFAULT FALSE NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    -- New: Track creator and member wallets for authentication
    created_by_wallet TEXT NOT NULL,  -- Stellar address of expense creator
    member_wallets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]  -- Array of all member wallet addresses
);

-- Create trips table
CREATE TABLE IF NOT EXISTS trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  members JSONB NOT NULL DEFAULT '[]',
  expense_ids TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  settled BOOLEAN DEFAULT FALSE NOT NULL,
  -- New: Track creator and member wallets for authentication
  created_by_wallet TEXT NOT NULL,  -- Stellar address of trip creator
  member_wallets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]  -- Array of all member wallet addresses
);

-- ============================================================================
-- 1.5. ADD WALLET COLUMNS (if tables already exist from previous setup)
-- ============================================================================
-- These statements safely add the wallet columns if they're missing
-- This allows upgrading existing databases without dropping tables

-- Add wallet columns to expenses table if they don't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'expenses' AND column_name = 'created_by_wallet'
    ) THEN
        ALTER TABLE expenses ADD COLUMN created_by_wallet TEXT NOT NULL DEFAULT '';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'expenses' AND column_name = 'member_wallets'
    ) THEN
        ALTER TABLE expenses ADD COLUMN member_wallets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'expenses' AND column_name = 'version'
    ) THEN
        ALTER TABLE expenses ADD COLUMN version BIGINT NOT NULL DEFAULT 1;
    END IF;
END $$;

-- Add wallet columns to trips table if they don't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'trips' AND column_name = 'created_by_wallet'
    ) THEN
        ALTER TABLE trips ADD COLUMN created_by_wallet TEXT NOT NULL DEFAULT '';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'trips' AND column_name = 'member_wallets'
    ) THEN
        ALTER TABLE trips ADD COLUMN member_wallets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
    END IF;
END $$;

-- Update users table schema (make display_name required, remove email if exists)
DO $$ 
BEGIN
    -- Set default value for any existing NULL display_name values (only if rows exist)
    IF EXISTS (SELECT 1 FROM users LIMIT 1) THEN
        UPDATE users SET display_name = 'User' WHERE display_name IS NULL OR display_name = '';
    END IF;
    
    -- Make display_name NOT NULL if it's currently nullable
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'display_name' AND is_nullable = 'YES'
    ) THEN
        ALTER TABLE users ALTER COLUMN display_name SET NOT NULL;
    END IF;

    -- Drop email column only if it actually exists
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email'
    ) THEN
        ALTER TABLE users DROP COLUMN email;
    END IF;
END $$;

-- ============================================================================
-- 2. CREATE INDEXES (for better query performance)
-- ============================================================================

-- Indexes for users
CREATE INDEX IF NOT EXISTS idx_users_wallet_address ON users (wallet_address);

CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at DESC);

-- Indexes for expenses

CREATE INDEX IF NOT EXISTS idx_expenses_created_by_wallet ON expenses (created_by_wallet);

CREATE INDEX IF NOT EXISTS idx_expenses_member_wallets ON expenses USING GIN (member_wallets);

CREATE INDEX IF NOT EXISTS idx_expenses_created_at ON expenses (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_settled ON expenses (settled);

CREATE INDEX IF NOT EXISTS idx_trips_created_by_wallet ON trips (created_by_wallet);

CREATE INDEX IF NOT EXISTS idx_trips_member_wallets ON trips USING GIN (member_wallets);
-- Indexes for trips
CREATE INDEX IF NOT EXISTS idx_trips_created_at ON trips (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trips_settled ON trips (settled);

-- ============================================================================
-- 3. ENABLE ROW LEVEL SECURITY & CREATE ACCESS POLICIES
-- ============================================================================
-- Authorization is based on the `wallet_address` claim of the request's JWT.
--
-- That token is minted by /api/auth/verify only after the caller has signed a
-- server-issued challenge transaction with their Stellar private key, and it is
-- signed with the project's JWT secret — which never leaves the server. A
-- caller therefore cannot pick their own identity.
--
-- This replaces the earlier `x-wallet-address` request header, which was set
-- purely client-side and could be forged by anyone holding the (public) anon
-- key. Any deployment still running those policies has no access control at
-- all — re-run this script to replace them.
-- ============================================================================

-- Enable RLS on all tables (required before creating policies)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

ALTER TABLE trips ENABLE ROW LEVEL SECURITY;

-- ── Identity helper ─────────────────────────────────────────────────────────
-- Returns the Stellar address the request proved control of, or NULL when the
-- request carries no verified wallet. NULL never equals anything, so every
-- policy below denies by default for unauthenticated callers.

-- Revoked token ids. A row here means the token was signed out (or revoked
-- for the whole wallet) before its `exp`, so it must stop working immediately.
-- Rows are purged once the token they deny would have expired anyway.
CREATE TABLE IF NOT EXISTS public.revoked_tokens (
    jti TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at ON public.revoked_tokens (expires_at);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_wallet ON public.revoked_tokens (wallet_address);

-- "Sign out everywhere" tombstones. A token is denied when it was issued at or
-- before `revoked_before`, which covers tokens this server never saw the id of.
CREATE TABLE IF NOT EXISTS public.revoked_wallets (
    wallet_address TEXT PRIMARY KEY,
    revoked_before TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_wallets_expires_at ON public.revoked_wallets (expires_at);

ALTER TABLE public.revoked_wallets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.revoked_wallets FROM anon, authenticated;

-- Written only by the server (service role key). RLS on with no policies means
-- anon and authenticated match no rows, so a stolen token cannot un-revoke
-- itself by deleting its own row.
ALTER TABLE public.revoked_tokens ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.revoked_tokens FROM anon, authenticated;

-- Reading the denylist has to work for callers who cannot read the table, so
-- the lookup is wrapped in a SECURITY DEFINER function that exposes exactly one
-- boolean and nothing else.
CREATE OR REPLACE FUNCTION public.settlex_token_revoked (
    p_jti TEXT,
    p_wallet_address TEXT,
    p_issued_at BIGINT
) RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER
SET
    search_path = public AS $$
  SELECT
    -- This exact token was signed out...
    EXISTS (SELECT 1 FROM public.revoked_tokens WHERE jti = p_jti)
    -- ...or it predates a "sign out everywhere" for the same wallet.
    OR EXISTS (
        SELECT 1 FROM public.revoked_wallets w
        WHERE w.wallet_address = p_wallet_address
          AND p_issued_at IS NOT NULL
          AND TO_TIMESTAMP(p_issued_at) <= w.revoked_before
    );
$$;

GRANT
EXECUTE ON FUNCTION public.settlex_token_revoked (TEXT, TEXT, BIGINT) TO anon,
authenticated;

CREATE OR REPLACE FUNCTION public.settlex_wallet()
RETURNS TEXT
LANGUAGE SQL
STABLE
-- No longer PARALLEL SAFE: the revocation check reads a table through a
-- SECURITY DEFINER function.
AS $$
  -- Every RLS policy routes through this one function, so the revocation check
  -- lives here: a revoked token resolves to NULL, and NULL equals nothing, so
  -- it matches no row on any table. Tokens minted before `jti` existed have no
  -- id to deny and stay valid until they expire.
  SELECT NULLIF(
    COALESCE(
      CASE
        WHEN public.settlex_token_revoked(
          NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'jti',
          NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'wallet_address',
          (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'iat')::BIGINT
        ) THEN ''
        ELSE NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'wallet_address'
      END,
      ''
    ),
    ''
  );
$$;

GRANT EXECUTE ON FUNCTION public.settlex_wallet() TO anon, authenticated;

-- Revokes one token id. Idempotent: signing out twice is not an error.
CREATE OR REPLACE FUNCTION public.settlex_revoke_token (
    p_jti TEXT,
    p_wallet_address TEXT,
    p_expires_at TIMESTAMPTZ
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET
    search_path = public AS $$
BEGIN
    DELETE FROM public.revoked_tokens WHERE expires_at <= NOW();

    INSERT INTO public.revoked_tokens (jti, wallet_address, expires_at)
    VALUES (p_jti, p_wallet_address, p_expires_at)
    ON CONFLICT (jti) DO NOTHING;
END;
$$;

-- Revokes every currently-live token for a wallet ("sign out everywhere").
-- Tokens are stateless, so there is no list of outstanding ids to walk; instead
-- a wallet-wide tombstone is written and `settlex_wallet()` denies any token
-- issued at or before it.
CREATE OR REPLACE FUNCTION public.settlex_revoke_wallet (p_wallet_address TEXT) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET
    search_path = public AS $$
DECLARE
    -- Must outlive the longest token AUTH_SESSION_TTL_SECONDS can mint (12h),
    -- or the tombstone would lapse while a denied token is still valid.
    v_max_ttl INTERVAL := INTERVAL '13 hours';
BEGIN
    INSERT INTO public.revoked_wallets (wallet_address, revoked_before, expires_at)
    VALUES (p_wallet_address, NOW(), NOW() + v_max_ttl)
    ON CONFLICT (wallet_address) DO UPDATE
    SET revoked_before = NOW(),
        expires_at = NOW() + v_max_ttl;

    DELETE FROM public.revoked_wallets WHERE expires_at <= NOW();
    RETURN 1;
END;
$$;

REVOKE ALL ON FUNCTION public.settlex_revoke_token (TEXT, TEXT, TIMESTAMPTZ)
FROM
    PUBLIC,
    anon,
    authenticated;

REVOKE ALL ON FUNCTION public.settlex_revoke_wallet (TEXT)
FROM
    PUBLIC,
    anon,
    authenticated;

GRANT
EXECUTE ON FUNCTION public.settlex_revoke_token (TEXT, TEXT, TIMESTAMPTZ) TO service_role;

GRANT
EXECUTE ON FUNCTION public.settlex_revoke_wallet (TEXT) TO service_role;

-- Purges denylist rows whose tokens have expired on their own. Called by the
-- server on sign-out; safe to also run from pg_cron.
CREATE OR REPLACE FUNCTION public.settlex_purge_revoked_tokens () RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET
    search_path = public AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM public.revoked_tokens WHERE expires_at <= NOW();
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.settlex_purge_revoked_tokens ()
FROM
    PUBLIC,
    anon,
    authenticated;

GRANT
EXECUTE ON FUNCTION public.settlex_purge_revoked_tokens () TO service_role;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Anyone can view users" ON users;

DROP POLICY IF EXISTS "Authenticated wallets can view users" ON users;

DROP POLICY IF EXISTS "Users can insert their own profile" ON users;

DROP POLICY IF EXISTS "Users can update their own profile" ON users;

DROP POLICY IF EXISTS "Allow all operations on users" ON users;

DROP POLICY IF EXISTS "Allow all operations on expenses" ON expenses;

DROP POLICY IF EXISTS "Allow all operations on trips" ON trips;

DROP POLICY IF EXISTS "Members can view their expenses" ON expenses;

DROP POLICY IF EXISTS "Members can create expenses" ON expenses;

DROP POLICY IF EXISTS "Members can update their expenses" ON expenses;

DROP POLICY IF EXISTS "Creator can delete expense" ON expenses;

DROP POLICY IF EXISTS "Members can view their trips" ON trips;

DROP POLICY IF EXISTS "Members can create trips" ON trips;

DROP POLICY IF EXISTS "Members can update their trips" ON trips;

DROP POLICY IF EXISTS "Creator can delete trip" ON trips;

-- ============================================================================
-- WALLET-BASED ACCESS CONTROL
-- ============================================================================
-- Only members can see/edit expenses/trips they're part of.
-- Each user can only access expenses/trips where their proven wallet address
-- is in member_wallets[] (or on one of the shares).
--
-- Do NOT replace these with `USING (true)` policies, not even temporarily:
-- the anon key is shipped in the browser bundle, so a permissive policy is
-- equivalent to publishing the table.
-- ============================================================================

-- USERS POLICIES --

-- Any wallet that has proven key ownership can read the member directory
-- (needed to resolve display names when picking members for a split).
-- Signing in does not require an existing profile, so a brand-new wallet can
-- still authenticate and then create one.
CREATE POLICY "Authenticated wallets can view users" ON users FOR
SELECT USING (
    public.settlex_wallet() IS NOT NULL
);

-- Users can insert their own profile during signup (wallet must match)
CREATE POLICY "Users can insert their own profile" ON users
FOR INSERT
WITH CHECK (
    wallet_address = public.settlex_wallet()
);

-- Users can only update their own profile
CREATE POLICY "Users can update their own profile" ON users
FOR UPDATE
USING (
    wallet_address = public.settlex_wallet()
)
WITH CHECK (
    wallet_address = public.settlex_wallet()
);

-- EXPENSES POLICIES --

-- Members can view expenses they're part of
-- Also allows any wallet that appears on a share (covers trip members who
-- were added without a wallet address at trip creation time)
CREATE POLICY "Members can view their expenses" ON expenses
FOR SELECT
USING (
    public.settlex_wallet() = ANY(member_wallets)
    OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(shares) AS s
        WHERE s->>'walletAddress' = public.settlex_wallet()
    )
);

-- Any authenticated wallet can create an expense (they become the creator)
CREATE POLICY "Members can create expenses" ON expenses
FOR INSERT
WITH CHECK (
    -- Creator wallet matches the proven wallet
    created_by_wallet = public.settlex_wallet()
    AND
    -- Creator must be in the members list
    created_by_wallet = ANY(member_wallets)
);

-- Members can update expenses they're part of
-- Also allows any wallet that appears on a share (even if not in member_wallets)
-- so members can record their own payment regardless of how the expense was created
CREATE POLICY "Members can update their expenses" ON expenses
FOR UPDATE
USING (
    public.settlex_wallet() = ANY(member_wallets)
    OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(shares) AS s
        WHERE s->>'walletAddress' = public.settlex_wallet()
    )
)
WITH CHECK (
    public.settlex_wallet() = ANY(member_wallets)
    OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(shares) AS s
        WHERE s->>'walletAddress' = public.settlex_wallet()
    )
);

-- Only the creator can delete an expense
CREATE POLICY "Creator can delete expense" ON expenses
FOR DELETE
USING (
    created_by_wallet = public.settlex_wallet()
);

-- TRIPS POLICIES --

-- Members can view trips they're part of
CREATE POLICY "Members can view their trips" ON trips
FOR SELECT
USING (
    public.settlex_wallet() = ANY(member_wallets)
);

-- Any authenticated wallet can create a trip
CREATE POLICY "Members can create trips" ON trips
FOR INSERT
WITH CHECK (
    created_by_wallet = public.settlex_wallet()
    AND
    created_by_wallet = ANY(member_wallets)
);

-- Members can update trips they're part of
CREATE POLICY "Members can update their trips" ON trips
FOR UPDATE
USING (
    public.settlex_wallet() = ANY(member_wallets)
)
WITH CHECK (
    public.settlex_wallet() = ANY(member_wallets)
);

-- Only the creator can delete a trip
CREATE POLICY "Creator can delete trip" ON trips
FOR DELETE
USING (
    created_by_wallet = public.settlex_wallet()
);

-- ============================================================================
-- 4. ENABLE REALTIME (for live updates across browsers)
-- ============================================================================
-- Safely add tables to realtime publication (only if not already added)

DO $$
BEGIN
    -- Add users table to realtime if not already added
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' 
        AND schemaname = 'public' 
        AND tablename = 'users'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE users;

END IF;

-- Add expenses table to realtime if not already added
IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE
        pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'expenses'
) THEN
ALTER PUBLICATION supabase_realtime
ADD
TABLE expenses;

END IF;

-- Add trips table to realtime if not already added
IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE
        pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'trips'
) THEN
ALTER PUBLICATION supabase_realtime
ADD
TABLE trips;

END IF;

END $$;

-- ============================================================================
-- 5. CREATE UPDATED_AT TRIGGERS (Auto-update timestamps)
-- ============================================================================

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing triggers if they exist
DROP TRIGGER IF EXISTS update_users_updated_at ON users;

DROP TRIGGER IF EXISTS update_expenses_updated_at ON expenses;

DROP TRIGGER IF EXISTS update_trips_updated_at ON trips;

-- Create trigger for users
CREATE TRIGGER update_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Create trigger for expenses
CREATE TRIGGER update_expenses_updated_at
BEFORE UPDATE ON expenses
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Optimistic concurrency: every update to an expense advances `version`.
--
-- Clients guard writes with `WHERE version = <the value they read>`, which only
-- detects a lost update if every writer actually moves the token. Enforcing the
-- bump here rather than trusting each call site means a writer that forgets --
-- or a hand-run SQL fix -- cannot silently defeat the guard for everyone else.
CREATE OR REPLACE FUNCTION bump_expense_version()
RETURNS TRIGGER AS $$
BEGIN
  -- Only when the row's contents actually changed, so a no-op write does not
  -- invalidate another editor's token for nothing.
  IF NEW IS DISTINCT FROM OLD THEN
    IF NEW.version IS NOT DISTINCT FROM OLD.version THEN
      NEW.version = COALESCE(OLD.version, 0) + 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bump_expenses_version ON expenses;

CREATE TRIGGER bump_expenses_version
BEFORE UPDATE ON expenses
FOR EACH ROW
EXECUTE FUNCTION bump_expense_version();

-- Create trigger for trips
CREATE TRIGGER update_trips_updated_at
BEFORE UPDATE ON trips
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 5.5. ATOMIC RPC FUNCTION FOR MARKING SHARES PAID (Concurrency-Safe)
-- ============================================================================
-- Safely patches a single element in the shares JSONB array using row-level locking
-- (FOR UPDATE), preventing concurrent payments from overwriting each other.
CREATE OR REPLACE FUNCTION public.mark_share_paid(
    p_expense_id UUID,
    p_member_id TEXT,
    p_tx_hash TEXT
)
RETURNS SETOF public.expenses
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_caller_wallet TEXT;
    v_current_shares JSONB;
    v_updated_shares JSONB;
    v_settled BOOLEAN;
BEGIN
    v_caller_wallet := public.settlex_wallet();
    IF v_caller_wallet IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Lock the expense row for update to eliminate race conditions
    SELECT shares INTO v_current_shares
    FROM public.expenses
    WHERE id = p_expense_id
    FOR UPDATE;

    IF v_current_shares IS NULL THEN
        RAISE EXCEPTION 'Expense not found';
    END IF;

    -- Atomically transform the specific member share inside the JSONB array
    SELECT 
        jsonb_agg(
            CASE 
                WHEN elem->>'memberId' = p_member_id THEN 
                    jsonb_set(
                        jsonb_set(elem, '{paid}', 'true'::jsonb),
                        '{txHash}', 
                        to_jsonb(p_tx_hash)
                    )
                ELSE elem 
            END
        ),
        bool_and(
            CASE 
                WHEN elem->>'memberId' = p_member_id THEN true
                ELSE COALESCE((elem->>'paid')::boolean, false)
            END
        )
    INTO v_updated_shares, v_settled
    FROM jsonb_array_elements(v_current_shares) AS elem;

    RETURN QUERY
    UPDATE public.expenses
    SET 
        shares = v_updated_shares,
        settled = COALESCE(v_settled, false),
        version = COALESCE(version, 0) + 1,
        updated_at = NOW()
    WHERE id = p_expense_id
      AND (
          v_caller_wallet = ANY(member_wallets)
          OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(shares) AS s
              WHERE s->>'walletAddress' = v_caller_wallet
          )
      )
    RETURNING *;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_share_paid(UUID, TEXT, TEXT) TO authenticated, anon;

-- ============================================================================
-- 5.6. AUTH SHARED STATE (Replay Guard + Rate Limiting Across Instances)
-- ============================================================================
-- The auth routes run on serverless instances that do not share memory, so a
-- challenge nonce burned in one process means nothing to its siblings and a
-- per-process rate limiter multiplies the real limit by the instance count.
-- Both tables below are written only by the server, using the service role key
-- (SUPABASE_SERVICE_ROLE_KEY) — never the anon key.

CREATE TABLE IF NOT EXISTS public.auth_nonces (
    nonce TEXT PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires_at ON public.auth_nonces (expires_at);

CREATE TABLE IF NOT EXISTS public.auth_rate_limits (
    key TEXT PRIMARY KEY,
    hits INTEGER NOT NULL,
    reset_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_reset_at ON public.auth_rate_limits (reset_at);

-- RLS on with no policies: anon and authenticated match no rows at all. The
-- service role bypasses RLS, which is exactly the access the auth routes need.
ALTER TABLE public.auth_nonces ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.auth_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.auth_nonces FROM anon, authenticated;

REVOKE ALL ON public.auth_rate_limits FROM anon, authenticated;

-- Burns a nonce for every instance at once. Returns TRUE the first time a nonce
-- is seen and FALSE on every replay; the insert is the atomic check, so two
-- concurrent verifies of the same challenge cannot both win.
CREATE OR REPLACE FUNCTION public.auth_consume_nonce (p_nonce TEXT, p_expires_at TIMESTAMPTZ) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET
    search_path = public AS $
DECLARE
    v_inserted INTEGER;
BEGIN
    DELETE FROM public.auth_nonces WHERE expires_at <= NOW();

    INSERT INTO public.auth_nonces (nonce, expires_at)
    VALUES (p_nonce, p_expires_at)
    ON CONFLICT (nonce) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted > 0;
END;
$;

-- Fixed-window counter shared by every instance. One statement does the read,
-- the increment and the window roll-over, so concurrent callers cannot both
-- read a stale count.
CREATE OR REPLACE FUNCTION public.auth_rate_limit (
    p_key TEXT,
    p_limit INTEGER,
    p_window_ms INTEGER
) RETURNS TABLE (allowed BOOLEAN, retry_after INTEGER) LANGUAGE plpgsql SECURITY DEFINER
SET
    search_path = public AS $
DECLARE
    v_window INTERVAL := (p_window_ms || ' milliseconds')::INTERVAL;
    v_hits INTEGER;
    v_reset TIMESTAMPTZ;
BEGIN
    DELETE FROM public.auth_rate_limits WHERE reset_at <= NOW();

    INSERT INTO public.auth_rate_limits AS r (key, hits, reset_at)
    VALUES (p_key, 1, NOW() + v_window)
    ON CONFLICT (key) DO UPDATE
    SET hits = CASE WHEN r.reset_at <= NOW() THEN 1 ELSE r.hits + 1 END,
        reset_at = CASE WHEN r.reset_at <= NOW() THEN NOW() + v_window ELSE r.reset_at END
    RETURNING r.hits, r.reset_at INTO v_hits, v_reset;

    IF v_hits > p_limit THEN
        RETURN QUERY SELECT FALSE, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_reset - NOW())))::INTEGER);
    ELSE
        RETURN QUERY SELECT TRUE, 0;
    END IF;
END;
$;

-- Only the server (service role) may call these.
REVOKE ALL ON FUNCTION public.auth_consume_nonce (TEXT, TIMESTAMPTZ)
FROM
    PUBLIC,
    anon,
    authenticated;

REVOKE ALL ON FUNCTION public.auth_rate_limit (TEXT, INTEGER, INTEGER)
FROM
    PUBLIC,
    anon,
    authenticated;

GRANT
EXECUTE ON FUNCTION public.auth_consume_nonce (TEXT, TIMESTAMPTZ) TO service_role;

GRANT
EXECUTE ON FUNCTION public.auth_rate_limit (TEXT, INTEGER, INTEGER) TO service_role;

-- ============================================================================
-- 6. VERIFICATION QUERIES (Optional - Run to verify setup)
-- ============================================================================

-- Check tables exist
SELECT table_name
FROM information_schema.tables
WHERE
    table_schema = 'public'
    AND table_name IN (
        'users',
        'expenses',
        'trips',
        'auth_nonces',
        'auth_rate_limits'
    );

-- Check indexes exist
SELECT indexname
FROM pg_indexes
WHERE
    tablename IN ('users', 'expenses', 'trips');

-- Check RLS is enabled
SELECT tablename, rowsecurity
FROM pg_tables
WHERE
    tablename IN ('users', 'expenses', 'trips');

-- Check policies exist
SELECT tablename, policyname
FROM pg_policies
WHERE
    tablename IN ('users', 'expenses', 'trips');

