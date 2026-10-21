#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! ENT-CAPTURE dated history, the 4대보험 change and the 상시근로자수 HOLD
//! placeholder, as the runtime role `console_rt` (FORCE RLS).

mod common;

use common::*;
use console_entity_application::{InsuranceChange, InsuranceRevision, LegalEntityRevision};
use console_entity_domain::insurance::InsurerInput;
use sqlx::PgPool;
use uuid::Uuid;

const ORG_A: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0E08);

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn history_lists_what_each_revision_changed_and_hides_restricted_names(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG_A, "A").await;
    let created = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record;
    let version = created.current.as_ref().unwrap().version;
    let mut input = corporation("주식회사 가나다", "000211-0006241");
    input.representatives = vec!["홍길동".into(), "김철수".into()];
    input.representation_mode = Some("SEVERAL".into());
    let rev = LegalEntityRevision {
        expected_version: Some(version),
        effective_from: Some("2030-01-01".into()),
        reason_code: Some("TRADE_NAME_CHANGE".into()),
        input,
    };
    store
        .revise_entity(&cmd(&actor), created.id, rev)
        .await
        .unwrap();

    let history = store
        .entity_history(&actor, created.id, true)
        .await
        .unwrap();
    assert_eq!(history.len(), 2, "newest first, the first record included");
    let newest = &history[0];
    assert_eq!(
        (newest.version, newest.reason_code.as_deref()),
        (version + 1, Some("TRADE_NAME_CHANGE"))
    );
    let changed: Vec<&str> = newest.changes.iter().map(|c| c.field.as_str()).collect();
    assert!(
        changed.contains(&"name") && changed.contains(&"representatives"),
        "{changed:?}"
    );
    let name = newest.changes.iter().find(|c| c.field == "name").unwrap();
    assert_eq!(
        (name.before.as_deref(), name.after.as_deref()),
        (Some("주식회사 가나"), Some("주식회사 가나다"))
    );
    assert!(newest.actor_name.is_some());
    assert!(
        history[1]
            .changes
            .iter()
            .any(|c| c.field == "head_office_address" && c.after.is_some())
    );

    // A reader without the write permission never sees 대표자 names, nor their changes.
    let plain = store
        .entity_history(&actor, created.id, false)
        .await
        .unwrap();
    assert!(
        plain
            .iter()
            .flat_map(|r| &r.changes)
            .all(|c| c.field != "representatives")
    );
    let (missing, _, _) = code(
        store
            .entity_history(&actor, Uuid::new_v4(), true)
            .await
            .unwrap_err(),
    );
    assert_eq!(missing, "legal_entity_not_found");
}

fn nps_established() -> InsurerInput {
    InsurerInput {
        insurer: Some("NPS".into()),
        status: Some("ESTABLISHED".into()),
        mgmt_no: Some("12345678901".into()),
        established_on: Some("2020-03-02".into()),
        ..InsurerInput::default()
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn insurance_changes_are_dated_versioned_and_in_the_workplace_history(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG_A, "A").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
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
    let wp = store
        .create_workplace(&cmd(&actor), entity, workplace_from(reg, "본사"), port())
        .await
        .unwrap()
        .record;
    assert_eq!(wp.regular_workers.status, "HOLD");
    assert_eq!(wp.regular_workers.value, None);
    let read = wp.insurance.iter().map(|i| i.version).max().unwrap();

    let change = |expected| InsuranceRevision {
        expected_version: Some(expected),
        effective_from: Some("2026-11-01".into()),
        reason_code: Some("INSURANCE_ESTABLISHED".into()),
        input: InsuranceChange {
            insurers: vec![nps_established()],
        },
    };
    let key = cmd(&actor);
    let saved = store
        .revise_insurance(&key, wp.id, change(read))
        .await
        .unwrap();
    assert_eq!(saved.change_mode, "SETUP");
    // The same Idempotency-Key replays: no second revision.
    store
        .revise_insurance(&key, wp.id, change(read))
        .await
        .unwrap();
    let nps_versions: i64 = sqlx::query_scalar("SELECT count(*) FROM workplace_insurance_revisions WHERE workplace_id = $1 AND insurer = 'NPS'")
        .bind(wp.id)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(nps_versions, 2);
    // Stale: the client read the version before this change.
    let (stale, _, _) = code(
        store
            .revise_insurance(&cmd(&actor), wp.id, change(read))
            .await
            .unwrap_err(),
    );
    assert_eq!(stale, "stale_revision");
    // A field issue names the insurer row.
    let mut bad = change(read + 1);
    bad.input.insurers[0].mgmt_no = None;
    let (_, fields, _) = code(
        store
            .revise_insurance(&cmd(&actor), wp.id, bad)
            .await
            .unwrap_err(),
    );
    assert_eq!(fields, vec![("insurers[0].mgmt_no".to_owned(), "required")]);

    let history = store.workplace_history(&actor, wp.id, true).await.unwrap();
    let newest = &history[0];
    assert!(
        newest.changes.iter().any(|c| c.field == "insurance.NPS.status" && c.after.as_deref() == Some("ESTABLISHED")),
        "{:?}",
        newest.changes
    );
    let entity_view = store.get_entity(&actor, entity, true).await.unwrap();
    assert_eq!(entity_view.regular_workers.status, "HOLD");
}
