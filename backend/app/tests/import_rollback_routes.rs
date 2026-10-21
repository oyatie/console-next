// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
//! Run-history routes must be mounted behind authentication and org-wide HR authorization.

use http::StatusCode;
use sqlx::PgPool;
use uuid::Uuid;

#[path = "emp_ui_routes/harness.rs"]
mod harness;
use harness::{Caller, keys, router, token, user};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn run_history_routes_are_authenticated_and_hide_unknown_runs(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Import rollback test')",
    )
    .bind(org)
    .bind(format!("rollback-{org}"))
    .execute(&pool)
    .await
    .unwrap();
    let keys = keys();
    let service = router(&pool, &keys).await;
    let ops_id = user(&pool, org, "SUPER_ADMIN").await;
    let member_id = user(&pool, org, "MEMBER").await;
    let ops = Caller {
        service: service.clone(),
        token: Some(token(&pool, &keys, org, ops_id, "SUPER_ADMIN").await),
    };
    let member = Caller {
        service: service.clone(),
        token: Some(token(&pool, &keys, org, member_id, "MEMBER").await),
    };
    let anonymous = Caller {
        service,
        token: None,
    };
    let list = "/api/v1/employee-import-runs";
    let record = format!("{list}/{}", Uuid::new_v4());
    for path in [list, &record] {
        assert_eq!(
            anonymous.call("GET", path, None).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            member.call("GET", path, None).await.0,
            StatusCode::FORBIDDEN
        );
    }
    for suffix in ["rollback/preview", "rollback"] {
        let path = format!("{record}/{suffix}");
        let body = (suffix == "rollback")
            .then(|| serde_json::json!({"preview_digest":"unused","acknowledged":true}));
        assert_eq!(
            anonymous.call("POST", &path, body.clone()).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            member.call("POST", &path, body.clone()).await.0,
            StatusCode::FORBIDDEN
        );
        let (status, error) = ops.call("POST", &path, body).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{error}");
        assert_eq!(error["error"]["code"], "import_run_not_found");
    }
    let (status, body) = ops.call("GET", list, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"], serde_json::json!([]));
    let (status, body) = ops.call("GET", &record, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "import_run_not_found");
}

#[allow(dead_code)]
#[path = "../../crates/hr/adapter-postgres/tests/emp_create/fixture.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "../../crates/hr/adapter-postgres/tests/import2/harness.rs"]
mod import_fixture;

