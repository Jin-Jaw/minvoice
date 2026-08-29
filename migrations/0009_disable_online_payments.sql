-- This deployment uses written payment instructions only. Keep historical
-- payment records and credentials intact, but permanently disable checkout.
UPDATE settings SET stripe_enabled = 0, paypal_enabled = 0 WHERE id = 1;
