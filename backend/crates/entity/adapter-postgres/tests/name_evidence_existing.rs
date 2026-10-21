#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Production 0h: 법인명 has one stored source (the entity's name). Every
//! registration's ① derives from it; records saved before the rules are typed
//! problems on read; diverged legacy 상호 become one-time reviews (20261013153646645).
mod common;
use common::*;
use console_entity_application::{LegalEntityRevision, LegalEntityView, SettleNameReview};
use console_kernel_core::kr::synthetic;
use sqlx::PgPool;
use uuid::Uuid;

const BRANCH_TEST_BRN: &str = "0008500031";

#[test]
fn branch_fixture_uses_the_canonical_registration_classification() {
    let brn = console_kernel_core::kr::BizRegNo::parse(BRANCH_TEST_BRN)
        .expect("synthetic branch registration number parses");
    assert!(brn.warnings().is_empty());
    let rule = console_entity_domain::registration_classification::classification(brn.as_str())
        .expect("synthetic branch registration class exists");
    assert!(rule.biz_kinds.contains(&"CORPORATION"));
    assert!(!rule.head_office);
}

async fn candidates(owner: &PgPool, org: Uuid) -> Vec<String> {
    let runtime = console_platform_test_support::runtime_role_pool(owner).await;
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let names = console_entity_adapter_postgres::name_evidence::company_candidates(&mut tx, org)
        .await
        .unwrap()
        .into_iter()
        .map(|c| c.name)
        .collect();
    tx.rollback().await.unwrap();
    names
}

fn codes(v: &LegalEntityView) -> Vec<&'static str> {
    v.identity_problems.iter().map(|p| p.code).collect()
}

/// A 법인 with its 등록증 and 본사, named `name`.
async fn entity(
    store: &console_entity_adapter_postgres::PgEntityStore,
    actor: &console_entity_application::Actor,
    name: &str,
    brn: &str,
) -> (Uuid, Uuid) {
    let crn = if brn == synthetic::brn(81, 4321) {
        "000111-0012348"
    } else {
        "000211-0006241"
    };
    let entity = store
        .create_entity(&cmd(actor), corporation(name, crn))
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(actor), entity, certificate(brn))
        .await
        .unwrap()
        .record
        .id;
    store
        .create_workplace(&cmd(actor), entity, workplace_from(reg, "본사"), port())
        .await
        .unwrap();
    (entity, reg)
}

