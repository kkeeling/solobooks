-- 011: a wrong bank match can be undone by recording an unmatch beside it, never by deleting it. SQLite can't drop a
-- UNIQUE, so bank_matches is rebuilt keeping every row, id and rule it had.

DROP TRIGGER bank_matches_no_update;
DROP TRIGGER bank_matches_no_delete;

-- bank_matches loses its one-row-per-line and one-row-per-entry rules: those now hold for live matches only, the ones
-- with no unmatch recorded, so a line whose wrong match was undone can be matched again with both rows kept.
CREATE TABLE bank_matches_new (
  id         INTEGER PRIMARY KEY,
  line_id    INTEGER NOT NULL REFERENCES bank_lines(id),
  entry_id   INTEGER NOT NULL REFERENCES entries(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  kind       TEXT    NOT NULL CHECK (kind IN ('exact', 'agent', 'payment')),
  matched_at TEXT    NOT NULL,
  source     TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);
INSERT INTO bank_matches_new (id, line_id, entry_id, account_id, kind, matched_at, source)
  SELECT id, line_id, entry_id, account_id, kind, matched_at, source FROM bank_matches;
DROP TABLE bank_matches;
ALTER TABLE bank_matches_new RENAME TO bank_matches;
CREATE INDEX bank_matches_line ON bank_matches(line_id);
CREATE INDEX bank_matches_entry ON bank_matches(entry_id, account_id);

-- An undone match: the match row stays, and this records who undid it, when and why. Each match is undone at most once.
CREATE TABLE bank_unmatches (
  id           INTEGER PRIMARY KEY,
  match_id     INTEGER NOT NULL UNIQUE REFERENCES bank_matches(id),
  reason       TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  unmatched_at TEXT    NOT NULL,
  source       TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);

-- The matches that stand: every match not undone.
CREATE VIEW live_bank_matches AS
  SELECT m.* FROM bank_matches m WHERE NOT EXISTS (SELECT 1 FROM bank_unmatches u WHERE u.match_id = m.id);

CREATE TRIGGER bank_matches_one_live BEFORE INSERT ON bank_matches
WHEN EXISTS (
  SELECT 1 FROM bank_matches m
  WHERE (m.line_id = NEW.line_id OR (m.entry_id = NEW.entry_id AND m.account_id = NEW.account_id))
    AND NOT EXISTS (SELECT 1 FROM bank_unmatches u WHERE u.match_id = m.id)
)
BEGIN SELECT RAISE(ABORT, 'a bank line and an entry each have at most one match standing; undo it first'); END;

CREATE TRIGGER bank_matches_no_update BEFORE UPDATE ON bank_matches
BEGIN SELECT RAISE(ABORT, 'bank matches are kept as they were made; undo one with bank unmatch'); END;
CREATE TRIGGER bank_matches_no_delete BEFORE DELETE ON bank_matches
BEGIN SELECT RAISE(ABORT, 'bank matches are kept as they were made; undo one with bank unmatch'); END;
CREATE TRIGGER bank_unmatches_no_update BEFORE UPDATE ON bank_unmatches
BEGIN SELECT RAISE(ABORT, 'bank unmatches are kept as they were made'); END;
CREATE TRIGGER bank_unmatches_no_delete BEFORE DELETE ON bank_unmatches
BEGIN SELECT RAISE(ABORT, 'bank unmatches are kept as they were made'); END;
