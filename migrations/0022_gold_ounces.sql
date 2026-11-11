-- Gold bought for Jin&Jaw Arabia. A purchase is an expense (cash out) that
-- also adds whole ounces to the company's gold holding. The holding is the
-- sum of gold_ounces over expenses that are not voided, so voiding the
-- expense takes the gold back out. Staff requests carry the ounces until an
-- admin approves them.
ALTER TABLE expenses ADD COLUMN gold_ounces INTEGER CHECK (gold_ounces IS NULL OR gold_ounces > 0);
ALTER TABLE submissions ADD COLUMN gold_ounces INTEGER CHECK (gold_ounces IS NULL OR gold_ounces > 0);
