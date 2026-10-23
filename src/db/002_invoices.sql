-- 002: business profile, client billing details, invoices and credit notes, expenses with receipts.
-- Drafts are free to change. Once issued, a document is locked: only sent and void are left for it.

-- The seller's details, set once. One row.
CREATE TABLE business_profile (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  legal_name           TEXT,
  address              TEXT,
  ein                  TEXT CHECK (ein IS NULL OR ein GLOB '[0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  email                TEXT,
  payment_instructions TEXT,
  next_invoice_number  INTEGER NOT NULL DEFAULT 1 CHECK (typeof(next_invoice_number) = 'integer' AND next_invoice_number >= 1),
  source               TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);

ALTER TABLE clients ADD COLUMN address TEXT;
ALTER TABLE clients ADD COLUMN email TEXT;
ALTER TABLE clients ADD COLUMN terms_days INTEGER NOT NULL DEFAULT 30 CHECK (typeof(terms_days) = 'integer' AND terms_days >= 0);
-- Sales tax only when the person sets a rate on the client: parts per million, so 6.25% is 62500.
ALTER TABLE clients ADD COLUMN tax_rate_ppm INTEGER CHECK (tax_rate_ppm IS NULL OR (typeof(tax_rate_ppm) = 'integer' AND tax_rate_ppm BETWEEN 1 AND 1000000));
ALTER TABLE clients ADD COLUMN tax_label TEXT;

-- The day a fixed fee becomes billable; a period's draft picks up milestones billable within it.
ALTER TABLE milestones ADD COLUMN billable_on TEXT;

CREATE TABLE expenses (
  id                     INTEGER PRIMARY KEY,
  date                   TEXT    NOT NULL,
  amount_cents           INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  currency               TEXT    NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  vendor                 TEXT    NOT NULL CHECK (length(trim(vendor)) > 0),
  memo                   TEXT,
  account_id             INTEGER NOT NULL REFERENCES accounts(id),
  paid_from_account_id   INTEGER NOT NULL REFERENCES accounts(id),
  entry_id               INTEGER NOT NULL REFERENCES entries(id),
  -- A pass-through cost: billed on to this client at cost.
  pass_through_client_id INTEGER REFERENCES clients(id),
  -- The receipt, copied into the books folder under receipts/, named by its sha256.
  receipt_file           TEXT,
  receipt_sha256         TEXT,
  receipt_bytes          INTEGER,
  source                 TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  CHECK ((receipt_file IS NULL) = (receipt_sha256 IS NULL))
);
CREATE TRIGGER expenses_no_update BEFORE UPDATE ON expenses
BEGIN SELECT RAISE(ABORT, 'expenses are posted and never change; post a reversing entry instead'); END;
CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses
BEGIN SELECT RAISE(ABORT, 'expenses are posted and never change; post a reversing entry instead'); END;

-- Invoices and credit notes. A draft holds no number; one is assigned only at issue.
-- Seller, client and tax details are copied in at issue so the document never changes afterwards.
CREATE TABLE invoices (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                 TEXT    NOT NULL CHECK (kind IN ('invoice', 'credit')),
  status               TEXT    NOT NULL CHECK (status IN ('draft', 'issued', 'sent', 'void')),
  client_id            INTEGER NOT NULL REFERENCES clients(id),
  number               INTEGER CHECK (number IS NULL OR (typeof(number) = 'integer' AND number >= 1)),
  credits_invoice_id   INTEGER REFERENCES invoices(id),
  period_start         TEXT    NOT NULL,
  period_end           TEXT    NOT NULL,
  terms_days           INTEGER NOT NULL CHECK (typeof(terms_days) = 'integer' AND terms_days >= 0),
  invoice_date         TEXT,
  due_date             TEXT,
  tax_rate_ppm         INTEGER,
  tax_label            TEXT,
  seller_legal_name    TEXT,
  seller_address       TEXT,
  seller_ein           TEXT,
  seller_email         TEXT,
  payment_instructions TEXT,
  client_name          TEXT,
  client_address       TEXT,
  client_email         TEXT,
  note                 TEXT,
  created_at           TEXT    NOT NULL,
  issued_at            TEXT,
  sent_at              TEXT,
  voided_at            TEXT,
  void_reason          TEXT,
  source               TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  CHECK ((status = 'draft') = (number IS NULL)),
  CHECK ((kind = 'credit') = (credits_invoice_id IS NOT NULL)),
  CHECK (status = 'draft' OR (invoice_date IS NOT NULL AND issued_at IS NOT NULL AND seller_legal_name IS NOT NULL)),
  CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  UNIQUE (kind, number)
);

CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'issued invoices are never deleted; void them instead'); END;

