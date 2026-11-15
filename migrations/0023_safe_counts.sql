-- Money Jin&Jaw Arabia holds right now, in the safe and the bank. A count is
-- the amount someone counted in one currency on one date. The amount held
-- today is the newest count for that currency, plus money received and minus
-- money spent after the count. Older counts stay as history. Gold is not
-- counted here: it is the sum of gold ounces bought and received.
CREATE TABLE safe_counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  counted_on TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_safe_counts_branch
  ON safe_counts(branch_id, currency, counted_on DESC, id DESC);
