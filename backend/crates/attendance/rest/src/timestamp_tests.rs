// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_attendance_application::CloseAmendmentRead;
use time::{OffsetDateTime, format_description::well_known::Rfc3339, macros::datetime};

fn close(at: OffsetDateTime) -> MonthCloseDto {
    MonthCloseDto::from(MonthCloseRead {
        id: Uuid::nil(),
        month: at.date(),
        branch_id: None,
        checks: vec![],
        attested_by: Uuid::nil(),
        attested_at: at,
        period_lock_id: None,
        closed_at: at,
        amendments: vec![CloseAmendmentRead {
            id: Uuid::nil(),
            reason: "correction".into(),
            actor: Uuid::nil(),
            created_at: at,
        }],
    })
}

#[test]
fn close_timestamps_are_rfc3339_and_preserve_fractional_seconds() {
    let at = datetime!(2026-11-05 03:31:02.238349 UTC);
    let value = serde_json::to_value(close(at)).unwrap();
    for timestamp in [
        &value["attested_at"],
        &value["closed_at"],
        &value["amendments"][0]["created_at"],
    ] {
        assert_eq!(timestamp, "2026-11-05T03:31:02.238349Z");
        assert_eq!(
            OffsetDateTime::parse(timestamp.as_str().unwrap(), &Rfc3339).unwrap(),
            at
        );
    }
}

#[test]
fn close_timestamps_refuse_unrepresentable_rfc3339_instead_of_emitting_display() {
    let at = datetime!(-0001-01-01 00:00 UTC);
    assert!(serde_json::to_value(close(at)).is_err());
}

#[test]
fn attendance_timestamps_normalize_offsets_to_utc() {
    use console_attendance_application::{ExceptionResolutionRead, Week52Read, Week52Tone};

    let at = datetime!(2026-11-05 12:31:02.238349 +09:00);
    let expected = "2026-11-05T03:31:02.238349Z";
    let exception = serde_json::to_value(ExceptionDto::from(AttendanceExceptionRead {
        id: Uuid::nil(),
        code: "AT-1".into(),
        kind: console_attendance_domain::ExceptionKind::Late,
        status: "RESOLVED".into(),
        employee_id: Uuid::nil(),
        employee_name: "employee".into(),
        team: None,
        branch_id: None,
        work_date: at.date(),
        occurred_at: at,
        detail: "late".into(),
        evidence: vec![],
        links: vec![],
        created_at: at,
        resolution: Some(ExceptionResolutionRead {
            action: console_attendance_domain::ResolutionAction::Confirm,
            reason: "verified".into(),
            linked_work_ref: None,
            ot_hours: None,
            actor: Uuid::nil(),
            resolved_at: at,
        }),
    }))
    .unwrap();
    let substitution = serde_json::to_value(SubstitutionDto::from(AttendanceSubstitutionRead {
        id: Uuid::nil(),
        site: "site".into(),
        branch_id: None,
        role: "role".into(),
        cover_date: at.date(),
        from_minutes: 0,
        to_minutes: 60,
        covered_employee_id: Uuid::nil(),
        covered_name: "employee".into(),
        reason_kind: "OTHER".into(),
        reason_detail: None,
        worker_employee_id: None,
        worker_name: "worker".into(),
        worker_type: "CONTRACTOR".into(),
        worker_rate: None,
        status: "ASSIGNED".into(),
        exception_id: None,
        created_by: Uuid::nil(),
        created_at: at,
    }))
    .unwrap();
    let week = |acknowledged_at| {
        Week52RowDto::from(Week52Read {
            employee_id: Uuid::nil(),
            name: "employee".into(),
            team: None,
            week_start: at.date(),
            current_hours: 40.0,
            projected_hours: 40.0,
            recognized_hours: None,
            overtime_hours: None,
            tone: Week52Tone::Ok,
            acknowledged_at,
        })
    };
    let acknowledged = serde_json::to_value(week(Some(at))).unwrap();
    let closed = serde_json::to_value(close(at)).unwrap();
    for value in [
        &exception["occurred_at"],
        &exception["created_at"],
        &exception["resolution"]["resolved_at"],
        &substitution["created_at"],
        &acknowledged["acked_at"],
        &closed["attested_at"],
        &closed["closed_at"],
        &closed["amendments"][0]["created_at"],
    ] {
        assert_eq!(value, expected);
    }
    assert!(
        serde_json::to_value(week(None))
            .unwrap()
            .get("acked_at")
            .is_none()
    );
}

#[test]
fn amendment_write_projection_normalizes_offsets_to_utc() {
    let value = CloseAmendmentDto::from(CloseAmendmentRead {
        id: Uuid::nil(),
        reason: "correction".into(),
        actor: Uuid::nil(),
        created_at: datetime!(2026-11-05 12:31:02.238349 +09:00),
    });
    assert_eq!(
        serde_json::to_value(value).unwrap()["created_at"],
        "2026-11-05T03:31:02.238349Z"
    );
}
