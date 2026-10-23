// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "MIGRATOR")]
async fn runtime_cannot_control_holds_in_own_or_foreign_tenant(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    let foreign = org(&pool).await;
    let hold = place(&pool, target, actor).await;
    for scope in [target, foreign] {
        for command in [PLACE, RELEASE] {
            let mut tx = pool.begin().await.unwrap();
            sqlx::query("SET LOCAL ROLE console_rt")
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query("SELECT set_config('app.current_org', $1, true)")
                .bind(scope.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            let id = if command == PLACE { target } else { hold };
            refused(
                &sqlx::query(command)
                    .bind(id)
                    .bind(actor)
                    .execute(&mut *tx)
                    .await
                    .unwrap_err(),
                "42501",
            );
            tx.rollback().await.unwrap();
        }
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn runtime_cannot_insert_update_or_delete_holds(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    place(&pool, target, actor).await;
    for command in [
        "INSERT INTO docs_evidence_legal_holds (org_id, reason, applied_by) VALUES ($1, 'spoofed', $2)",
        "UPDATE docs_evidence_legal_holds SET reason = 'rewritten', applied_by = $2 WHERE org_id = $1",
        "DELETE FROM docs_evidence_legal_holds WHERE org_id = $1 AND applied_by = $2",
    ] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL ROLE console_rt")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(target.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        refused(
            &sqlx::query(command)
                .bind(target)
                .bind(actor)
                .execute(&mut *tx)
                .await
                .unwrap_err(),
            "42501",
        );
        tx.rollback().await.unwrap();
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn owner_cannot_rewrite_hold_evidence(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    let hold = place(&pool, target, actor).await;
    for assignment in [
        "reason = 'rewrite'",
        "applied_by = NULL",
        "case_ref = 'other'",
        "basis = 'other'",
        "org_id = gen_random_uuid()",
        "applied_at = now()",
        "id = gen_random_uuid()",
        "audit_event_id = gen_random_uuid()",
        "evidence_object_id = gen_random_uuid()",
    ] {
        let error = sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE docs_evidence_legal_holds SET status = 'RELEASED', released_by = $2, released_at = now(), release_reason = 'closed', {assignment} WHERE id = $1"
        )))
        .bind(hold)
        .bind(actor)
        .execute(&pool)
        .await
        .unwrap_err();
        refused(&error, "55000");
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn owner_cannot_reactivate_released_hold(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    let hold = place(&pool, target, actor).await;
    release(&pool, hold, actor).await;
    let error = sqlx::query("UPDATE docs_evidence_legal_holds SET status = 'ACTIVE', released_by = NULL, released_at = NULL, release_reason = NULL WHERE id = $1")
        .bind(hold).execute(&pool).await.unwrap_err();
    refused(&error, "55000");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn release_accepts_only_one_active_hold_id(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    let first = place(&pool, target, actor).await;
    let second: Uuid = sqlx::query_scalar(sqlx::AssertSqlSafe(PLACE.replace("CASE-42", "CASE-43")))
        .bind(target)
        .bind(actor)
        .fetch_one(&pool)
        .await
        .unwrap();
    for id in [target, Uuid::new_v4()] {
        refused(
            &sqlx::query(RELEASE)
                .bind(id)
                .bind(actor)
                .execute(&pool)
                .await
                .unwrap_err(),
            "P0002",
        );
    }
    release(&pool, first, actor).await;
    refused(
        &sqlx::query(RELEASE)
            .bind(first)
            .bind(actor)
            .execute(&pool)
            .await
            .unwrap_err(),
        "P0002",
    );
    let active: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM docs_evidence_legal_holds WHERE org_id = $1 AND status = 'ACTIVE'",
    )
    .bind(target)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(active, vec![second]);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn commands_require_accountable_actors(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    refused(
        &sqlx::query(PLACE)
            .bind(target)
            .bind(None::<Uuid>)
            .execute(&pool)
            .await
            .unwrap_err(),
        "22004",
    );
    let hold = place(&pool, target, actor).await;
    refused(
        &sqlx::query(RELEASE)
            .bind(hold)
            .bind(None::<Uuid>)
            .execute(&pool)
            .await
            .unwrap_err(),
        "22004",
    );
    let status: String =
        sqlx::query_scalar("SELECT status FROM docs_evidence_legal_holds WHERE id = $1")
            .bind(hold)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "ACTIVE");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn case_details_and_release_actor_are_required(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    for (case_ref, basis) in [("", "order"), ("case", " ")] {
        refused(&sqlx::query("SELECT audit_legal_hold_place($1, $2, $3, 'preserve', $4, repeat('a',32)::char(32), repeat('b',16)::char(16), now())")
            .bind(target).bind(case_ref).bind(basis).bind(actor).execute(&pool).await.unwrap_err(), "23514");
    }
    let hold = place(&pool, target, actor).await;
    refused(&sqlx::query("UPDATE docs_evidence_legal_holds SET status = 'RELEASED', released_at = now(), release_reason = 'closed' WHERE id = $1")
        .bind(hold).execute(&pool).await.unwrap_err(), "23514");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn runtime_reads_only_its_tenant_holds(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    let foreign = org(&pool).await;
    let hold = place(&pool, target, actor).await;
    place(&pool, foreign, actor).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(target.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let visible: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM docs_evidence_legal_holds")
        .fetch_all(&mut *tx)
        .await
        .unwrap();
    assert_eq!(visible, vec![hold]);
}
