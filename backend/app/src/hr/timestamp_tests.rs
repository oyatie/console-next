// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use time::macros::datetime;

fn responses(
    at: OffsetDateTime,
    optional: Option<OffsetDateTime>,
) -> Vec<Result<Value, serde_json::Error>> {
    vec![
        serde_json::to_value(AttendanceSummaryItem {
            user_id: Uuid::nil(),
            display_name: "person".into(),
            arrivals: 1,
            departures: 0,
            last_kind: None,
            last_event_at: optional,
        }),
        serde_json::to_value(EmployeeAttendanceRecordResponse {
            id: Uuid::nil(),
            employee_id: Uuid::nil(),
            employee_display_name: "person".into(),
            kind: "CLOCK_IN".into(),
            occurred_at: at,
            work_date: "2026-11-05".into(),
            state_after: "WORKING".into(),
            note: None,
            payroll_material_ref_id: Uuid::nil(),
            payroll_link_status: "LINKED".into(),
            duplicate: false,
        }),
        serde_json::to_value(HrImportReadinessSummary {
            runs: 1,
            applied_runs: 1,
            input_rows: 1,
            candidate_rows: 1,
            preserved_rows: 0,
            ledger_rows: 1,
            latest_import_at: optional,
        }),
        serde_json::to_value(HrPayrollReadinessSummary {
            draft_runs: 1,
            blocked_runs: 0,
            calculation_enabled_runs: 0,
            active_close_runs: 0,
            draft_lines: 0,
            payroll_source_rows: 0,
            attendance_source_rows: 0,
            attendance_event_links: 0,
            attendance_material_refs: 0,
            gross_pay_source_lines: 0,
            net_pay_source_lines: 0,
            latest_status: None,
            latest_source_label: None,
            latest_period_start: None,
            latest_period_end: None,
            latest_updated_at: optional,
        }),
        serde_json::to_value(AttendanceImportSummaryItem {
            run_id: Uuid::nil(),
            status: "APPLIED".into(),
            source_filename: "attendance.csv".into(),
            source_format: "CSV".into(),
            source_sha256: String::new(),
            input_rows: 1,
            candidate_rows: 1,
            preserved_rows: 0,
            dry_run_summary: json!({}),
            apply_summary: json!({}),
            created_at: at,
            applied_at: optional,
        }),
    ]
}

#[test]
fn response_timestamps_are_fractional_utc_strings_and_absent_options_stay_absent() {
    let at = datetime!(2026-11-05 12:31:02.238349 +09:00);
    for optional in [Some(at), None] {
        for response in responses(at, optional) {
            let response = response.unwrap();
            for field in ["occurred_at", "created_at"] {
                if let Some(value) = response.get(field) {
                    assert_eq!(value, "2026-11-05T03:31:02.238349Z");
                }
            }
            for field in [
                "last_event_at",
                "latest_import_at",
                "latest_updated_at",
                "applied_at",
            ] {
                if let Some(value) = response.get(field) {
                    assert!(optional.is_some());
                    assert_eq!(value, "2026-11-05T03:31:02.238349Z");
                }
            }
        }
    }
}

#[test]
fn response_timestamps_refuse_unrepresentable_values() {
    let invalid = datetime!(-0001-01-01 00:00 UTC);
    for response in responses(invalid, Some(invalid)) {
        assert!(response.is_err());
    }
}
