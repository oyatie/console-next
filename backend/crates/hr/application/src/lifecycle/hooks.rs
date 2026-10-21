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

/// Facts checked before a TERMINATE can change the employee; no database types.
pub struct TerminationFacts<'a> {
    pub involuntary: bool,
    pub notice_required: bool,
    pub notice: Option<console_hr_domain::exits::protection::NoticeFacts<'a>>,
    pub protected_periods: &'a [console_hr_domain::exits::protection::ProtectedPeriod],
    pub termination_date: Date,
}

/// # Errors
/// Coded refusals for a missing case, a protected period, or missing notice.
pub fn terminate_may_apply(facts: Option<&TerminationFacts<'_>>) -> Result<(), KernelError> {
    use console_hr_domain::exits::protection::notice_missing;
    let facts = facts.ok_or_else(|| {
        KernelError::conflict("an exit case is required for termination")
            .with_code("exit_case_required")
    })?;
    if facts.involuntary
        && facts
            .protected_periods
            .iter()
            .any(|p| p.blocks(facts.termination_date))
    {
        return Err(
            KernelError::conflict("dismissal is blocked during a protected leave period")
                .with_code("exit_protected_period"),
        );
    }
    if facts.notice_required && !notice_missing(facts.notice, facts.termination_date).is_empty() {
        return Err(
            KernelError::validation("written dismissal notice evidence is required")
                .with_code("notice_evidence_missing"),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_hr_domain::exits::protection::{NoticeFacts, ProtectedPeriod};
    use time::macros::date;

    #[test]
    fn termination_requires_a_case_checks_protection_and_preserves_voluntary_exits() {
        assert_eq!(
            terminate_may_apply(None).unwrap_err().code,
            Some("exit_case_required")
        );
        let periods = [ProtectedPeriod {
            lifecycle_event_id: Uuid::nil(),
            leave_type: "WORK_INJURY".into(),
            leave_from: date!(2026 - 01 - 01),
            leave_until: None,
            protected_until: None,
            instrument: Some("근로기준법".into()),
            article: Some("제23조제2항".into()),
        }];
        let mut facts = TerminationFacts {
            involuntary: true,
            notice_required: false,
            notice: None,
            protected_periods: &periods,
            termination_date: date!(2026 - 04 - 30),
        };
        assert_eq!(
            terminate_may_apply(Some(&facts)).unwrap_err().code,
            Some("exit_protected_period")
        );
        facts.involuntary = false;
        assert!(terminate_may_apply(Some(&facts)).is_ok());
        facts.involuntary = true;
        facts.protected_periods = &[];
        assert!(
            terminate_may_apply(Some(&facts)).is_ok(),
            "권고사직 has no notice requirement"
        );
        facts.notice_required = true;
        assert_eq!(
            terminate_may_apply(Some(&facts)).unwrap_err().code,
            Some("notice_evidence_missing")
        );
        facts.notice = Some(NoticeFacts {
            reason_text: "사유",
            served_on: Some(date!(2026 - 05 - 01)),
            method: "CERTIFIED_MAIL",
            evidence_ref: "receipt",
        });
        assert_eq!(
            terminate_may_apply(Some(&facts)).unwrap_err().code,
            Some("notice_evidence_missing")
        );
        facts.notice.as_mut().unwrap().served_on = Some(date!(2026 - 04 - 30));
        assert!(terminate_may_apply(Some(&facts)).is_ok());
    }
}
