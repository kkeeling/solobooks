-- 006: owner money. The person's own money moving is never income or expense: a transfer between their own
-- accounts nets to zero, and a draw or contribution moves equity. Each is a posted entry plus one row saying which
-- kind of owner money it was, and neither ever changes.

CREATE TABLE owner_moves (
  id           INTEGER PRIMARY KEY,
  kind         TEXT    NOT NULL CHECK (kind IN ('transfer', 'draw', 'contribution')),
  date         TEXT    NOT NULL,
  -- What moved: for a transfer, the total going into the accounts that received it.
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  memo         TEXT,
  entry_id     INTEGER NOT NULL UNIQUE REFERENCES entries(id),
  -- A business cost the person paid with their own money: the expense this contribution paid for.
  expense_id   INTEGER REFERENCES expenses(id),
  source       TEXT    NOT NULL CHECK (length(trim(source)) > 0),
  CHECK (expense_id IS NULL OR kind = 'contribution')
);
CREATE TRIGGER owner_moves_no_update BEFORE UPDATE ON owner_moves
BEGIN SELECT RAISE(ABORT, 'owner money is posted and never changes; post a reversing entry instead'); END;
CREATE TRIGGER owner_moves_no_delete BEFORE DELETE ON owner_moves
BEGIN SELECT RAISE(ABORT, 'owner money is posted and never changes; post a reversing entry instead'); END;
