-- 007: payments on invoices, recorded gross plus fee, so what the client paid, what the processor kept and what
-- reached the bank all reconcile to the 1099-K. A refund reverses its payment with a reversing entry. Money paid
-- beyond what an invoice still owed is a client credit. All of it is posted when written and never changes.

CREATE TABLE payments (
  id                 INTEGER PRIMARY KEY,
  invoice_id         INTEGER NOT NULL REFERENCES invoices(id),
  date               TEXT    NOT NULL,
  -- Gross: what the client paid, before the processor's fee.
  amount_cents       INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  fee_cents          INTEGER NOT NULL CHECK (typeof(fee_cents) = 'integer' AND fee_cents >= 0),
  -- Where the rest, amount less fee, landed.
  deposit_account_id INTEGER NOT NULL REFERENCES accounts(id),
  -- What it settled on the invoice, and what was left over as a client credit.
  applied_cents      INTEGER NOT NULL CHECK (typeof(applied_cents) = 'integer' AND applied_cents >= 0),
  credit_cents       INTEGER NOT NULL CHECK (typeof(credit_cents) = 'integer' AND credit_cents >= 0),
  memo               TEXT,
  entry_id           INTEGER NOT NULL UNIQUE REFERENCES entries(id),
  source             TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  CHECK (fee_cents < amount_cents),
  CHECK (applied_cents + credit_cents = amount_cents)
);
CREATE INDEX payments_invoice ON payments(invoice_id);

CREATE TABLE refunds (
  id         INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL UNIQUE REFERENCES payments(id),
  date       TEXT    NOT NULL,
  reason     TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  entry_id   INTEGER NOT NULL UNIQUE REFERENCES entries(id),
  source     TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);

-- Money held for a client: an overpayment adds to it, and refunding that payment takes it back out.
-- A client's credit balance is the sum of their rows.
CREATE TABLE client_credits (
  id           INTEGER PRIMARY KEY,
  client_id    INTEGER NOT NULL REFERENCES clients(id),
  date         TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents <> 0),
  payment_id   INTEGER NOT NULL REFERENCES payments(id),
  refund_id    INTEGER REFERENCES refunds(id),
  source       TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  CHECK ((refund_id IS NULL) = (amount_cents > 0))
);
CREATE INDEX client_credits_client ON client_credits(client_id);

CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments
BEGIN SELECT RAISE(ABORT, 'payments are posted and never change; refund them instead'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'payments are posted and never change; refund them instead'); END;
CREATE TRIGGER refunds_no_update BEFORE UPDATE ON refunds
BEGIN SELECT RAISE(ABORT, 'refunds are posted and never change'); END;
CREATE TRIGGER refunds_no_delete BEFORE DELETE ON refunds
BEGIN SELECT RAISE(ABORT, 'refunds are posted and never change'); END;
CREATE TRIGGER client_credits_no_update BEFORE UPDATE ON client_credits
BEGIN SELECT RAISE(ABORT, 'client credits are posted and never change'); END;
CREATE TRIGGER client_credits_no_delete BEFORE DELETE ON client_credits
BEGIN SELECT RAISE(ABORT, 'client credits are posted and never change'); END;
