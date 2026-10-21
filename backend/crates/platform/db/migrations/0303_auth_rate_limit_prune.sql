-- PROD-RESILIENCE PR-06 (R5): the worker prunes auth_rate_limit windows that
-- ended more than an hour ago (nothing ever reads them again; the table was
-- never pruned). console_rt already UPDATEs any row of this global counter
-- table, so DELETE gives it no new power over it. Numbered after BE-26's
-- 0295 on the b9v3 stack; INTEG renumbers at the merge.
SET LOCAL lock_timeout = '2s';

GRANT DELETE ON auth_rate_limit TO console_rt;
