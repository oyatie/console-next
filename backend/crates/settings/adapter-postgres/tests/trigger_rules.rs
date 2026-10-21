//! The BW-00 table as the runtime role (`console_rt`, RLS armed): the
//! `BEFORE INSERT` trigger enforces the D0.3 change rules even when the
//! domain check is skipped, a loosening waits 24 h once the tenant has an
//! employee, rows are append-only and tenant-isolated, and force removal of
//! an archived tenant clears them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::{
    AuditRequestContext, KernelError, OrgId, SettingVersionId, TraceContext,
};
use console_platform_db::{DbError, with_org_conn};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use console_settings_adapter_postgres::{
    PgSettingsError, PgSettingsStore, settings_change_payload,
};
use console_settings_application::{Actor, ChangeSetting};
use console_settings_domain::{Direction, SettingKey, SettingValue};
use serde_json::{Value, json};
use sha2::Digest;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

const KEY: &str = "approval.delegation.max_days"; // 1..=90, default 30, higher is looser

fn audit() -> (TraceContext, AuditRequestContext) {
    (TraceContext::generate(), AuditRequestContext::default())
}

fn change(value: Value, effective_from: Option<OffsetDateTime>) -> ChangeSetting {
    ChangeSetting {
        key: KEY.to_owned(),
        scope_entity_id: None,
        value,
        effective_from,
        reason_code: "POLICY_REVIEW".to_owned(),
        reason_note: Some("quarterly review".to_owned()),
        step_up_assertion_id: None,
    }
}

async fn tenant(pool: &PgPool) -> (Actor, PgSettingsStore) {
    let org = Uuid::new_v4();
    let user = seed_org_and_super_admin(pool, org, "settings").await;
    let actor = Actor {
        org: OrgId::from_uuid(org),
        user,
    };
    (actor, PgSettingsStore::new(runtime_role_pool(pool).await))
}

async fn hire_someone(pool: &PgPool, org: OrgId) {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, source_row, source_key, raw_row, source_metadata) VALUES ($1, $2, 'test', 'someone', 'test.xlsx', 'employees', 1, $3, '{}', '{}')",
    )
    .bind(id)
    .bind(org.as_uuid())
    .bind(format!("settings-{id}"))
    // rls-arming: ok test fixture seeds as owner during setup
    .execute(pool)
    .await
    .unwrap();
}

fn err_code(err: &PgSettingsError) -> &'static str {
    match err {
        PgSettingsError::Domain(KernelError { code: Some(c), .. }) => c,
        other => panic!("expected a coded refusal, got {other:?}"),
    }
}

fn code(result: Result<impl std::fmt::Debug, PgSettingsError>) -> &'static str {
    match result {
        Err(err) => err_code(&err),
        other => panic!("expected a coded refusal, got {other:?}"),
    }
}

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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn random_uuid_step_up_is_refused_for_loosening_and_writes_no_row(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let later = OffsetDateTime::now_utc() + Duration::hours(24);
    let cmd = ChangeSetting {
        key: KEY.to_owned(),
        scope_entity_id: None,
        value: json!(60),
        effective_from: Some(later),
        reason_code: "POLICY_REVIEW".to_owned(),
        reason_note: None,
        step_up_assertion_id: Some(Uuid::new_v4()),
    };
    let err = store
        .change_setting(actor, cmd, audit(), |facts| {
            if facts.direction == Direction::Loosen && !facts.step_up {
                return Err(
                    KernelError::forbidden("loosening a setting requires passkey step-up")
                        .with_code("step_up_required"),
                );
            }
            Ok(())
        })
        .await
        .unwrap_err();
    assert_eq!(err_code(&err), "step_up_required");

    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tenant_setting_overrides WHERE org_id = $1")
            .bind(actor.org.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn real_settings_change_step_up_permits_loosening_and_writes_row(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let later = OffsetDateTime::now_utc() + Duration::hours(24);
    let ceremony_id = Uuid::new_v4();
    let key: SettingKey = KEY.parse().unwrap();
    let val = SettingValue::Int(60);
    let payload = settings_change_payload(key, &val);
    let payload_hash = hex::encode(sha2::Sha256::digest(payload.as_bytes()));

    // Seed the verified step_up_assertion
    sqlx::query(
        "INSERT INTO step_up_assertions (ceremony_id, org_id, user_id, credential_row_id, action_kind, object_id, payload_hash, user_verified)
         VALUES ($1, $2, $3, $4, 'SETTINGS_CHANGE', $5, $6, true)",
    )
    .bind(ceremony_id)
    .bind(actor.org.as_uuid())
    .bind(actor.user.as_uuid())
    .bind(Uuid::new_v4())
    .bind(Uuid::nil())
    .bind(payload_hash)
    .execute(&pool)
    .await
    .unwrap();

    let cmd = ChangeSetting {
        key: KEY.to_owned(),
        scope_entity_id: None,
        value: json!(60),
        effective_from: Some(later),
        reason_code: "POLICY_REVIEW".to_owned(),
        reason_note: None,
        step_up_assertion_id: Some(ceremony_id),
    };
    let view = store
        .change_setting(actor, cmd, audit(), |facts| {
            assert!(facts.step_up);
            assert_eq!(facts.direction, Direction::Loosen);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(view.direction, Direction::Loosen);

    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tenant_setting_overrides WHERE org_id = $1")
            .bind(actor.org.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1);

    let saved_ceremony: Option<Uuid> = sqlx::query_scalar(
        "SELECT step_up_assertion_id FROM tenant_setting_overrides WHERE org_id = $1",
    )
    .bind(actor.org.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(saved_ceremony, Some(ceremony_id));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unknown_reason_code_is_refused_and_writes_no_row(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let cmd = ChangeSetting {
        key: KEY.to_owned(),
        scope_entity_id: None,
        value: json!(20),
        effective_from: None,
        reason_code: "UNKNOWN_REASON_CODE".to_owned(),
        reason_note: None,
        step_up_assertion_id: None,
    };
    let err = store
        .change_setting(actor, cmd, audit(), |_| Ok(()))
        .await
        .unwrap_err();
    assert_eq!(err_code(&err), "reason_code_invalid");

    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tenant_setting_overrides WHERE org_id = $1")
            .bind(actor.org.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
}
