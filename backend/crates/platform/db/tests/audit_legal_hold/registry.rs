// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "MIGRATOR")]
async fn one_hold_registry_and_no_owner_privilege_loss(pool: PgPool) {
    let parallel: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('audit_legal_holds')::text")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(parallel.is_none(), "holds must share the existing registry");
    let (target, actor) = fixture(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    // Replay production ownership: SQLx normally migrates as a bootstrap superuser.
    sqlx::query("ALTER TABLE docs_evidence_legal_holds OWNER TO console_app")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SET LOCAL ROLE console_app")
        .execute(&mut *tx)
        .await
        .unwrap();
    let hold: Uuid = sqlx::query_scalar("INSERT INTO docs_evidence_legal_holds(org_id,case_ref,basis,reason,applied_by,applied_at) VALUES($1,'OWNER-CASE','order','preserve',$2,now()) RETURNING id")
        .bind(target).bind(actor).fetch_one(&mut *tx).await.unwrap();
    sqlx::query("UPDATE docs_evidence_legal_holds SET status='RELEASED',released_by=$2,released_at=now(),release_reason='closed' WHERE id=$1")
        .bind(hold).bind(actor).execute(&mut *tx).await.unwrap();
    sqlx::query("SET LOCAL app.platform_force_remove_org = 'on'")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM docs_evidence_legal_holds WHERE org_id = $1")
        .bind(target)
        .execute(&mut *tx)
        .await
        .unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn owner_cannot_truncate_any_holds(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    let hold = place(&pool, target, actor).await;
    for released in [false, true] {
        if released {
            release(&pool, hold, actor).await;
        }
        refused(
            &sqlx::query("TRUNCATE docs_evidence_legal_holds")
                .execute(&pool)
                .await
                .unwrap_err(),
            "42501",
        );
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn owner_cannot_delete_released_hold_outside_force_removal(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    let hold = place(&pool, target, actor).await;
    release(&pool, hold, actor).await;
    refused(
        &sqlx::query("DELETE FROM docs_evidence_legal_holds WHERE id = $1")
            .bind(hold)
            .execute(&pool)
            .await
            .unwrap_err(),
        "55000",
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn held_command_returns_typed_denial_and_changes_nothing(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    let hold = place(&pool, target, actor).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_platform_force_cmd")
        .execute(&mut *tx)
        .await
        .unwrap();
    let outcome: String = sqlx::query_scalar("SELECT platform_force_remove_organization_command($1,$2,repeat('e',32)::char(32),repeat('f',16)::char(16),now())")
        .bind(target).bind(actor).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(outcome, "blocked_legal_hold");
    tx.commit().await.unwrap();
    let status: String =
        sqlx::query_scalar("SELECT status FROM docs_evidence_legal_holds WHERE id=$1")
            .bind(hold)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "ACTIVE");
    let denied: (String, String, String, String, String, Option<Uuid>) = sqlx::query_as("SELECT outcome,principal_type,actor_kind,source,trace_id,command_id FROM audit_events WHERE org_id=$1 AND action='platform.tenant.force_remove.refused'")
        .bind(target).fetch_one(&pool).await.unwrap();
    assert_eq!(
        (
            &denied.0[..],
            &denied.1[..],
            &denied.2[..],
            &denied.3[..],
            &denied.4[..]
        ),
        (
            "DENIED",
            "SUPPORT_OPERATOR",
            "SUPPORT_OPERATOR",
            "API",
            "e".repeat(32).as_str()
        )
    );
    assert!(denied.5.is_some());
}
