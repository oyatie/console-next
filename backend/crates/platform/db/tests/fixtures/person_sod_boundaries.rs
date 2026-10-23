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

async fn boundary(pool: &PgPool, sql: &'static str, code: &str, domain: &str, leave: bool) {
    let p = parties(pool).await;
    let unbound: Uuid = sqlx::query_scalar("INSERT INTO users (org_id,display_name,roles,is_tenant_ops) VALUES ($1,'Unbound',ARRAY['ADMIN'],true) RETURNING id")
        .bind(p.org).fetch_one(pool).await.unwrap();
    // A second account retains its canonical person even without an employee link.
    sqlx::query("UPDATE users SET employee_id=NULL WHERE id=$1")
        .bind(p.same_person_alias)
        .execute(pool)
        .await
        .unwrap();
    for (maker, checker, expected) in [
        (Some(p.maker), p.same_person, Some(code.to_owned())),
        (Some(p.maker), p.same_person_alias, Some(code.to_owned())),
        (Some(p.maker), p.maker, Some(code.to_owned())),
        (Some(p.same_person_alias), p.maker, Some(code.to_owned())),
        (
            Some(p.maker),
            unbound,
            Some(format!("{domain}.refuse.identity_unbound")),
        ),
        (
            Some(unbound),
            p.independent,
            Some(format!("{domain}.refuse.identity_unbound")),
        ),
        (
            None,
            p.independent,
            Some(format!("{domain}.refuse.identity_unbound")),
        ),
        (
            Some(p.maker),
            Uuid::new_v4(),
            Some(format!("{domain}.refuse.identity_unbound")),
        ),
        (Some(p.maker), p.independent, None),
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
        if let Some(expected) = expected {
            let error = result.expect_err("SQL must refuse missing or shared person identities");
            let error = error.as_database_error().unwrap();
            assert_eq!(error.code().as_deref(), Some("42501"));
            assert_eq!(error.message(), expected);
        } else {
            result.unwrap();
            sqlx::query("SET LOCAL ROLE NONE")
                .execute(tx.as_mut())
                .await
                .unwrap();
            let (snapshot, after): (Option<serde_json::Value>, serde_json::Value) = sqlx::query_as(
                "INSERT INTO audit_events (org_id,actor,action,target_type,target_id,trace_id,span_id,occurred_at) \
                 VALUES ($1,$2,'sod.test','decision','test',repeat('a',32),repeat('b',16),now()) \
                 RETURNING decision_snapshot,after_snap")
                .bind(p.org).bind(checker).fetch_one(tx.as_mut()).await.unwrap();
            assert!(
                snapshot.is_none_or(|v| !v.to_string().contains("sod.")),
                "identity values never enter the policy-version snapshot"
            );
            assert_eq!(after["independence"]["maker"], maker.unwrap().to_string());
            assert_eq!(after["independence"]["checker"], checker.to_string());
            assert!(after["independence"]["maker_person"].is_string());
            assert!(after["independence"]["checker_person"].is_string());
        }
        tx.rollback().await.unwrap();
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn org_change_invariant_requires_known_distinct_people(pool: PgPool) {
    boundary(
        &pool,
        ORG_CHANGE,
        "org_change_decide.sod_violation",
        "org_change",
        false,
    )
    .await;
}
#[sqlx::test(migrator = "MIGRATOR")]
async fn payroll_invariant_requires_known_distinct_people(pool: PgPool) {
    boundary(
        &pool,
        PAYROLL,
        "payroll_decide.sod_violation",
        "payroll",
        false,
    )
    .await;
}
#[sqlx::test(migrator = "MIGRATOR")]
async fn leave_invariant_requires_known_distinct_people(pool: PgPool) {
    boundary(
        &pool,
        LEAVE,
        "leave_decide.requester_forbidden",
        "leave",
        true,
    )
    .await;
}
#[sqlx::test(migrator = "MIGRATOR")]
async fn period_unlock_invariant_requires_known_distinct_people(pool: PgPool) {
    boundary(
        &pool,
        UNLOCK,
        "second_person_required",
        "period_unlock",
        false,
    )
    .await;
}
#[sqlx::test(migrator = "MIGRATOR")]
async fn period_lock_invariant_requires_known_distinct_people(pool: PgPool) {
    boundary(
        &pool,
        LOCK,
        "second_person_required",
        "period_unlock",
        false,
    )
    .await;
}

async fn unbound_boundary(pool: &PgPool, sql: &'static str, domain: &str, leave: bool) {
    let p = parties(pool).await;
    let unbound:Uuid=sqlx::query_scalar("INSERT INTO users(org_id,display_name,is_tenant_ops) VALUES($1,'Unbound',true) RETURNING id").bind(p.org).fetch_one(pool).await.unwrap();
    for (maker, checker) in [(p.maker, unbound), (unbound, p.independent)] {
        let mut tx = decision_tx(pool, &p, leave).await;
        let error = sqlx::query(sql)
            .bind(p.org)
            .bind(maker)
            .bind(checker)
            .bind(p.employee)
            .bind(p.branch)
            .execute(tx.as_mut())
            .await
            .expect_err("a missing person binding must refuse");
        assert_eq!(
            error.as_database_error().unwrap().message(),
            format!("{domain}.refuse.identity_unbound")
        );
        tx.rollback().await.unwrap();
    }
}
#[sqlx::test(migrator = "MIGRATOR")]
async fn org_change_refuses_identity_unbound(pool: PgPool) {
    unbound_boundary(&pool, ORG_CHANGE, "org_change", false).await;
}
#[sqlx::test(migrator = "MIGRATOR")]
async fn leave_refuses_identity_unbound(pool: PgPool) {
    unbound_boundary(&pool, LEAVE, "leave", true).await;
}
#[sqlx::test(migrator = "MIGRATOR")]
async fn payroll_refuses_identity_unbound(pool: PgPool) {
    unbound_boundary(&pool, PAYROLL, "payroll", false).await;
}
#[sqlx::test(migrator = "MIGRATOR")]
async fn period_unlock_refuses_identity_unbound(pool: PgPool) {
    unbound_boundary(&pool, UNLOCK, "period_unlock", false).await;
}
#[sqlx::test(migrator = "MIGRATOR")]
async fn period_lock_refuses_identity_unbound(pool: PgPool) {
    unbound_boundary(&pool, LOCK, "period_unlock", false).await;
}
