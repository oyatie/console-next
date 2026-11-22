// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_hr_adapter_postgres::directory::types::CreateEmployeeRequest;
use console_hr_domain::import::detect::WorkbookMappingRequest;
use console_leave_adapter_postgres::PgLeaveStore;
use serde_json::json;
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

use crate::harness::{decisions, importer, table};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn prehire_nbsp_name_uniqueness_caught_in_dry_run_and_never_500_on_apply(pool: PgPool) {
    let i = importer(pool.clone()).await;
    let org_id = i.org();
    let actor_id = *i.f.principal.user_id.as_uuid();
    let unit_id = Uuid::new_v4();
    sqlx::query("INSERT INTO org_units (org_id, id) VALUES ($1, $2)")
        .bind(org_id)
        .bind(unit_id)
        .execute(&i.owner)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO org_unit_revisions \
         (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
         VALUES ($1, $2, 1, gen_random_uuid(), $3, decode(repeat('00', 32), 'hex'), \
                 '{\"name\": \"site\", \"kind\": \"site\"}'::jsonb, '{}'::jsonb)",
    )
    .bind(org_id)
    .bind(unit_id)
    .bind(actor_id)
    .execute(&i.owner)
    .await
    .unwrap();

    let inbox = Arc::new(console_inbox_adapter_postgres::PgInboxStore::new(
        i.f.hr.pool().clone(),
    ));
    let leave_store = PgLeaveStore::new(i.f.hr.pool().clone(), inbox);

    let create_req = |name: &str, phone: &str| -> CreateEmployeeRequest {
        serde_json::from_value(json!({
            "idempotency_key": Uuid::new_v4().to_string(),
            "company": "Acme Co",
            "employment_type": "REGULAR",
            "phone": phone,
            "org_unit_id": unit_id,
            "position": "Staff",
            "site": "HQ",
            "name": name,
            "hire_date": "2029-05-01",
            "birth_date": "1994-04-04",
            "id_type": "NOT_ISSUED"
        }))
        .unwrap()
    };

    // 1. Register "Kim\u{00A0}Nbsp" (PRE_HIRE + NOT_ISSUED) on file.
    let (status, _) = console_platform_request_context::scope_org(
        i.f.principal.org_id,
        i.f.hr.create_employee(
            i.f.principal.clone(),
            leave_store.clone(),
            create_req("Kim\u{00A0}Nbsp", "010-1234-5678"),
        ),
    )
    .await
    .unwrap();
    assert_eq!(status, 201);

    // Second create_employee with "Kim\u{00A0}Nbsp" is refused 409 duplicate_candidate.
    let create_dup_err = console_platform_request_context::scope_org(
        i.f.principal.org_id,
        i.f.hr.create_employee(
            i.f.principal.clone(),
            leave_store.clone(),
            create_req("Kim\u{00A0}Nbsp", "010-9999-0000"),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (create_dup_err.status.as_u16(), create_dup_err.code),
        (409, "duplicate_candidate")
    );

    // 2. On-file NBSP match: dry_run catches both exact and case-variant NBSP names.
    let on_file_run = i
        .preview(
            "nbsp-on-file.xlsx",
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
                        "NBSP-1",
                        "Kim\u{00A0}Nbsp",
                        "2029-06-01",
                        "1994-04-04",
                        "NOT_ISSUED",
                    ],
                    &[
                        "NBSP-2",
                        "KIM\u{00A0}NBSP",
                        "2029-06-01",
                        "1994-04-04",
                        "NOT_ISSUED",
                    ],
                ],
            )],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let on_file_plan = i.dry_run(on_file_run, decisions()).await;
    assert_eq!(on_file_plan.review.blocking, 2, "{:?}", on_file_plan.rows);
    assert_eq!(on_file_plan.rows[0].outcome, "refused");
    assert_eq!(on_file_plan.rows[0].refusal_code, Some("duplicate_in_file"));
    assert_eq!(on_file_plan.rows[1].outcome, "refused");
    assert_eq!(on_file_plan.rows[1].refusal_code, Some("duplicate_in_file"));

    // 3. In-file NBSP duplicate: dry_run catches two NBSP rows in the same file.
    let in_file_run = i
        .preview(
            "nbsp-in-file.xlsx",
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
                        "NBSP-3",
                        "Park\u{00A0}Nbsp",
                        "2029-06-01",
                        "1994-04-04",
                        "NOT_ISSUED",
                    ],
                    &[
                        "NBSP-4",
                        "park\u{00A0}nbsp",
                        "2029-06-01",
                        "1994-04-04",
                        "NOT_ISSUED",
                    ],
                ],
            )],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let in_file_plan = i.dry_run(in_file_run, decisions()).await;
    assert_eq!(in_file_plan.review.blocking, 2, "{:?}", in_file_plan.rows);
    assert_eq!(in_file_plan.rows[0].refusal_code, Some("duplicate_in_file"));
    assert_eq!(in_file_plan.rows[1].refusal_code, Some("duplicate_in_file"));

    // 4. ASCII space vs NBSP matches Postgres index semantics cleanly without collision.
    let ascii_run = i
        .preview(
            "nbsp-ascii.xlsx",
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
                        "NBSP-5",
                        "Kim Nbsp",
                        "2029-06-01",
                        "1994-04-04",
                        "NOT_ISSUED",
                    ],
                ],
            )],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let ascii_plan = i.dry_run(ascii_run, decisions()).await;
    assert_eq!(ascii_plan.review.blocking, 0, "{:?}", ascii_plan.review);
    let ascii_report = i
        .apply(ascii_run, &ascii_plan.dry_run_digest)
        .await
        .unwrap();
    assert_eq!(ascii_report.inserted, 1);

    // 5. Concurrent creation between dry_run and apply returns 409, never 500.
    let race_run = i
        .preview(
            "nbsp-race.xlsx",
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
                        "NBSP-6",
                        "Race\u{00A0}Nbsp",
                        "2029-06-01",
                        "1994-04-04",
                        "NOT_ISSUED",
                    ],
                ],
            )],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let race_plan = i.dry_run(race_run, decisions()).await;
    assert_eq!(race_plan.review.blocking, 0);

    let (race_status, _) = console_platform_request_context::scope_org(
        i.f.principal.org_id,
        i.f.hr.create_employee(
            i.f.principal.clone(),
            leave_store,
            create_req("Race\u{00A0}Nbsp", "010-7777-8888"),
        ),
    )
    .await
    .unwrap();
    assert_eq!(race_status, 201);

    let apply_err = i
        .apply(race_run, &race_plan.dry_run_digest)
        .await
        .unwrap_err();
    assert_eq!(apply_err.status, 409);
}
