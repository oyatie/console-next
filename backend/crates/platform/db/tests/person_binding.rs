// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use sqlx::{PgPool, Row};
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

async fn tenant(pool: &PgPool) -> Uuid {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id,slug,name) VALUES ($1,$2,'Person bindings')")
        .bind(org)
        .bind(org.to_string())
        .execute(pool)
        .await
        .unwrap();
    org
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn every_tenant_account_is_bound_and_person_facts_are_authoritative(pool: PgPool) {
    let org = tenant(&pool).await;
    let user: Uuid = sqlx::query_scalar("INSERT INTO users (org_id,display_name,phone) VALUES ($1,'Before','+821012345678') RETURNING id")
        .bind(org).fetch_one(&pool).await.unwrap();
    let person: Uuid = sqlx::query_scalar("SELECT person_id FROM users WHERE id=$1")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT console_revise_person_facts($1,$2,'{\"legal_name\":\"After\",\"phone\":null}'::jsonb,$3)")
        .bind(org).bind(person).bind(user).execute(tx.as_mut()).await.unwrap();
    let row = sqlx::query("SELECT display_name,phone FROM person_accounts_current WHERE id=$1")
        .bind(user)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("display_name"), "After");
    assert_eq!(row.get::<Option<String>, _>("phone"), None);
    let legacy: String = sqlx::query_scalar("SELECT display_name FROM users WHERE id=$1")
        .bind(user)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(
        legacy, "After",
        "the N-1 column projects the current Person"
    );
    tx.commit().await.unwrap();
    let error = sqlx::query("UPDATE users SET person_id=NULL WHERE id=$1")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn backfill_two_thousand_people_is_idempotent_and_invites_share_the_person(pool: PgPool) {
    let org = tenant(&pool).await;
    sqlx::query("INSERT INTO employees (org_id,company,name,employee_number,birth_date,source_filename,source_sheet,source_row,source_key) SELECT $1,'Co','Worker '||n,'P-'||n,'1990-01-01','test','test',n,'person-'||n FROM generate_series(1,2000) n")
        .bind(org).execute(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT console_backfill_person_bindings($1)")
        .bind(org)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (org_id,display_name,employee_id) SELECT org_id,'Stale invite copy',id FROM employees WHERE org_id=$1")
        .bind(org).execute(tx.as_mut()).await.unwrap();
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM person_revisions WHERE org_id=$1")
        .bind(org)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT console_backfill_person_bindings($1)")
        .bind(org)
        .execute(tx.as_mut())
        .await
        .unwrap();
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM person_revisions WHERE org_id=$1")
        .bind(org)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(before, after);
    let unbound: i64 = sqlx::query_scalar("SELECT count(*) FROM employees e LEFT JOIN employee_person_bindings b ON b.org_id=e.org_id AND b.employee_id=e.id LEFT JOIN users u ON u.org_id=e.org_id AND u.employee_id=e.id WHERE e.org_id=$1 AND (b.person_id IS NULL OR u.person_id IS DISTINCT FROM b.person_id)")
        .bind(org).fetch_one(tx.as_mut()).await.unwrap();
    assert_eq!(unbound, 0);
    let people: i64 = sqlx::query_scalar("SELECT count(*) FROM persons WHERE org_id=$1")
        .bind(org)
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(people, 2000);
    let names: i64 = sqlx::query_scalar("SELECT count(*) FROM person_accounts_current WHERE org_id=$1 AND display_name LIKE 'Worker %'")
        .bind(org).fetch_one(tx.as_mut()).await.unwrap();
    assert_eq!(names, 2000);
    tx.commit().await.unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn ambiguous_number_birth_evidence_is_persisted_without_a_merge(pool: PgPool) {
    let org = tenant(&pool).await;
    // Reproduce a legacy roster before the unique-number cleanup.
    sqlx::query("DROP INDEX employees_org_employee_number_key")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO employees (org_id,company,name,employee_number,birth_date,source_filename,source_sheet,source_row,source_key) VALUES ($1,'Co','Same label','DUP','1990-01-01','test','test',1,'a'),($1,'Co','Same label','DUP','1991-01-01','test','test',2,'b')")
        .bind(org).execute(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    for _ in 0..2 {
        sqlx::query("SELECT console_backfill_person_bindings($1)")
            .bind(org)
            .execute(tx.as_mut())
            .await
            .unwrap();
    }
    let people: i64 = sqlx::query_scalar(
        "SELECT count(DISTINCT person_id) FROM employee_person_bindings WHERE org_id=$1",
    )
    .bind(org)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    assert_eq!(people, 2);
    let evidence: Vec<serde_json::Value> = sqlx::query_scalar(
        "SELECT evidence FROM person_binding_reviews WHERE org_id=$1 ORDER BY subject_id",
    )
    .bind(org)
    .fetch_all(tx.as_mut())
    .await
    .unwrap();
    assert_eq!(evidence.len(), 2, "one durable review per ambiguous record");
    assert!(
        evidence
            .iter()
            .all(|v| v["candidates"].as_array().unwrap().len() == 2)
    );
    assert!(evidence.iter().all(|v| v.get("rrn").is_none()));
    tx.commit().await.unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn operators_are_typed_non_person_principals_and_foreign_people_are_refused(pool: PgPool) {
    let org = tenant(&pool).await;
    let row = sqlx::query("INSERT INTO users (org_id,display_name,is_tenant_ops) VALUES ($1,'Operations',true) RETURNING person_id,principal_kind")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(row.get::<Option<Uuid>, _>("person_id"), None);
    assert_eq!(row.get::<String, _>("principal_kind"), "OPERATIONS");
    let other = tenant(&pool).await;
    let person: Uuid = sqlx::query_scalar(
        "INSERT INTO users (org_id,display_name) VALUES ($1,'Foreign') RETURNING person_id",
    )
    .bind(other)
    .fetch_one(&pool)
    .await
    .unwrap();
    let error =
        sqlx::query("INSERT INTO users (org_id,display_name,person_id) VALUES ($1,'Forged',$2)")
            .bind(org)
            .bind(person)
            .execute(&pool)
            .await
            .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );
}
