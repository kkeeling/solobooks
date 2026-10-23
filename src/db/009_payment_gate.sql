-- 009: recording an invoice payment with no imported bank line behind it becomes a gated action, payment_unmatched,
-- because a receipt or CSV the agent reads could tell it to mark everything paid. SQLite can't change a CHECK, so the
-- gate's two tables are rebuilt with the new action allowed, keeping every row, id and rule they had.

DROP TRIGGER pending_actions_locked;
DROP TRIGGER pending_actions_no_delete;

CREATE TABLE gate_levels_new (
  action TEXT PRIMARY KEY CHECK (action IN ('invoice_issue', 'invoice_void', 'invoice_credit', 'payment_instructions', 'payment_unmatched')),
  level  TEXT NOT NULL CHECK (level IN ('agent_decides', 'click', 'passkey')),
  source TEXT NOT NULL CHECK (length(trim(source)) > 0)
);
INSERT INTO gate_levels_new (action, level, source) SELECT action, level, source FROM gate_levels;
DROP TABLE gate_levels;
ALTER TABLE gate_levels_new RENAME TO gate_levels;

CREATE TABLE pending_actions_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('invoice_issue', 'invoice_void', 'invoice_credit', 'payment_instructions', 'payment_unmatched', 'gate_settings')),
  op              TEXT NOT NULL,
  input           TEXT NOT NULL,
  level           TEXT NOT NULL CHECK (level IN ('click', 'passkey')),
  prompt          TEXT NOT NULL,
  idempotency_key TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_at      TEXT,
  decided_via     TEXT CHECK (decided_via IS NULL OR decided_via IN ('page', 'elicitation')),
  excluded        TEXT,
  result          TEXT,
  source          TEXT NOT NULL CHECK (length(trim(source)) > 0),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
INSERT INTO pending_actions_new (id, created_at, action, op, input, level, prompt, idempotency_key, status, decided_at, decided_via, excluded, result, source)
  SELECT id, created_at, action, op, input, level, prompt, idempotency_key, status, decided_at, decided_via, excluded, result, source FROM pending_actions;
DROP TABLE pending_actions;
ALTER TABLE pending_actions_new RENAME TO pending_actions;

CREATE TRIGGER pending_actions_locked BEFORE UPDATE ON pending_actions
WHEN OLD.status <> 'pending' OR NEW.status = 'pending'
  OR NEW.created_at IS NOT OLD.created_at OR NEW.action IS NOT OLD.action OR NEW.op IS NOT OLD.op
  OR NEW.input IS NOT OLD.input OR NEW.level IS NOT OLD.level OR NEW.prompt IS NOT OLD.prompt
  OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.source IS NOT OLD.source
BEGIN SELECT RAISE(ABORT, 'a pending action is decided once and never changes afterwards'); END;
CREATE TRIGGER pending_actions_no_delete BEFORE DELETE ON pending_actions
BEGIN SELECT RAISE(ABORT, 'pending actions are kept; reject one instead'); END;
