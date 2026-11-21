-- ============================================================================
-- SettleX Migration: 20261121000000_trip_settlements.sql
-- Net settle-up transfers as first-class rows (Issue #203)
--
-- Settle-up pays a NET amount between two members, but progress used to be
-- recorded by marking whole GROSS shares paid. Netting means those never line
-- up: if A owes B 10 and B owes A 4, the net transfer is A->B 6, A's 10 share
-- never fits a 6 budget, and B's 4 share is never touched because no payment
-- goes B->A. The trip could never reach "All settled up".
--
-- A settle-up transfer is now recorded here as its own row, and each member's
-- balance is computed as  owed - paid shares - settlements.  Per-share marking
-- (mark_share_paid) is used only for direct share payments.
--
-- Writes go only through record_trip_settlement(), which checks that the
-- caller is an accepted trip member, is the sender (the `from` member's
-- wallet), and that the transaction hash has not been used before, either here
-- or for a share payment.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.trip_settlements (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id        UUID        NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
    from_member_id TEXT        NOT NULL,
    to_member_id   TEXT        NOT NULL,
    from_wallet    TEXT        NOT NULL,
    to_wallet      TEXT        NOT NULL,
    -- XLM with up to 7 decimals, as everywhere else in the schema.
    amount         TEXT        NOT NULL,
    tx_hash        TEXT        NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT trip_settlements_tx_hash_check   CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT trip_settlements_amount_check    CHECK (
        amount ~ '^[0-9]{1,9}(\.[0-9]{1,7})?$'
        AND amount::NUMERIC > 0
        AND amount::NUMERIC <= 100000000
    ),
    CONSTRAINT trip_settlements_distinct_members CHECK (from_member_id <> to_member_id),
    CONSTRAINT trip_settlements_member_id_len   CHECK (
        char_length(from_member_id) <= 128 AND char_length(to_member_id) <= 128
    ),
    CONSTRAINT trip_settlements_wallet_len      CHECK (
        char_length(from_wallet) <= 56 AND char_length(to_wallet) <= 56
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trip_settlements_tx_hash ON public.trip_settlements(tx_hash);
CREATE INDEX IF NOT EXISTS idx_trip_settlements_trip_id ON public.trip_settlements(trip_id);

ALTER TABLE public.trip_settlements ENABLE ROW LEVEL SECURITY;

-- Every member of the trip can see its settlements: everyone's balance
-- depends on them.
DROP POLICY IF EXISTS "Trip members can view settlements" ON public.trip_settlements;
CREATE POLICY "Trip members can view settlements" ON public.trip_settlements
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.trips t
            WHERE t.id = trip_settlements.trip_id
              AND (
                  public.settlex_wallet() = t.created_by_wallet
                  OR (
                      public.settlex_wallet() = ANY(t.member_wallets)
                      AND public.settlex_wallet() = ANY(t.accepted_wallets)
                  )
              )
        )
    );

-- No INSERT / UPDATE / DELETE policies: settlements are append-only and are
-- written exclusively by record_trip_settlement().
REVOKE ALL ON public.trip_settlements FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trip_settlements TO authenticated;

CREATE OR REPLACE FUNCTION public.record_trip_settlement(
    p_trip_id UUID,
    p_from_member_id TEXT,
    p_to_member_id TEXT,
    p_amount TEXT,
    p_tx_hash TEXT
)
RETURNS SETOF public.trip_settlements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_caller_wallet TEXT;
    v_trip public.trips%ROWTYPE;
    v_from_wallet TEXT;
    v_to_wallet TEXT;
BEGIN
    v_caller_wallet := public.settlex_wallet();
    IF v_caller_wallet IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF p_tx_hash IS NULL OR NOT (p_tx_hash ~ '^[0-9a-f]{64}$') THEN
        RAISE EXCEPTION 'Valid transaction hash is required to record a settlement';
    END IF;

    IF p_amount IS NULL
       OR NOT (p_amount ~ '^[0-9]{1,9}(\.[0-9]{1,7})?$')
       OR p_amount::NUMERIC <= 0
       OR p_amount::NUMERIC > 100000000 THEN
        RAISE EXCEPTION 'Settlement amount is invalid';
    END IF;

    IF p_from_member_id IS NULL OR p_to_member_id IS NULL
       OR p_from_member_id = p_to_member_id THEN
        RAISE EXCEPTION 'A settlement needs two different members';
    END IF;

    -- One Stellar transaction records exactly one settlement, and can never
    -- also count as a share payment.
    IF EXISTS (SELECT 1 FROM public.trip_settlements WHERE tx_hash = p_tx_hash) THEN
        RAISE EXCEPTION 'Settlement already recorded for this transaction';
    END IF;
    IF EXISTS (SELECT 1 FROM public.payments WHERE tx_hash = p_tx_hash) THEN
        RAISE EXCEPTION 'Transaction hash already used on another payment';
    END IF;

    SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Trip not found';
    END IF;

    IF NOT (
        v_caller_wallet = v_trip.created_by_wallet
        OR (
            v_caller_wallet = ANY(v_trip.member_wallets)
            AND v_caller_wallet = ANY(v_trip.accepted_wallets)
        )
    ) THEN
        RAISE EXCEPTION 'Accept the trip invitation before recording a settlement';
    END IF;

    IF v_trip.settled THEN
        RAISE EXCEPTION 'Trip is already settled';
    END IF;

    SELECT m->>'walletAddress' INTO v_from_wallet
    FROM pg_catalog.jsonb_array_elements(v_trip.members) AS m
    WHERE m->>'id' = p_from_member_id;

    SELECT m->>'walletAddress' INTO v_to_wallet
    FROM pg_catalog.jsonb_array_elements(v_trip.members) AS m
    WHERE m->>'id' = p_to_member_id;

    IF v_from_wallet IS NULL OR v_from_wallet = ''
       OR v_to_wallet IS NULL OR v_to_wallet = '' THEN
        RAISE EXCEPTION 'Both settlement members must belong to the trip and have a wallet';
    END IF;

    -- Only the sender records their own transfer.
    IF v_from_wallet <> v_caller_wallet THEN
        RAISE EXCEPTION 'Only the sender can record this settlement';
    END IF;

    RETURN QUERY
    INSERT INTO public.trip_settlements (
        trip_id, from_member_id, to_member_id, from_wallet, to_wallet, amount, tx_hash
    )
    VALUES (
        p_trip_id, p_from_member_id, p_to_member_id, v_from_wallet, v_to_wallet, p_amount, p_tx_hash
    )
    RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.record_trip_settlement(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_trip_settlement(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- The reverse guard: a hash already used for a settlement cannot be replayed
-- through mark_share_paid as a direct share payment.
CREATE OR REPLACE FUNCTION public.payments_reject_settlement_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.trip_settlements WHERE tx_hash = NEW.tx_hash) THEN
        RAISE EXCEPTION 'Transaction hash already used on another payment';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.payments_reject_settlement_hash() FROM PUBLIC;

DROP TRIGGER IF EXISTS payments_reject_settlement_hash ON public.payments;
CREATE TRIGGER payments_reject_settlement_hash
    BEFORE INSERT ON public.payments
    FOR EACH ROW EXECUTE FUNCTION public.payments_reject_settlement_hash();