fn correction(v: &LegalEntityView, name: &str, alias: &str) -> LegalEntityRevision {
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_registration_name_is_the_entity_name_and_follows_its_edit(owner: PgPool) {
    let org = Uuid::new_v4();
    let (store, actor) = tenant(&owner, org, "single-source").await;
    // No 등록증 yet: the name is shown, its evidence is the problem.
    let bare = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000111-0012348"))
        .await
        .unwrap()
        .record;
    assert_eq!(codes(&bare), ["legal_name_unconfirmed"]);
    assert_eq!(bare.current.as_ref().unwrap().name, "주식회사 가나");
    let (id, reg) = entity(&store, &actor, "NURI", "000-81-00009").await;
    let view = store.get_entity(&actor, id, true).await.unwrap();
    assert_eq!(
        view.registrations[0].current.as_ref().unwrap().trade_name,
        "NURI"
    );
    // A 법인's registered 상호 is never without 한글 (상업등기규칙 §2).
    assert_eq!(codes(&view), ["legal_name_not_hangul"]);
    assert!(candidates(&owner, org).await.is_empty());

    // regression (0h): ① 수정 edits the one name, and every reader sees the new one.
    store
        .revise_entity(&cmd(&actor), id, correction(&view, "주식회사 누리", "NURI"))
        .await
        .unwrap();
    let view = store.get_entity(&actor, id, true).await.unwrap();
    assert_eq!(view.current.as_ref().unwrap().name, "주식회사 누리");
    assert_eq!(
        view.registrations[0].current.as_ref().unwrap().trade_name,
        "주식회사 누리"
    );
    assert!(codes(&view).is_empty(), "{:?}", codes(&view));
    assert_eq!(candidates(&owner, org).await, ["주식회사 누리"]);

    // A 지점 number saved as 대표 등록번호 before the classification rule existed.
    sqlx::query("UPDATE business_registrations SET brn = $2 WHERE id = $1")
        .bind(reg)
        .bind(BRANCH_TEST_BRN)
        .execute(&owner)
        .await
        .unwrap();
    let view = store.get_entity(&actor, id, true).await.unwrap();
    assert_eq!(codes(&view), ["primary_registration_classification"]);
    assert_eq!(view.identity_problems[0].field, "brn");
    assert!(candidates(&owner, org).await.is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_person_shaped_alias_saved_before_the_guard_is_typed(owner: PgPool) {
    let org = Uuid::new_v4();
    let (store, actor) = tenant(&owner, org, "alias-person").await;
    let (id, _) = entity(&store, &actor, "주식회사 누리", "000-81-00009").await;
    // As production's one production 법인: 「김예시,박예시」 typed into the 약칭.
    let mut tx = owner.begin().await.unwrap();
    sqlx::query(
        "ALTER TABLE legal_entity_revisions DISABLE TRIGGER trg_legal_entity_revisions_append_only",
    )
    .execute(tx.as_mut())
    .await
    .unwrap();
    sqlx::query("UPDATE legal_entity_revisions SET display_name = '김예시,박예시' WHERE legal_entity_id = $1")
        .bind(id)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "ALTER TABLE legal_entity_revisions ENABLE TRIGGER trg_legal_entity_revisions_append_only",
    )
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let view = store.get_entity(&actor, id, true).await.unwrap();
    assert_eq!(codes(&view), ["display_name_is_person"]);
    assert_eq!(view.identity_problems[0].field, "display_name");
    // The one-action fix: the record's 약칭 수정 (here: cleared).
    let mut fix = correction(&view, "주식회사 누리", "");
    fix.input.display_name = None;
    store.revise_entity(&cmd(&actor), id, fix).await.unwrap();
    let view = store.get_entity(&actor, id, true).await.unwrap();
    assert!(codes(&view).is_empty(), "{:?}", codes(&view));
}

/// A registration revision written by the old code, with its own 상호.
async fn diverge(owner: &PgPool, reg: Uuid, name: &str) {
    sqlx::query(
        "INSERT INTO business_registration_revisions (org_id, registration_id, version, effective_from, trade_name, opened_on, \
           business_address_id, unit_taxation, tax_office_label, tax_type, status, change_mode, reason_code, actor_id, \
           payload_digest, settings_snapshot, command_id) \
         SELECT org_id, registration_id, version + 1, effective_from, $2, opened_on, business_address_id, unit_taxation, \
           tax_office_label, tax_type, status, change_mode, reason_code, actor_id, payload_digest, settings_snapshot, gen_random_uuid() \
         FROM business_registration_revisions WHERE registration_id = $1 AND version = 1",
    )
    .bind(reg)
    .bind(name)
    .execute(owner)
    .await
    .unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn diverged_legacy_names_become_reviews_a_person_settles(owner: PgPool) {
    let org = Uuid::new_v4();
    let (store, actor) = tenant(&owner, org, "name-reviews").await;
    let (kept, kept_reg) = entity(&store, &actor, "주식회사 누리", "000-81-00009").await;
    let (taken, taken_reg) = entity(&store, &actor, "가나", &synthetic::brn(81, 4321)).await;
    diverge(&owner, kept_reg, "NURI").await;
    diverge(&owner, taken_reg, "주식회사 가나").await;
    let backfill = "SELECT legal_entity_name_review_backfill()";
    let raised: i64 = sqlx::query_scalar(backfill)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(raised, 2);
    let again: i64 = sqlx::query_scalar(backfill)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(again, 0, "a rerun raises nothing new");

    let view = store.get_entity(&actor, kept, true).await.unwrap();
    assert!(codes(&view).contains(&"legal_name_review"));
    let review = view.name_reviews[0].clone();
    assert_eq!(
        (
            review.entity_name.as_str(),
            review.registration_name.as_str()
        ),
        ("주식회사 누리", "NURI")
    );
    // The entity's name stays the source until a person picks: ① still shows it.
    assert_eq!(
        view.registrations[0].current.as_ref().unwrap().trade_name,
        "주식회사 누리"
    );
    let hidden = store.get_entity(&actor, kept, false).await.unwrap();
    assert!(hidden.name_reviews.is_empty(), "personal readers only");

    // Refusals, each without a write: a name that is neither value, another 법인's review.
    let other = store.get_entity(&actor, taken, true).await.unwrap();
    let bad = SettleNameReview {
        revision: Some(correction(&view, "아무개 상사", "NURI")),
    };
    let refused = code(
        store
            .settle_name_review(&cmd(&actor), kept, review.id, bad)
            .await
            .unwrap_err(),
    );
    assert_eq!(refused.1, [("name".to_owned(), "name_review_choice")]);
    let refused = code(
        store
            .settle_name_review(
                &cmd(&actor),
                kept,
                other.name_reviews[0].id,
                SettleNameReview::default(),
            )
            .await
            .unwrap_err(),
    );
    assert_eq!(refused.0, "name_review_not_found");
    let still = store.get_entity(&actor, kept, true).await.unwrap();
    assert_eq!(still.name_reviews.len(), 1);
    assert_eq!(
        still.current.as_ref().unwrap().version,
        view.current.as_ref().unwrap().version
    );

    // Keep the entity's name; a settled review cannot be settled again.
    let saved = store
        .settle_name_review(&cmd(&actor), kept, review.id, SettleNameReview::default())
        .await
        .unwrap();
    assert!(saved.record.name_reviews.is_empty());
    assert_eq!(saved.record.current.as_ref().unwrap().name, "주식회사 누리");
    let refused = code(
        store
            .settle_name_review(&cmd(&actor), kept, review.id, SettleNameReview::default())
            .await
            .unwrap_err(),
    );
    assert_eq!(refused.0, "name_review_not_found");

    // Take the registration's 상호 by a dated 정정; the old name is kept as 약칭.
    let take = SettleNameReview {
        revision: Some(correction(&other, "주식회사 가나", "가나")),
    };
    let saved = store
        .settle_name_review(&cmd(&actor), taken, other.name_reviews[0].id, take)
        .await
        .unwrap();
    let state = saved.record.current.as_ref().unwrap();
    assert_eq!(
        (state.name.as_str(), state.display_name.as_deref()),
        ("주식회사 가나", Some("가나"))
    );
    assert!(saved.record.name_reviews.is_empty());
    let settled: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT registration_name, settled_name FROM legal_entity_name_reviews WHERE org_id = $1 ORDER BY registration_name COLLATE \"C\"",
    )
    .bind(org)
    .fetch_all(&owner)
    .await
    .unwrap();
    assert_eq!(
        settled,
        [
            ("NURI".into(), Some("주식회사 누리".into())),
            ("주식회사 가나".into(), Some("주식회사 가나".into()))
        ]
    );
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'legal_entity.name_review.settle'",
    )
    .bind(org)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(audits, 2);
}
