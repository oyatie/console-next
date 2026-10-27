// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod settings_support;
use console_settings_application::Actor;
use serde_json::json;
use settings_support::*;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

async fn scopes(pool: &PgPool, actor: Actor) -> (Uuid, Uuid) {
    let entity: Uuid = sqlx::query_scalar("INSERT INTO legal_entities (org_id, biz_kind, created_change_mode, created_by) VALUES ($1, 'CORPORATION', 'SETUP', $2) RETURNING id")
        .bind(actor.org.as_uuid()).bind(actor.user.as_uuid()).fetch_one(pool).await.unwrap();
    let workplace: Uuid = sqlx::query_scalar("INSERT INTO workplaces (org_id, legal_entity_id, needs_confirmation, created_change_mode, created_by) VALUES ($1, $2, true, 'SETUP', $3) RETURNING id")
        .bind(actor.org.as_uuid()).bind(entity).bind(actor.user.as_uuid()).fetch_one(pool).await.unwrap();
    (entity, workplace)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reach_uses_descendants_not_siblings_and_ignores_future_only_rows(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let (a, workplace_a) = scopes(&pool, actor).await;
    let (_, workplace_b) = scopes(&pool, actor).await;
    let (future_entity, future_workplace) = scopes(&pool, actor).await;
    let now = OffsetDateTime::now_utc();
    for (scope, days, value) in [
        (workplace_a, 0, 20),
        (workplace_a, 1, 15),
        (workplace_b, 0, 20),
        (future_workplace, 4, 10),
    ] {
        let mut cmd = change(
            json!(value),
            (days > 0).then_some(now + Duration::days(days)),
        );
        cmd.scope_entity_id = Some(scope);
        store
            .change_setting(actor, cmd, audit(), |_| Ok(()))
            .await
            .unwrap();
    }
    let mut all = vec![workplace_a, workplace_b];
    all.sort();
    for (scope, expected) in [
        (None, all),
        (Some(a), vec![workplace_a]),
        (Some(future_entity), vec![]),
        (Some(workplace_a), vec![]),
    ] {
        let mut cmd = change(json!(10), Some(now + Duration::days(2)));
        cmd.scope_entity_id = scope;
        let plan = store.plan_setting(actor, cmd, |_| Ok(())).await.unwrap();
        assert_eq!(plan.reaches.scope_entity_id, scope);
        assert_eq!(plan.reaches.keeps_own_value, expected);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn concurrent_expected_version_writes_apply_once(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    sqlx::raw_sql("CREATE FUNCTION pause_setting_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$;
        CREATE TRIGGER pause_setting_insert BEFORE INSERT ON tenant_setting_overrides FOR EACH ROW EXECUTE FUNCTION pause_setting_insert();")
        .execute(&pool).await.unwrap();
    let (first, second) = tokio::join!(store.pool().acquire(), store.pool().acquire());
    drop((first.unwrap(), second.unwrap()));
    let mut cmd = change(json!(20), None);
    cmd.expected_version = Some(console_kernel_core::SettingVersionId::CodeDefault);
    let (a, b) = tokio::join!(
        store.change_setting(actor, cmd.clone(), audit(), |_| Ok(())),
        store.change_setting(actor, cmd, audit(), |_| Ok(())),
    );
    assert_eq!(
        usize::from(a.is_ok()) + usize::from(b.is_ok()),
        1,
        "{a:?} {b:?}"
    );
    let refused = a.err().or_else(|| b.err()).unwrap();
    assert_eq!(err_code(&refused), "setting_version_stale");
}
