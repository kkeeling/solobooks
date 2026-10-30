-- 014: billable charges. A charge is an amount billed back to one client at cost, waiting for that client's next
-- invoice. It may name the expense it came out of, or none, since token usage billed back rarely matches one card
-- charge. An agent adds charges whenever it learns of them, so recording an expense never forces a billing choice.
-- The whole-expense pass-through each expense could carry becomes one full-amount charge, keeping its invoice link,
-- and expenses.pass_through_client_id is no longer written or read.

CREATE TABLE charges (
  id              INTEGER PRIMARY KEY,
  client_id       INTEGER NOT NULL REFERENCES clients(id),
  date            TEXT    NOT NULL,
  amount_cents    INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  line_text       TEXT    NOT NULL CHECK (length(trim(line_text)) > 0),
  -- The agent's own name for what it billed, such as "openai:etr-key:2026-10", so a rerun can't bill it twice.
  reference       TEXT,
  expense_id      INTEGER REFERENCES expenses(id),
  -- What the amount came from, such as a usage export, copied into the books folder under evidence/.
  evidence_file   TEXT,
  evidence_sha256 TEXT,
  evidence_bytes  INTEGER,
  source          TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  -- Set when a charge billed only on voided invoices is deleted: the voided record keeps its line, nothing bills it again.
  deleted_at      TEXT,
  CHECK ((evidence_file IS NULL) = (evidence_sha256 IS NULL))
);
CREATE UNIQUE INDEX charges_reference ON charges(client_id, reference) WHERE reference IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX charges_expense ON charges(expense_id);

ALTER TABLE invoice_lines ADD COLUMN charge_id INTEGER REFERENCES charges(id);
CREATE INDEX invoice_lines_charge ON invoice_lines(charge_id);

-- A charge billed on an issued invoice is locked with it.
CREATE TRIGGER charges_billed_update BEFORE UPDATE ON charges
WHEN EXISTS (SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
             WHERE l.charge_id = OLD.id AND i.status IN ('issued', 'sent'))
BEGIN SELECT RAISE(ABORT, 'a charge on an issued invoice is locked'); END;
CREATE TRIGGER charges_billed_delete BEFORE DELETE ON charges
WHEN EXISTS (SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
             WHERE l.charge_id = OLD.id AND i.status IN ('issued', 'sent'))
BEGIN SELECT RAISE(ABORT, 'a charge on an issued invoice is locked'); END;

-- Each pass-through expense becomes one charge for its full amount, worded as its invoice line always was.
INSERT INTO charges (client_id, date, amount_cents, line_text, expense_id, source)
SELECT pass_through_client_id, date, amount_cents,
       date || ' ' || vendor || CASE WHEN memo IS NULL OR memo = '' THEN '' ELSE ', ' || memo END || ' (pass-through cost)',
       id, source
FROM expenses WHERE pass_through_client_id IS NOT NULL ORDER BY id;

-- Lines already billing those costs point at their charge. Issued lines are locked, so the lock steps aside for this
-- one update and comes back unchanged.
DROP TRIGGER invoice_lines_locked_update;
UPDATE invoice_lines SET charge_id = (SELECT c.id FROM charges c WHERE c.expense_id = invoice_lines.expense_id)
WHERE kind = 'pass_through' AND expense_id IS NOT NULL;
CREATE TRIGGER invoice_lines_locked_update BEFORE UPDATE ON invoice_lines
WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) <> 'draft'
  OR (SELECT status FROM invoices WHERE id = NEW.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'issued invoices are locked; void or credit them instead'); END;
