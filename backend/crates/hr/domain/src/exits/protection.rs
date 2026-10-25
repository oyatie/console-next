// SPDX-License-Identifier: LicenseRef-Proprietary
//! Dismissal protection folded from APPLIED, non-voided employee events.
//! Numbers and citations come from the statutory register, including HOLD rows.
use crate::lifecycle::childcare::AppliedEvent;
use time::{Date, Duration};
use uuid::Uuid;

/// The register's protection rule in force on the statutory exit date being checked.
pub struct ProtectionRule {
    pub tail_days: Option<i64>,
    pub instrument: String,
    pub article: String,
}
pub trait ProtectionRegister {
    /// None means unprotected; an unknown tail on a mapped type stays open.
    fn rule(&self, leave_type: &str) -> Option<ProtectionRule>;
}
#[derive(Debug, Clone, Copy)]
pub struct AppliedExitEvent<'a> {
    pub lifecycle_event_id: Uuid,
    pub event: AppliedEvent<'a>,
}
#[derive(Debug, Clone)]
pub struct ProtectedPeriod {
    pub lifecycle_event_id: Uuid,
    pub leave_type: String,
    pub leave_from: Date,
    pub leave_until: Option<Date>,
    pub protected_until: Option<Date>,
    pub instrument: Option<String>,
    pub article: Option<String>,
}
impl ProtectedPeriod {
    /// The statutory exit date (day after the last working day), inclusive.
    #[must_use]
    pub fn blocks(&self, termination_date: Date) -> bool {
        termination_date >= self.leave_from
            && self
                .protected_until
                .is_none_or(|end| termination_date <= end)
    }
}
/// Events are in effective-date order. A return closes the leave the day before;
/// absent a return, its expected return closes it. A missing rule stays open.
#[must_use]
pub fn protected_periods(
    events: &[AppliedExitEvent<'_>],
    register: &dyn ProtectionRegister,
) -> Vec<ProtectedPeriod> {
    let mut periods = Vec::new();
    let mut open: Option<&AppliedExitEvent<'_>> = None;
    for event in events {
        match event.event.event_type {
            "LEAVE_OF_ABSENCE" => {
                if let Some(start) = open.take() {
                    periods.push(period(start, None, register));
                }
                if event
                    .event
                    .leave_type
                    .and_then(|leave_type| register.rule(leave_type))
                    .is_some()
                {
                    open = Some(event);
                }
            }
            "RETURN_FROM_LEAVE" | "TERMINATE" => {
                if let Some(start) = open.take() {
                    periods.push(period(start, Some(event.event.effective_date), register));
                }
            }
            _ => {}
        }
    }
    if let Some(start) = open {
        periods.push(period(start, None, register));
    }
    periods
}
fn period(
    start: &AppliedExitEvent<'_>,
    returned: Option<Date>,
    register: &dyn ProtectionRegister,
) -> ProtectedPeriod {
    let leave_until = returned
        .or(start.event.expected_return_date)
        .and_then(Date::previous_day);
    let rule = start
        .event
        .leave_type
        .and_then(|leave_type| register.rule(leave_type));
    let protected_until = rule.as_ref().and_then(|r| {
        let tail = i32::try_from(r.tail_days?).ok().filter(|tail| *tail >= 0)?;
        leave_until?.checked_add(Duration::days(i64::from(tail)))
    });
    ProtectedPeriod {
        lifecycle_event_id: start.lifecycle_event_id,
        leave_type: start.event.leave_type.unwrap_or_default().to_owned(),
        leave_from: start.event.effective_date,
        leave_until,
        protected_until,
        instrument: rule.as_ref().map(|r| r.instrument.clone()),
        article: rule.map(|r| r.article),
    }
}

/// Evidence as facts, shared by immediate confirmation and scheduled application.
#[derive(Debug, Clone, Copy)]
pub struct NoticeFacts<'a> {
    pub reason_text: &'a str,
    pub served_on: Option<Date>,
    pub method: &'a str,
    pub evidence_ref: &'a str,
}
#[must_use]
pub fn notice_missing(
    notice: Option<NoticeFacts<'_>>,
    termination_date: Date,
) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if notice.is_none_or(|n| n.reason_text.trim().is_empty()) {
        missing.push("reason_text");
    }
    if notice.is_none_or(|n| n.served_on.is_none_or(|date| date > termination_date)) {
        missing.push("served_on");
    }
    if notice.is_none_or(|n| {
        !matches!(
            n.method,
            "IN_PERSON_SIGNED" | "CERTIFIED_MAIL" | "ELECTRONIC"
        )
    }) {
        missing.push("method");
    }
    if notice.is_none_or(|n| n.evidence_ref.trim().is_empty()) {
        missing.push("evidence_ref");
    }
    missing
}
