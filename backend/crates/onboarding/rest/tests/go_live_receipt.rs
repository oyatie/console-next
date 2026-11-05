// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use common::*;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

const PATH: &str = "/api/v1/onboarding/go-live/receipt";

async fn recorded(owner: &PgPool, h: &Harness) -> Value {
    let facts = json!({"entities": 7, "employees": 0, "phase_is_setup": true});
    // rls-arming: ok owner seeds a historical receipt; requests use the runtime role.
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING', go_live_at=now(), go_live_by=$2, go_live_preview_digest=$3, go_live_facts_snapshot=$4 WHERE org_id=$1")
        .bind(h.actor.org.as_uuid()).bind(h.actor.user.as_uuid()).bind("a".repeat(64)).bind(&facts)
        .execute(owner).await.unwrap();
    facts
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn receipt_is_not_found_before_go_live_or_for_backfilled_tenants(owner: PgPool) {
    let h = harness(&owner, true).await;
    for operating in [false, true] {
        if operating {
            // rls-arming: ok a pre-console tenant has no recorded go-live.
            sqlx::query("UPDATE tenant_phase SET phase='OPERATING' WHERE org_id=$1")
                .bind(h.actor.org.as_uuid())
                .execute(&owner)
                .await
                .unwrap();
        }
        assert_refused(
            &owner,
            &h,
            "GET",
            PATH,
            Value::Null,
            (StatusCode::NOT_FOUND, "go_live_receipt_not_found", None),
        )
        .await;
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_receipt_returns_stored_metadata_and_an_explicit_missing_snapshot(owner: PgPool) {
    let h = harness(&owner, true).await;
    let runtime = console_platform_test_support::runtime_role_pool(&owner).await;
    let mut tx = runtime.begin().await.unwrap();
    // rls-arming: ok rehearse the old writer under the runtime role after the expand migration.
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(h.actor.org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at=now(),go_live_by=$2,go_live_preview_digest=$3 WHERE org_id=$1")
        .bind(h.actor.org.as_uuid()).bind(h.actor.user.as_uuid()).bind("b".repeat(64))
        .execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let (status, receipt) = send(&h, "GET", PATH, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(receipt["go_live_by"], h.actor.user.as_uuid().to_string());
    assert_eq!(receipt["preview_digest"], "b".repeat(64));
    assert_eq!(receipt.get("facts_snapshot"), Some(&Value::Null));
    assert_eq!(receipt["facts_snapshot_version"], 1);
    let error = sqlx::query("UPDATE tenant_phase SET go_live_facts_snapshot='{}' WHERE org_id=$1")
        .bind(h.actor.org.as_uuid())
        .execute(&owner)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("P0001")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn receipt_is_stored_tenant_local_and_write_once(owner: PgPool) {
    let h = harness(&owner, true).await;
    let other = harness(&owner, true).await;
    let facts = recorded(&owner, &h).await;
    let (status, receipt) = send(&h, "GET", PATH, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    assert_eq!(receipt["facts_snapshot"], facts);
    assert_eq!(receipt["facts_snapshot_version"], 1);
    assert_eq!(receipt["preview_digest"], "a".repeat(64));
    assert_eq!(receipt["go_live_by"], h.actor.user.as_uuid().to_string());
    assert!(receipt["go_live_at"].as_str().is_some());
    // A query parameter cannot select another tenant's receipt.
    let (status, body) = send(
        &other,
        "GET",
        &format!("{PATH}?org_id={}", h.actor.org.as_uuid()),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    for replacement in [json!({"entities": 99}), Value::Null] {
        let result =
            sqlx::query("UPDATE tenant_phase SET go_live_facts_snapshot=$2 WHERE org_id=$1")
                .bind(h.actor.org.as_uuid())
                .bind(replacement)
                .execute(&owner)
                .await;
        assert!(result.is_err(), "historical facts must remain immutable");
    }
    // Current setup facts change; the read must not rebuild the preview.
    sqlx::query("INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION')")
        .bind(h.actor.org.as_uuid()).bind(Uuid::new_v4()).execute(&owner).await.unwrap();
    assert_eq!(send(&h, "GET", PATH, Value::Null).await.1, receipt);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn receipt_requires_authentication_and_live_tenant_wide_setup_authority(owner: PgPool) {
    let h = harness(&owner, false).await;
    let response = h
        .app
        .clone()
        .oneshot(Request::builder().uri(PATH).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_refused(
        &owner,
        &h,
        "GET",
        PATH,
        Value::Null,
        (StatusCode::FORBIDDEN, "forbidden", None),
    )
    .await;
    let role = Uuid::new_v4();
    // rls-arming: ok test grants are loaded through the single access fact loader.
    sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'Test setup','ACTIVE',1,$3)")
        .bind(h.actor.org.as_uuid()).bind(role).bind(h.actor.user.as_uuid()).execute(&owner).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'Test setup','ACTIVE','SETUP',$3),($1,$2,2,'Test setup','ACTIVE','SETUP',$3)")
        .bind(h.actor.org.as_uuid()).bind(role).bind(h.actor.user.as_uuid()).execute(&owner).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'hr_basic',ARRAY['view'])")
        .bind(h.actor.org.as_uuid()).bind(role).execute(&owner).await.unwrap();
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',(SELECT id FROM users WHERE org_id=$1 AND is_tenant_ops))")
        .bind(h.actor.org.as_uuid()).bind(h.actor.user.as_uuid()).bind(role).execute(&owner).await.unwrap();
    assert_refused(
        &owner,
        &h,
        "GET",
        PATH,
        Value::Null,
        (StatusCode::FORBIDDEN, "forbidden", None),
    )
    .await;
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,2,'hr_basic',ARRAY['view','edit'])")
        .bind(h.actor.org.as_uuid()).bind(role).execute(&owner).await.unwrap();
    sqlx::query("UPDATE access_roles SET version=2 WHERE org_id=$1 AND id=$2")
        .bind(h.actor.org.as_uuid())
        .bind(role)
        .execute(&owner)
        .await
        .unwrap();
    recorded(&owner, &h).await;
    assert_eq!(send(&h, "GET", PATH, Value::Null).await.0, StatusCode::OK);
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$2 WHERE org_id=$1 AND account_id=$2")
        .bind(h.actor.org.as_uuid())
        .bind(h.actor.user.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    assert_refused(
        &owner,
        &h,
        "GET",
        PATH,
        Value::Null,
        (StatusCode::FORBIDDEN, "forbidden", None),
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_former_ops_holder_cannot_read_with_a_stale_role_claim(owner: PgPool) {
    let h = harness(&owner, true).await;
    recorded(&owner, &h).await;
    assert_eq!(send(&h, "GET", PATH, Value::Null).await.0, StatusCode::OK);
    let next = console_platform_test_support::seed_active_user(
        &owner,
        *h.actor.org.as_uuid(),
        "SUPER_ADMIN",
        "Next ops",
    )
    .await;
    let mut tx = owner.begin().await.unwrap();
    // rls-arming: ok an atomic ops handover preserves the tenant lockout invariant.
    sqlx::query("UPDATE users SET is_tenant_ops=false WHERE org_id=$1 AND id=$2")
        .bind(h.actor.org.as_uuid())
        .bind(h.actor.user.as_uuid())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE org_id=$1 AND id=$2")
        .bind(h.actor.org.as_uuid())
        .bind(next.as_uuid())
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_refused(
        &owner,
        &h,
        "GET",
        PATH,
        Value::Null,
        (StatusCode::FORBIDDEN, "forbidden", None),
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_scoped_setup_editor_cannot_read_tenant_wide_history(owner: PgPool) {
    let h = harness(&owner, false).await;
    let entity = Uuid::new_v4();
    let role = Uuid::new_v4();
    // rls-arming: ok synthetic scoped grant, evaluated through the live fact loader.
    sqlx::query("INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION')")
        .bind(h.actor.org.as_uuid()).bind(entity).execute(&owner).await.unwrap();
    sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'Test scoped setup','ACTIVE',1,$3)")
        .bind(h.actor.org.as_uuid()).bind(role).bind(h.actor.user.as_uuid()).execute(&owner).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'Test scoped setup','ACTIVE','SETUP',$3)")
        .bind(h.actor.org.as_uuid()).bind(role).bind(h.actor.user.as_uuid()).execute(&owner).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'org',ARRAY['view','edit'])")
        .bind(h.actor.org.as_uuid()).bind(role).execute(&owner).await.unwrap();
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,legal_entity_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'LEGAL_ENTITY',$4,now()-interval '1 day',true,'SETUP','TEST',(SELECT id FROM users WHERE org_id=$1 AND is_tenant_ops))")
        .bind(h.actor.org.as_uuid()).bind(h.actor.user.as_uuid()).bind(role).bind(entity).execute(&owner).await.unwrap();
    recorded(&owner, &h).await;
    assert_refused(
        &owner,
        &h,
        "GET",
        PATH,
        Value::Null,
        (StatusCode::FORBIDDEN, "forbidden", None),
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn snapshot_shape_refuses_non_objects_without_committing_go_live(owner: PgPool) {
    let h = harness(&owner, true).await;
    // rls-arming: ok malformed historical data must be rejected at the database boundary.
    let result = sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at=now(),go_live_by=$2,go_live_preview_digest=$3,go_live_facts_snapshot='[]' WHERE org_id=$1")
        .bind(h.actor.org.as_uuid()).bind(h.actor.user.as_uuid()).bind("c".repeat(64)).execute(&owner).await;
    let error = result.unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );
    assert_eq!(state(&owner, &h).await.2, "SETUP");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_wide_org_and_access_editors_can_read_receipts(owner: PgPool) {
    for domain in ["org", "access"] {
        let h = harness(&owner, false).await;
        let role = Uuid::new_v4();
        // rls-arming: ok live tenant grants are evaluated by the single Cedar fact loader.
        sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'Test editor','ACTIVE',1,$3)")
            .bind(h.actor.org.as_uuid()).bind(role).bind(h.actor.user.as_uuid()).execute(&owner).await.unwrap();
        sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'Test editor','ACTIVE','SETUP',$3)")
            .bind(h.actor.org.as_uuid()).bind(role).bind(h.actor.user.as_uuid()).execute(&owner).await.unwrap();
        sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,$3,ARRAY['view','edit'])")
            .bind(h.actor.org.as_uuid()).bind(role).bind(domain).execute(&owner).await.unwrap();
        sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',(SELECT id FROM users WHERE org_id=$1 AND is_tenant_ops))")
            .bind(h.actor.org.as_uuid()).bind(h.actor.user.as_uuid()).bind(role).execute(&owner).await.unwrap();
        recorded(&owner, &h).await;
        let (status, body) = send(&h, "GET", PATH, Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{domain}: {body}");
        assert_eq!(body["preview_digest"], "a".repeat(64));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn snapshot_version_is_positive_and_write_once(owner: PgPool) {
    let h = harness(&owner, true).await;
    // rls-arming: ok malformed versions must fail before any receipt is committed.
    let error =
        sqlx::query("UPDATE tenant_phase SET go_live_facts_snapshot_version=0 WHERE org_id=$1")
            .bind(h.actor.org.as_uuid())
            .execute(&owner)
            .await
            .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );
    recorded(&owner, &h).await;
    let error =
        sqlx::query("UPDATE tenant_phase SET go_live_facts_snapshot_version=2 WHERE org_id=$1")
            .bind(h.actor.org.as_uuid())
            .execute(&owner)
            .await
            .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("P0001")
    );
}
