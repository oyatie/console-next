// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_hr_adapter_postgres::lifecycle::requests::CreateEmployeeLifecycleEventRequest;
use console_hr_domain::import::detect::WorkbookMappingRequest;
use serde_json::json;
use sqlx::PgPool;

use crate::harness::{decisions, importer, table};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pre_hire_not_issued_inline_repair_and_domestic_residence_end_to_end(pool: PgPool) {
    let i = importer(pool.clone()).await;

    // 1. Two-digit year triggers two_digit_year + YYYY-MM-DD + cells resolution;
    //    restricted targets ("rrn"/"phone"/"name") in decisions.cells fail closed with 422.
    let run_bad = i
        .preview(
            "repair.xlsx",
            &[table(
                "Sheet1",
                0,
                &[
                    &[
                        "employee_number",
                        "name",
                        "hire_date",
                        "birth_date",
                        "id_type",
                    ],
                    &[
                        "PRE-1",
                        "KimPrehire",
                        "2029-05-01",
                        "95-03-04",
                        "NOT_ISSUED",
                    ],
                ],
            )],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;

    let plan = i.dry_run(run_bad, decisions()).await;
    assert_eq!(plan.review.blocking, 1);
    assert_eq!(plan.review.items[0].reason, "two_digit_year");
    assert_eq!(plan.review.items[0].expected_format, Some("YYYY-MM-DD"));
    assert_eq!(
        plan.review.items[0].resolution.as_ref().map(|r| r.decision),
        Some("cells")
    );
    let source_key = plan.rows[0].source_key.clone();

    for restricted in ["rrn", "phone", "name"] {
        let mut bad_dec = decisions();
        bad_dec
            .cells
            .entry(source_key.clone())
            .or_default()
            .insert(restricted.into(), "X".into());
        assert_eq!(
            i.try_dry_run(run_bad, bad_dec).await.unwrap_err().status,
            422
        );
    }

    let mut fix_dec = decisions();
    fix_dec
        .cells
        .entry(source_key.clone())
        .or_default()
        .insert("birth_date".into(), "1995-03-04".into());
    let fixed = i.dry_run(run_bad, fix_dec).await;
    assert_eq!(fixed.review.blocking, 0, "{:?}", fixed.review.items);
    i.apply(run_bad, &fixed.dry_run_digest).await.unwrap();

    let (emp_id, emp_status, id_type): (uuid::Uuid, String, Option<String>) = sqlx::query_as(
        "SELECT id, employment_status, id_type FROM employees WHERE org_id = $1 AND employee_number = 'PRE-1'",
    )
    .bind(i.org())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(emp_status, "PRE_HIRE");
    assert_eq!(id_type.as_deref(), Some("NOT_ISSUED"));

    // 2. Onboarding PRE_HIRE -> ACTIVE is blocked while id_type == NOT_ISSUED
    let onboard_req: CreateEmployeeLifecycleEventRequest = serde_json::from_value(json!({
        "event_type": "ONBOARD",
        "to_status": "ACTIVE",
        "effective_date": "2026-11-22",
        "comment": "onboard check"
    }))
    .unwrap();
    let onboard_err =
        i.f.hr
            .record_lifecycle_event(
                i.f.principal.clone(),
                emp_id,
                uuid::Uuid::new_v4().to_string(),
                onboard_req,
            )
            .await
            .unwrap_err();
    assert_eq!(onboard_err.status, 409);
    assert_eq!(onboard_err.code, "invalid_transition");

    // 3. Duplicate PRE_HIRE NOT_ISSUED on same (name_key, birth_date) is refused in dry run
    let dup_run = i
        .preview(
            "dup.xlsx",
            &[table(
                "Sheet1",
                0,
                &[
                    &[
                        "employee_number",
                        "name",
                        "hire_date",
                        "birth_date",
                        "id_type",
                    ],
                    &[
                        "PRE-2",
                        "Kim Prehire",
                        "2029-06-01",
                        "1995-03-04",
                        "NOT_ISSUED",
                    ],
                ],
            )],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let dup_plan = i.dry_run(dup_run, decisions()).await;
    assert!(dup_plan.review.blocking > 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn foreigner_reg_alias_domestic_residence_mod11_and_sex_derivation(pool: PgPool) {
    let i = importer(pool.clone()).await;
    let run = i
        .preview(
            "foreign.xlsx",
            &[table(
                "Sheet1",
                0,
                &[
                    &["employee_number", "name", "hire_date", "rrn", "id_type"],
                    &[
                        "F-1",
                        "Park Foreign",
                        "2025-02-01",
                        "900101-5000014",
                        "FOREIGNER_REG",
                    ],
                    &[
                        "F-2",
                        "Lee Domestic",
                        "2025-02-01",
                        "900101-5000014",
                        "DOMESTIC_RESIDENCE",
                    ],
                ],
            )],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let plan = i.dry_run(run, decisions()).await;
    // Same RRN across F-1 and F-2 triggers duplicate/in_use if applied together, so test single-row import check:
    assert_eq!(
        plan.rows[0]
            .new_person
            .as_ref()
            .and_then(|p| p.id_type.as_deref()),
        Some("ARC")
    );
    assert_eq!(
        plan.rows[0]
            .new_person
            .as_ref()
            .and_then(|p| p.sex.as_deref()),
        Some("MALE")
    );
    assert_eq!(
        plan.rows[1]
            .new_person
            .as_ref()
            .and_then(|p| p.id_type.as_deref()),
        Some("DOMESTIC_RESIDENCE")
    );

    // Invalid Mod-11 5..=8 RRN is refused
    let bad = i
        .preview(
            "bad-arc.xlsx",
            &[table(
                "Sheet1",
                0,
                &[
                    &["employee_number", "name", "hire_date", "rrn", "id_type"],
                    &["F-3", "Oh Invalid", "2025-02-01", "900101-5000010", "ARC"],
                ],
            )],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let bad_plan = i.dry_run(bad, decisions()).await;
    assert_eq!(bad_plan.rows[0].refusal_code, Some("rrn_mod11_invalid"));
}
