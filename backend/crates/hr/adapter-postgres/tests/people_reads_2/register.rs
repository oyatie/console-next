//! The 근로자 명부 export layout (SC-HRR-003) and its manage gate.

use console_hr_adapter_postgres::directory::read_export::ExportPurposeQuery;
use futures::StreamExt;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::fixtures::fixture;
use crate::support::{employee, principal, query, tenant, user};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_layout_writes_the_form_16_columns_and_derives_the_retirement_date(pool: PgPool) {
    let t = tenant(&pool).await;
    let hr_user = user(&pool, t.org, None).await;
    let person = employee(&pool, t.org, "Kim", "E-1", "EXITED").await;
    fixture(
        &pool,
        "UPDATE employees SET birth_date = '1990-05-01', hire_date = '2024-03-02', hire_on = '2024-03-02', job = '정비', \
         worksite_name = '서울본사', exit_date = '2026-09-30', exit_on = '2026-09-30' WHERE org_id = $1 AND id = $2",
        t.org,
        &[person],
    )
    .await;
    fixture(
        &pool,
        "INSERT INTO employee_employment_profiles (employee_id, org_id, employment_type, phone_e164, \
         base_pay, idempotency_key, request_hash, created_by) \
         VALUES ($2, $1, 'CONTRACT', '+821012345678', 0, 'profile-key', repeat('a', 64), $3)",
        t.org,
        &[person, *hr_user.as_uuid()],
    )
    .await;
    fixture(
        &pool,
        "INSERT INTO employee_contracts (org_id, employee_id, command_id, kind, start_date, end_date, \
         wage_won, pay_unit, weekly_minutes, created_by) \
         VALUES ($1, $2, gen_random_uuid(), 'FIXED_TERM', '2024-03-02', '2026-09-30', 2500000, 'MONTHLY', 2400, $3)",
        t.org,
        &[person, *hr_user.as_uuid()],
    )
    .await;

    // 사업장 by id (E-S3a): the register names the workplace's current name,
    // and `workplace_id` leaves out the employee assigned nowhere.
    let workplace = Uuid::new_v4();
    fixture(
        &pool,
        "WITH le AS (INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) \
           VALUES ($1, $3, true, 'MIGRATION')), \
         wp AS (INSERT INTO workplaces (org_id, id, legal_entity_id, needs_confirmation, created_change_mode) \
           VALUES ($1, $4, $3, true, 'MIGRATION')), \
         wr AS (INSERT INTO workplace_revisions (org_id, workplace_id, version, command_id, effective_from, \
           name, status, change_mode, reason_code, payload_digest, settings_snapshot) \
           VALUES ($1, $4, 1, gen_random_uuid(), '2020-01-01', '서울 본사', 'CONTINUING', 'MIGRATION', \
           'test', sha256('x'::bytea), '{}')) \
         INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, \
           valid_from, cause, command_id) \
         VALUES ($1, $2, $3, $4, '2024-03-02', 'MIGRATION', gen_random_uuid())",
        t.org,
        &[person, Uuid::new_v4(), workplace],
    )
    .await;
    employee(&pool, t.org, "Lee", "E-2", "ACTIVE").await;

    let (file_name, chunks) =
        t.hr.export_employees_csv(
            principal(t.org, hr_user),
            query(json!({ "workplace_id": workplace })),
            ExportPurposeQuery {
                export_purpose: Some("AUDIT_RESPONSE".to_owned()),
                layout: Some("register".to_owned()),
            },
        )
        .await
        .unwrap();
    assert_eq!(file_name, "employees-register.csv");
    let body = chunks
        .map(|chunk| chunk.unwrap())
        .collect::<Vec<_>>()
        .await
        .concat();
    let lines: Vec<_> = body
        .trim_start_matches('\u{feff}')
        .trim_end()
        .split("\r\n")
        .collect();
    assert_eq!(
        lines,
        [
            "사번,성명,성별,생년월일,주소,전화번호,사업장,소속,종사 업무,고용일,갱신일,계약기간,마지막 근무일,퇴직일,퇴직(해고) 사유,이력,그 밖에 필요한 사항",
            "E-1,Kim,,1990-05-01,,'+821012345678,서울 본사,,정비,2024-03-02,,2024-03-02~2026-09-30,2026-09-30,2026-10-01,,,",
        ]
    );
    let logged: String =
        sqlx::query_scalar("SELECT file_name FROM excel_export_logs WHERE org_id = $1")
            .bind(t.org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(logged, "employees-register.csv");
}

/// The register carries 생년월일 and the personal phone: a directory reader
/// without `employee_directory_manage` (EXECUTIVE) may export the standard
/// columns but never the register, and the refusal logs no download.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_layout_is_refused_to_a_reader_without_manage(pool: PgPool) {
    let t = tenant(&pool).await;
    let hr_user = user(&pool, t.org, None).await;
    employee(&pool, t.org, "Kim", "E-1", "ACTIVE").await;
    let executive = console_platform_authz::Principal::new(
        hr_user,
        console_kernel_core::OrgId::from_uuid(t.org),
        std::collections::BTreeSet::from([console_platform_authz::Role::Executive]),
        console_kernel_core::BranchScope::All,
    );
    let export = |layout: &str| ExportPurposeQuery {
        export_purpose: Some("AUDIT_RESPONSE".to_owned()),
        layout: Some(layout.to_owned()),
    };

    let Err(err) =
        t.hr.export_employees_csv(executive.clone(), query(json!({})), export("register"))
            .await
    else {
        panic!("a reader without manage exported the register");
    };
    assert_eq!(err.status.as_u16(), 403);
    let logged: i64 =
        sqlx::query_scalar("SELECT count(*) FROM excel_export_logs WHERE org_id = $1")
            .bind(t.org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(logged, 0);

    t.hr.export_employees_csv(executive, query(json!({})), export("standard"))
        .await
        .unwrap();
}
