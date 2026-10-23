-- 003: the person says which kinds of line a client's sales tax applies to, and every invoice line keeps the date
-- of what it bills, so a draft can show what it carried over from before its period.

-- Comma-separated line kinds, such as "time,fixed". Set together with the rate; solobooks never picks them.
ALTER TABLE clients ADD COLUMN tax_applies_to TEXT;
ALTER TABLE invoices ADD COLUMN tax_applies_to TEXT;
ALTER TABLE invoice_lines ADD COLUMN item_date TEXT;

-- Books written before 003 taxed every line, so their rates keep doing exactly that.
UPDATE clients SET tax_applies_to = 'time,fixed,recurring,pass_through,manual' WHERE tax_rate_ppm IS NOT NULL;
DROP TRIGGER invoices_locked;
UPDATE invoices SET tax_applies_to = 'time,fixed,recurring,pass_through,manual' WHERE tax_rate_ppm IS NOT NULL;

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
  AND (OLD.sent_at IS NULL OR NEW.sent_at IS OLD.sent_at)
)
BEGIN SELECT RAISE(ABORT, 'issued invoices are locked; void or credit them instead'); END;
