-- 005: invoices that happened before solobooks. The agent brings past invoices in as already sent, and optionally
-- already paid. They keep their original numbers, post to the ledger like any invoice, and never pass the gate,
-- because nothing about them reaches a client now.

ALTER TABLE invoices ADD COLUMN historical INTEGER NOT NULL DEFAULT 0
  CHECK (historical IN (0, 1) AND (historical = 0 OR (kind = 'invoice' AND status IN ('sent', 'void'))));
-- A past invoice paid in full before it was brought in: the day, and the account the money landed in.
ALTER TABLE invoices ADD COLUMN paid_on TEXT CHECK (paid_on IS NULL OR historical = 1);
ALTER TABLE invoices ADD COLUMN paid_account_id INTEGER REFERENCES accounts(id) CHECK ((paid_on IS NULL) = (paid_account_id IS NULL));

DROP TRIGGER invoices_locked;
CREATE TRIGGER invoices_locked BEFORE UPDATE ON invoices
WHEN OLD.status <> 'draft' AND NOT (
  ((OLD.status = 'issued' AND NEW.status IN ('sent', 'void')) OR (OLD.status = 'sent' AND NEW.status = 'void'))
  AND NEW.kind IS OLD.kind AND NEW.client_id IS OLD.client_id AND NEW.number IS OLD.number
  AND NEW.credits_invoice_id IS OLD.credits_invoice_id AND NEW.period_start IS OLD.period_start
  AND NEW.period_end IS OLD.period_end AND NEW.terms_days IS OLD.terms_days AND NEW.invoice_date IS OLD.invoice_date
  AND NEW.due_date IS OLD.due_date AND NEW.tax_rate_ppm IS OLD.tax_rate_ppm AND NEW.tax_label IS OLD.tax_label AND NEW.tax_applies_to IS OLD.tax_applies_to
  AND NEW.seller_legal_name IS OLD.seller_legal_name AND NEW.seller_address IS OLD.seller_address
  AND NEW.seller_ein IS OLD.seller_ein AND NEW.seller_email IS OLD.seller_email
  AND NEW.payment_instructions IS OLD.payment_instructions AND NEW.client_name IS OLD.client_name
  AND NEW.client_address IS OLD.client_address AND NEW.client_email IS OLD.client_email AND NEW.note IS OLD.note
  AND NEW.created_at IS OLD.created_at AND NEW.issued_at IS OLD.issued_at AND NEW.source IS OLD.source
  AND NEW.historical IS OLD.historical AND NEW.paid_on IS OLD.paid_on AND NEW.paid_account_id IS OLD.paid_account_id
  AND (OLD.sent_at IS NULL OR NEW.sent_at IS OLD.sent_at)
)
BEGIN SELECT RAISE(ABORT, 'issued invoices are locked; void or credit them instead'); END;
