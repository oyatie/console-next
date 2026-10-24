// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_kernel_core::OrgId;
use console_platform_db::{DbError, settings_read::resolve_in_tx, with_org_conn};
use console_settings_domain::{SettingKey, SettingValue};
use sqlx::PgPool;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[sqlx::test(migrator = "MIGRATOR")]
async fn platform_values_are_effective_dated_registry_checked_and_runtime_read_only(pool: PgPool) {
    let key = SettingKey::NtsCheckCadenceHours;
    for (wire, value) in [
        ("nts.check.cadence_hours", "0"),
        ("nts.check.cadence_hours", "\"bad\""),
        ("nts.check.reflection_lag_days", "2"),
        ("auth.idle_timeout_minutes", "20"),
    ] {
        assert!(
            sqlx::query(
                "INSERT INTO platform_setting_overrides(key,value) VALUES($1,$2::text::jsonb)"
            )
            .bind(wire)
            .bind(value)
            .execute(&pool)
            .await
            .is_err()
        );
    }
    sqlx::query("INSERT INTO platform_setting_overrides(key,value) VALUES($1,'7')")
        .bind(key.as_str())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO platform_setting_overrides(key,value,effective_from) VALUES($1,'3',now()+interval '1 day')").bind(key.as_str()).execute(&pool).await.unwrap();
    let runtime = sqlx::postgres::PgPoolOptions::new()
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    for org in [OrgId::new(), OrgId::new()] {
        with_org_conn::<_, _, DbError>(&runtime, org, move |tx| {
            Box::pin(async move {
                // Rows are stamped by the database clock, so read "now" from it too.
                let now: time::OffsetDateTime = sqlx::query_scalar("SELECT now()")
                    .fetch_one(tx.as_mut())
                    .await
                    .unwrap();
                let settings = resolve_in_tx(tx.as_mut(), org, &[key], None, now)
                    .await
                    .unwrap();
                assert_eq!(settings[&key].as_ref().unwrap().value, SettingValue::Int(7));
                let later = resolve_in_tx(
                    tx.as_mut(),
                    org,
                    &[key],
                    None,
                    now + time::Duration::days(2),
                )
                .await
                .unwrap();
                assert_eq!(later[&key].as_ref().unwrap().value, SettingValue::Int(3));
                Ok(())
            })
        })
        .await
        .unwrap();
    }
    for statement in [
        "INSERT INTO platform_setting_overrides(key,value) VALUES('nts.check.cadence_hours','5')",
        "UPDATE platform_setting_overrides SET value='5'",
        "DELETE FROM platform_setting_overrides",
    ] {
        assert!(sqlx::query(statement).execute(&runtime).await.is_err());
    }
    for statement in [
        "UPDATE platform_setting_overrides SET value='5'",
        "DELETE FROM platform_setting_overrides",
    ] {
        assert!(
            sqlx::query(statement)
                .execute(&pool)
                .await
                .unwrap_err()
                .to_string()
                .contains("append-only")
        );
    }
}
