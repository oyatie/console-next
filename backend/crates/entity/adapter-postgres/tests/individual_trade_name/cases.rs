// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_entity_application::{CloseLegalEntity, CloseWithdrawal};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn individual_backdated_revision_inherits_facts_in_force_not_scheduled_facts(pool: PgPool) {
    let (store, actor, id, reg) = individual_setup(&pool).await;
    let view = store.get_entity(&actor, id, true).await.unwrap();
    let mut future = revision(&view, reg, printed("000-01-00007", "미래 상호"));
    future.effective_from = Some("2027-01-01".into());
    future.reason_code = Some("AMENDMENT".into());
    future.input.classification_reason = Some(Some("미래 등록증의 판단 근거".into()));
    store
        .revise_registration(&cmd(&actor), reg, future, status())
        .await
        .unwrap();
    let mut past = revision(&view, reg, certificate("000-01-00007"));
    past.expected_version = Some(head(&pool, reg).await.0);
    past.effective_from = Some("2020-03-02".into());
    past.input.tax_office_label = Some("다른 세무서".into());
    store
        .revise_registration(&cmd(&actor), reg, past, status())
        .await
        .unwrap();
    let saved: (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT trade_name, classification_reason FROM business_registration_revisions \
         WHERE registration_id = $1 ORDER BY version DESC LIMIT 1",
    )
    .bind(reg)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(saved, (Some("독립 상호".into()), None));
    let dated = store
        .get_entity_at(
            &actor,
            id,
            true,
            console_entity_application::ReadOptions {
                as_of: Some(time::macros::date!(2021 - 03 - 31)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let current = dated.registrations[0].current.as_ref().unwrap();
    assert_eq!(current.trade_name, "독립 상호");
    assert_eq!(current.classification_reason, None);
    assert_eq!(head(&pool, reg).await.1.as_deref(), Some("미래 상호"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn individual_status_and_close_copies_keep_individual_trade_name(pool: PgPool) {
    let (store, actor, id, reg) = individual_setup(&pool).await;
    store
        .create_workplace(&cmd(&actor), id, workplace_from(reg, "본사"), port())
        .await
        .unwrap();
    for state in ["SUSPENDED", "CONTINUING"] {
        let today: time::Date =
            sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
                .fetch_one(&pool)
                .await
                .unwrap();
        let view = store.get_entity(&actor, id, true).await.unwrap();
        let mut rev = revision(&view, reg, printed("000-01-00007", "가나상회"));
        rev.effective_from = Some(today.to_string());
        store
            .revise_registration(
                &cmd(&actor),
                reg,
                rev,
                RegistrationStatusInput {
                    status: Some(state.into()),
                    status_since: (state == "SUSPENDED").then(|| today.to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(head(&pool, reg).await.1.as_deref(), Some("가나상회"));
    }
    // Lock: seed a differing stored fact before the copies, including on the base writer.
    sqlx::query("INSERT INTO business_registration_revisions SELECT (jsonb_populate_record(NULL::business_registration_revisions, to_jsonb(r) || jsonb_build_object('id', gen_random_uuid(), 'version', r.version+1, 'trade_name', '독립 상호', 'command_id', gen_random_uuid()))).* FROM business_registration_revisions r WHERE registration_id=$1 ORDER BY version DESC LIMIT 1").bind(reg).execute(&pool).await.unwrap();
    let today: String = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date::text")
        .fetch_one(&pool)
        .await
        .unwrap();
    store
        .close_entity(
            &cmd(&actor),
            id,
            CloseLegalEntity {
                closed_on: Some(today),
                reason_code: Some("BUSINESS_CLOSED".into()),
            },
            port(),
        )
        .await
        .unwrap();
    assert_eq!(head(&pool, reg).await.1.as_deref(), Some("독립 상호"));
    store
        .withdraw_close(
            &cmd(&actor),
            id,
            CloseWithdrawal {
                why: Some("계속 영업".into()),
            },
            port(),
        )
        .await
        .unwrap();
    assert_eq!(head(&pool, reg).await.1.as_deref(), Some("독립 상호"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_null_individual_reads_fallback_but_revision_keeps_null(pool: PgPool) {
    let (store, actor, id, reg) = individual_setup(&pool).await;
    sqlx::query("INSERT INTO business_registration_revisions SELECT (jsonb_populate_record(NULL::business_registration_revisions, to_jsonb(r) || jsonb_build_object('id', gen_random_uuid(), 'version', r.version+1, 'trade_name', NULL, 'command_id', gen_random_uuid()))).* FROM business_registration_revisions r WHERE registration_id=$1 ORDER BY version DESC LIMIT 1").bind(reg).execute(&pool).await.unwrap();
    let view = store.get_entity(&actor, id, true).await.unwrap();
    assert_eq!(
        view.registrations[0].current.as_ref().unwrap().trade_name,
        "가나상회"
    );
    store
        .revise_registration(
            &cmd(&actor),
            reg,
            revision(&view, reg, certificate("000-01-00007")),
            status(),
        )
        .await
        .unwrap();
    assert_eq!(head(&pool, reg).await.1, None);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn corporate_legacy_copy_is_cleared_without_a_history_change(pool: PgPool) {
    let (store, actor) = tenant(&pool, Uuid::new_v4(), "corporate").await;
    let id = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0123459"))
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(&actor), id, printed("000-81-00009", "무시할 상호"))
        .await
        .unwrap()
        .record
        .id;
    assert_eq!(head(&pool, reg).await.1, None);
    sqlx::query("INSERT INTO business_registration_revisions SELECT (jsonb_populate_record(NULL::business_registration_revisions, to_jsonb(r) || jsonb_build_object('id', gen_random_uuid(), 'version', r.version+1, 'trade_name', '옛 법인명', 'command_id', gen_random_uuid()))).* FROM business_registration_revisions r WHERE registration_id=$1 ORDER BY version DESC LIMIT 1").bind(reg).execute(&pool).await.unwrap();
    let view = store.get_entity(&actor, id, true).await.unwrap();
    store
        .revise_registration(
            &cmd(&actor),
            reg,
            revision(&view, reg, printed("000-81-00009", "무시할 상호")),
            status(),
        )
        .await
        .unwrap();
    assert_eq!(head(&pool, reg).await.1, None);
    let view = store.get_entity(&actor, id, true).await.unwrap();
    assert_eq!(
        view.registrations[0].current.as_ref().unwrap().trade_name,
        "주식회사 가나"
    );
    // Copy a legacy corporate row through close, too: catches a revision_copy CASE regression.
    sqlx::query("INSERT INTO business_registration_revisions SELECT (jsonb_populate_record(NULL::business_registration_revisions, to_jsonb(r) || jsonb_build_object('id', gen_random_uuid(), 'version', r.version+1, 'trade_name', '옛 법인명', 'command_id', gen_random_uuid()))).* FROM business_registration_revisions r WHERE registration_id=$1 ORDER BY version DESC LIMIT 1").bind(reg).execute(&pool).await.unwrap();
    store
        .create_workplace(&cmd(&actor), id, workplace_from(reg, "본사"), port())
        .await
        .unwrap();
    let today: String = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date::text")
        .fetch_one(&pool)
        .await
        .unwrap();
    store
        .close_entity(
            &cmd(&actor),
            id,
            CloseLegalEntity {
                closed_on: Some(today),
                reason_code: Some("BUSINESS_CLOSED".into()),
            },
            port(),
        )
        .await
        .unwrap();
    assert_eq!(head(&pool, reg).await.1, None);
    let history =
        serde_json::to_value(store.registration_history(&actor, reg, true).await.unwrap()).unwrap();
    assert!(!history.to_string().contains("trade_name"), "{history}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn individual_concurrent_trade_name_edits_have_exactly_one_survivor(pool: PgPool) {
    let (store, actor, id, reg) = individual_setup(&pool).await;
    let view = store.get_entity(&actor, id, true).await.unwrap();
    let a = cmd(&actor);
    let b = cmd(&actor);
    let (a, b) = tokio::join!(
        store.revise_registration(
            &a,
            reg,
            revision(&view, reg, printed("000-01-00007", "상호 A")),
            status()
        ),
        store.revise_registration(
            &b,
            reg,
            revision(&view, reg, printed("000-01-00007", "상호 B")),
            status()
        )
    );
    let (winner, loser) = match (a, b) {
        (Ok(a), Err(b)) | (Err(b), Ok(a)) => (a, b),
        other => panic!("{other:?}"),
    };
    assert_eq!(code(loser).0, "stale_revision");
    let name = winner.record.current.unwrap().trade_name;
    assert!(["상호 A", "상호 B"].contains(&name.as_str()));
    assert_eq!(head(&pool, reg).await.1, Some(name));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn individual_foreign_tenant_and_replay_append_nothing(pool: PgPool) {
    let (store, actor, id, reg) = individual_setup(&pool).await;
    let view = store.get_entity(&actor, id, true).await.unwrap();
    let rev = revision(&view, reg, certificate("000-01-00007"));
    let before = head(&pool, reg).await;
    let (_, other) = tenant(&pool, Uuid::new_v4(), "foreign").await;
    let err = store
        .revise_registration(&cmd(&other), reg, rev.clone(), status())
        .await
        .unwrap_err();
    assert_eq!(code(err).0, "registration_not_found");
    assert_eq!(head(&pool, reg).await, before);
    let once = cmd(&actor);
    store
        .revise_registration(&once, reg, rev.clone(), status())
        .await
        .unwrap();
    let saved = head(&pool, reg).await;
    assert_eq!(saved.0, before.0 + 1);
    assert_eq!(saved.1.as_deref(), Some("독립 상호"));
    store
        .revise_registration(&once, reg, rev, status())
        .await
        .unwrap();
    assert_eq!(head(&pool, reg).await, saved);
}
