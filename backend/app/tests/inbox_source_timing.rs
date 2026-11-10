// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "../../crates/hr/adapter-postgres/tests/statutory/age_scale.rs"]
mod age_scale;
#[path = "support/http.rs"]
mod http;
#[path = "../../crates/payroll/rest/tests/fixtures/pay_view.rs"]
mod pay_view;
#[path = "support/reference_logs.rs"]
mod reference_logs;
use serde_json::Value;
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn setup_readiness_is_loaded_only_for_current_setup_actions(pool: PgPool) {
    let (org, ops) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let denied = http::add_user(&pool, org, &[]).await;
    let viewer = http::ctx(&pool, org, denied, &[], None).await;
    let payroll_reader = http::add_user(&pool, org, &[]).await;
    pay_view::grant_view(
        &pool,
        console_kernel_core::OrgId::from_uuid(org),
        payroll_reader,
        None,
    )
    .await;
    let payroll_viewer = http::ctx(&pool, org, payroll_reader, &[], None).await;
    let operator = http::ctx(&pool, org, ops, &["SUPER_ADMIN"], None).await;
    let (status, healthy) = operator.call("GET", "/api/v1/me/action-inbox", None).await;
    assert_eq!(status, ::http::StatusCode::OK, "{healthy}");
    assert!(
        healthy["unavailable"].as_array().unwrap().is_empty(),
        "{healthy}"
    );
    assert!(
        healthy["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["kind"] == "setup_entity"),
        "{healthy}"
    );
    sqlx::query("ALTER TABLE tenant_phase_events RENAME TO unavailable_phase_events")
        .execute(&pool)
        .await
        .unwrap();
    let (status, page) = viewer.call("GET", "/api/v1/me/action-inbox", None).await;
    assert_eq!(status, ::http::StatusCode::OK, "{page}");
    assert!(page["unavailable"].as_array().unwrap().is_empty(), "{page}");
    assert!(page["items"].as_array().unwrap().is_empty(), "{page}");

    let (status, page) = payroll_viewer
        .call("GET", "/api/v1/me/action-inbox", None)
        .await;
    assert_eq!(status, ::http::StatusCode::OK, "{page}");
    assert!(page["unavailable"].as_array().unwrap().is_empty(), "{page}");
    assert!(
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| !s["kind"].as_str().unwrap().starts_with("setup_")),
        "{page}"
    );

    let (status, page) = operator.call("GET", "/api/v1/me/action-inbox", None).await;
    assert_eq!(status, ::http::StatusCode::OK, "{page}");
    assert!(
        page["unavailable"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["source"] == "setup"),
        "{page}"
    );

    sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at=clock_timestamp(),go_live_by=$2,go_live_preview_digest=repeat('0',64) WHERE org_id=$1")
        .bind(org).bind(ops.as_uuid()).execute(&pool).await.unwrap();
    let (status, page) = operator.call("GET", "/api/v1/me/action-inbox", None).await;
    assert_eq!(status, ::http::StatusCode::OK, "{page}");
    assert!(
        page["unavailable"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["source"] != "setup"),
        "{page}"
    );
    assert!(
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| !s["kind"].as_str().unwrap().starts_with("setup_")),
        "{page}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn setup_preflight_preserves_the_full_routed_step_set(pool: PgPool) {
    let (org, creator) = http::tenant(&pool, &[]).await;
    let settings_user = http::add_user(&pool, org, &[]).await;
    let role = uuid::Uuid::new_v4();
    // rls-arming: ok owner-only fixture gives this actor settings access and no other setup action.
    sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'설정 담당','ACTIVE',1,$3)")
        .bind(org).bind(role).bind(creator.as_uuid()).execute(&pool).await.unwrap();
    // rls-arming: ok immutable role history for the settings-only fixture.
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'설정 담당','ACTIVE','SETUP',$3)")
        .bind(org).bind(role).bind(creator.as_uuid()).execute(&pool).await.unwrap();
    // rls-arming: ok the fixture has only the settings::edit setup action.
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'settings',ARRAY['view','edit'])")
        .bind(org).bind(role).execute(&pool).await.unwrap();
    // rls-arming: ok effective before both database and host clocks.
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',$4)")
        .bind(org).bind(settings_user.as_uuid()).bind(role).bind(creator.as_uuid()).execute(&pool).await.unwrap();
    let ctx = http::ctx(&pool, org, settings_user, &[], None).await;
    for routed in [false, true] {
        if routed {
            // rls-arming: ok owner-only fixture opts into routed org changes.
            sqlx::query("INSERT INTO tenant_setting_overrides (org_id,key,value,set_by,reason_code) VALUES ($1,'approval.policy.org_structure','\"route\"',$2,'BW01')")
                .bind(org).bind(creator.as_uuid()).execute(&pool).await.unwrap();
        }
        let (status, full) = ctx.call("GET", "/api/v1/onboarding/checklist", None).await;
        assert_eq!(status, ::http::StatusCode::OK, "{full}");
        let keys: Vec<_> = full["steps"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|step| step["can_act"] == true)
            .map(|step| step["key"].as_str().unwrap())
            .collect();
        assert_eq!(keys, if routed { vec!["approval"] } else { vec![] });
        let (status, page) = ctx.call("GET", "/api/v1/me/action-inbox", None).await;
        assert_eq!(status, ::http::StatusCode::OK, "{page}");
        assert!(page["unavailable"].as_array().unwrap().is_empty(), "{page}");
        let setup: Vec<_> = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| {
                item["kind"]
                    .as_str()
                    .filter(|kind| kind.starts_with("setup_"))
            })
            .collect();
        assert_eq!(
            setup,
            keys.iter()
                .map(|key| format!("setup_{key}"))
                .collect::<Vec<_>>()
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn source_work_and_permit_wait_are_measured_separately_even_on_failure(pool: PgPool) {
    let (org, user) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, user, &["SUPER_ADMIN"], None).await;
    let (entity, site, _, _) = http::structure(&ctx).await;
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at='2020-01-01',go_live_by=$2,go_live_preview_digest=repeat('0',64) WHERE org_id=$1")
        .bind(org).bind(user.as_uuid()).execute(&pool).await.unwrap();
    age_scale::seed(
        &pool,
        org,
        user,
        entity.parse().unwrap(),
        site.parse().unwrap(),
        1999,
        6,
    )
    .await;
    for fail in [false, true] {
        if fail {
            sqlx::query("ALTER TABLE change_requests RENAME TO unavailable_requests")
                .execute(&pool)
                .await
                .unwrap();
        }
        let logs = reference_logs::Logs::default();
        let writer = logs.clone();
        let subscriber = tracing_subscriber::fmt()
            .json()
            .with_max_level(tracing::Level::DEBUG)
            .with_writer(move || writer.clone())
            .finish();
        let (status, page) = ctx
            .call("GET", "/api/v1/me/action-inbox?filter=turn", None)
            .with_subscriber(subscriber)
            .await;
        let raw = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
        let mut timings: Vec<Value> = raw
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .filter(|v: &Value| v["fields"]["message"] == "inbox source measured")
            .collect();
        if status != ::http::StatusCode::OK {
            eprintln!(
                "partial costs: {}",
                serde_json::to_string(&timings).unwrap()
            );
        }
        assert_eq!(status, ::http::StatusCode::OK, "{page}");
        let sources: std::collections::BTreeSet<_> = timings
            .iter()
            .map(|e| e["span"]["source"].as_str().unwrap())
            .collect();
        assert_eq!(
            sources.len(),
            console_action_inbox_application::ActionInboxSource::ALL.len(),
            "each source must report work and permit wait"
        );
        for event in &timings {
            assert!(event["fields"]["permit_wait_seconds"].as_f64().unwrap() >= 0.0);
            assert!(event["fields"]["work_seconds"].as_f64().unwrap() >= 0.0);
        }
        timings.sort_by(|a, b| {
            b["fields"]["work_seconds"]
                .as_f64()
                .partial_cmp(&a["fields"]["work_seconds"].as_f64())
                .unwrap()
        });
        let costs: Vec<_> = timings.iter().map(|e| serde_json::json!({"source":e["span"]["source"], "work_seconds":e["fields"]["work_seconds"], "permit_wait_seconds":e["fields"]["permit_wait_seconds"]})).collect();
        eprintln!(
            "source costs (1999 birthdays; failure={fail}): {}",
            serde_json::to_string(&costs).unwrap()
        );
        assert!(timings.iter().any(|e| e["span"]["source"] == "HrInsurance"));
        if fail {
            assert!(timings.iter().any(|e| e["span"]["source"] == "HrRequests"));
            assert!(!page["unavailable"].as_array().unwrap().is_empty());
        }
    }
}
