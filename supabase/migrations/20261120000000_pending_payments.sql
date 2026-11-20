-- ============================================================================
-- SettleX Migration: 20261120000000_pending_payments.sql
-- Durable pending payments (Issue #205)
--
-- A share payment has two halves: the XLM transfer on Stellar and the
-- mark_share_paid write here. If the transfer lands and the write fails, the
-- money has left the wallet while the share still reads unpaid, and nothing
-- stopped the user from paying again.
--
-- The client now writes a row here after signing and before submitting, keyed
-- by (expense_id, member_id) and holding the transaction hash, which is known
-- as soon as the transaction is signed. The row survives reloads and other
-- devices; while it exists the share's Pay action is blocked, and on load the
-- client reconciles it against Horizon and removes it once the share is
-- recorded (or once Horizon shows the transaction can never land).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.pending_payments (
    expense_id     UUID        NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
    member_id      TEXT        NOT NULL,
    tx_hash        TEXT        NOT NULL,
    payer_wallet   TEXT        NOT NULL DEFAULT public.settlex_wallet(),
    destination_wallet TEXT    NOT NULL,
    amount         TEXT        NOT NULL,
    trip_id        TEXT,
    status         TEXT        NOT NULL DEFAULT 'signed',
    ledger         BIGINT,
    valid_until    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (expense_id, member_id),
    CONSTRAINT pending_payments_tx_hash_check CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT pending_payments_status_check  CHECK (status IN ('signed', 'submitted')),
    CONSTRAINT pending_payments_member_id_len CHECK (char_length(member_id) <= 128),
    CONSTRAINT pending_payments_amount_len    CHECK (char_length(amount) <= 32),
    CONSTRAINT pending_payments_trip_id_len   CHECK (trip_id IS NULL OR char_length(trip_id) <= 128),
    CONSTRAINT pending_payments_wallet_len    CHECK (
        char_length(payer_wallet) <= 56 AND char_length(destination_wallet) <= 56
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_payments_tx_hash ON public.pending_payments(tx_hash);
CREATE INDEX IF NOT EXISTS idx_pending_payments_payer_wallet ON public.pending_payments(payer_wallet);

ALTER TABLE public.pending_payments ENABLE ROW LEVEL SECURITY;

-- Only the wallet that signed the transfer can see or change its pending row.
-- Inserts additionally require that the caller can see the expense (RLS on
-- public.expenses applies inside the EXISTS), so rows cannot be planted
-- against arbitrary expenses.
DROP POLICY IF EXISTS "Payers can view their pending payments" ON public.pending_payments;
CREATE POLICY "Payers can view their pending payments" ON public.pending_payments
    FOR SELECT
    USING (payer_wallet = public.settlex_wallet());

DROP POLICY IF EXISTS "Payers can create pending payments" ON public.pending_payments;
CREATE POLICY "Payers can create pending payments" ON public.pending_payments
    FOR INSERT
    WITH CHECK (
        payer_wallet = public.settlex_wallet()
        AND EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = pending_payments.expense_id)
    );

DROP POLICY IF EXISTS "Payers can update their pending payments" ON public.pending_payments;
CREATE POLICY "Payers can update their pending payments" ON public.pending_payments
    FOR UPDATE
    USING (payer_wallet = public.settlex_wallet())
    WITH CHECK (payer_wallet = public.settlex_wallet());

DROP POLICY IF EXISTS "Payers can delete their pending payments" ON public.pending_payments;
CREATE POLICY "Payers can delete their pending payments" ON public.pending_payments
    FOR DELETE
    USING (payer_wallet = public.settlex_wallet());

CREATE OR REPLACE FUNCTION public.pending_payments_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.updated_at := pg_catalog.now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pending_payments_touch_updated_at ON public.pending_payments;
CREATE TRIGGER pending_payments_touch_updated_at
    BEFORE UPDATE ON public.pending_payments
    FOR EACH ROW EXECUTE FUNCTION public.pending_payments_touch_updated_at();

-- Once mark_share_paid records the transfer in public.payments, the pending
-- row has done its job. Clearing it here means a client that crashes right
-- after a successful write still sees the share as recorded, not pending.
CREATE OR REPLACE FUNCTION public.pending_payments_clear_on_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    DELETE FROM public.pending_payments
    WHERE expense_id = NEW.expense_id
      AND member_id = NEW.member_id;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.pending_payments_clear_on_payment() FROM PUBLIC;

DROP TRIGGER IF EXISTS pending_payments_clear_on_payment ON public.payments;
CREATE TRIGGER pending_payments_clear_on_payment
    AFTER INSERT ON public.payments
    FOR EACH ROW EXECUTE FUNCTION public.pending_payments_clear_on_payment();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pending_payments TO authenticated;
