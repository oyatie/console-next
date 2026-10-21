-- Expand: an unplaced registration has no legacy company label yet.
-- Keep the string projection compatible; supplied whitespace is still invalid.
ALTER TABLE employees
    DROP CONSTRAINT employees_company_check,
    ADD CONSTRAINT employees_company_check CHECK (company = '' OR btrim(company) <> '');
