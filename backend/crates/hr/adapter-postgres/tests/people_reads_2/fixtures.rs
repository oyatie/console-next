//! Fixture rows for the PEOPLE-READS-2 suite (writer guards off).

use console_hr_adapter_postgres::lifecycle::requests::BulkEmployeeLifecycleEventRequest;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

/// Runs `sql` with the writer guards off (fixture rows), binding `$1 = org`.
pub async fn fixture(pool: &PgPool, sql: &str, org: Uuid, binds: &[Uuid]) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    // Test fixture SQL built from literals and generated values only.
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.to_owned())).bind(org);
    for bind in binds {
        q = q.bind(*bind);
    }
    q.execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
}

pub async fn site(pool: &PgPool, org: Uuid, actor: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    fixture(
        pool,
        "INSERT INTO org_units (org_id, id) VALUES ($1, $2)",
        org,
        &[id],
    )
    .await;
    fixture(
        pool,
        &format!(
            "INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, \
             payload_digest, attributes, receipt) VALUES ($1, $2, 1, gen_random_uuid(), $3, \
             decode(repeat('00', 32), 'hex'), jsonb_build_object('name', '{name}', 'kind', 'site'), '{{}}'::jsonb)"
        ),
        org,
        &[id, actor],
    )
    .await;
    id
}

pub fn bulk_body(value: Value) -> BulkEmployeeLifecycleEventRequest {
    let mut body = json!({
        "event_type": "TRANSFER",
        "effective_date": time::OffsetDateTime::now_utc().date().to_string(),
        "comment": "bulk",
        "signoffs": { "privacy_notice_ack": true, "korean_labor_law_ack": true },
    });
    body.as_object_mut()
        .unwrap()
        .extend(value.as_object().unwrap().clone());
    serde_json::from_value(body).unwrap()
}
