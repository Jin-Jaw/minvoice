-- Written payment instructions belong to the issuing branch. Keeping them on
-- the branch prevents a shared client from receiving the other company's bank
-- details, while still prefilling every new invoice.
ALTER TABLE branches ADD COLUMN default_payment_details TEXT NOT NULL DEFAULT '';