CREATE TRIGGER invoices_locked BEFORE UPDATE ON invoices
WHEN OLD.status <> 'draft' AND NOT (
  ((OLD.status = 'issued' AND NEW.status IN ('sent', 'void')) OR (OLD.status = 'sent' AND NEW.status = 'void'))
  AND NEW.kind IS OLD.kind AND NEW.client_id IS OLD.client_id AND NEW.number IS OLD.number
  AND NEW.credits_invoice_id IS OLD.credits_invoice_id AND NEW.period_start IS OLD.period_start
  AND NEW.period_end IS OLD.period_end AND NEW.terms_days IS OLD.terms_days AND NEW.invoice_date IS OLD.invoice_date
  AND NEW.due_date IS OLD.due_date AND NEW.tax_rate_ppm IS OLD.tax_rate_ppm AND NEW.tax_label IS OLD.tax_label
  AND NEW.seller_legal_name IS OLD.seller_legal_name AND NEW.seller_address IS OLD.seller_address
  AND NEW.seller_ein IS OLD.seller_ein AND NEW.seller_email IS OLD.seller_email
  AND NEW.payment_instructions IS OLD.payment_instructions AND NEW.client_name IS OLD.client_name
  AND NEW.client_address IS OLD.client_address AND NEW.client_email IS OLD.client_email AND NEW.note IS OLD.note
  AND NEW.created_at IS OLD.created_at AND NEW.issued_at IS OLD.issued_at AND NEW.source IS OLD.source
  AND (OLD.sent_at IS NULL OR NEW.sent_at IS OLD.sent_at)
)
BEGIN SELECT RAISE(ABORT, 'issued invoices are locked; void or credit them instead'); END;

CREATE TABLE invoice_lines (
  id            INTEGER PRIMARY KEY,
  invoice_id    INTEGER NOT NULL REFERENCES invoices(id),
  kind          TEXT    NOT NULL CHECK (kind IN ('time', 'fixed', 'recurring', 'pass_through', 'manual')),
  description   TEXT    NOT NULL CHECK (length(trim(description)) > 0),
  amount_cents  INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  time_entry_id INTEGER REFERENCES time_entries(id),
  milestone_id  INTEGER REFERENCES milestones(id),
  engagement_id INTEGER REFERENCES engagements(id),
  cycle_start   TEXT,
  expense_id    INTEGER REFERENCES expenses(id),
  source        TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);
CREATE INDEX invoice_lines_invoice ON invoice_lines(invoice_id);
CREATE INDEX invoice_lines_time ON invoice_lines(time_entry_id);

CREATE TRIGGER invoice_lines_locked_insert BEFORE INSERT ON invoice_lines
WHEN (SELECT status FROM invoices WHERE id = NEW.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'issued invoices are locked; void or credit them instead'); END;
CREATE TRIGGER invoice_lines_locked_update BEFORE UPDATE ON invoice_lines
WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) <> 'draft'
  OR (SELECT status FROM invoices WHERE id = NEW.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'issued invoices are locked; void or credit them instead'); END;
CREATE TRIGGER invoice_lines_locked_delete BEFORE DELETE ON invoice_lines
WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) <> 'draft'
BEGIN SELECT RAISE(ABORT, 'issued invoices are locked; void or credit them instead'); END;

-- Time billed on an issued invoice is locked with it.
CREATE TRIGGER time_entries_billed_update BEFORE UPDATE ON time_entries
WHEN EXISTS (SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
             WHERE l.time_entry_id = OLD.id AND i.status IN ('issued', 'sent'))
BEGIN SELECT RAISE(ABORT, 'time on an issued invoice is locked'); END;
CREATE TRIGGER time_entries_billed_delete BEFORE DELETE ON time_entries
WHEN EXISTS (SELECT 1 FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
             WHERE l.time_entry_id = OLD.id AND i.status IN ('issued', 'sent'))
BEGIN SELECT RAISE(ABORT, 'time on an issued invoice is locked'); END;
