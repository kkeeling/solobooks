-- 001: ledger, history, clients, engagements and time.
-- Every table carries a non-empty source. Money is whole cents, USD only.

CREATE TABLE history (
  id              INTEGER PRIMARY KEY,
  at              TEXT    NOT NULL,
  op              TEXT    NOT NULL,
  source          TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  idempotency_key TEXT    UNIQUE,
  payload_hash    TEXT    NOT NULL,
  payload         TEXT    NOT NULL,
  result          TEXT    NOT NULL
);
CREATE TRIGGER history_no_update BEFORE UPDATE ON history
BEGIN SELECT RAISE(ABORT, 'history rows are append-only'); END;
CREATE TRIGGER history_no_delete BEFORE DELETE ON history
BEGIN SELECT RAISE(ABORT, 'history rows are append-only'); END;

CREATE TABLE accounts (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  type   TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  source TEXT NOT NULL CHECK (length(trim(source)) > 0)
);

-- Journal entries are posted when written and never change afterwards.
CREATE TABLE entries (
  id     INTEGER PRIMARY KEY,
  date   TEXT NOT NULL,
  memo   TEXT NOT NULL,
  source TEXT NOT NULL CHECK (length(trim(source)) > 0)
);
CREATE TABLE lines (
  id           INTEGER PRIMARY KEY,
  entry_id     INTEGER NOT NULL REFERENCES entries(id),
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  debit_cents  INTEGER NOT NULL DEFAULT 0 CHECK (typeof(debit_cents) = 'integer' AND debit_cents >= 0),
  credit_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(credit_cents) = 'integer' AND credit_cents >= 0),
  currency     TEXT    NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  source       TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  CHECK ((debit_cents > 0) + (credit_cents > 0) = 1)
);
CREATE INDEX lines_entry ON lines(entry_id);
CREATE INDEX lines_account ON lines(account_id);

CREATE TRIGGER entries_no_update BEFORE UPDATE ON entries
BEGIN SELECT RAISE(ABORT, 'posted entries are immutable; post a reversing entry instead'); END;
CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries
BEGIN SELECT RAISE(ABORT, 'posted entries are immutable; post a reversing entry instead'); END;
CREATE TRIGGER lines_no_update BEFORE UPDATE ON lines
BEGIN SELECT RAISE(ABORT, 'posted entries are immutable; post a reversing entry instead'); END;
CREATE TRIGGER lines_no_delete BEFORE DELETE ON lines
BEGIN SELECT RAISE(ABORT, 'posted entries are immutable; post a reversing entry instead'); END;

CREATE TABLE clients (
  id                INTEGER PRIMARY KEY,
  name              TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  increment_minutes INTEGER NOT NULL DEFAULT 1 CHECK (typeof(increment_minutes) = 'integer' AND increment_minutes >= 1),
  minimum_minutes   INTEGER NOT NULL DEFAULT 0 CHECK (typeof(minimum_minutes) = 'integer' AND minimum_minutes >= 0),
  source            TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);

-- An engagement's terms are data: any mix of an hourly rate, milestones and a recurring fee.
CREATE TABLE engagements (
  id                     INTEGER PRIMARY KEY,
  client_id              INTEGER NOT NULL REFERENCES clients(id),
  name                   TEXT    NOT NULL,
  rate_cents_per_hour    INTEGER CHECK (rate_cents_per_hour IS NULL OR (typeof(rate_cents_per_hour) = 'integer' AND rate_cents_per_hour > 0)),
  recurring_amount_cents INTEGER CHECK (recurring_amount_cents IS NULL OR (typeof(recurring_amount_cents) = 'integer' AND recurring_amount_cents > 0)),
  recurring_interval     TEXT    CHECK (recurring_interval IS NULL OR recurring_interval IN ('monthly', 'quarterly', 'yearly')),
  currency               TEXT    NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  source                 TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  CHECK ((recurring_amount_cents IS NULL) = (recurring_interval IS NULL)),
  UNIQUE (client_id, name)
);
CREATE TABLE milestones (
  id            INTEGER PRIMARY KEY,
  engagement_id INTEGER NOT NULL REFERENCES engagements(id),
  name          TEXT    NOT NULL,
  amount_cents  INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  currency      TEXT    NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  source        TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);

CREATE TABLE time_entries (
  id            INTEGER PRIMARY KEY,
  client_id     INTEGER NOT NULL REFERENCES clients(id),
  engagement_id INTEGER REFERENCES engagements(id),
  date          TEXT    NOT NULL,
  minutes       INTEGER NOT NULL CHECK (typeof(minutes) = 'integer' AND minutes > 0),
  note          TEXT    NOT NULL CHECK (length(trim(note)) > 0),
  source        TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);
