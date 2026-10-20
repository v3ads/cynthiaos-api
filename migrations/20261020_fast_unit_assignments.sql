-- Additive, rerunnable. No unit assignments are seeded.
CREATE TABLE IF NOT EXISTS fast_unit_assignments (
 category text NOT NULL CHECK (category IN ('basic','upgraded','premium')),
 furnishing text NOT NULL CHECK (furnishing IN ('furnished','unfurnished')),
 unit_numbers text NOT NULL DEFAULT '',
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by text,
 PRIMARY KEY(category, furnishing),
 CHECK (length(unit_numbers) <= 1000)
);
ALTER TABLE fast_unit_assignments ENABLE ROW LEVEL SECURITY;
