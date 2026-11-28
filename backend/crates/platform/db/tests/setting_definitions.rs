// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_settings_domain::{Governance, SettingKey, SettingKind};
use serde_json::{Value, json};
use sqlx::{Connection, PgPool};

#[path = "../../../settings/domain/examples/support/definition_sql.rs"]
mod definition_sql;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

fn definition(key: SettingKey) -> Value {
    let def = key.def();
    let (kind, min, max, codes) = match def.kind {
        SettingKind::Int { min, max, .. } => ("int", min, max, None),
        SettingKind::Bool => ("bool", None, None, None),
        SettingKind::Code { allowed } => ("code", None, None, Some(allowed)),
    };
    json!({
        "kind": kind, "min_value": min, "max_value": max,
        "default_ordinal": def.default.and_then(|value| def.ordinal(value)),
        "looser_when": def.looser_when, "governance": def.governance, "codes": codes,
    })
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn all_migrations_match_the_settings_registry(pool: PgPool) {
    assert_registry(&pool).await;
}

async fn assert_registry(pool: &PgPool) {
    for &key in SettingKey::ALL {
        let actual: Value = sqlx::query_scalar("SELECT to_jsonb(d) FROM setting_definition($1) d")
            .bind(key.as_str())
            .fetch_one(pool)
            .await
            .unwrap();
        // Infrastructure-only keys may have no SQL storage path; legacy rows still must match.
        if key.def().governance == Governance::ReadOnly && actual["kind"].is_null() {
            continue;
        }
        assert_eq!(actual, definition(key), "definition for {}", key.as_str());
    }
    let stored: Vec<String> = sqlx::query_scalar(
        "SELECT key FROM setting_definitions WHERE retired_at IS NULL ORDER BY key",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert!(!stored.is_empty());
    for key in stored {
        key.parse::<SettingKey>()
            .expect("no unregistered SQL definition");
    }
    let unknown: Value =
        sqlx::query_scalar("SELECT to_jsonb(d) FROM setting_definition('unknown') d")
            .fetch_one(pool)
            .await
            .unwrap();
    assert!(unknown.as_object().unwrap().values().all(Value::is_null));
}

#[sqlx::test(migrations = false)]
async fn upgraded_definitions_preserve_the_previous_function(pool: PgPool) {
    use sqlx::migrate::Migrator;
    use std::borrow::Cow;

    let transition = MIGRATOR
        .iter()
        .find(|m| m.description == "setting definitions as data")
        .expect("definitions table migration");
    let mut previous = Migrator {
        migrations: Cow::Owned(
            MIGRATOR
                .iter()
                .filter(|m| m.version < transition.version)
                .cloned()
                .collect(),
        ),
        ..Migrator::DEFAULT
    };
    previous.run(&pool).await.unwrap();
    let keys: Vec<_> = SettingKey::ALL.iter().map(|key| key.as_str()).collect();
    let query = "SELECT to_jsonb(d) FROM unnest($1::text[]) AS registry(key) \
                 CROSS JOIN LATERAL setting_definition(registry.key) d ORDER BY registry.key";
    let before: Vec<Value> = sqlx::query_scalar(query)
        .bind(&keys)
        .fetch_all(&pool)
        .await
        .unwrap();
    previous.migrations.to_mut().push(transition.clone());
    previous.run(&pool).await.unwrap();
    let after: Vec<Value> = sqlx::query_scalar(query)
        .bind(&keys)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(before, after);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn independent_definition_inserts_compose_and_runtime_cannot_mutate_them(pool: PgPool) {
    let first = "INSERT INTO setting_definitions(key,kind,default_ordinal,looser_when,governance) \
                 VALUES ('test.first','bool',0,'neutral','tenant')";
    let second = "INSERT INTO setting_definitions(key,kind,default_ordinal,looser_when,governance) \
                  VALUES ('test.second','bool',0,'neutral','tenant')";
    for statements in [[first, second], [second, first]] {
        let mut tx = pool.begin().await.unwrap();
        for statement in statements {
            sqlx::raw_sql(statement).execute(tx.as_mut()).await.unwrap();
        }
        for key in ["test.first", "test.second"] {
            let kind: String = sqlx::query_scalar("SELECT kind FROM setting_definition($1)")
                .bind(key)
                .fetch_one(tx.as_mut())
                .await
                .unwrap();
            assert_eq!(kind, "bool");
        }
        tx.rollback().await.unwrap();
    }
    for statement in [
        first,
        "UPDATE setting_definitions SET min_value = 0",
        "DELETE FROM setting_definitions",
    ] {
        let mut tx = pool.begin().await.unwrap();
        sqlx::raw_sql("SET LOCAL ROLE console_rt")
            .execute(tx.as_mut())
            .await
            .unwrap();
        let kind: String = sqlx::query_scalar("SELECT kind FROM setting_definition($1)")
            .bind(SettingKey::ALL[0].as_str())
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
        assert_eq!(
            kind,
            definition(SettingKey::ALL[0])["kind"].as_str().unwrap()
        );
        let error = sqlx::raw_sql(statement)
            .execute(tx.as_mut())
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("42501")
        );
        tx.rollback().await.unwrap();
    }
}

#[sqlx::test(migrations = false)]
async fn definitions_migrated_by_console_app_are_read_only_for_runtime(pool: PgPool) {
    let mut conn = pool.acquire().await.unwrap();
    let database: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "ALTER DATABASE \"{}\" OWNER TO console_app",
        database.replace('"', "\"\"")
    )))
    .execute(&mut *conn)
    .await
    .unwrap();
    sqlx::query("GRANT CREATE ON SCHEMA public TO console_app")
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("SET SESSION AUTHORIZATION console_app")
        .execute(&mut *conn)
        .await
        .unwrap();
    let result = MIGRATOR.run(&mut *conn).await;
    conn.detach().close().await.unwrap();
    result.unwrap();
    let can_change_catalog: bool = sqlx::query_scalar(
        "SELECT has_table_privilege('console_rt','public.release_modules','INSERT,UPDATE,DELETE,TRUNCATE')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!can_change_catalog);
    let grants: (bool, bool, bool, bool) = sqlx::query_as(
        "SELECT has_table_privilege('console_rt','public.setting_definitions','SELECT'), \
         has_table_privilege('console_rt','public.setting_definitions','INSERT'), \
         has_table_privilege('console_rt','public.setting_definitions','UPDATE'), \
         has_table_privilege('console_rt','public.setting_definitions','DELETE')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(grants, (true, false, false, false));
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn definition_domains_reject_invalid_metadata(pool: PgPool) {
    for update in [
        "kind = 'integer', min_value = NULL, max_value = NULL",
        "looser_when = 'higer'",
        "governance = 'tennant'",
        "kind = 'code', codes = NULL, min_value = NULL, max_value = NULL",
        "kind = 'bool', codes = ARRAY['yes'], min_value = NULL, max_value = NULL",
        "kind = 'bool', min_value = 1",
        "kind = 'bool', max_value = 1",
        "min_value = 2, max_value = 1",
    ] {
        let error = sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE setting_definitions SET {update} WHERE key = $1"
        )))
        .bind(SettingKey::ALL[0].as_str())
        .execute(&pool)
        .await
        .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23514"),
            "{update}"
        );
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn retired_definitions_remain_readable_for_older_binaries(pool: PgPool) {
    sqlx::query(
        "INSERT INTO setting_definitions(key,kind,looser_when,governance,retired_at) \
                 VALUES ('test.retired','bool','neutral','tenant',now())",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_registry(&pool).await;
    let kind: String = sqlx::query_scalar("SELECT kind FROM setting_definition('test.retired')")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(kind, "bool");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn generated_upserts_add_and_update_only_requested_definitions(pool: PgPool) {
    let keys = [
        SettingKey::DisplayPageSize,
        SettingKey::ExitAccessRevokeModeVoluntary,
    ];
    let names: Vec<_> = keys.iter().map(|key| key.as_str()).collect();
    for before in [
        "DELETE FROM setting_definitions WHERE key = ANY($1)",
        "UPDATE setting_definitions SET kind = 'int', min_value = 0, max_value = 1, \
         default_ordinal = 0, looser_when = 'neutral', governance = 'read_only', codes = NULL \
         WHERE key = ANY($1)",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(before))
            .bind(&names)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(definition_sql::generated(&keys)))
            .execute(&pool)
            .await
            .unwrap();
        assert_registry(&pool).await;
    }
}
