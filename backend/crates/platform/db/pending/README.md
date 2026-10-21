# Pending contract migrations

Expand/contract (ADR-0004 §Schema): blue and green share one schema during a
rollout and after a rollback, so a release only expands. The contract half of a
change waits here, outside `migrations/`, headed `-- contract-of: <expand version>`.

To ship one: in a release whose *previous* release already contains the expand
and the code that no longer needs the old shape, move the file into
`migrations/` under a new version (keep the header; the release lint accepts it)
and delete it here.

| File | Contracts | Ships when |
|---|---|---|
| `0356_group_transfer_one_act.contract-1.sql` | re-backfill rows the pre-0356 release wrote; `NOT NULL` checks added `NOT VALID` | the release after 0356's; drop the NULL fallback in `hr/adapter-postgres/src/lifecycle/rows.rs` with it |
| `0356_group_transfer_one_act.contract-2.sql` | `VALIDATE`, `SET NOT NULL` on the 연차/근속 pair, helper checks dropped | the migration right after contract-1 (a separate transaction) |
| `20261013142447372_attendance_closed_month_unlock.contract.sql` | drops `trg_attendance_entries_closed_month` + `attendance_entries_closed_month()`, and the 0188 lock-side trigger `trg_period_lock_attendance_close_consistent` | the release after 20261013142447372's; remove the `app.period_unlock` marker in `platform/db/src/period_lock/unlock.rs` with it |
