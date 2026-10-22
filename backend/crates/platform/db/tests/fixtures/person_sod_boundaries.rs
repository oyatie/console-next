// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

macro_rules! boundary_sql {
    ($sql:literal) => { concat!("WITH args AS (SELECT $1::uuid org, $2::uuid maker, $3::uuid checker, $4::uuid employee, $5::uuid branch) ", $sql) };
}
const PAYROLL: &str = boundary_sql!(
    "INSERT INTO payroll_draft_runs (org_id,period_start,period_end,source_label,status,submitted_by,decided_by,decided_at) SELECT org,'2026-01-01','2026-01-31','sod','APPROVED',maker,checker,now() FROM args"
);
const ORG_CHANGE: &str = boundary_sql!(
    "INSERT INTO gov_approvals (org_id,request_ref,kind,requested_by,approver_id,decision) SELECT org,gen_random_uuid(),'org_change_step',maker,checker,'approved' FROM args"
);
const LEAVE: &str = boundary_sql!(
    "INSERT INTO leave_requests (org_id,branch_id,requester_user_id,subject_employee_id,leave_type,days,start_date,end_date,status,decided_by,decided_at,charge_state,charge_units,charge_review_reasons) SELECT org,branch,maker,employee,'annual',1,'2026-01-01','2026-01-01','approved',checker,now(),'legacy_unverified',1,ARRAY[]::text[] FROM args"
);
const UNLOCK: &str = boundary_sql!(
    ", locked AS (INSERT INTO period_locks (org_id,domain,period_start,period_end,reason_code) SELECT org,'payroll','2026-01-01','2026-01-31','MONTHLY_PAYROLL_CLOSE' FROM args RETURNING id) INSERT INTO period_unlock_requests (org_id,lock_id,requested_by,reason_code,relock_at,step_up_assertion_id,outcome,decided_by,decided_at) SELECT org,locked.id,maker,'PAYROLL_ERROR',now()+interval '1 day',gen_random_uuid(),'APPROVED',checker,now() FROM args,locked"
);

const LOCK: &str = boundary_sql!(
    "INSERT INTO period_locks (org_id,domain,period_start,period_end,reason_code,unlocked_at,unlocked_by,unlock_approved_by,unlock_reason_code,relock_at) SELECT org,'payroll','2026-01-01','2026-01-31','MONTHLY_PAYROLL_CLOSE',now(),maker,checker,'PAYROLL_ERROR',now()+interval '1 day' FROM args"
);

async fn boundary(pool: &PgPool, sql: &'static str, code: &str, leave: bool) {
    let p = parties(pool).await;
    let unknown: Uuid = sqlx::query_scalar("INSERT INTO users (org_id,display_name,roles) VALUES ($1,'Unknown',ARRAY['ADMIN']) RETURNING id")
        .bind(p.org).fetch_one(pool).await.unwrap();
    for (maker, checker, allowed) in [
        (p.maker, p.independent, true),
        (p.maker, p.maker, false),
        (p.maker, p.same_person, false),
        (p.maker, unknown, false),
        (unknown, p.independent, false),
    ] {
        let mut tx = decision_tx(pool, &p, leave).await;
        let result = sqlx::query(sql)
            .bind(p.org)
            .bind(maker)
            .bind(checker)
            .bind(p.employee)
            .bind(p.branch)
            .execute(tx.as_mut())
            .await;
        if allowed {
            result.unwrap();
        } else {
            let error =
                result.expect_err("database invariant must refuse unknown or shared people");
            let error = error.as_database_error().unwrap();
            assert_eq!(error.code().as_deref(), Some("42501"));
            assert_eq!(error.message(), code);
        }
        tx.rollback().await.unwrap();
    }
    // An employee link without a person binding is also an unknown identity.
    sqlx::query("DELETE FROM employee_person_bindings WHERE employee_id=(SELECT employee_id FROM users WHERE id=$1)")
        .bind(p.independent).execute(pool).await.unwrap();
    let mut tx = decision_tx(pool, &p, leave).await;
    let error = sqlx::query(sql)
        .bind(p.org)
        .bind(p.maker)
        .bind(p.independent)
        .bind(p.employee)
        .bind(p.branch)
        .execute(tx.as_mut())
        .await
        .expect_err("missing binding must refuse");
    assert_eq!(error.as_database_error().unwrap().message(), code);
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn org_change_invariant_requires_known_distinct_people(pool: PgPool) {
    boundary(&pool, ORG_CHANGE, "org_change_decide.sod_violation", false).await;
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn payroll_invariant_requires_known_distinct_people(pool: PgPool) {
    boundary(&pool, PAYROLL, "payroll_decide.sod_violation", false).await;
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn leave_invariant_requires_known_distinct_people(pool: PgPool) {
    boundary(&pool, LEAVE, "leave_decide.requester_forbidden", true).await;
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn period_unlock_invariant_requires_known_distinct_people(pool: PgPool) {
    boundary(&pool, UNLOCK, "second_person_required", false).await;
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn period_lock_invariant_requires_known_distinct_people(pool: PgPool) {
    boundary(&pool, LOCK, "second_person_required", false).await;
}
