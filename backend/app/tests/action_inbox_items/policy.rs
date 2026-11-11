// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{http, org_change};
use ::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;
use tracing_subscriber::{filter::dynamic_filter_fn, prelude::*};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn org_inbox_stored_steps_keep_policy_when_tenant_stops_routing(pool: PgPool) {
    let (org, maker) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let (id, _) = org_change::request(&pool, org, maker).await;
    let ctx = http::ctx(&pool, org, maker, &["SUPER_ADMIN"], None).await;
    let before = org_change::snapshot(&pool, id).await;
    let mut version = Value::Null;
    let mut governing_policy = Value::Null;
    for routed in [true, false] {
        sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,'approval.policy.org_structure',$2,$3,'BW01')")
            .bind(org).bind(json!(if routed { "route" } else { "none" }))
            .bind(maker.as_uuid()).execute(&pool).await.unwrap();
        let (status, body) = ctx
            .call("GET", "/api/v1/me/action-inbox?filter=waiting", None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let row = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == format!("org_change:{id}"))
            .unwrap_or_else(|| panic!("missing request: {body}"));
        assert!(row["version"].is_string(), "{row}");
        if routed {
            assert_eq!(
                row["policy"],
                json!({
                    "key":"approval.policy.org_structure", "routed":true,
                    "merge_consecutive":false, "bulk_allowed":false, "step_up":false
                })
            );
            version = row["version"].clone();
            governing_policy = row["policy"].clone();
        } else {
            assert_eq!(
                row["policy"], governing_policy,
                "stored steps still govern: {row}"
            );
            assert_eq!(
                row["version"], version,
                "policy edits do not change item evidence"
            );
        }
    }
    assert_eq!(org_change::snapshot(&pool, id).await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn org_inbox_resolves_policy_once_for_two_hundred_rows_and_refreshes_next_request(
    pool: PgPool,
) {
    tracing_subscriber::registry().try_init().ok();
    let (org, maker) = http::tenant(&pool, &["MEMBER"]).await;
    http::add_user(&pool, org, &["MEMBER"]).await;
    super::org_change_fixtures::grant_org_levels(&pool, maker, &["view", "edit"]).await;
    sqlx::query("INSERT INTO org_change_requests(org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) SELECT $1,'OC-2026-'||lpad(n::text,4,'0'),'REORG','IN_APPROVAL','REGION','region','조직 개편',CURRENT_DATE,'검토','[]',$2,gen_random_uuid()::text,repeat('a',64) FROM generate_series(1,200) n")
        .bind(org).bind(maker.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO org_change_approval_steps(org_id,request_id,step_order,role_key) SELECT org_id,id,1,'hr' FROM org_change_requests WHERE org_id=$1")
        .bind(org).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,'approval.policy.org_structure','\"route\"',$2,'BW01')")
        .bind(org).bind(maker.as_uuid()).execute(&pool).await.unwrap();
    let ctx = http::ctx(&pool, org, maker, &["MEMBER"], None).await;
    for enabled in [false, true] {
        if enabled {
            sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,'approval.policy.org_structure','\"none\"',$2,'BW01')")
                .bind(org).bind(maker.as_uuid()).execute(&pool).await.unwrap();
            for key in [
                "approval.bulk.org_structure",
                "approval.step_up.org_structure",
            ] {
                sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,$2,$3,$4,'BW01')")
                .bind(org).bind(key).bind(json!(enabled)).bind(maker.as_uuid())
                .execute(&pool).await.unwrap();
            }
        }
        let statements = super::statements::Statements::default();
        let policy_statements = super::statements::Statements::default();
        let source_logs = super::reference_logs::Logs::default();
        let writer = source_logs.clone();
        let source_layer = tracing_subscriber::fmt::layer()
            .json()
            .with_writer(move || writer.clone())
            .with_filter(dynamic_filter_fn(|metadata, context| {
                metadata.is_span()
                    || context.lookup_current().is_some_and(|span| {
                        span.scope()
                            .any(|span| span.name() == "action_inbox.source")
                    })
            }));
        // Authentication resolves its own security settings before the inbox handler.
        let policy_layer =
            policy_statements
                .clone()
                .with_filter(dynamic_filter_fn(|metadata, context| {
                    metadata.is_span()
                        || context.lookup_current().is_some_and(|span| {
                            span.scope()
                                .any(|span| span.name() == "action_inbox.policy")
                        })
                }));
        let dispatch = tracing::Dispatch::new(
            tracing_subscriber::registry()
                .with(statements.clone())
                .with(policy_layer)
                .with(source_layer),
        );
        let (status, body) = ctx
            .call(
                "GET",
                "/api/v1/me/action-inbox?filter=waiting&limit=200",
                None,
            )
            .with_subscriber(dispatch)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["unavailable"], json!([]), "{body}");
        let rows = body["items"].as_array().unwrap();
        assert_eq!(rows.len(), 200);
        for row in rows {
            assert!(row["version"].is_string(), "{row}");
            assert_eq!(row["policy"]["bulk_allowed"], enabled, "{row}");
            assert_eq!(row["policy"]["step_up"], enabled, "{row}");
        }
        let queries = statements.take();
        assert_eq!(
            policy_statements
                .take()
                .iter()
                .filter(|s| s.contains("FROM tenant_setting_overrides"))
                .count(),
            1,
            "{queries:#?}"
        );
        let raw = String::from_utf8(source_logs.0.lock().unwrap().clone()).unwrap();
        let org_events: Vec<Value> = raw
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .filter(|event: &Value| {
                event["spans"].as_array().is_some_and(|spans| {
                    spans.iter().any(|span| {
                        span["name"] == "action_inbox.source" && span["source"] == "OrgChange"
                    })
                })
            })
            .collect();
        assert!(
            !org_events.is_empty(),
            "org-change source span must be observed"
        );
        // The org-change source reuses the request settings snapshot.
        assert_eq!(
            org_events
                .iter()
                .filter(|event| event.to_string().contains("FROM tenant_setting_overrides"))
                .count(),
            0,
            "org-change source must reuse the request settings snapshot: {org_events:#?}"
        );
        assert_eq!(
            queries
                .iter()
                .filter(|s| s.contains("second_person_candidates"))
                .count(),
            0
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn org_inbox_work_without_stored_steps_has_no_policy(pool: PgPool) {
    let (org, maker) = http::tenant(&pool, &["ADMIN"]).await;
    let unchained: uuid::Uuid = sqlx::query_scalar("INSERT INTO org_change_requests(org_id,code,kind,status,target_kind,target_ref,target_label,effective_date,reason,proposal,drafted_by,idempotency_key,request_fingerprint) VALUES($1,'OC-2026-0002','REORG','APPROVED','REGION','region','조직 개편',CURRENT_DATE,'검토','[]',$2,gen_random_uuid()::text,repeat('a',64)) RETURNING id")
        .bind(org).bind(maker.as_uuid()).fetch_one(&pool).await.unwrap();
    let ctx = http::ctx(&pool, org, maker, &["ADMIN"], None).await;
    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,'approval.policy.org_structure','\"route\"',$2,'BW01')")
        .bind(org).bind(maker.as_uuid()).execute(&pool).await.unwrap();
    let (status, body) = ctx
        .call("GET", "/api/v1/me/action-inbox?filter=waiting", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let row = body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == format!("org_change:{unchained}"))
        .unwrap();
    assert!(row.get("policy").is_none(), "{row}");
}