async fn applied_run(i: &import_fixture::Importer) -> Uuid {
    let run = i
        .preview(
            "http-rollback.xlsx",
            &[import_fixture::table(
                "명부",
                0,
                &[
                    &["사번", "성명", "입사일", "고용형태"],
                    &["HTTP-UNDO-01", "웹되돌림", "2024-03-04", "정규직"],
                ],
            )],
            &Default::default(),
        )
        .await
        .unwrap()
        .run_id;
    let dry = i.dry_run(run, import_fixture::decisions()).await;
    i.apply(run, &dry.dry_run_digest).await.unwrap();
    run
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_http_preview_ack_stale_execute_and_repeated_execute(pool: PgPool) {
    let i = import_fixture::importer(pool.clone()).await;
    let run = applied_run(&i).await;
    let keys = keys();
    let ops = Caller {
        service: router(&pool, &keys).await,
        token: Some(token(&pool, &keys, i.org(), i.f.principal.user_id, "SUPER_ADMIN").await),
    };
    let record = format!("/api/v1/employee-import-runs/{run}");
    let preview_path = format!("{record}/rollback/preview");
    let rollback_path = format!("{record}/rollback");
    let (status, preview) = ops.call("POST", &preview_path, None).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["mode"], "SETUP");
    assert_eq!(preview["rows"].as_array().unwrap().len(), 1);
    assert_eq!(preview["blockers"], serde_json::json!([]));
    for (body, status, code) in [
        (
            serde_json::json!({"preview_digest":preview["preview_digest"],"acknowledged":false}),
            StatusCode::UNPROCESSABLE_ENTITY,
            "import_rollback_ack_required",
        ),
        (
            serde_json::json!({"preview_digest":"stale","acknowledged":true}),
            StatusCode::CONFLICT,
            "rows_changed_since_preview",
        ),
    ] {
        let (actual, error) = ops.call("POST", &rollback_path, Some(body)).await;
        assert_eq!(actual, status, "{error}");
        assert_eq!(error["error"]["code"], code);
        let (_, current) = ops.call("GET", &record, None).await;
        assert_eq!(current["status"], "APPLIED");
    }
    let body = serde_json::json!({"preview_digest":preview["preview_digest"],"acknowledged":true});
    let (status, error) = ops
        .send("POST", &rollback_path, Some(body.clone()), false)
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{error}");
    let (status, outcome) = ops.call("POST", &rollback_path, Some(body.clone())).await;
    assert_eq!(status, StatusCode::OK, "{outcome}");
    assert_eq!(outcome["status"], "ROLLED_BACK");
    let (status, error) = ops.call("POST", &rollback_path, Some(body)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["error"]["code"], "import_run_already_rolled_back");
    let (status, record) = ops.call("GET", &record, None).await;
    assert_eq!(status, StatusCode::OK, "{record}");
    assert_eq!(record["status"], "ROLLED_BACK");
    assert_eq!(record["apply_summary"]["inserted"], 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_http_refuses_blockers_and_preserves_the_applied_batch(pool: PgPool) {
    let i = import_fixture::importer(pool.clone()).await;
    let run = applied_run(&i).await;
    sqlx::query(
        "UPDATE employees SET position='과장',updated_at=clock_timestamp() WHERE org_id=$1",
    )
    .bind(i.org())
    .execute(&pool)
    .await
    .unwrap();
    let keys = keys();
    let ops = Caller {
        service: router(&pool, &keys).await,
        token: Some(token(&pool, &keys, i.org(), i.f.principal.user_id, "SUPER_ADMIN").await),
    };
    let path = format!("/api/v1/employee-import-runs/{run}/rollback");
    let (status, preview) = ops.call("POST", &format!("{path}/preview"), None).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert!(!preview["blockers"].as_array().unwrap().is_empty());
    assert_eq!(preview["allowed"], serde_json::json!([]));
    let (status, body) = ops
        .call(
            "POST",
            &path,
            Some(
                serde_json::json!({"preview_digest":preview["preview_digest"],"acknowledged":true}),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "import_rollback_blocked");
    assert!(
        body["error"]["refusals"]
            .as_array()
            .is_some_and(|rows| !rows.is_empty()),
        "{body}"
    );
    assert_eq!(
        i.f.hr
            .import_run(i.f.principal.clone(), run)
            .await
            .unwrap()
            .status,
        "APPLIED"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rollback_all_four_routes_refuse_scoped_management_grants(pool: PgPool) {
    use console_kernel_core::{BranchId, BranchScope};
    use console_platform_authz::{
        EffectiveFeatureGrant, Feature, PermissionLevel, Principal, Role,
    };
    let i = import_fixture::importer(pool).await;
    let principal = Principal::new(
        i.f.principal.user_id,
        i.f.principal.org_id,
        [Role::Member].into(),
        BranchScope::All,
    )
    .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
        Feature::EmployeeDirectoryManage,
        PermissionLevel::Allow,
        BranchScope::Branches([BranchId::from_uuid(i.f.branch)].into()),
    )]);
    let caller = Caller {
        service: console_hr_rest::import_runs::router(i.f.hr.clone(), None)
            .layer(axum::Extension(principal)),
        token: None,
    };
    let record = format!("/api/v1/employee-import-runs/{}", Uuid::new_v4());
    for (method, path, body) in [
        ("GET", "/api/v1/employee-import-runs".to_owned(), None),
        ("GET", record.clone(), None),
        ("POST", format!("{record}/rollback/preview"), None),
        (
            "POST",
            format!("{record}/rollback"),
            Some(serde_json::json!({"preview_digest":"unused","acknowledged":true})),
        ),
    ] {
        let (status, error) = caller.call(method, &path, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {error}");
    }
}

async fn import_policy(i: &import_fixture::Importer, routed: bool, sole_refuse: bool) {
    let mut tx = i.owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(i.org().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING' WHERE org_id=$1")
        .bind(i.org())
        .execute(tx.as_mut())
        .await
        .unwrap();
    // Synthetic policies are already effective when the HTTP command reads them.
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    for (key, value) in [
        (
            "approval.policy.import_rollback",
            if routed { "route" } else { "none" },
        ),
        (
            "authz.sole_holder.mode",
            if sole_refuse {
                "refuse"
            } else {
                "step_up_notice_review"
            },
        ),
    ] {
        sqlx::query("INSERT INTO tenant_setting_overrides (org_id,key,value,set_by,reason_code,effective_from) VALUES ($1,$2,$3,$4,'TEST',now()-interval '1 day')")
            .bind(i.org()).bind(key).bind(serde_json::json!(value)).bind(*i.f.principal.user_id.as_uuid()).execute(tx.as_mut()).await.unwrap();
    }
    tx.commit().await.unwrap();
}

async fn eligible_holder(i: &import_fixture::Importer, id: console_kernel_core::UserId) {
    let mut body = i.f.body(&format!("rollback-holder-{id}"), "REGULAR");
    body.employee_number = format!("HOLDER-{id}");
    let employee = i.f.create(body).await.unwrap().employee.id;
    sqlx::query("UPDATE users SET employee_id=$1 WHERE org_id=$2 AND id=$3")
        .bind(employee)
        .bind(i.org())
        .bind(*id.as_uuid())
        .execute(&i.owner)
        .await
        .unwrap();
    sqlx::query("UPDATE authz_grant_ledger SET occurred_at=now()-interval '400 days' WHERE org_id=$1 AND user_id=$2")
        .bind(i.org()).bind(*id.as_uuid()).execute(&i.owner).await.unwrap();
    sqlx::query("INSERT INTO authz_grant_ledger (org_id,user_id,grant_kind,grant_ref,event,source,channel) SELECT org_id,user_id,grant_kind,grant_ref,'NOTICE_DELIVERED','NOTIFIER','IN_APP' FROM authz_grant_ledger WHERE org_id=$1 AND user_id=$2 AND grant_kind='SYSTEM_ROLE' AND event='GRANTED'")
        .bind(i.org()).bind(*id.as_uuid()).execute(&i.owner).await.unwrap();
}

async fn rollback_frames(i: &import_fixture::Importer, run: Uuid) -> Vec<String> {
    sqlx::query_scalar("SELECT a.action FROM resource_changes c JOIN audit_events a ON a.id=c.audit_event_id WHERE c.org_id=$1 AND c.resource_type='import_run' AND c.resource_id=$2 AND a.action IN ('data_import.rollback_request','data_import.rollback_request_closed','data_import.rollback') ORDER BY c.seq")
        .bind(i.org()).bind(run.to_string()).fetch_all(&i.owner).await.unwrap()
}

#[path = "import_rollback/approval_journey.rs"]
mod import_rollback_journey;
