-- 013: the default chart of accounts is Schedule C's. Every books file gets one expense account per Schedule C expense
-- line, and the income accounts for the lines a consultant uses, each tagged with its line, so an expense is put on a
-- line by choosing its account rather than by inventing one. Books that already have an account of the same name keep
-- it; it only gets the line, if it is of the right type and has none yet.

CREATE TEMP TABLE chart (name TEXT, type TEXT, line TEXT);
INSERT INTO chart (name, type, line) VALUES
  ('Consulting income', 'income', '1'),
  ('Reimbursed expense income', 'income', '1'),
  ('Other income', 'income', '6'),
  ('Advertising', 'expense', '8'),
  ('Car and truck expenses', 'expense', '9'),
  ('Commissions and fees', 'expense', '10'),
  ('Contract labor', 'expense', '11'),
  ('Depreciation and section 179 expense', 'expense', '13'),
  ('Insurance (other than health)', 'expense', '15'),
  ('Interest: mortgage', 'expense', '16a'),
  ('Interest: other', 'expense', '16b'),
  ('Legal and professional services', 'expense', '17'),
  ('Office expense', 'expense', '18'),
  ('Rent or lease: vehicles, machinery, and equipment', 'expense', '20a'),
  ('Rent or lease: other business property', 'expense', '20b'),
  ('Repairs and maintenance', 'expense', '21'),
  ('Supplies', 'expense', '22'),
  ('Taxes and licenses', 'expense', '23'),
  ('Travel', 'expense', '24a'),
  ('Deductible meals', 'expense', '24b'),
  ('Utilities', 'expense', '25'),
  ('Other expenses', 'expense', '27b'),
  ('Expenses for business use of your home', 'expense', '30');

UPDATE accounts SET schedule_c = (SELECT c.line FROM chart c WHERE c.name = accounts.name COLLATE NOCASE AND c.type = accounts.type)
WHERE schedule_c IS NULL AND EXISTS (SELECT 1 FROM chart c WHERE c.name = accounts.name COLLATE NOCASE AND c.type = accounts.type);

INSERT INTO accounts (name, type, schedule_c, source)
SELECT c.name, c.type, c.line, 'solobooks:chart' FROM chart c
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.name = c.name COLLATE NOCASE)
ORDER BY c.rowid;

DROP TABLE chart;
