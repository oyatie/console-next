// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_settings_domain::{Governance, SettingKey, SettingKind};
use serde_json::{Value, json};
use sqlx::PgPool;

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
    for &key in SettingKey::ALL {
        let actual: Value = sqlx::query_scalar("SELECT to_jsonb(d) FROM setting_definition($1) d")
            .bind(key.as_str())
            .fetch_one(&pool)
            .await
            .unwrap();
        // Infrastructure-only keys may have no SQL storage path; legacy rows still must match.
        if key.def().governance == Governance::ReadOnly && actual["kind"].is_null() {
            continue;
        }
        assert_eq!(actual, definition(key), "definition for {}", key.as_str());
    }
    let stored: Vec<String> =
        sqlx::query_scalar("SELECT key FROM setting_definitions ORDER BY key")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(!stored.is_empty());
    for key in stored {
        key.parse::<SettingKey>()
            .expect("no unregistered SQL definition");
    }
    let unknown: Value =
        sqlx::query_scalar("SELECT to_jsonb(d) FROM setting_definition('unknown') d")
            .fetch_one(&pool)
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
