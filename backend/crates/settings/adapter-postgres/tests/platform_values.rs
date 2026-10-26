// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_kernel_core::OrgId;
use console_settings_adapter_postgres::PgSettingsStore;
use console_settings_domain::{SettingKey, SettingValue};
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn migrations_preserve_every_writable_registry_key(pool: PgPool) {
    let keys: Vec<_> = SettingKey::ALL
        .iter()
        .filter(|key| key.def().governance != console_settings_domain::Governance::ReadOnly)
        .map(|key| key.as_str())
        .collect();
    let missing: Vec<String> = sqlx::query_scalar(
        "SELECT key FROM unnest($1::text[]) AS registry(key) \
         LEFT JOIN LATERAL setting_definition(registry.key) d ON true WHERE d.kind IS NULL",
    )
    .bind(keys)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(
        missing.is_empty(),
        "missing setting definitions: {missing:?}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn effective_settings_show_the_same_platform_value_and_schedule_as_commands(pool: PgPool) {
    let key = SettingKey::NtsCheckCadenceHours;
    sqlx::query("INSERT INTO platform_setting_overrides(key,value) VALUES($1,'7')")
        .bind(key.as_str())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO platform_setting_overrides(key,value,effective_from) VALUES($1,'3',now()+interval '1 day')").bind(key.as_str()).execute(&pool).await.unwrap();
    let runtime = console_platform_test_support::runtime_role_pool(&pool).await;
    let settings = PgSettingsStore::new(runtime)
        .list_effective(OrgId::new(), None)
        .await
        .unwrap();
    let value = settings.iter().find(|row| row.key == key).unwrap();
    assert_eq!(value.value, Some(SettingValue::Int(7)));
    let wire = serde_json::to_value(value).unwrap();
    assert_eq!(wire["source"]["layer"], "platform");
    assert_eq!(
        wire["chain"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["deciding"] == true)
            .count(),
        1
    );
    assert!(
        !wire["chain"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["layer"] == "tenant")
    );
    assert!(value.effective_from.is_some());
    assert_eq!(value.scheduled.len(), 1);
    assert_eq!(value.scheduled[0].value, SettingValue::Int(3));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn deadline_display_window_is_available_without_a_stored_definition(pool: PgPool) {
    let runtime = console_platform_test_support::runtime_role_pool(&pool).await;
    let settings = PgSettingsStore::new(runtime)
        .list_effective(OrgId::new(), None)
        .await
        .unwrap();
    let window = settings
        .iter()
        .find(|row| row.key.as_str() == "display.deadline_due_soon_days")
        .expect("the shared display window must be in the settings registry");
    assert_eq!(
        window.governance,
        console_settings_domain::Governance::PlatformOnly
    );
    assert!(window.value.is_some());
    assert_eq!(window.value, window.default);
    assert_eq!(
        window.version,
        Some(console_kernel_core::SettingVersionId::CodeDefault)
    );
    assert!(window.effective_from.is_none());
    assert!(window.scheduled.is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn deadline_window_uses_only_effective_platform_rows(pool: PgPool) {
    let key = SettingKey::DeadlineDueSoonDays;
    sqlx::query("INSERT INTO platform_setting_overrides(key,value,effective_from) VALUES($1,'2',now()-interval '1 day'),($1,'9',now()+interval '1 day')")
        .bind(key.as_str()).execute(&pool).await.unwrap();
    let runtime = console_platform_test_support::runtime_role_pool(&pool).await;
    let org = OrgId::new();
    let settings = PgSettingsStore::new(runtime.clone())
        .list_effective(org, None)
        .await
        .unwrap();
    assert_eq!(
        settings.iter().find(|row| row.key == key).unwrap().value,
        Some(SettingValue::Int(2))
    );
    console_platform_db::with_org_conn::<_, _, console_platform_db::DbError>(
        &runtime,
        org,
        move |tx| {
            Box::pin(async move {
                assert_eq!(
                    console_settings_adapter_postgres::deadline_due_soon_days_in_tx(
                        tx.as_mut(),
                        org,
                        time::OffsetDateTime::now_utc()
                    )
                    .await
                    .unwrap(),
                    2
                );
                Ok(())
            })
        },
    )
    .await
    .unwrap();
}
