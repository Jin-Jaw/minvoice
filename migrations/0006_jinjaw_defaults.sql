-- Jin&Jaw-specific first-launch defaults. Keep setup_complete at 0 so the
-- registered address, tax position, rates, and payment terms are confirmed by
-- an authorised person before the first invoice is issued.
UPDATE settings
SET business_name = 'Jin&Jaw LTD',
    business_email = 'contact@jin-jaw.co.uk',
    logo_url = 'https://jin-jaw.co.uk/assets/jinjaw-square.png',
    currency = 'GBP',
    timezone = 'Europe/London',
    accent_color = '#ef4958',
    stripe_enabled = 0,
    paypal_enabled = 0
WHERE id = 1 AND setup_complete = 0;
