//! The named waivers for statements the parser cannot read (moved out of the
//! pinned lib.rs so the list can grow without growing a pinned file).

use crate::UnsupportedWaiver;

/// Every statement in the existing corpus that the inverted parser cannot read.
///
/// Inverting the dispatch turned 210 migrations into 27 findings; teaching the
/// body scan the same column-neutral `ALTER TABLE` actions the parser already
/// knows (`COLUMN_NEUTRAL_ALTER_ACTIONS`) took that to one. This is the one.
///
/// SHRINK-ONLY, and mechanically: a waiver whose migration is present but whose
/// finding is gone is itself a violation (`WaiverMatchesNothing`), so an entry
/// cannot outlive the statement it excuses. Growing the list is a Rust edit in
/// the same commit as the migration, which is the review surface a data file
/// does not give.
pub const UNSUPPORTED_WAIVERS: &[UnsupportedWaiver] = &[
    UnsupportedWaiver {
        migration: "0005_create_compliance_location_store.sql",
        construct: "a dollar-quoted body builds `create table`",
        reason: "location_pings_ensure_partition() runs EXECUTE format('CREATE TABLE IF NOT EXISTS \
             %I PARTITION OF location_pings …') with a name computed per day, so no parse can \
             name the relation. A partition declares no columns of its own; it takes \
             location_pings', and location_pings is in the parsed schema and checked like any \
             other table. NOT covered: the partition relations themselves carry no markers, \
             because COMMENT ON COLUMN is per-relation.",
    },
    UnsupportedWaiver {
        migration: "0313_employment_periods.sql",
        construct: "a dollar-quoted body builds `create temp table`",
        reason: "employment_backfill() stages its work in two session temp tables (ON COMMIT DROP): \
             employment_backfill_plan_rows is `SELECT * FROM employment_backfill_plan(p_org) \
             WITH NO DATA`, the plan function's own projection of employment_heads and the \
             lifecycle events (ids, dates, finding kind/detail), and employment_backfill_current \
             holds (employee_id, employment_id) pairs. Neither outlives the transaction nor \
             holds a value the classified source tables do not already hold. NOT covered: the \
             temp relations carry no markers (they are not in any persisted schema).",
    },
];
