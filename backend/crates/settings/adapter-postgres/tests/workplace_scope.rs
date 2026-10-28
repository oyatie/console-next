// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod settings_support;
use console_kernel_core::SettingVersionId;
use console_platform_db::{DbError, with_org_conn};
use console_settings_adapter_postgres::{load_rows_in_tx, resolve_in_tx};
use console_settings_domain::{OverrideRow, SettingKey, SettingValue, resolve};
use serde_json::json;
use settings_support::*;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

async fn scopes(pool: &PgPool, actor: console_settings_application::Actor) -> (Uuid, Uuid) {
    let entity = Uuid::new_v4();
    sqlx::query("INSERT INTO legal_entities(org_id,id,biz_kind,created_change_mode,created_by) VALUES($1,$2,'INDIVIDUAL','SETUP',$3)")
        .bind(actor.org.as_uuid()).bind(entity).bind(actor.user.as_uuid()).execute(pool).await.unwrap();
    let workplace = Uuid::new_v4();
    sqlx::query("INSERT INTO workplaces(org_id,id,legal_entity_id,needs_confirmation,created_change_mode,created_by) VALUES($1,$2,$3,true,'SETUP',$4)")
        .bind(actor.org.as_uuid()).bind(workplace).bind(entity).bind(actor.user.as_uuid()).execute(pool).await.unwrap();
    (entity, workplace)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn workplace_loader_and_plan_inherit_parent_and_entity_callers_are_unchanged(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let (entity, workplace) = scopes(&pool, actor).await;
    let mut cmd = change(json!(20), None);
    cmd.scope_entity_id = Some(entity);
    let parent = store
        .change_setting(actor, cmd, audit(), |_| Ok(()))
        .await
        .unwrap();
    let key: SettingKey = KEY.parse().unwrap();
    with_org_conn(store.pool(), actor.org, move |tx| {
        Box::pin(async move {
            let now: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
                .fetch_one(tx.as_mut())
                .await
                .unwrap();
            let (chain, rows) = load_rows_in_tx(tx.as_mut(), actor.org, &[key], Some(workplace))
                .await
                .unwrap();
            assert_eq!(
                chain.iter().map(|scope| scope.id).collect::<Vec<_>>(),
                vec![workplace, entity]
            );
            assert_eq!(rows[&key][0].id, parent.id);
            let inherited = resolve_in_tx(tx.as_mut(), actor.org, &[key], Some(workplace), now)
                .await
                .unwrap();
            let resolved = inherited[&key].as_ref().unwrap();
            assert_eq!(resolved.value, SettingValue::Int(20));
            assert_eq!(resolved.version, SettingVersionId::Override(parent.id));
            let values = resolve_in_tx(tx.as_mut(), actor.org, SettingKey::ALL, Some(entity), now)
                .await
                .unwrap();
            for &candidate in SettingKey::ALL {
                let rows = if candidate == key {
                    vec![OverrideRow {
                        id: parent.id,
                        scope_entity_id: Some(entity),
                        value: SettingValue::Int(20),
                        effective_from: now,
                    }]
                } else {
                    vec![]
                };
                assert_eq!(
                    values[&candidate],
                    resolve(candidate, &rows, Some(entity), now)
                );
            }
            Ok::<_, DbError>(())
        })
    })
    .await
    .unwrap();
    let mut cmd = change(json!(25), None);
    cmd.scope_entity_id = Some(workplace);
    let plan = store
        .plan_setting(actor, cmd.clone(), |_| Ok(()))
        .await
        .unwrap();
    assert_eq!(plan.in_force.value, Some(SettingValue::Int(20)));
    assert_eq!(plan.in_force.scope_entity_id, Some(entity));
    hire_someone(&pool, actor.org).await;
    assert_eq!(
        code(store.plan_setting(actor, cmd.clone(), |_| Ok(())).await),
        "setting_loosening_too_soon"
    );
    assert_eq!(
        code(store.change_setting(actor, cmd, audit(), |_| Ok(())).await),
        "setting_loosening_too_soon"
    );
    // Closed employers must remain readable by historical certificate and attendance callers.
    sqlx::query("UPDATE legal_entities SET closed_on=CURRENT_DATE, close_reason_code='BUSINESS_CLOSED' WHERE org_id=$1 AND id=$2")
        .bind(actor.org.as_uuid())
        .bind(entity)
        .execute(&pool)
        .await
        .unwrap();
    let listed = store
        .list_effective(actor.org, Some(workplace))
        .await
        .unwrap();
    assert_eq!(
        listed.iter().find(|r| r.key == key).unwrap().value,
        Some(SettingValue::Int(20))
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn trigger_compares_workplace_against_parent_and_rejects_unknown_scope(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let (entity, workplace) = scopes(&pool, actor).await;
    let mut cmd = change(json!(10), None);
    cmd.scope_entity_id = Some(entity);
    store
        .change_setting(actor, cmd, audit(), |_| Ok(()))
        .await
        .unwrap();
    hire_someone(&pool, actor.org).await;
    for (scope, expected) in [
        (workplace, "setting_loosening_delay"),
        (Uuid::new_v4(), "setting_scope_unknown"),
    ] {
        let err = with_org_conn(store.pool(), actor.org, move |tx| Box::pin(async move {
            sqlx::query("INSERT INTO tenant_setting_overrides(org_id,scope_entity_id,key,value,effective_from,set_by,reason_code) VALUES($1,$2,$3,'20',now(),$4,'X')")
                .bind(actor.org.as_uuid()).bind(scope).bind(KEY).bind(actor.user.as_uuid()).execute(tx.as_mut()).await.map_err(DbError::Sqlx)
        })).await.unwrap_err();
        assert!(
            matches!(err, DbError::Sqlx(sqlx::Error::Database(ref db)) if db.message() == expected),
            "{err:?}"
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn migration_preserves_the_old_binary_insert_columns_and_existing_rows(pool: PgPool) {
    let (actor, _) = tenant(&pool).await;
    let (entity, _) = scopes(&pool, actor).await;
    let migration = include_str!(
        "../../../platform/db/migrations/20261028083028731_settings_workplace_chain.sql"
    );
    let previous = migration.split("/* Rollback:").nth(1).unwrap();
    let previous =
        &previous[previous.find("CREATE OR REPLACE").unwrap()..previous.rfind("*/").unwrap()];
    let mut tx = pool.begin().await.unwrap();
    sqlx::raw_sql(previous).execute(tx.as_mut()).await.unwrap();
    let mut ids = vec![];
    for (forward, value) in [(false, 20), (true, 10)] {
        if forward {
            sqlx::raw_sql(migration).execute(tx.as_mut()).await.unwrap();
        }
        for scope in [None, Some(entity)] {
            let id: Uuid = sqlx::query_scalar("INSERT INTO tenant_setting_overrides(org_id,scope_entity_id,key,value,effective_from,set_by,reason_code,reason_note,step_up_assertion_id) VALUES($1,$2,$3,$4,clock_timestamp(),$5,'POLICY_REVIEW',NULL,NULL) RETURNING id")
                .bind(actor.org.as_uuid()).bind(scope).bind(KEY).bind(json!(value)).bind(actor.user.as_uuid()).fetch_one(tx.as_mut()).await.unwrap();
            ids.push(id);
        }
    }
    let retained: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tenant_setting_overrides WHERE id=ANY($1)")
            .bind(ids)
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
    assert_eq!(retained, 4);
    tx.commit().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unknown_scope_refusal_matches_plan_and_write(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let mut cmd = change(json!(20), None);
    cmd.scope_entity_id = Some(Uuid::new_v4());
    assert_eq!(
        code(store.plan_setting(actor, cmd.clone(), |_| Ok(())).await),
        "setting_scope_unknown"
    );
    assert_eq!(
        code(store.change_setting(actor, cmd, audit(), |_| Ok(())).await),
        "setting_scope_unknown"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn closed_heads_are_not_live_even_with_a_future_recorded_date(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let (entity, workplace) = scopes(&pool, actor).await;
    sqlx::query("UPDATE legal_entities SET closed_on=CURRENT_DATE+1, close_reason_code='BUSINESS_CLOSED' WHERE org_id=$1 AND id=$2")
        .bind(actor.org.as_uuid()).bind(entity).execute(&pool).await.unwrap();
    for scope in [entity, workplace] {
        let mut cmd = change(json!(20), None);
        cmd.scope_entity_id = Some(scope);
        assert_eq!(
            code(store.plan_setting(actor, cmd.clone(), |_| Ok(())).await),
            "setting_scope_unknown"
        );
        assert_eq!(
            code(store.change_setting(actor, cmd, audit(), |_| Ok(())).await),
            "setting_scope_unknown"
        );
        let err = with_org_conn(store.pool(), actor.org, move |tx| Box::pin(async move {
            sqlx::query("INSERT INTO tenant_setting_overrides(org_id,scope_entity_id,key,value,effective_from,set_by,reason_code) VALUES($1,$2,$3,'20',now(),$4,'X')")
                .bind(actor.org.as_uuid()).bind(scope).bind(KEY).bind(actor.user.as_uuid()).execute(tx.as_mut()).await.map_err(DbError::Sqlx)
        })).await.unwrap_err();
        assert!(
            matches!(err, DbError::Sqlx(sqlx::Error::Database(ref db)) if db.message() == "setting_scope_unknown"),
            "{err:?}"
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn trigger_prefers_older_workplace_value_over_newer_parent_value(pool: PgPool) {
    let (actor, _) = tenant(&pool).await;
    let (entity, workplace) = scopes(&pool, actor).await;
    for (scope, value) in [(workplace, 10), (entity, 20)] {
        sqlx::query("INSERT INTO tenant_setting_overrides(org_id,scope_entity_id,key,value,effective_from,set_by,reason_code) VALUES($1,$2,$3,$4,clock_timestamp(),$5,'X')")
            .bind(actor.org.as_uuid()).bind(scope).bind(KEY).bind(json!(value)).bind(actor.user.as_uuid()).execute(&pool).await.unwrap();
    }
    hire_someone(&pool, actor.org).await;
    let error = sqlx::query("INSERT INTO tenant_setting_overrides(org_id,scope_entity_id,key,value,effective_from,set_by,reason_code) VALUES($1,$2,$3,'15',clock_timestamp(),$4,'X')")
        .bind(actor.org.as_uuid()).bind(workplace).bind(KEY).bind(actor.user.as_uuid()).execute(&pool).await.unwrap_err();
    assert!(
        matches!(error, sqlx::Error::Database(ref db) if db.message()=="setting_loosening_delay"),
        "{error:?}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_explain_has_one_deciding_layer_and_unknown_scope_is_not_a_legal_entity(
    pool: PgPool,
) {
    let (actor, store) = tenant(&pool).await;
    store
        .change_setting(actor, change(json!(20), None), audit(), |_| Ok(()))
        .await
        .unwrap();
    let items = store.list_effective(actor.org, None).await.unwrap();
    let item = items.iter().find(|item| item.key.as_str() == KEY).unwrap();
    let wire = serde_json::to_value(item).unwrap();
    assert_eq!(wire["source"]["layer"], "tenant");
    assert_eq!(
        wire["chain"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["deciding"] == true)
            .count(),
        1
    );
    assert_eq!(
        code(store.list_effective(actor.org, Some(Uuid::new_v4())).await),
        "setting_scope_unknown"
    );
}
