-- Expand: a name + hire date can precede employment classification.
-- Existing enum, phone and pay CHECKs still validate every recorded value.
ALTER TABLE employee_employment_profiles
    ALTER COLUMN employment_type DROP NOT NULL;
