-- 004: the approval gate. The person sets how much the agent may do alone for each gated action; a gated request
-- at click or passkey level waits here, exactly as asked, until the person approves or rejects it.

-- One row per gated action the person has changed. No row means the default, click.
CREATE TABLE gate_levels (
  action TEXT PRIMARY KEY CHECK (action IN ('invoice_issue', 'invoice_void', 'invoice_credit', 'payment_instructions')),
  level  TEXT NOT NULL CHECK (level IN ('agent_decides', 'click', 'passkey')),
  source TEXT NOT NULL CHECK (length(trim(source)) > 0)
);

-- A request waiting for the person. What runs on approval is the stored op and input, never new input.
CREATE TABLE pending_actions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('invoice_issue', 'invoice_void', 'invoice_credit', 'payment_instructions', 'gate_settings')),
  op              TEXT NOT NULL,
  input           TEXT NOT NULL,
  level           TEXT NOT NULL CHECK (level IN ('click', 'passkey')),
  -- What the person is asked to approve: the sentence, and each invoice or change it covers.
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

-- A pending action is decided once, and what was asked never changes.
CREATE TRIGGER pending_actions_locked BEFORE UPDATE ON pending_actions
WHEN OLD.status <> 'pending' OR NEW.status = 'pending'
  OR NEW.created_at IS NOT OLD.created_at OR NEW.action IS NOT OLD.action OR NEW.op IS NOT OLD.op
  OR NEW.input IS NOT OLD.input OR NEW.level IS NOT OLD.level OR NEW.prompt IS NOT OLD.prompt
  OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.source IS NOT OLD.source
BEGIN SELECT RAISE(ABORT, 'a pending action is decided once and never changes afterwards'); END;
CREATE TRIGGER pending_actions_no_delete BEFORE DELETE ON pending_actions
BEGIN SELECT RAISE(ABORT, 'pending actions are kept; reject one instead'); END;

-- The passkey the person registered on the local approval page. Its public key checks passkey-level approvals.
CREATE TABLE passkeys (
  id            INTEGER PRIMARY KEY,
  credential_id TEXT    NOT NULL UNIQUE,
  public_key    BLOB    NOT NULL,
  counter       INTEGER NOT NULL CHECK (typeof(counter) = 'integer' AND counter >= 0),
  transports    TEXT,
  aaguid        TEXT,
  created_at    TEXT    NOT NULL,
  source        TEXT    NOT NULL CHECK (length(trim(source)) > 0)
);
CREATE TRIGGER passkeys_counter_only BEFORE UPDATE ON passkeys
WHEN NEW.credential_id IS NOT OLD.credential_id OR NEW.public_key IS NOT OLD.public_key OR NEW.created_at IS NOT OLD.created_at
  OR NEW.source IS NOT OLD.source OR NEW.counter < OLD.counter
BEGIN SELECT RAISE(ABORT, 'a passkey only ever moves its counter forward'); END;
CREATE TRIGGER passkeys_no_delete BEFORE DELETE ON passkeys
BEGIN SELECT RAISE(ABORT, 'passkeys are kept'); END;
