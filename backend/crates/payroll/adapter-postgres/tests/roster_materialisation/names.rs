//! A dated assignment and the 법인명 in force (once its 등록증 is confirmed), never an employee's imported label, own payslip names.
use super::seed::*;
use console_kernel_core::kr::synthetic;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn payroll_uses_the_periods_exact_certificate_spelling(pool: PgPool) {
    let f = seed_org_and_run(&pool).await;
    let person = seed_employee(&pool, f.org, "registered-person", "김직원").await;
    let entity = Uuid::new_v4();
    let registration = Uuid::new_v4();
    sqlx::query("INSERT INTO legal_entities (org_id,id,biz_kind,created_change_mode) VALUES ($1,$2,'CORPORATION','MIGRATION')")
        .bind(f.org).bind(entity).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO business_registrations (org_id,id,legal_entity_id,brn,created_change_mode) VALUES ($1,$2,$3,$4,'MIGRATION')")
        .bind(f.org).bind(registration).bind(entity).bind(synthetic::brn(81, 2).replace('-', "")).execute(&pool).await.unwrap();
    for (version, on, name) in [
        (1, PERIOD_START, "주식회사 가나테크"),
        (2, time::macros::date!(2030 - 01 - 01), "주식회사 미래"),
    ] {
        // The 법인명 has one stored source; the registration's own column is a shadow nobody reads.
        sqlx::query("INSERT INTO legal_entity_revisions (org_id,legal_entity_id,version,command_id,effective_from,name,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,$3,$4,$5,$6,'MIGRATION','CREATE',decode(repeat('00',32),'hex'),'{}')")
            .bind(f.org).bind(entity).bind(version).bind(Uuid::new_v4()).bind(on).bind(name).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO business_registration_revisions (org_id,registration_id,version,command_id,effective_from,trade_name,opened_on,status,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,$3,$4,$5,'GANATECH',$5,'CONTINUING','MIGRATION','CREATE',decode(repeat('00',32),'hex'),'{}')")
            .bind(f.org).bind(registration).bind(version).bind(Uuid::new_v4()).bind(on).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,valid_from,cause,command_id) VALUES ($1,$2,$3,$4,'MIGRATION',$5)")
        .bind(f.org).bind(person).bind(entity).bind(PERIOD_START).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    seed_import(
        &pool,
        f.org,
        "APPLIED",
        "CANDIDATE",
        (PERIOD_START, PERIOD_END),
        "registered-person",
        attendance_row(),
    )
    .await;
    assert_eq!(materialise(&pool, &f).await, 1);
    let printed: String =
        sqlx::query_scalar("SELECT employee_company FROM payroll_draft_lines WHERE run_id = $1")
            .bind(f.run)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(printed, "주식회사 가나테크");
}
