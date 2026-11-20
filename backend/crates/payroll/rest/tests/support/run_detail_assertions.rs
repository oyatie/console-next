// SPDX-License-Identifier: LicenseRef-Proprietary
use http::StatusCode;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

pub(crate) async fn assert_uncalculated_run_detail(
    rt: &PgPool,
    keys: &super::Keys,
    run: Uuid,
    token: &str,
) {
    let (status, detail) = super::send(
        rt,
        keys,
        "GET",
        &format!("/api/v1/payroll/runs/{run}"),
        token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["calculation"], Value::Null);
    let line = &detail["lines"][0];
    for field in [
        "calculation_version",
        "gross_won",
        "deductions",
        "total_deductions_won",
        "net_won",
        "tax_table_version",
    ] {
        assert_eq!(
            line[field],
            Value::Null,
            "uncalculated line must keep {field} null"
        );
    }
}

pub(crate) fn assert_calculated_run_detail(calculated: &Value) {
    let calc = &calculated["calculation"];
    assert_eq!(calc["total_gross_won"], 3_000_000);
    assert_eq!(calc["total_deductions_won"], 373_300);
    assert_eq!(calc["total_net_won"], 2_626_700);
    let line = &calculated["lines"][0];
    assert_eq!(line["calculation_version"], 1);
    assert_eq!(line["gross_won"], 3_000_000);
    assert_eq!(line["total_deductions_won"], 373_300);
    assert_eq!(line["net_won"], 2_626_700);
    let tax_version = line["tax_table_version"]
        .as_str()
        .expect("tax_table_version");
    assert!(
        tax_version.starts_with("NTS-") && tax_version.ends_with("-fixture-row-v1"),
        "unexpected tax_table_version: {tax_version}"
    );
    let deductions = line["deductions"].as_array().expect("deductions array");
    assert_eq!(deductions.len(), 6);
    assert_eq!(deductions[0]["code"], "NATIONAL_PENSION");
}

pub(crate) async fn assert_issued_payslip_payload(pool: &PgPool, run: Uuid) {
    let payload: Value = sqlx::query_scalar(
        "SELECT payload FROM inbox_docs WHERE kind = 'payslip' AND source_id = $1",
    )
    .bind(run.to_string())
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(payload["employee_display_name"], "Alice");
    assert_eq!(payload["employee_company"], "SAE");
    assert_eq!(payload["overtime_hours"], 2.5);
    assert_eq!(payload["gross_won"], 3_000_000);
    assert_eq!(payload["total_deductions_won"], 373_300);
    assert_eq!(payload["net_won"], 2_626_700);
    assert_eq!(payload["calculation_version"], 1);
    let tax_version = payload["tax_table_version"]
        .as_str()
        .expect("payload tax_table_version");
    assert!(
        tax_version.starts_with("NTS-") && tax_version.ends_with("-fixture-row-v1"),
        "unexpected payload tax_table_version: {tax_version}"
    );
    assert_eq!(payload["deductions"].as_array().unwrap().len(), 6);
    for key in [
        "pay_date",
        "work_days",
        "regular_hours",
        "night_hours",
        "holiday_hours",
        "leave_used",
        "leave_remaining",
    ] {
        assert!(
            payload.get(key).is_some(),
            "payslip payload missing key {key}: {payload}"
        );
    }
}
