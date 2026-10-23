-- 012: sales tax paid to the state, Schedule C lines on accounts, and the year-end records an accountant asks for:
-- the mileage log, home office figures, owner items (estimated tax, health insurance, retirement) and contractors.
-- solobooks stores what the person tells it. It never decides what is taxable or deductible, and computes no tax.

-- The Schedule C line an income or expense account reports on, as the person or their agent set it. NULL means not
-- set: solobooks' own accounts then use their standard line, and any other account is listed as needing one.
ALTER TABLE accounts ADD COLUMN schedule_c TEXT CHECK (schedule_c IS NULL OR schedule_c IN (
  '1', '2', '6', '8', '9', '10', '11', '13', '15', '16a', '16b', '17', '18', '20a', '20b', '21', '22', '23', '24a', '24b', '25', '27b', '30'
));

-- Sales tax paid to a state: the return's period, the tax label it pays, and the posted entry that moved the money.
CREATE TABLE sales_tax_payments (
  id           INTEGER PRIMARY KEY,
  date         TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  tax_label    TEXT    NOT NULL CHECK (length(trim(tax_label)) > 0),
  period_start TEXT    NOT NULL,
  period_end   TEXT    NOT NULL,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  entry_id     INTEGER NOT NULL UNIQUE REFERENCES entries(id),
  confirmation TEXT,
  memo         TEXT,
  source       TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  CHECK (period_start <= period_end)
);
CREATE TRIGGER sales_tax_payments_no_update BEFORE UPDATE ON sales_tax_payments
BEGIN SELECT RAISE(ABORT, 'sales tax payments are posted and never change'); END;
CREATE TRIGGER sales_tax_payments_no_delete BEFORE DELETE ON sales_tax_payments
BEGIN SELECT RAISE(ABORT, 'sales tax payments are posted and never change'); END;

-- The mileage log. A trip's rate is never stored: it is looked up from the IRS rate table by the trip's date.
CREATE TABLE mileage_trips (
  id           INTEGER PRIMARY KEY,
  date         TEXT    NOT NULL,
  -- Tenths of a mile, so 12.5 miles is 125.
  miles_tenths INTEGER NOT NULL CHECK (typeof(miles_tenths) = 'integer' AND miles_tenths > 0),
  destination  TEXT    NOT NULL CHECK (length(trim(destination)) > 0),
  purpose      TEXT    NOT NULL CHECK (length(trim(purpose)) > 0),
  client_id    INTEGER REFERENCES clients(id),
  source       TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);

-- Home office figures for a year, as the person gives them, and the home expenses that go with them.
CREATE TABLE home_offices (
  year               INTEGER PRIMARY KEY CHECK (typeof(year) = 'integer'),
  office_square_feet INTEGER NOT NULL CHECK (typeof(office_square_feet) = 'integer' AND office_square_feet > 0),
  home_square_feet   INTEGER NOT NULL CHECK (typeof(home_square_feet) = 'integer' AND home_square_feet >= office_square_feet),
  note               TEXT,
  source             TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);
CREATE TABLE home_office_expenses (
  id           INTEGER PRIMARY KEY,
  year         INTEGER NOT NULL REFERENCES home_offices(year),
  description  TEXT    NOT NULL CHECK (length(trim(description)) > 0),
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  source       TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);

-- Owner items: money the person spent on themselves that their accountant totals apart from the business. Paid from
-- a business account it is also an owner draw (entry and owner_moves row); paid personally it is only this record.
CREATE TABLE owner_items (
  id              INTEGER PRIMARY KEY,
  kind            TEXT    NOT NULL CHECK (kind IN ('estimated_tax', 'health_insurance', 'retirement')),
  date            TEXT    NOT NULL,
  amount_cents    INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  paid_personally INTEGER NOT NULL CHECK (paid_personally IN (0, 1)),
  account_id      INTEGER REFERENCES accounts(id),
  entry_id        INTEGER UNIQUE REFERENCES entries(id),
  owner_move_id   INTEGER UNIQUE REFERENCES owner_moves(id),
  -- For an estimated tax payment: who it was paid to, such as federal or a state.
  jurisdiction    TEXT,
  confirmation    TEXT,
  memo            TEXT,
  source          TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  CHECK ((paid_personally = 1) = (entry_id IS NULL) AND (entry_id IS NULL) = (account_id IS NULL) AND (entry_id IS NULL) = (owner_move_id IS NULL)),
  CHECK ((kind = 'estimated_tax') = (jurisdiction IS NOT NULL))
);
CREATE TRIGGER owner_items_no_update BEFORE UPDATE ON owner_items
BEGIN SELECT RAISE(ABORT, 'owner items are recorded as they happened and never change'); END;
CREATE TRIGGER owner_items_no_delete BEFORE DELETE ON owner_items
BEGIN SELECT RAISE(ABORT, 'owner items are recorded as they happened and never change'); END;

-- People the business paid for work, with whether their W-9 is on file. A payment to one is an expense naming them.
CREATE TABLE contractors (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  w9_status      TEXT NOT NULL CHECK (w9_status IN ('on_file', 'not_on_file')),
  w9_received_on TEXT,
  source         TEXT NOT NULL CHECK (length(trim(source)) > 0),
  CHECK (w9_received_on IS NULL OR w9_status = 'on_file')
);

ALTER TABLE expenses ADD COLUMN contractor_id INTEGER REFERENCES contractors(id);
-- How an expense was paid. Card and PayPal payments to a contractor are reported on Form 1099-K, not 1099-NEC.
ALTER TABLE expenses ADD COLUMN payment_method TEXT CHECK (payment_method IS NULL OR payment_method IN (
  'ach', 'wire', 'check', 'cash', 'zelle', 'card', 'paypal', 'other'
));
