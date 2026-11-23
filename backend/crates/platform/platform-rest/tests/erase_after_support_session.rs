// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[allow(dead_code)]
#[path = "fixtures/rename.rs"]
mod fixture;
#[path = "../../../../test_support/governed_erase.rs"]
mod governed_erase;
#[allow(dead_code)]
#[path = "fixtures/support_sessions.rs"]
mod support;

use console_kernel_core::OrgId;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use support::{READ, Support, ok};

async fn command_role_pool(owner: &PgPool) -> PgPool {
    let options = owner.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_platform_force_cmd")
                    .execute(conn)
                    .await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_with_support_session_can_be_archived_and_erased(owner: PgPool) {
    let mut h = Support::new(owner.clone()).await;
    let (session_id, token) = h.active().await;

    // Exercise an audited support read, then end the session cleanly.
    ok(
        h.send("GET", READ, Value::Null, &token).await,
        StatusCode::OK,
    );
    ok(
        h.send(
            "POST",
            &format!("/api/platform/support-sessions/{session_id}/end"),
            json!({ "org_id": h.org }),
            &h.a.token,
        )
        .await,
        StatusCode::OK,
    );

    let session_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM support_sessions WHERE org_id = $1")
            .bind(h.org)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(session_count, 1);

    let decision_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM support_session_decisions WHERE org_id = $1")
            .bind(h.org)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(
        decision_count >= 3,
        "expected request/approve/decide/end decisions"
    );

    // Archive and fulfill dual-control cooling erasure.
    ok(
        h.send(
            "PATCH",
            &format!("/api/platform/orgs/{}", h.org),
            json!({ "status": "ARCHIVED" }),
            &h.a.token,
        )
        .await,
        StatusCode::OK,
    );
    governed_erase::due(&owner, h.org, *h.b.id.as_uuid()).await;

    let force_pool = command_role_pool(&owner).await;
    let erased: i64 = sqlx::query_scalar("SELECT platform_run_due_tenant_erases()")
        .fetch_one(&force_pool)
        .await
        .unwrap();
    assert_eq!(erased, 1);

    // Organization and direct support-session child rows are removed; audit events are re-homed.
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SET LOCAL row_security = off")
        .execute(&mut *tx)
        .await
        .unwrap();
    let org_left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organizations WHERE id = $1")
        .bind(h.org)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let sessions_left: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM support_sessions WHERE org_id = $1")
            .bind(h.org)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let decisions_left: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM support_session_decisions WHERE org_id = $1")
            .bind(h.org)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let rehomed_audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE org_id = $1 AND target_id = $2",
    )
    .bind(OrgId::platform().as_uuid())
    .bind(session_id.to_string())
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(org_left, 0);
    assert_eq!(sessions_left, 0);
    assert_eq!(decisions_left, 0);
    assert!(
        rehomed_audits >= 2,
        "support audit events must survive re-homed to platform sentinel"
    );
}
