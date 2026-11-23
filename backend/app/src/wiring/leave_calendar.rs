// SPDX-License-Identifier: LicenseRef-Proprietary
//! Composition bridge from `PgAttendanceStore` to `leave::WorkCalendarPort`.

use console_kernel_core::KernelError;
use console_leave_adapter_postgres::{
    LeaveChargeFuture, ResolveLeaveChargeQuery, WorkCalendarPort,
};
use console_leave_domain::{
    LeaveChargeAssessment, LeaveChargeEvidence, LeaveChargeReviewReason, LeaveDateCharge,
    LeaveType, LeaveUnits, NonWorkBasis, SourceRevisionRef, WorkObligation,
};
use sqlx::PgPool;

use console_attendance_adapter_postgres::{DayKind, PgAttendanceStore};

#[derive(Clone)]
pub(crate) struct AttendanceWorkCalendarPort {
    attendance: PgAttendanceStore,
}

impl std::fmt::Debug for AttendanceWorkCalendarPort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AttendanceWorkCalendarPort")
            .finish_non_exhaustive()
    }
}

impl AttendanceWorkCalendarPort {
    #[must_use]
    pub(crate) fn new(pool: PgPool) -> Self {
        Self {
            attendance: PgAttendanceStore::new(pool),
        }
    }
}

impl WorkCalendarPort for AttendanceWorkCalendarPort {
    fn resolve_charge(&self, query: ResolveLeaveChargeQuery) -> LeaveChargeFuture<'_> {
        Box::pin(async move {
            let span = self
                .attendance
                .resolve_employee_schedule_span(
                    *query.org_id.as_uuid(),
                    query.subject_employee_id,
                    query.start_date,
                    query.end_date,
                )
                .await
                .map_err(|error| KernelError::internal(error.to_string()))?;

            let Some(span) = span else {
                return LeaveChargeAssessment::review_required(vec![
                    LeaveChargeReviewReason::MissingCalendar,
                ]);
            };
            if !span.holidays_loaded
                || span
                    .days
                    .iter()
                    .any(|day| matches!(day.kind, DayKind::NoSchedule))
            {
                return LeaveChargeAssessment::review_required(vec![
                    LeaveChargeReviewReason::MissingCalendar,
                ]);
            }

            let mut date_charges = Vec::with_capacity(span.days.len());
            let mut total_micros: i64 = 0;
            for day in &span.days {
                let (obligation, units) = match day.kind {
                    DayKind::Work => {
                        let units = match query.leave_type {
                            LeaveType::Annual => LeaveUnits::ONE_DAY,
                            LeaveType::HalfDay => LeaveUnits::from_micros(500_000)?,
                        };
                        (
                            WorkObligation::Scheduled {
                                minutes: u32::from(day.minutes).max(1),
                            },
                            units,
                        )
                    }
                    DayKind::WeeklyHoliday | DayKind::RestDay => (
                        WorkObligation::NotScheduled {
                            basis: NonWorkBasis::RestDay,
                        },
                        LeaveUnits::ZERO,
                    ),
                    DayKind::PublicHoliday | DayKind::ElectionDay | DayKind::LaborDay => (
                        WorkObligation::NotScheduled {
                            basis: NonWorkBasis::PublicHoliday,
                        },
                        LeaveUnits::ZERO,
                    ),
                    DayKind::SubstituteHoliday => (
                        WorkObligation::NotScheduled {
                            basis: NonWorkBasis::SubstituteHoliday,
                        },
                        LeaveUnits::ZERO,
                    ),
                    DayKind::ContractualHoliday => (
                        WorkObligation::NotScheduled {
                            basis: NonWorkBasis::ContractualDayOff,
                        },
                        LeaveUnits::ZERO,
                    ),
                    DayKind::NoSchedule => {
                        return LeaveChargeAssessment::review_required(vec![
                            LeaveChargeReviewReason::MissingCalendar,
                        ]);
                    }
                };
                total_micros += units.micros();
                date_charges.push(LeaveDateCharge {
                    date: day.date,
                    obligation,
                    units,
                });
            }

            if total_micros == 0 {
                return Err(KernelError::validation(
                    "selected dates contain no scheduled workdays",
                )
                .with_code("leave_no_scheduled_workdays"));
            }

            let calendar_revision_ref = SourceRevisionRef::new(
                "attendance_schedule",
                &query.branch_id.to_string(),
                &format!("{}..{}", query.start_date, query.end_date),
            )?;
            let policy_revision_ref = SourceRevisionRef::new("kr_labor_policy", "lsa_60", "v1")?;

            Ok(LeaveChargeAssessment::Resolved {
                evidence: LeaveChargeEvidence {
                    home_branch_id: query.branch_id,
                    calendar_revision_ref,
                    policy_revision_ref,
                    supporting_source_refs: Vec::new(),
                    date_charges,
                },
            })
        })
    }
}
