-- 008: bank statement lines. solobooks reads the bank's own CSV with the column map the agent declares, keeps a copy
-- of the file, and records every line with the file and row it came from. A line is a fact from the bank, so it never
-- changes. Each line is matched to at most one posted entry, and each entry to at most one line per account.

CREATE TABLE bank_imports (
  id          INTEGER PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id),
  -- The file as the agent named it, and the copy kept in the books folder under statements/, named by its sha256.
  file_name   TEXT    NOT NULL,
  file_sha256 TEXT    NOT NULL,
  stored_file TEXT    NOT NULL,
  -- Data rows read from the file, and how many of them were new rather than already in the books.
  row_count   INTEGER NOT NULL CHECK (typeof(row_count) = 'integer' AND row_count >= 0),
  new_lines   INTEGER NOT NULL CHECK (typeof(new_lines) = 'integer' AND new_lines >= 0 AND new_lines <= row_count),
  imported_at TEXT    NOT NULL,
  source      TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);

CREATE TABLE bank_lines (
  id           INTEGER PRIMARY KEY,
  import_id    INTEGER NOT NULL REFERENCES bank_imports(id),
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  -- The row of the file it came from, counting the header row: what a spreadsheet would show.
  file_row     INTEGER NOT NULL CHECK (typeof(file_row) = 'integer' AND file_row >= 1),
  date         TEXT    NOT NULL,
  description  TEXT    NOT NULL,
  -- Positive when money went into the account, negative when it left.
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents <> 0),
  currency     TEXT    NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  source       TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);
CREATE INDEX bank_lines_key ON bank_lines(account_id, date, amount_cents);

-- exact: solobooks found the one entry with the same account, day and amount on import. agent: the agent proposed
-- it, with the same amount on another day. payment: a payment recorded against this line.
CREATE TABLE bank_matches (
  id         INTEGER PRIMARY KEY,
  line_id    INTEGER NOT NULL UNIQUE REFERENCES bank_lines(id),
  entry_id   INTEGER NOT NULL REFERENCES entries(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  kind       TEXT    NOT NULL CHECK (kind IN ('exact', 'agent', 'payment')),
  matched_at TEXT    NOT NULL,
  source     TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  UNIQUE (entry_id, account_id)
);

CREATE TRIGGER bank_imports_no_update BEFORE UPDATE ON bank_imports
BEGIN SELECT RAISE(ABORT, 'bank imports are kept as they happened'); END;
CREATE TRIGGER bank_imports_no_delete BEFORE DELETE ON bank_imports
BEGIN SELECT RAISE(ABORT, 'bank imports are kept as they happened'); END;
CREATE TRIGGER bank_lines_no_update BEFORE UPDATE ON bank_lines
BEGIN SELECT RAISE(ABORT, 'bank lines are facts from the bank and never change'); END;
CREATE TRIGGER bank_lines_no_delete BEFORE DELETE ON bank_lines
BEGIN SELECT RAISE(ABORT, 'bank lines are facts from the bank and never change'); END;
CREATE TRIGGER bank_matches_no_update BEFORE UPDATE ON bank_matches
BEGIN SELECT RAISE(ABORT, 'bank matches are kept as they were made'); END;
CREATE TRIGGER bank_matches_no_delete BEFORE DELETE ON bank_matches
BEGIN SELECT RAISE(ABORT, 'bank matches are kept as they were made'); END;
