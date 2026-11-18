// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
mod support;
#[path = "statutory/world.rs"]
mod world;

use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn set_person_projection_preserves_latest_facts_nulls_fallbacks_and_tenant_isolation(
    pool: PgPool,
) {
    let w = world::world(&pool).await;
    let other = world::world(&pool).await;
    let employee = support::employee(&pool, w.tenant.org, "Legacy name", "BOUND", "ACTIVE").await;
    let person = Uuid::new_v4();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET birth_date='1990-01-02' WHERE org_id=$1 AND id=$2")
        .bind(w.tenant.org)
        .bind(employee)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO persons(org_id,id) VALUES($1,$2)")
        .bind(w.tenant.org)
        .bind(person)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO employee_person_bindings(org_id,employee_id,person_id,actor_id,payload_digest) VALUES($1,$2,$3,$4,decode(repeat('00',32),'hex'))")
        .bind(w.tenant.org).bind(employee).bind(person).bind(w.user.as_uuid()).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let runtime = console_platform_test_support::runtime_role_pool(&pool).await;
    for (version, attributes, expected_birth) in [
        (
            1_i64,
            json!({"legal_name":"Current name","birth_date":"1980-03-04"}),
            json!("1980-03-04"),
        ),
        (
            2,
            json!({"legal_name":"Current name","birth_date":null}),
            Value::Null,
        ),
        (3, json!({}), json!("1990-01-02")),
    ] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL session_replication_role=replica")
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("INSERT INTO person_revisions(org_id,person_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES($1,$2,$3,gen_random_uuid(),$4,decode(repeat('00',32),'hex'),$5,'{}')")
            .bind(w.tenant.org).bind(person).bind(version).bind(w.user.as_uuid()).bind(attributes).execute(tx.as_mut()).await.unwrap();
        tx.commit().await.unwrap();
        let expected: Value = sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM (SELECT id,org_id,name,birth_date,employee_number,home_branch_id,org_unit_id,voided_at FROM person_employees_current WHERE org_id=$1) p")
            .bind(w.tenant.org).fetch_one(&pool).await.unwrap();
        let actual: Value = console_platform_db::with_org_conn::<_, _, console_platform_db::DbError>(
            &runtime,
            console_kernel_core::OrgId::from_uuid(w.tenant.org),
            |tx| Box::pin(async move {
                Ok(sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM person_employees_current_set p")
                    .fetch_one(tx.as_mut()).await?)
            }),
        ).await.unwrap();
        assert_eq!(actual, expected);
        let people = actual.as_array().unwrap();
        assert_eq!(people.len(), 2);
        assert!(
            people
                .iter()
                .all(|p| p["org_id"] != other.tenant.org.to_string())
        );
        let bound = people
            .iter()
            .find(|p| p["id"] == employee.to_string())
            .unwrap();
        assert_eq!(bound["birth_date"], expected_birth);
        assert_eq!(
            bound["name"],
            if version < 3 {
                "Current name"
            } else {
                "Legacy name"
            }
        );
    }
}
