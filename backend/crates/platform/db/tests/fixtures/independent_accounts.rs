use super::*;

#[sqlx::test(migrator = "MIGRATOR")]
async fn distinct_accounts_without_employee_or_person_bindings_are_independent(pool: PgPool) {
    let p = parties(&pool).await;
    for account in [p.maker, p.independent] {
        sqlx::query("UPDATE users SET employee_id=NULL WHERE id=$1")
            .bind(account)
            .execute(&pool)
            .await
            .unwrap();
        let mut tx = decision_tx(&pool, &p, false).await;
        assert!(independent(&mut tx, &p).await);
        tx.rollback().await.unwrap();
    }
    // All existing decision triggers consume the same fact, including on older binaries.
    let run: Uuid = sqlx::query_scalar("INSERT INTO payroll_draft_runs (org_id,period_start,period_end,source_label,status,submitted_by) VALUES ($1,'2026-01-01','2026-01-31','unlinked','SUBMITTED',$2) RETURNING id")
        .bind(p.org).bind(p.maker).fetch_one(&pool).await.unwrap();
    let mut tx = decision_tx(&pool, &p, false).await;
    sqlx::query("UPDATE payroll_draft_runs SET status='APPROVED',decided_by=$2,decided_at=now() WHERE id=$1")
        .bind(run).bind(p.independent).execute(tx.as_mut()).await.unwrap();
    for decision in ["approved", "rejected"] {
        sqlx::query("INSERT INTO gov_approvals (org_id,request_ref,kind,requested_by,approver_id,decision) VALUES ($1,$2,'org_change_step',$3,$4,$5)")
            .bind(p.org).bind(Uuid::new_v4()).bind(p.maker).bind(p.independent).bind(decision).execute(tx.as_mut()).await.unwrap();
    }
    tx.commit().await.unwrap();
    let mut tx = decision_tx(&pool, &p, true).await;
    sqlx::query("INSERT INTO leave_requests (org_id,branch_id,requester_user_id,subject_employee_id,leave_type,days,start_date,end_date,status,decided_by,decided_at,charge_state,charge_units,charge_review_reasons) VALUES ($1,$2,$3,$4,'annual',1,'2026-01-01','2026-01-01','approved',$5,now(),'legacy_unverified',1,ARRAY[]::text[])")
        .bind(p.org).bind(p.branch).bind(p.maker).bind(p.employee).bind(p.independent).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn absent_binding_is_independent_and_locked_against_concurrent_insertion(pool: PgPool) {
    let p = parties(&pool).await;
    let employee: Uuid = sqlx::query_scalar("SELECT employee_id FROM users WHERE id=$1")
        .bind(p.independent)
        .fetch_one(&pool)
        .await
        .unwrap();
    let person: Uuid =
        sqlx::query_scalar("SELECT person_id FROM employee_person_bindings WHERE employee_id=$1")
            .bind(p.employee)
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("DELETE FROM employee_person_bindings WHERE employee_id=$1")
        .bind(employee)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = decision_tx(&pool, &p, false).await;
    assert!(independent(&mut tx, &p).await);
    let mut writer = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL lock_timeout='250ms'")
        .execute(writer.as_mut())
        .await
        .unwrap();
    let error = sqlx::query("INSERT INTO employee_person_bindings (org_id,employee_id,person_id,actor_id,payload_digest) VALUES ($1,$2,$3,$4,$5)")
        .bind(p.org).bind(employee).bind(person).bind(p.independent).bind([7u8;32].as_slice()).execute(writer.as_mut()).await.expect_err("a decision must retain an absent binding fact too");
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("55P03")
    );
    writer.rollback().await.unwrap();
    tx.commit().await.unwrap();
    sqlx::query("INSERT INTO employee_person_bindings (org_id,employee_id,person_id,actor_id,payload_digest) VALUES ($1,$2,$3,$4,$5)")
        .bind(p.org).bind(employee).bind(person).bind(p.independent).bind([7u8;32].as_slice()).execute(&pool).await.unwrap();
    let mut retry = decision_tx(&pool, &p, false).await;
    assert!(!independent(&mut retry, &p).await);
    retry.rollback().await.unwrap();
}
