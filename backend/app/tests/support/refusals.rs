//! Refusal assertions shared by the 법인 · 사업장 · setup 부서 negative suites
//! (entity_refusals_api, entity_refusals_structure_api).

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::support::{Ctx, count};

pub async fn audit_rows(pool: &PgPool, org: Uuid) -> i64 {
    count(pool, "audit_events", org).await
}

pub fn code(v: &Value) -> &str {
    v["error"]["code"].as_str().unwrap_or_default()
}

pub fn field_codes(v: &Value) -> Vec<(String, String)> {
    v["error"]["errors"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|e| {
                    (
                        e["field"].as_str().unwrap_or_default().to_owned(),
                        e["code"].as_str().unwrap_or_default().to_owned(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The canonical records stay identical, including revisions and void flags.
pub async fn business_state(pool: &PgPool, org: Uuid) -> Value {
    sqlx::query_scalar(
        "SELECT COALESCE(jsonb_agg(item ORDER BY item::text), '[]') FROM (\
         SELECT jsonb_build_array('legal_entities',to_jsonb(r)) AS item FROM legal_entities r WHERE org_id=$1 \
         UNION ALL SELECT jsonb_build_array('legal_entity_revisions',to_jsonb(r)) FROM legal_entity_revisions r WHERE org_id=$1 \
         UNION ALL SELECT jsonb_build_array('legal_entity_representatives',to_jsonb(r)) FROM legal_entity_representatives r WHERE org_id=$1 \
         UNION ALL SELECT jsonb_build_array('legal_entity_directors',to_jsonb(r)) FROM legal_entity_directors r WHERE org_id=$1 \
         UNION ALL SELECT jsonb_build_array('business_registrations',to_jsonb(r)) FROM business_registrations r WHERE org_id=$1 \
         UNION ALL SELECT jsonb_build_array('business_registration_revisions',to_jsonb(r)) FROM business_registration_revisions r WHERE org_id=$1 \
         UNION ALL SELECT jsonb_build_array('business_registration_business_types',to_jsonb(r)) FROM business_registration_business_types r WHERE org_id=$1 \
         UNION ALL SELECT jsonb_build_array('workplaces',to_jsonb(r)) FROM workplaces r WHERE org_id=$1 \
         UNION ALL SELECT jsonb_build_array('workplace_revisions',to_jsonb(r)) FROM workplace_revisions r WHERE org_id=$1 \
         UNION ALL SELECT jsonb_build_array('entity_addresses',to_jsonb(r)) FROM entity_addresses r WHERE org_id=$1 \
         UNION ALL SELECT jsonb_build_array('entity_documents',to_jsonb(r)) FROM entity_documents r WHERE org_id=$1 \
         UNION ALL SELECT jsonb_build_array('branches',to_jsonb(r)) FROM branches r WHERE org_id=$1 \
         UNION ALL SELECT jsonb_build_array('org_units',to_jsonb(r)) FROM org_units r WHERE org_id=$1 \
         UNION ALL SELECT jsonb_build_array('org_unit_revisions',to_jsonb(r)) FROM org_unit_revisions r WHERE org_id=$1 \
         UNION ALL SELECT jsonb_build_array('org_setup_batches',to_jsonb(r)) FROM org_setup_batches r WHERE org_id=$1 \
         UNION ALL SELECT jsonb_build_array('entity_setup_batches',to_jsonb(r)) FROM entity_setup_batches r WHERE org_id=$1) records",
    )
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Refusal status/code, durable receipt, terminal retry, and no business writes.
pub async fn refused(
    pool: &PgPool,
    ctx: &Ctx,
    method: &str,
    uri: &str,
    body: Option<Value>,
    status: StatusCode,
    want: &str,
) {
    let before = audit_rows(pool, ctx.org).await;
    let business = business_state(pool, ctx.org).await;
    let commands = count(pool, "command_outcomes", ctx.org).await;
    let (got, first) = ctx.call(method, uri, body.clone()).await;
    assert_eq!(got, status, "{method} {uri}: {first}");
    assert!(
        code(&first) == want || field_codes(&first).iter().any(|(_, c)| c == want),
        "{method} {uri}: expected {want}, got {first}"
    );
    let (got, retry) = ctx.retry(method, uri, body).await;
    if matches!(method, "GET" | "HEAD" | "OPTIONS") {
        assert_eq!(got, status, "{method} {uri}: {retry}");
        assert_eq!(code(&retry), code(&first));
        assert_eq!(field_codes(&retry), field_codes(&first));
        assert_eq!(audit_rows(pool, ctx.org).await, before);
        assert_eq!(count(pool, "command_outcomes", ctx.org).await, commands);
    } else {
        assert_eq!(got, StatusCode::CONFLICT, "{method} {uri}: {retry}");
        assert_eq!(code(&retry), "command_settled", "{retry}");
        let id = Uuid::parse_str(first["error"]["operation_id"].as_str().unwrap()).unwrap();
        assert_eq!(retry["error"]["operation_id"], id.to_string());
        let outcome: (String, String, Option<Value>, Value) = sqlx::query_as(
            "SELECT state,refusal_code,result,touched FROM command_outcomes \
             WHERE org_id=$1 AND actor_id=$2 AND id=$3 AND idempotency_key=$4",
        )
        .bind(ctx.org)
        .bind(ctx.user.as_uuid())
        .bind(id)
        .bind(ctx.key.get().to_string())
        .fetch_one(pool)
        .await
        .unwrap();
        assert_eq!(
            outcome,
            (
                if status == StatusCode::CONFLICT {
                    "CONFLICT"
                } else {
                    "REFUSED"
                }
                .into(),
                code(&first).into(),
                None,
                json!([])
            ),
            "retry must preserve the original refusal and no applied result"
        );
        let evidence: Vec<Value> = sqlx::query_scalar(
            "SELECT jsonb_build_array(action,outcome,after_snap->>'refusal_code') \
             FROM audit_events WHERE org_id=$1 AND command_id=$2 ORDER BY created_at,id",
        )
        .bind(ctx.org)
        .bind(id)
        .fetch_all(pool)
        .await
        .unwrap();
        assert_eq!(
            evidence,
            vec![
                json!(["command.received", "ALLOWED", null]),
                json!(["command.refused", "DENIED", code(&first)]),
                json!(["command.refused", "DENIED", "command_settled"])
            ],
            "no successful domain mutation audit may accompany the refusal"
        );
        assert_eq!(audit_rows(pool, ctx.org).await, before + 3);
        assert_eq!(count(pool, "command_outcomes", ctx.org).await, commands + 1);
    }
    assert_eq!(
        business_state(pool, ctx.org).await,
        business,
        "{method} {uri}: a refusal changed business records"
    );
}
