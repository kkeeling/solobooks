-- 015: client credit applied to an invoice can be taken back, and a recurring fee can begin before its first draft.
-- SQLite can't change a CHECK, so client_credits is rebuilt keeping every row, id and rule it had.

DROP TRIGGER client_credits_never_negative;
DROP TRIGGER client_credits_no_update;
DROP TRIGGER client_credits_no_delete;

-- Taking one credit application back. The application itself never changes: this row says it no longer settles its
-- invoice, from this date, and each application can only have one.
CREATE TABLE credit_unapplications (
  id             INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL UNIQUE REFERENCES credit_applications(id),
  date           TEXT    NOT NULL,
  entry_id       INTEGER NOT NULL UNIQUE REFERENCES entries(id),
  source         TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);

-- Money held for a client: an overpayment adds to it; a refund of that payment, or applying it to an invoice, takes
-- it back out; taking an application back adds it again, as a positive row naming that application.
CREATE TABLE client_credits_new (
  id             INTEGER PRIMARY KEY,
  client_id      INTEGER NOT NULL REFERENCES clients(id),
  date           TEXT    NOT NULL,
  amount_cents   INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents <> 0),
  payment_id     INTEGER REFERENCES payments(id),
  refund_id      INTEGER REFERENCES refunds(id),
  application_id INTEGER REFERENCES credit_applications(id),
  source         TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  CHECK (
    (amount_cents > 0 AND payment_id IS NOT NULL AND refund_id IS NULL AND application_id IS NULL)
    OR (amount_cents < 0 AND payment_id IS NOT NULL AND refund_id IS NOT NULL AND application_id IS NULL)
    OR (amount_cents < 0 AND payment_id IS NULL AND refund_id IS NULL AND application_id IS NOT NULL)
    OR (amount_cents > 0 AND payment_id IS NULL AND refund_id IS NULL AND application_id IS NOT NULL)
  )
);
INSERT INTO client_credits_new (id, client_id, date, amount_cents, payment_id, refund_id, application_id, source)
  SELECT id, client_id, date, amount_cents, payment_id, refund_id, application_id, source FROM client_credits;

DROP TABLE client_credits;
ALTER TABLE client_credits_new RENAME TO client_credits;
CREATE INDEX client_credits_client ON client_credits(client_id);

CREATE TRIGGER client_credits_never_negative AFTER INSERT ON client_credits
WHEN (SELECT SUM(amount_cents) FROM client_credits WHERE client_id = NEW.client_id) < 0
BEGIN SELECT RAISE(ABORT, 'a client credit balance never goes below zero'); END;

CREATE TRIGGER client_credits_no_update BEFORE UPDATE ON client_credits
BEGIN SELECT RAISE(ABORT, 'client credits are posted and never change'); END;
CREATE TRIGGER client_credits_no_delete BEFORE DELETE ON client_credits
BEGIN SELECT RAISE(ABORT, 'client credits are posted and never change'); END;
CREATE TRIGGER credit_unapplications_no_update BEFORE UPDATE ON credit_unapplications
BEGIN SELECT RAISE(ABORT, 'credit taken back is posted and never changes'); END;
CREATE TRIGGER credit_unapplications_no_delete BEFORE DELETE ON credit_unapplications
BEGIN SELECT RAISE(ABORT, 'credit taken back is posted and never changes'); END;

-- The day a recurring fee began, when it began before its first draft. Null is an engagement that doesn't say: its
-- cycles are owed from the first one billed, as they always were.
ALTER TABLE engagements ADD COLUMN start_date TEXT CHECK (start_date IS NULL OR recurring_amount_cents IS NOT NULL);
