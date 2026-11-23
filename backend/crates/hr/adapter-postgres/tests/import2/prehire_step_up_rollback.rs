// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_hr_adapter_postgres::corrections::SecondPersonContext;
use console_hr_adapter_postgres::import::rollback::RollbackRequest;
use console_hr_adapter_postgres::import::row_identifier::{
    ImportRowIdentifierRequest, import_row_identifier_binding,
};
use console_hr_domain::import::detect::WorkbookMappingRequest;
use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};
use serde_json::json;
use sqlx::PgPool;

use crate::harness::{decisions, importer, table};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pre_hire_not_issued_draft_identifier_dry_run_apply_and_sex_persistence(pool: PgPool) {
    let i = importer(pool.clone()).await;
    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
        .bind(i.f.principal.user_id.as_uuid())
        .execute(&i.owner)
        .await
        .unwrap();
    let mut key = SoftKey::enroll(&pool, i.f.principal.org_id, i.f.principal.user_id).await;

    let run = i
        .preview(
            "step-up-draft.xlsx",
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
                        "PRE-STEP-1",
                        "Kim Stepup",
                        "2029-05-01",
                        "1990-01-01",
                        "NOT_ISSUED",
                    ],
                ],
            )],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;

    let pre_plan = i.dry_run(run, decisions()).await;
    let source_key = pre_plan.rows[0].source_key.clone();

    let binding = import_row_identifier_binding(run, &source_key);
    let start = passkey_service()
        .start_mobile_step_up(&pool, *i.f.principal.user_id.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{"type": "public-key", "id": key.credential_id()}]);
    let req: ImportRowIdentifierRequest = serde_json::from_value(json!({
        "rrn": "900101-6000017",
        "id_type": "DOMESTIC_RESIDENCE",
        "step_up": {
            "binding": binding,
            "assertion": {
                "ceremony_id": start.ceremony_id,
                "credential": key.assert(&challenge).unwrap()
            }
        }
    }))
    .unwrap();
    let res =
        i.f.hr
            .record_import_row_identifier(
                i.f.principal.clone(),
                run,
                source_key,
                req,
                Some(&crate::harness::MirrorVault),
                Some(&passkey_service()),
            )
            .await
            .unwrap();
    assert_eq!(res.id_type, "DOMESTIC_RESIDENCE");
    assert_eq!(res.sex_derived.as_deref(), Some("FEMALE"));

    let dry = i.dry_run(run, decisions()).await;
    assert_eq!(dry.review.blocking, 0, "{:?}", dry.review.items);
    assert_eq!(dry.rows[0].outcome, "insert");
    let np = dry.rows[0].new_person.as_ref().unwrap();
    assert_eq!(np.id_type.as_deref(), Some("DOMESTIC_RESIDENCE"));
    assert_eq!(np.sex.as_deref(), Some("FEMALE"));

    i.apply(run, &dry.dry_run_digest).await.unwrap();

    let (emp_id, stored_id_type): (uuid::Uuid, Option<String>) = sqlx::query_as(
        "SELECT id, id_type FROM employees WHERE org_id = $1 AND employee_number = 'PRE-STEP-1'",
    )
    .bind(i.org())
    .fetch_one(&i.owner)
    .await
    .unwrap();
    assert_eq!(stored_id_type.as_deref(), Some("DOMESTIC_RESIDENCE"));

    let rrn_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM employee_rrn WHERE org_id = $1 AND employee_id = $2)",
    )
    .bind(i.org())
    .bind(emp_id)
    .fetch_one(&i.owner)
    .await
    .unwrap();
    assert!(rrn_exists);

    let sex: Option<String> = sqlx::query_scalar(
        "SELECT sex FROM employee_register_facts WHERE org_id = $1 AND employee_id = $2",
    )
    .bind(i.org())
    .bind(emp_id)
    .fetch_one(&i.owner)
    .await
    .unwrap();
    assert_eq!(sex.as_deref(), Some("FEMALE"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_restores_exact_prior_id_type_for_rrn_not_issued_and_null(pool: PgPool) {
    let i = importer(pool.clone()).await;

    let seed_run = i
        .preview(
            "seed.xlsx",
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
                    &["EMP-RRN", "Pre Rrn", "2024-01-01", "1990-01-01", "RRN"],
                    &[
                        "EMP-NI",
                        "Pre NotIssued",
                        "2029-01-01",
                        "1991-02-02",
                        "NOT_ISSUED",
                    ],
                    &["EMP-NULL", "Pre Null", "2024-01-01", "1992-03-03", ""],
                ],
            )],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let seed_dry = i.dry_run(seed_run, decisions()).await;
    assert_eq!(seed_dry.review.blocking, 0, "{:?}", seed_dry.review.items);
    i.apply(seed_run, &seed_dry.dry_run_digest).await.unwrap();

    let (emp_rrn, emp_ni, emp_null): (uuid::Uuid, uuid::Uuid, uuid::Uuid) = (
        i.person("Pre Rrn").await.0,
        i.person("Pre NotIssued").await.0,
        i.person("Pre Null").await.0,
    );

    sqlx::query(
        "INSERT INTO audit_events (actor, action, target_type, target_id, trace_id, span_id, occurred_at, org_id) \
         VALUES ($1, 'employee.id_registered', 'employee', $2, 'trace', 'span', now(), $3)",
    )
    .bind(i.f.principal.user_id.as_uuid())
    .bind(emp_null.to_string())
    .bind(i.org())
    .execute(&i.owner)
    .await
    .unwrap();

    let run = i
        .preview(
            "add-rrn.xlsx",
            &[table(
                "Sheet1",
                0,
                &[
                    &["employee_number", "name", "hire_date", "rrn", "id_type"],
                    &["EMP-RRN", "Pre Rrn", "2024-01-01", "900101-1234567", "RRN"],
                    &[
                        "EMP-NI",
                        "Pre NotIssued",
                        "2029-01-01",
                        "900101-6000017",
                        "DOMESTIC_RESIDENCE",
                    ],
                    &[
                        "EMP-NULL",
                        "Pre Null",
                        "2024-01-01",
                        "920303-1234567",
                        "RRN",
                    ],
                ],
            )],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let dry = i.dry_run(run, decisions()).await;
    assert_eq!(dry.review.blocking, 0, "{:?}", dry.review.items);
    i.apply(run, &dry.dry_run_digest).await.unwrap();

    let after_apply: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT employee_number, id_type FROM employees WHERE org_id = $1 AND id = ANY($2) ORDER BY employee_number",
    )
    .bind(i.org())
    .bind([emp_rrn, emp_ni, emp_null])
    .fetch_all(&i.owner)
    .await
    .unwrap();
    assert_eq!(
        after_apply,
        vec![
            ("EMP-NI".into(), Some("DOMESTIC_RESIDENCE".into())),
            ("EMP-NULL".into(), Some("RRN".into())),
            ("EMP-RRN".into(), Some("RRN".into())),
        ]
    );

    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);

    i.f.hr
        .rollback_import(
            i.f.principal.clone(),
            run,
            RollbackRequest {
                preview_digest: preview.preview_digest,
                acknowledged: true,
                reason_code: Some("WRONG_FILE".into()),
                note: None,
                step_up: None,
            },
            None,
            SecondPersonContext {
                other_eligible_holders: 0,
                sole_holder_refuse: false,
                routed: false,
            },
        )
        .await
        .unwrap();

    let after_rollback: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT employee_number, id_type FROM employees WHERE org_id = $1 AND id = ANY($2) ORDER BY employee_number",
    )
    .bind(i.org())
    .bind([emp_rrn, emp_ni, emp_null])
    .fetch_all(&i.owner)
    .await
    .unwrap();
    assert_eq!(
        after_rollback,
        vec![
            ("EMP-NI".into(), Some("NOT_ISSUED".into())),
            ("EMP-NULL".into(), None),
            ("EMP-RRN".into(), Some("RRN".into())),
        ]
    );

    let rrn_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employee_rrn WHERE org_id = $1 AND employee_id = ANY($2)",
    )
    .bind(i.org())
    .bind([emp_rrn, emp_ni, emp_null])
    .fetch_one(&i.owner)
    .await
    .unwrap();
    assert_eq!(rrn_count, 0);
}
