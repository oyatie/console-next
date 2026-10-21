//! Lifecycle apply hooks and the TERMINATE predicate (PREREG-3, C8).
//!
//! LIFE owns the apply function and calls these at its three points; EXIT
//! implements the trait and fills [`terminate_may_apply`] in this file. Every
//! call takes the caller's open transaction as `tx`, so a hook's writes commit
//! or roll back with the lifecycle change; this crate never names a database
//! type.

use std::future::Future;

use console_kernel_core::{KernelError, OrgId};
use time::Date;
use uuid::Uuid;

/// The lifecycle event a hook or the predicate is asked about.
#[derive(Debug, Clone, Copy)]
pub struct LifecycleApplyEvent<'a> {
    pub org_id: OrgId,
    pub event_id: Uuid,
    pub employee_id: Uuid,
    /// `employee_lifecycle_events.event_type`, e.g. `TERMINATE`.
    pub event_type: &'a str,
    pub effective_date: Date,
}

/// What EXIT plugs into LIFE's apply function. An `Err` from any hook makes
/// the caller roll the whole transaction back.
pub trait LifecycleApplyHooks<Tx: ?Sized + Send>: Sync {
    /// Runs before the event changes the employee; an `Err` refuses the apply.
    fn before_apply(
        &self,
        tx: &mut Tx,
        event: &LifecycleApplyEvent<'_>,
    ) -> impl Future<Output = Result<(), KernelError>> + Send;

    /// Runs after the employee changed, in the same transaction.
    fn after_apply(
        &self,
        tx: &mut Tx,
        event: &LifecycleApplyEvent<'_>,
    ) -> impl Future<Output = Result<(), KernelError>> + Send;

    /// Runs when an applied or scheduled event is rescinded (BW-11).
    fn on_rescind(
        &self,
        tx: &mut Tx,
        event: &LifecycleApplyEvent<'_>,
    ) -> impl Future<Output = Result<(), KernelError>> + Send;
}

/// Whether a TERMINATE event may apply now (EXIT-owned, filled in this file).
///
/// # Errors
///
/// Always, until EXIT implements it: a TERMINATE must not apply on an
/// unchecked exit case (fail closed). Callers must roll back.
pub async fn terminate_may_apply<Tx: ?Sized>(
    _tx: &mut Tx,
    _event: &LifecycleApplyEvent<'_>,
) -> Result<(), KernelError> {
    Err(KernelError::internal(
        "the TERMINATE predicate is not implemented; refusing to apply the termination",
    ))
}

#[cfg(test)]
mod tests {
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use time::macros::date;

    use super::*;

    #[test]
    fn terminate_predicate_stub_fails_closed() {
        let event = LifecycleApplyEvent {
            org_id: OrgId::from_uuid(Uuid::nil()),
            event_id: Uuid::nil(),
            employee_id: Uuid::nil(),
            event_type: "TERMINATE",
            effective_date: date!(2026 - 10 - 04),
        };
        let mut tx = ();
        let mut future = pin!(terminate_may_apply(&mut tx, &event));
        let mut cx = Context::from_waker(Waker::noop());
        let Poll::Ready(result) = future.as_mut().poll(&mut cx) else {
            panic!("the stub must not suspend");
        };
        assert!(
            result.is_err(),
            "TERMINATE must refuse until EXIT implements the predicate"
        );
    }
}
