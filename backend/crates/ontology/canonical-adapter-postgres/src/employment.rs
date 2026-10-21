//! `EmploymentPort` — the Postgres implementation of `ObjectKey::Employment`,
//! and the home of every `employees` statement that used to live outside the
//! owning crate. Org-change `ReassignOrgUnit` is PORT-ROUTED: `apply_op` calls
//! [`reassign_org_unit_via_transfers_in_tx`], which emits one `hr.transfer`
//! per matched ACTIVE employee inside the apply transaction (no raw bulk
//! rewrite as authority; EXITED heads are excluded; unknown from/to OrgUnits
//! fail closed).
//!
//! Owned tables, verbatim from the contract
//! (`backend/crates/ontology/canonical-domain/src/lib.rs`): `employees`,
//! `employment_heads`, `employment_revisions`, `employment_source_bindings`.
//! `employees` is the LEGACY COMPATIBILITY HEAD — 0063 created it, the rest of
//! the tree still reads it, and `employment_source_bindings` is the surface
//! that resolves a canonical employment back to it.
//!
//! # Why the two legacy-head writes are public
//!
//! Before this module, `console-app` held three `employees` statements in
//! `backend/app/src/hr.rs` and `console-gate-writer-ownership` recorded that as
//! a ratcheted dual writer. The REST handlers own the surrounding transaction —
//! the employee row, its employment profile, its lifecycle event, the audit
//! chain and the idempotency reservation all commit or roll back together — so
//! moving those writes behind a port that opens its own connection would have
//! traded a writer-ownership violation for an atomicity one.
//!
//! [`insert_employee_record`] and [`apply_employment_change`] therefore take the
//! CALLER's transaction and hold the SQL here, in the owning crate. They are not
//! wrappers around the port: they are the port's own legacy-head writes, called
//! by [`PgEmploymentPort::execute`] for `hr.promote` and `hr.transfer` and by
//! the REST handlers for the same change arriving over HTTP. One statement, one
//! crate, two callers.
//!
//! Three statements collapsed to two: the confirmed-exit write was
//! `SET employment_status = 'EXITED', exit_date = $3` and the lifecycle write
//! is that plus the company/org-unit/position triple, whose `CASE WHEN $6 =
//! 'EXITED'` arm sets the same `exit_date`. Passing the employee's current
//! company/org-unit/position through the lifecycle statement produces the
//! identical row, so the exit path is a call to the general one. The non-EXITED
//! arm clears `exit_date`: reactivation (EXITED → ACTIVE|UNKNOWN) must not leave
//! a termination date on a non-exited status (console-90h).
//!
//! # Append-only, enforced by the database
//!
//! 0214's `canonical_employment_row_immutable` trigger refuses UPDATE and DELETE
//! on `employment_revisions` and UPDATE on `employment_source_bindings`, so a
//! revision is never edited: `Promote`/`Transfer` append `MAX(version) + 1`.
//! `employment_heads` carries a narrow trigger — `valid_to` is the one
//! legitimate mutation. When a Promote/Transfer revision carries
//! `employment_status = EXITED`, this port sets `employment_heads.valid_to` to
//! that revision's `valid_from` in the same transaction that appends the
//! revision and updates the legacy head. There is no separate `hr.exit`
//! dispatch target: exit is expressed as Promote/Transfer with EXITED.
//!
//! A revision stores only `valid_from`; its half-open interval ends at the next
//! revision's `valid_from`, or at the head's `valid_to`. That is 0214's temporal
//! contract, and it is why there is no `valid_to` on the revision to write.
//!
//! # Where the receipt is stored
//!
//! In `ont_action_command_receipts`, the generalised 0177 store, exactly as
//! `PersonPort` does: `PRIMARY KEY (org_id, command_id)` is what makes a command
//! id tenant-global ACROSS owners, so one client idempotency key can never mean
//! two accepted commands. 0177 carries no `owner`/`target` column yet, so the
//! `DispatchTarget` travels inside the receipt JSONB as its wire string and
//! read-back parses it with `FromStr`. A stored row that names no target is
//! refused, never replayed.
//!
//! # Synchronous port, async driver
//!
//! `CanonicalPort::execute` is synchronous and `sqlx` is async-only, so
//! [`PgEmploymentPort`] holds a `tokio::runtime::Handle` and blocks on it.
//! `Handle::block_on` panics when called from a runtime worker thread; an async
//! caller must reach `execute` through `spawn_blocking`.
//! one runtime handle, no thread pool of its own — revisit only if the
//! trait ever gains an async form.

mod appointment;
mod change_window;
mod derived;
mod error;
mod legacy_head;
mod lookups;
mod model;
mod port;
mod projection;
mod read;
mod receipt;
mod write;

pub use derived::{appoint_legacy_head_in_tx, reassign_org_unit_via_transfers_in_tx};
pub use error::EmploymentError;
pub use legacy_head::{
    EmploymentChange, NewEmployeeRecord, apply_employment_change, assignable_org_unit_name,
    insert_employee_record, set_employee_org_unit,
};
pub use lookups::{ensure_job_position_exists, ensure_org_unit_exists};
pub use model::{EmploymentAttributes, EmploymentCommand, EmploymentQuery};
pub use port::PgEmploymentPort;
pub use projection::{EmploymentEffectiveProjection, EmploymentEffectiveStatus, EmploymentHead};
pub use write::write_in_tx;
