#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! SS-001 / AD-F02c: 법인명 has one stored source. The released binary already derives
//! every registration's ① from the entity (no reader of `trade_name` remains), so no
//! write path stores 법인명 into `trade_name`: a 법인명 change appends nothing, status
//! copies drop legacy corporate names, and an individual registration keeps its 상호.
mod common;
use common::*;
use console_entity_application::{
    CloseLegalEntity, CloseWithdrawal, LegalEntityRevision, LegalEntityView,
};
use sqlx::PgPool;
use uuid::Uuid;

fn revision(v: &LegalEntityView, name: &str, alias: &str) -> LegalEntityRevision {
    let state = v.current.as_ref().unwrap();
    let mut input = corporation(name, &v.crn.as_ref().unwrap().value);
    input.display_name = Some(alias.into());
    LegalEntityRevision {
        input,
        expected_version: Some(state.version),
        effective_from: Some(state.effective_from.to_string()),
        reason_code: Some("CORRECTION".into()),
    }
}

/// (version, trade_name, reason_code, business types) of the registration's head revision, as stored.
async fn head(owner: &PgPool, reg: Uuid) -> (i32, Option<String>, String, i64) {
    sqlx::query_as(
        "SELECT r.version, r.trade_name, r.reason_code, \
           (SELECT count(*) FROM business_registration_business_types t WHERE t.revision_id = r.id) \
         FROM business_registration_revisions r WHERE r.registration_id = $1 \
         ORDER BY r.effective_from DESC, r.version DESC LIMIT 1",
    )
    .bind(reg)
    .fetch_one(owner)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_name_is_not_copied_on_close_replay_or_reopen(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "legacy-name").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0123459"))
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    store
        .create_workplace(&cmd(&actor), entity, workplace_from(reg, "본사"), port())
        .await
        .unwrap();
    // Immutable pre-upgrade revision with a Hangul corporate-name copy.
    sqlx::query(
        "INSERT INTO business_registration_revisions SELECT (jsonb_populate_record(NULL::business_registration_revisions, \
         to_jsonb(r) || jsonb_build_object('id', gen_random_uuid(), 'version', r.version + 1, \
           'trade_name', '주식회사 가나', 'command_id', gen_random_uuid()))).* \
         FROM business_registration_revisions r WHERE r.registration_id = $1 ORDER BY r.version DESC LIMIT 1",
    )
    .bind(reg)
    .execute(&owner)
    .await
    .unwrap();
    let today: String = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date::text")
        .fetch_one(&owner)
        .await
        .unwrap();
    let close = CloseLegalEntity {
        closed_on: Some(today),
        reason_code: Some("BUSINESS_CLOSED".into()),
    };
    let (_, other) = tenant(&owner, Uuid::new_v4(), "legacy-other").await;
    let before = head(&owner, reg).await;
    assert_eq!(before.1.as_deref(), Some("주식회사 가나"));
    let refused = store
        .close_entity(&cmd(&other), entity, close.clone(), port())
        .await
        .unwrap_err();
    assert_eq!(code(refused).0, "legal_entity_not_found");
    assert_eq!(head(&owner, reg).await, before);

    let once = cmd(&actor);
    store
        .close_entity(&once, entity, close.clone(), port())
        .await
        .unwrap();
    let closed = head(&owner, reg).await;
    assert_eq!(closed.0, before.0 + 1);
    assert_eq!(
        closed.1, None,
        "status copies must discard legacy corporate names"
    );
    store
        .close_entity(&once, entity, close, port())
        .await
        .unwrap();
    assert_eq!(head(&owner, reg).await, closed, "replay appends nothing");

    store
        .withdraw_close(
            &cmd(&actor),
            entity,
            CloseWithdrawal {
                why: Some("계속 영업".into()),
            },
            port(),
        )
        .await
        .unwrap();
    let reopened = head(&owner, reg).await;
    assert_eq!(reopened.0, closed.0 + 1);
    assert_eq!(reopened.1, None, "reopening must not revive a legacy name");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_legal_name_change_stores_no_copy_and_reads_the_new_name(owner: PgPool) {
    let org = Uuid::new_v4();
    let (store, actor) = tenant(&owner, org, "canary-name").await;
    let id = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000111-0012348"))
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(&actor), id, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    store
        .create_workplace(&cmd(&actor), id, workplace_from(reg, "본사"), port())
        .await
        .unwrap();
    let (version, trade, _, types) = head(&owner, reg).await;
    assert_eq!(trade, None, "no write path stores 법인명 into trade_name");
    let listed = store
        .registration_history(&actor, reg, true)
        .await
        .unwrap()
        .len();

    // An edit that keeps the 법인명 appends nothing to the registration.
    let view = store.get_entity(&actor, id, true).await.unwrap();
    store
        .revise_entity(&cmd(&actor), id, revision(&view, "주식회사 가나", "가나"))
        .await
        .unwrap();
    assert_eq!(head(&owner, reg).await.0, version);

    // A rename: no write path stores 법인명 into trade_name; no derived copy appended.
    let view = store.get_entity(&actor, id, true).await.unwrap();
    store
        .revise_entity(&cmd(&actor), id, revision(&view, "주식회사 누리", "가나"))
        .await
        .unwrap();
    assert_eq!(
        head(&owner, reg).await,
        (version, None, "CREATE".into(), types),
        "no copy is appended and trade_name remains NULL"
    );
    let view = store.get_entity(&actor, id, true).await.unwrap();
    let current = view.registrations[0].current.as_ref().unwrap();
    assert_eq!(current.trade_name, "주식회사 누리");
    assert_eq!(
        store
            .registration_history(&actor, reg, true)
            .await
            .unwrap()
            .len(),
        listed,
        "a rename appends no registration revision"
    );

    // A 등록증 sheet opened before the rename still saves: no person changed the registration.
    let back = console_entity_application::RegistrationRevision {
        expected_version: Some(version),
        effective_from: Some(current.effective_from.to_string()),
        reason_code: Some("CORRECTION".into()),
        input: certificate("000-81-00009"),
    };
    let status = console_entity_application::RegistrationStatusInput {
        status: Some("CONTINUING".into()),
        ..Default::default()
    };
    store
        .revise_registration(&cmd(&actor), reg, back.clone(), status.clone())
        .await
        .unwrap();
    // Once a person has, the old read is stale.
    let stale = store
        .revise_registration(&cmd(&actor), reg, back, status)
        .await
        .unwrap_err();
    assert_eq!(code(stale).0, "stale_revision");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_individual_registration_retains_trade_name(owner: PgPool) {
    let org = Uuid::new_v4();
    let (store, actor) = tenant(&owner, org, "individual-trade").await;
    let ind_input = console_entity_domain::legal_entity::LegalEntityInput {
        biz_kind: Some("INDIVIDUAL".into()),
        name: Some("가나상회".into()),
        representation_mode: Some("SINGLE".into()),
        representatives: vec!["홍길동".into()],
        ..Default::default()
    };
    let id = store
        .create_entity(&cmd(&actor), ind_input)
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(&actor), id, certificate("000-01-00007"))
        .await
        .unwrap()
        .record
        .id;
    let (_, trade, _, _) = head(&owner, reg).await;
    assert_eq!(
        trade,
        Some("가나상회".into()),
        "individual registration retains trade_name"
    );
    store
        .create_workplace(&cmd(&actor), id, workplace_from(reg, "본사"), port())
        .await
        .unwrap();
    // A certificate's own 상호 must survive independently of the entity name.
    sqlx::query(
        "INSERT INTO business_registration_revisions SELECT (jsonb_populate_record(NULL::business_registration_revisions, \
         to_jsonb(r) || jsonb_build_object('id', gen_random_uuid(), 'version', r.version + 1, \
           'trade_name', '독립 등록증 상호', 'command_id', gen_random_uuid()))).* \
         FROM business_registration_revisions r WHERE r.registration_id = $1 ORDER BY r.version DESC LIMIT 1",
    )
    .bind(reg)
    .execute(&owner)
    .await
    .unwrap();
    let today: String = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date::text")
        .fetch_one(&owner)
        .await
        .unwrap();
    let close = CloseLegalEntity {
        closed_on: Some(today),
        reason_code: Some("BUSINESS_CLOSED".into()),
    };
    let (_, other) = tenant(&owner, Uuid::new_v4(), "individual-other").await;
    let before = head(&owner, reg).await;
    assert_eq!(before.1.as_deref(), Some("독립 등록증 상호"));
    let refused = store
        .close_entity(&cmd(&other), id, close.clone(), port())
        .await
        .unwrap_err();
    assert_eq!(code(refused).0, "legal_entity_not_found");
    assert_eq!(head(&owner, reg).await, before);

    let once = cmd(&actor);
    store
        .close_entity(&once, id, close.clone(), port())
        .await
        .unwrap();
    let closed = head(&owner, reg).await;
    assert_eq!(closed.0, before.0 + 1);
    assert_eq!(closed.1.as_deref(), Some("독립 등록증 상호"));
    assert_eq!(closed.3, before.3);
    store.close_entity(&once, id, close, port()).await.unwrap();
    assert_eq!(head(&owner, reg).await, closed, "replay appends nothing");

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
    let reopened = head(&owner, reg).await;
    assert_eq!(reopened.0, closed.0 + 1);
    assert_eq!(reopened.1.as_deref(), Some("독립 등록증 상호"));
    assert_eq!(reopened.3, before.3);
}
