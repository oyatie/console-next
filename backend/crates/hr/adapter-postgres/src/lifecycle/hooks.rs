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
//! itself; every TERMINATE now passes through EXIT's fail-closed implementation.

use console_compliance_domain::statutory::StatutoryRegister;
use console_hr_application::lifecycle::hooks::{LifecycleApplyEvent, LifecycleApplyHooks};
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_kernel_core::{ErrorKind, KernelError, OrgId};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::HrError;

/// EXIT checks the action; its case trail commits with the same action.
#[derive(Debug, Clone, Copy)]
pub struct LifecycleTrailHooks<'a> {
    pub register: Option<&'a StatutoryRegister>,
    pub defer_cases: bool,
}

pub const LIFECYCLE_HOOKS: LifecycleTrailHooks<'static> = LifecycleTrailHooks {
    register: None,
    defer_cases: false,
};

impl LifecycleApplyHooks<Transaction<'_, Postgres>> for LifecycleTrailHooks<'_> {
    async fn before_apply(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        event: &LifecycleApplyEvent<'_>,
    ) -> Result<(), KernelError> {
        crate::exits::hooks::ExitLifecycleHooks
            .before_apply(tx.as_mut(), event)
            .await
    }

    async fn after_apply(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        event: &LifecycleApplyEvent<'_>,
    ) -> Result<(), KernelError> {
        crate::exits::hooks::ExitLifecycleHooks
            .after_apply(tx.as_mut(), event)
            .await?;
        if self.defer_cases {
            return Ok(());
        }
        crate::cases::open::event_with_register(
            tx,
            *event.org_id.as_uuid(),
            event.event_id,
            self.register,
        )
        .await
        .map_err(kernel)
    }

    async fn on_rescind(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        event: &LifecycleApplyEvent<'_>,
    ) -> Result<(), KernelError> {
        crate::exits::hooks::ExitLifecycleHooks
            .on_rescind(tx.as_mut(), event)
            .await?;
        crate::cases::open::cancel(
            tx,
            *event.org_id.as_uuid(),
            event.event_id,
            "EVENT_WITHDRAWN",
        )
        .await
        .map_err(kernel)
    }
}

fn kernel(error: HrError) -> KernelError {
    let kind = match error.status.as_u16() {
        422 => ErrorKind::Validation,
        409 => ErrorKind::Conflict,
        _ => ErrorKind::Internal,
    };
    KernelError::new(kind, error.message).with_code(error.code)
}

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
    tx: &mut Transaction<'_, Postgres>,
    event: &LifecycleApplyEvent<'_>,
) -> Result<(), HrError> {
    LIFECYCLE_HOOKS
        .on_rescind(tx, event)
        .await
        .map_err(HrError::from_kernel)
}
