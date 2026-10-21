#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::OrgId;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[path = "fixtures/person_sod_locks.rs"]
mod locks;
use locks::independent;
#[path = "fixtures/independent_accounts.rs"]
mod independent_accounts;

struct Parties {
    org: Uuid,
    maker: Uuid,
    same_person: Uuid,
    independent: Uuid,
    same_person_alias: Uuid,
    employee: Uuid,
    branch: Uuid,
}

async fn parties(pool: &PgPool) -> Parties {
    let org = *OrgId::one().as_uuid();
    sqlx::query("INSERT INTO organizations (id,slug,name) VALUES ($1,'sod','SoD') ON CONFLICT (id) DO NOTHING")
        .bind(org).execute(pool).await.unwrap();
    let person: Uuid = sqlx::query_scalar("INSERT INTO persons (org_id) VALUES ($1) RETURNING id")
        .bind(org)
        .fetch_one(pool)
        .await
        .unwrap();
    let independent_person: Uuid =
        sqlx::query_scalar("INSERT INTO persons (org_id) VALUES ($1) RETURNING id")
            .bind(org)
            .fetch_one(pool)
            .await
            .unwrap();
    let mut accounts = Vec::new();
    let mut employees = Vec::new();
    for linked_person in [
        Some(person),
        Some(person),
        Some(independent_person),
        Some(person),
    ] {
        let account = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id,org_id,display_name,roles) VALUES ($1,$2,'Decider',ARRAY['ADMIN'])")
            .bind(account).bind(org).execute(pool).await.unwrap();
        accounts.push(account);
        if let Some(person) = linked_person {
            let employee: Uuid = sqlx::query_scalar("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key) VALUES ($1,'ACME','Decider','test','test',1,$2) RETURNING id")
                .bind(org).bind(account.to_string()).fetch_one(pool).await.unwrap();
            sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2")
                .bind(employee)
                .bind(account)
                .execute(pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO employee_person_bindings (org_id,employee_id,person_id,actor_id,payload_digest) VALUES ($1,$2,$3,$4,$5)")
                .bind(org).bind(employee).bind(person).bind(account).bind([7u8;32].as_slice())
                .execute(pool).await.unwrap();
            employees.push(employee);
        }
    }
    let region: Uuid =
        sqlx::query_scalar("INSERT INTO regions (org_id,name) VALUES ($1,'SoD') RETURNING id")
            .bind(org)
            .fetch_one(pool)
            .await
            .unwrap();
    let branch: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (org_id,region_id,name) VALUES ($1,$2,'SoD') RETURNING id",
    )
    .bind(org)
    .bind(region)
    .fetch_one(pool)
    .await
    .unwrap();
    Parties {
        org,
        maker: accounts[0],
        same_person: accounts[1],
        independent: accounts[2],
        same_person_alias: accounts[3],
        employee: employees[0],
        branch,
    }
}

async fn decision_tx(pool: &PgPool, p: &Parties, leave: bool) -> Transaction<'static, Postgres> {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query(if leave {
        "SET LOCAL ROLE console_leave_definer"
    } else {
        "SET LOCAL ROLE console_rt"
    })
    .execute(tx.as_mut())
    .await
    .unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(p.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx
}

fn refused(result: Result<sqlx::postgres::PgQueryResult, sqlx::Error>) {
    let error = result.expect_err("different accounts for one person must not decide");
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn payroll_sod_refuses_same_person_accounts_and_missing_maker(pool: PgPool) {
    let p = parties(&pool).await;
    for (maker, checker) in [
        (Some(p.maker), p.same_person),
        (Some(p.maker), p.same_person_alias),
        (None, p.independent),
    ] {
        let run: Uuid = sqlx::query_scalar("INSERT INTO payroll_draft_runs (org_id,period_start,period_end,source_label,status,submitted_by) VALUES ($1,'2026-01-01','2026-01-31',$2,'SUBMITTED',$3) RETURNING id")
            .bind(p.org).bind(Uuid::new_v4().to_string()).bind(maker).fetch_one(&pool).await.unwrap();
        let mut tx = decision_tx(&pool, &p, false).await;
        refused(sqlx::query("UPDATE payroll_draft_runs SET status='APPROVED',decided_by=$2,decided_at=now() WHERE id=$1")
            .bind(run).bind(checker).execute(tx.as_mut()).await);
        tx.rollback().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT status FROM payroll_draft_runs WHERE id=$1")
                .bind(run)
                .fetch_one(&pool)
                .await
                .unwrap(),
            "SUBMITTED"
        );
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn leave_sod_refuses_same_person_accounts_checker(pool: PgPool) {
    let p = parties(&pool).await;
    for checker in [p.same_person, p.same_person_alias] {
        let mut tx = decision_tx(&pool, &p, true).await;
        refused(sqlx::query("INSERT INTO leave_requests (org_id,branch_id,requester_user_id,subject_employee_id,leave_type,days,start_date,end_date,status,decided_by,decided_at,charge_state,charge_units,charge_review_reasons) VALUES ($1,$2,$3,$4,'annual',1,'2026-01-01','2026-01-01','approved',$5,now(),'legacy_unverified',1,ARRAY[]::text[])")
            .bind(p.org).bind(p.branch).bind(p.maker).bind(p.employee).bind(checker)
            .execute(tx.as_mut()).await);
        tx.rollback().await.unwrap();
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM leave_requests")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn org_change_sod_refuses_same_person_accounts_checker(pool: PgPool) {
    let p = parties(&pool).await;
    for checker in [p.same_person, p.same_person_alias] {
        let mut tx = decision_tx(&pool, &p, false).await;
        refused(sqlx::query("INSERT INTO gov_approvals (org_id,request_ref,kind,requested_by,approver_id,decision) VALUES ($1,$2,'org_change_step',$3,$4,'approved')")
            .bind(p.org).bind(Uuid::new_v4()).bind(p.maker).bind(checker).execute(tx.as_mut()).await);
        tx.rollback().await.unwrap();
    }
    let mut tx = decision_tx(&pool, &p, false).await;
    sqlx::query("INSERT INTO gov_approvals (org_id,request_ref,kind,requested_by,approver_id,decision) VALUES ($1,$2,'org_change_step',$3,$4,'approved')")
        .bind(p.org).bind(Uuid::new_v4()).bind(p.maker).bind(p.independent).execute(tx.as_mut()).await.unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM gov_approvals")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}
