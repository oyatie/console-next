// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod settings_support;
use console_kernel_core::{KernelError, SettingVersionId};
use console_platform_db::{DbError, with_org_conn};
use console_settings_adapter_postgres::{PgSettingsError, PgSettingsStore};
use console_settings_application::Actor;
use console_settings_domain::{Direction, SettingKey, SettingValue};
use serde_json::{Value, json};
use settings_support::*;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};

/// Inserts straight into the table as the runtime role, skipping the domain
/// check, and returns the trigger's refusal message (or the stored direction).
async fn raw_insert(
    store: &PgSettingsStore,
    actor: Actor,
    key: &'static str,
    value: Value,
    after_now: &'static str,
) -> Result<String, String> {
    with_org_conn(store.pool(), actor.org, move |tx| {
        Box::pin(async move {
            sqlx::query_scalar::<_, String>(
                "INSERT INTO tenant_setting_overrides
                     (org_id, key, value, effective_from, set_by, reason_code, direction)
                 VALUES ($1, $2, $3, now() + $4::interval, $5, 'X', 'tighten')
                 RETURNING direction",
            )
            .bind(actor.org.as_uuid())
            .bind(key)
            .bind(value)
            .bind(after_now)
            .bind(actor.user.as_uuid())
            .fetch_one(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)
        })
    })
    .await
    .map_err(|e: DbError| match e {
        DbError::Sqlx(sqlx::Error::Database(db)) => db.message().to_owned(),
        other => panic!("{other:?}"),
    })
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_change_is_resolved_listed_audited_and_kept_in_history(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let view = store
        .change_setting(actor, change(json!(20), None), audit(), |_| Ok(()))
        .await
        .unwrap();
    assert_eq!(view.direction, Direction::Tighten);

    let listed = store.list_effective(actor.org, None).await.unwrap();
    assert_eq!(listed.len(), SettingKey::ALL.len());
    let row = listed.iter().find(|s| s.key.as_str() == KEY).unwrap();
    assert_eq!(row.value, Some(SettingValue::Int(20)));
    assert_eq!(row.version, Some(SettingVersionId::Override(view.id)));
    let untouched = listed
        .iter()
        .find(|s| s.key.as_str() == "auth.idle_timeout_minutes")
        .unwrap();
    assert_eq!(untouched.version, Some(SettingVersionId::CodeDefault));

    let key: SettingKey = KEY.parse().unwrap();
    let history = store.history(actor.org, key).await.unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].set_by, *actor.user.as_uuid());
    assert_eq!(history[0].reason_note.as_deref(), Some("quarterly review"));

    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action = 'settings.override_insert' AND target_id = $1",
    )
    .bind(view.id.to_string())
    // rls-arming: ok test assertion reads as owner
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audits, 1);

    // A refused change writes neither the row nor the audit.
    let denied = store
        .change_setting(actor, change(json!(10), None), audit(), |_| {
            Err(KernelError::forbidden("denied"))
        })
        .await;
    assert!(
        matches!(denied, Err(PgSettingsError::Domain(e)) if e == KernelError::forbidden("denied"))
    );
    assert_eq!(store.history(actor.org, key).await.unwrap().len(), 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_loosening_waits_a_day_once_the_tenant_has_an_employee(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let onboarding = store
        .change_setting(actor, change(json!(40), None), audit(), |_| Ok(()))
        .await
        .unwrap();
    assert_eq!(onboarding.direction, Direction::Loosen);
    assert!(onboarding.onboarding_exempt);

    hire_someone(&pool, actor.org).await;
    let too_soon = store
        .change_setting(actor, change(json!(50), None), audit(), |_| Ok(()))
        .await;
    assert_eq!(code(too_soon), "setting_loosening_delay");

    let later = OffsetDateTime::now_utc() + Duration::hours(25);
    let scheduled = store
        .change_setting(actor, change(json!(50), Some(later)), audit(), |_| Ok(()))
        .await
        .unwrap();
    assert!(!scheduled.onboarding_exempt);
    let listed = store.list_effective(actor.org, None).await.unwrap();
    let row = listed.iter().find(|s| s.key.as_str() == KEY).unwrap();
    assert_eq!(row.value, Some(SettingValue::Int(40)), "not in force yet");
    assert_eq!(row.scheduled.len(), 1);
    assert_eq!(row.scheduled[0].id, scheduled.id);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_trigger_refuses_what_the_domain_refuses(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let fixed = "approval.doc_class.registered_branch_change.requires_governing_body_decision";
    for (key, value, at, expected) in [
        ("no.such.key", json!(1), "0", "setting_unknown_key"),
        (fixed, json!(false), "0", "setting_not_editable"),
        (
            "backup.archive_tail",
            json!(10),
            "0",
            "setting_not_editable",
        ),
        (KEY, json!("20"), "0", "setting_value_invalid"),
        (KEY, json!(91), "0", "setting_out_of_range"),
        (KEY, json!(20), "-1 minute", "setting_backdated"),
    ] {
        let got = raw_insert(&store, actor, key, value, at).await;
        assert_eq!(got, Err(expected.to_owned()), "{key}");
    }
    // The trigger, not the caller, sets the direction.
    let direction = raw_insert(&store, actor, KEY, json!(40), "0").await;
    assert_eq!(direction, Ok("loosen".to_owned()));

    hire_someone(&pool, actor.org).await;
    let got = raw_insert(&store, actor, KEY, json!(60), "23 hours").await;
    assert_eq!(got, Err("setting_loosening_delay".to_owned()));
    let got = raw_insert(&store, actor, KEY, json!(20), "1 hour").await;
    assert_eq!(got, Ok("tighten".to_owned()));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rows_are_append_only_and_tenant_isolated(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    store
        .change_setting(actor, change(json!(20), None), audit(), |_| Ok(()))
        .await
        .unwrap();
    for statement in [
        "UPDATE tenant_setting_overrides SET value = '25'",
        "DELETE FROM tenant_setting_overrides",
    ] {
        // rls-arming: ok owner-pool probe of the append-only trigger
        let err = sqlx::query(statement).execute(&pool).await.unwrap_err();
        let sqlx::Error::Database(db) = err else {
            panic!("{err:?}")
        };
        assert_eq!(db.code().as_deref(), Some("55000"), "{statement}");
    }

    let (other, other_store) = tenant(&pool).await;
    let listed = other_store.list_effective(other.org, None).await.unwrap();
    let row = listed.iter().find(|s| s.key.as_str() == KEY).unwrap();
    assert_eq!(row.version, Some(SettingVersionId::CodeDefault));
    // Armed as the other tenant, an unfiltered read sees none of its rows.
    let visible: i64 = with_org_conn(other_store.pool(), other.org, |tx| {
        Box::pin(async move {
            sqlx::query_scalar("SELECT count(*) FROM tenant_setting_overrides")
                .fetch_one(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)
        })
    })
    .await
    .unwrap();
    assert_eq!(visible, 0, "RLS hides the first tenant's rows");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn force_removal_of_an_archived_tenant_clears_its_settings(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    store
        .change_setting(actor, change(json!(20), None), audit(), |_| Ok(()))
        .await
        .unwrap();
    // rls-arming: ok owner-pool platform maintenance
    sqlx::query("UPDATE organizations SET status = 'ARCHIVED' WHERE id = $1")
        .bind(actor.org.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    // rls-arming: ok owner-pool platform maintenance
    let outcome: String = sqlx::query_scalar("SELECT platform_force_remove_organization($1)")
        .bind(actor.org.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(outcome, "removed");
    // rls-arming: ok owner-pool assertion
    let left: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tenant_setting_overrides WHERE org_id = $1")
            .bind(actor.org.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(left, 0);
}
