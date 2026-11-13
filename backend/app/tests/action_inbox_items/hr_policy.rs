// SPDX-License-Identifier: LicenseRef-Proprietary
use super::http;
use ::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;
use tracing_subscriber::{filter::dynamic_filter_fn, prelude::*};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hr_policy_page_resolves_settings_once_without_holder_queries(pool: PgPool) {
    tracing_subscriber::registry().try_init().ok();
    let (org, viewer) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let maker = http::add_user(&pool, org, &["SUPER_ADMIN"]).await;
    sqlx::query("INSERT INTO change_requests(org_id,kind,subject_type,subject_id,requested_by,assignee_role,assignee_user_id,reason_code) SELECT $1,'PROFILE_CORRECTION','USER_ACCOUNT',$2,$3,'HR',$2,'DATA_ENTRY_ERROR' FROM generate_series(1,200)")
        .bind(org).bind(viewer.as_uuid()).bind(maker.as_uuid()).execute(&pool).await.unwrap();
    let ctx = http::ctx(&pool, org, viewer, &["SUPER_ADMIN"], None).await;
    let statements = super::statements::Statements::default();
    let policy_statements = super::statements::Statements::default();
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
    let dispatch = tracing::Dispatch::new(
        tracing_subscriber::registry()
            .with(statements.clone())
            .with(policy_layer)
            .with(source_layer),
    );
    let (status, body) = ctx
        .call("GET", "/api/v1/me/action-inbox?filter=turn&limit=200", None)
        .with_subscriber(dispatch)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["unavailable"], json!([]), "{body}");
    let rows = body["items"].as_array().unwrap();
    assert_eq!(rows.len(), 200);
    let hr_rows = rows
        .iter()
        .filter(|row| row["kind"] == "hr_request")
        .collect::<Vec<_>>();
    assert!(!hr_rows.is_empty());
    for row in hr_rows {
        assert!(
            row["version"].is_string() && row["policy"]["routed"] == true,
            "{row}"
        );
    }
    assert_eq!(
        policy_statements
            .take()
            .iter()
            .filter(|s| s.contains("FROM tenant_setting_overrides"))
            .count(),
        1
    );
    let raw = String::from_utf8(source_logs.0.lock().unwrap().clone()).unwrap();
    let hr_events: Vec<Value> = raw
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|event: &Value| {
            event["spans"].as_array().is_some_and(|spans| {
                spans.iter().any(|span| {
                    span["name"] == "action_inbox.source" && span["source"] == "HrRequests"
                })
            })
        })
        .collect();
    assert!(
        !hr_events.is_empty(),
        "HR request source span must be observed"
    );
    assert_eq!(
        hr_events
            .iter()
            .filter(|event| event.to_string().contains("FROM tenant_setting_overrides"))
            .count(),
        0,
        "HR requests must reuse the request settings snapshot: {hr_events:#?}"
    );
    assert_eq!(
        statements
            .take()
            .iter()
            .filter(|s| s.contains("second_person_candidates"))
            .count(),
        0
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hr_items_use_their_kind_policy_and_stable_request_version(pool: PgPool) {
    let (org, viewer) = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let maker = http::add_user(&pool, org, &["SUPER_ADMIN"]).await;
    let ctx = http::ctx(&pool, org, viewer, &["SUPER_ADMIN"], None).await;
    let cases = [
        ("PROFILE_CORRECTION", Some("people_correction")),
        ("IDENTITY_REVIEW", Some("identity_merge")),
        ("IMPORT_ROLLBACK", Some("import_rollback")),
        ("EMPLOYEE_VOID", Some("registration_void")),
        ("ACCESS_EXPLANATION", None),
        ("POLICY_QUESTION", None),
        ("OTHER", None),
    ];
    let mut ids = Vec::new();
    for (kind, _) in cases {
        let id: Uuid = sqlx::query_scalar("INSERT INTO change_requests(org_id,kind,subject_type,subject_id,requested_by,assignee_role,assignee_user_id,reason_code,note) VALUES($1,$2,'USER_ACCOUNT',$3,$4,'HR',$3,'DATA_ENTRY_ERROR','검토 요청') RETURNING id")
            .bind(org).bind(kind).bind(viewer.as_uuid()).bind(maker.as_uuid())
            .fetch_one(&pool).await.unwrap();
        ids.push(id);
    }
    let mut versions = Vec::new();
    for routed in [true, false] {
        for class in [
            "people_correction",
            "identity_merge",
            "import_rollback",
            "registration_void",
        ] {
            for (key, value) in [
                (
                    format!("approval.policy.{class}"),
                    json!(if routed { "route" } else { "none" }),
                ),
                (
                    format!("approval.bulk.{class}"),
                    json!(class != "identity_merge"),
                ),
                (
                    format!("approval.step_up.{class}"),
                    json!(class != "people_correction"),
                ),
            ] {
                sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,$2,$3,$4,'BW01')")
                    .bind(org).bind(key).bind(value).bind(viewer.as_uuid()).execute(&pool).await.unwrap();
            }
        }
        let before = http::audits(&pool, org, "change_request.decide").await;
        let (status, body) = ctx
            .call("GET", "/api/v1/me/action-inbox?filter=turn", None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["unavailable"], json!([]), "{body}");
        for ((_, class), id) in cases.into_iter().zip(&ids) {
            let row = body["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == format!("hr_request:{id}"))
                .unwrap();
            assert!(row["version"].is_string(), "{row}");
            if let Some(class) = class {
                assert_eq!(
                    row["policy"],
                    json!({"key":format!("approval.policy.{class}"),
                    "routed":true,"merge_consecutive":false,"bulk_allowed":class != "identity_merge","step_up":class != "people_correction"})
                );
            } else {
                assert!(row.get("policy").is_none(), "{row}");
            }
            if routed {
                versions.push(row["version"].clone());
            } else {
                assert_eq!(
                    row["version"],
                    versions[ids.iter().position(|v| v == id).unwrap()]
                );
            }
        }
        assert_eq!(
            http::audits(&pool, org, "change_request.decide").await,
            before
        );
    }
    let outsider_org = http::tenant(&pool, &["SUPER_ADMIN"]).await;
    let outsider = http::ctx(
        &pool,
        outsider_org.0,
        outsider_org.1,
        &["SUPER_ADMIN"],
        None,
    )
    .await;
    let lower_user = http::add_user(&pool, org, &["MEMBER"]).await;
    let lower = http::ctx(&pool, org, lower_user, &["MEMBER"], None).await;
    for caller in [&outsider, &lower] {
        let (status, body) = caller
            .call("GET", "/api/v1/me/action-inbox?filter=turn", None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(
            body["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| !ids.iter().any(|id| row["id"] == format!("hr_request:{id}")))
        );
    }
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM change_requests WHERE org_id=$1 AND status='OPEN' AND decided_at IS NULL")
        .bind(org).fetch_one(&pool).await.unwrap(), ids.len() as i64);
    assert!(versions.iter().all(Value::is_string));
}
