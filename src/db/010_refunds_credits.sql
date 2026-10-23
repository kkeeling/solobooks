-- 010: a refund can be partial, may return some of the processor's fee, and one payment can have several; a client
-- credit can be applied to a later invoice of the same client. SQLite can't change a CHECK or drop a UNIQUE, so refunds
-- and client_credits are rebuilt keeping every row, id and rule they had.

DROP TRIGGER refunds_no_update;
DROP TRIGGER refunds_no_delete;
DROP TRIGGER client_credits_no_update;
DROP TRIGGER client_credits_no_delete;

-- A refund gives back amount_cents of what the client paid. Of that, applied_cents is taken back off the invoice, so
-- it is owed again, and credit_cents out of the client credit the payment made. fee_returned_cents is any fee the
-- processor gave back, so what leaves the deposit account is amount_cents less fee_returned_cents.
-- Rows written before this migration were full refunds that also reversed the whole fee, which is what they posted.
CREATE TABLE refunds_new (
  id                 INTEGER PRIMARY KEY,
  payment_id         INTEGER NOT NULL REFERENCES payments(id),
  date               TEXT    NOT NULL,
  reason             TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  amount_cents       INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  fee_returned_cents INTEGER NOT NULL CHECK (typeof(fee_returned_cents) = 'integer' AND fee_returned_cents >= 0),
  applied_cents      INTEGER NOT NULL CHECK (typeof(applied_cents) = 'integer' AND applied_cents >= 0),
  credit_cents       INTEGER NOT NULL CHECK (typeof(credit_cents) = 'integer' AND credit_cents >= 0),
  entry_id           INTEGER NOT NULL UNIQUE REFERENCES entries(id),
  source             TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  CHECK (applied_cents + credit_cents = amount_cents),
  CHECK (fee_returned_cents < amount_cents)
);
INSERT INTO refunds_new (id, payment_id, date, reason, amount_cents, fee_returned_cents, applied_cents, credit_cents, entry_id, source)
  SELECT r.id, r.payment_id, r.date, r.reason, p.amount_cents, p.fee_cents, p.applied_cents, p.credit_cents, r.entry_id, r.source
  FROM refunds r JOIN payments p ON p.id = r.payment_id;
CREATE INDEX refunds_payment ON refunds_new(payment_id);

-- Client credit used to pay down one of the same client's invoices. The money never leaves the books: what was held
-- for the client settles what they owe.
CREATE TABLE credit_applications (
  id           INTEGER PRIMARY KEY,
  client_id    INTEGER NOT NULL REFERENCES clients(id),
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id),
  date         TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  entry_id     INTEGER NOT NULL UNIQUE REFERENCES entries(id),
  source       TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);
CREATE INDEX credit_applications_invoice ON credit_applications(invoice_id);

-- Money held for a client: an overpayment adds to it; a refund of that payment, or applying it to an invoice, takes
-- it back out. A client's credit balance is the sum of their rows, and it never goes below zero.
CREATE TABLE client_credits_new (
  id             INTEGER PRIMARY KEY,
  client_id      INTEGER NOT NULL REFERENCES clients(id),
  date           TEXT    NOT NULL,
  amount_cents   INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents <> 0),
  payment_id     INTEGER REFERENCES payments(id),
  refund_id      INTEGER REFERENCES refunds_new(id),
  application_id INTEGER REFERENCES credit_applications(id),
  source         TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  CHECK (
    (amount_cents > 0 AND payment_id IS NOT NULL AND refund_id IS NULL AND application_id IS NULL)
    OR (amount_cents < 0 AND payment_id IS NOT NULL AND refund_id IS NOT NULL AND application_id IS NULL)
    OR (amount_cents < 0 AND payment_id IS NULL AND refund_id IS NULL AND application_id IS NOT NULL)
  )
);
INSERT INTO client_credits_new (id, client_id, date, amount_cents, payment_id, refund_id, application_id, source)
  SELECT id, client_id, date, amount_cents, payment_id, refund_id, NULL, source FROM client_credits;

-- The old tables go child first, so no foreign key is ever left pointing at a missing row.
DROP TABLE client_credits;
DROP TABLE refunds;
ALTER TABLE refunds_new RENAME TO refunds;
ALTER TABLE client_credits_new RENAME TO client_credits;
CREATE INDEX client_credits_client ON client_credits(client_id);

CREATE TRIGGER client_credits_never_negative AFTER INSERT ON client_credits
WHEN (SELECT SUM(amount_cents) FROM client_credits WHERE client_id = NEW.client_id) < 0
BEGIN SELECT RAISE(ABORT, 'a client credit balance never goes below zero'); END;

CREATE TRIGGER refunds_no_update BEFORE UPDATE ON refunds
BEGIN SELECT RAISE(ABORT, 'refunds are posted and never change'); END;
CREATE TRIGGER refunds_no_delete BEFORE DELETE ON refunds
BEGIN SELECT RAISE(ABORT, 'refunds are posted and never change'); END;
CREATE TRIGGER credit_applications_no_update BEFORE UPDATE ON credit_applications
BEGIN SELECT RAISE(ABORT, 'applied credits are posted and never change'); END;
CREATE TRIGGER credit_applications_no_delete BEFORE DELETE ON credit_applications
BEGIN SELECT RAISE(ABORT, 'applied credits are posted and never change'); END;
CREATE TRIGGER client_credits_no_update BEFORE UPDATE ON client_credits
BEGIN SELECT RAISE(ABORT, 'client credits are posted and never change'); END;
CREATE TRIGGER client_credits_no_delete BEFORE DELETE ON client_credits
BEGIN SELECT RAISE(ABORT, 'client credits are posted and never change'); END;
