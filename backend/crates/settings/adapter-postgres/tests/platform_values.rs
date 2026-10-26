// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_kernel_core::OrgId;
use console_settings_adapter_postgres::PgSettingsStore;
use console_settings_domain::{SettingKey, SettingValue};
use sqlx::PgPool;

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
        console_settings_domain::Governance::ReadOnly
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
