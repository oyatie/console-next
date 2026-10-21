#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Audit metadata readers preserve isolated command roles and tenant boundaries.
use sqlx::{PgPool, Row};
use uuid::Uuid;
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[sqlx::test(migrator = "MIGRATOR")]
async fn metadata_reader_is_tenant_bound_value_free_and_restricted(pool: PgPool) {
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    for org in [a, b] {
        sqlx::query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Audit metadata')")
            .bind(org)
            .bind(org.to_string())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO tenant_phase(org_id,phase) VALUES($1,'SETUP') ON CONFLICT(org_id) DO UPDATE SET phase='SETUP'")
            .bind(org).execute(&pool).await.unwrap();
    }
    for role in [
        "console_app",
        "console_rt",
        "console_leave_definer",
        "console_ontology_writer",
    ] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!("SET LOCAL ROLE {role}")))
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(a.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let row = sqlx::query("SELECT * FROM audit_admission_snapshot($1,$2)")
            .bind(a)
            .bind(vec![b])
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
        assert_eq!(
            row.get::<Option<String>, _>("phase").as_deref(),
            Some("SETUP")
        );
        assert!(row.get::<Vec<Uuid>, _>("parent_scopes").is_empty());
        assert_eq!(
            row.get::<serde_json::Value, _>("versions"),
            serde_json::json!({})
        );
        tx.rollback().await.unwrap();
        for org_guc in [Some(a), None] {
            let mut tx = pool.begin().await.unwrap();
            sqlx::query(sqlx::AssertSqlSafe(format!("SET LOCAL ROLE {role}")))
                .execute(tx.as_mut())
                .await
                .unwrap();
            sqlx::query("SELECT set_config('app.current_org',$1,true)")
                .bind(org_guc.map(|id| id.to_string()).unwrap_or_default())
                .execute(tx.as_mut())
                .await
                .unwrap();
            let error = sqlx::query("SELECT * FROM audit_admission_snapshot($1,$2)")
                .bind(b)
                .bind(Vec::<Uuid>::new())
                .fetch_one(tx.as_mut())
                .await
                .unwrap_err();
            assert_eq!(
                error.as_database_error().unwrap().code().as_deref(),
                Some("42501")
            );
            tx.rollback().await.unwrap();
        }
    }
    let callable: bool=sqlx::query_scalar("SELECT has_function_privilege('console_leave_cmd','audit_admission_snapshot(uuid,uuid[])','EXECUTE')")
        .fetch_one(&pool).await.unwrap();
    assert!(!callable, "command-only role cannot read metadata directly");
    let direct: bool = sqlx::query_scalar(
        "SELECT has_table_privilege('console_leave_definer','workplaces','SELECT')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        !direct,
        "metadata reader must not grant underlying table access"
    );
}
