//! LIFE's side of C8: the apply function calls EXIT's `LifecycleApplyHooks`
//! (PREREG-3) at its three points, inside the caller's transaction.
//!
//! - `before_apply` / `after_apply` wrap every write of an event's effect on
//!   the employee ([`super::record::apply_lifecycle_head`]): immediate events
//!   (single, bulk, change set, exit confirmation, correction replacement) and
//!   the scheduled runner alike.
//! - `on_rescind` runs when an applied event is undone (rescind, or the void
//!   half of a correction) and when a SCHEDULED event is cancelled.
//!
//! The TERMINATE predicate (`terminate_may_apply`) is EXIT's: its
//! `before_apply` calls it for `TERMINATE`. LIFE does not call the predicate
//! itself, so the fail-closed stub cannot refuse exits before EXIT lands.

use console_hr_application::lifecycle::hooks::{LifecycleApplyEvent, LifecycleApplyHooks};
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::{KernelError, OrgId};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::HrError;

/// Hooks that do nothing: the placeholder until EXIT's impl is on trunk.
#[derive(Debug, Clone, Copy)]
pub struct NoLifecycleHooks;

impl LifecycleApplyHooks<PgConnection> for NoLifecycleHooks {
    async fn before_apply(
        &self,
        _tx: &mut PgConnection,
        _event: &LifecycleApplyEvent<'_>,
    ) -> Result<(), KernelError> {
        Ok(())
    }

    async fn after_apply(
        &self,
        _tx: &mut PgConnection,
        _event: &LifecycleApplyEvent<'_>,
    ) -> Result<(), KernelError> {
        Ok(())
    }

    async fn on_rescind(
        &self,
        _tx: &mut PgConnection,
        _event: &LifecycleApplyEvent<'_>,
    ) -> Result<(), KernelError> {
        Ok(())
    }
}

/// THE SWAP POINT: INTEG replaces this (type and value) with EXIT's
/// `LifecycleApplyHooks<PgConnection>` impl when LIFE and EXIT meet on trunk.
pub const LIFECYCLE_HOOKS: NoLifecycleHooks = NoLifecycleHooks;

/// The hook event for one ledger row; `effective_date` is the stored
/// `YYYY-MM-DD` text.
pub fn apply_event<'a>(
    org: Uuid,
    event_id: Uuid,
    employee_id: Uuid,
    event_type: &'a str,
    effective_date: &str,
) -> Result<LifecycleApplyEvent<'a>, HrError> {
    Ok(LifecycleApplyEvent {
        org_id: OrgId::from_uuid(org),
        event_id,
        employee_id,
        event_type,
        effective_date: parse_yyyy_mm_dd(effective_date).map_err(HrError::from_kernel)?,
    })
}

/// Runs `on_rescind` for the event being undone or cancelled.
pub async fn rescinded(
    tx: &mut PgConnection,
    event: &LifecycleApplyEvent<'_>,
) -> Result<(), HrError> {
    LIFECYCLE_HOOKS
        .on_rescind(tx, event)
        .await
        .map_err(HrError::from_kernel)
}
