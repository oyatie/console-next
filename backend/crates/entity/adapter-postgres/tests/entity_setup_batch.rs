#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! MR-29: bulk 법인 · 사업장 create and update from a sheet, as the runtime
//! role (FORCE RLS): a dry run writes nothing and diffs; the apply needs the
//! dry run's digest and writes one receipt; the SETUP undo restores the exact
//! prior records and voids what the batch created; never a blind revert.

mod common;
mod sheet_support;

use common::*;
use console_entity_application::{EntitySetupOp, LegalEntityRevision};
use sheet_support::*;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_dry_run_writes_nothing_and_the_apply_needs_its_digest(owner: PgPool) {
    let f = fixture(&owner).await;
    let before = plain(&f.store.list_entities(&f.actor, true).await.unwrap());
    let mut batch = sheet(&f).await;
    batch.dry_run = true;
    let preview = run(&f, batch.clone()).await;
    let outcomes: Vec<_> = preview.items.iter().map(|i| i.outcome).collect();
    assert_eq!(
        outcomes,
        ["CREATED", "CREATED", "CHANGED", "CHANGED"],
        "{preview:?}"
    );
    assert!(
        preview.items[2]
            .changes
            .iter()
            .any(|c| c.field == "capital_won")
    );
    let fields: Vec<_> = preview.items[3]
        .changes
        .iter()
        .map(|c| c.field.as_str())
        .collect();
    assert!(
        fields.contains(&"name") && fields.contains(&"is_head_office"),
        "{fields:?}"
    );
    assert_eq!(
        plain(&f.store.list_entities(&f.actor, true).await.unwrap()),
        before,
        "a dry run writes nothing"
    );

    // Every row's refusal at once, with the record a duplicate CREATE matched.
    let mut bad = batch.clone();
    bad.ops.push(EntitySetupOp {
        entity: Some(corporation("주식회사 가나", "000211-0006241")),
        ..op("CREATE_ENTITY")
    });
    bad.ops.push(EntitySetupOp {
        entity_ref: Some("nope".into()),
        workplace: Some(site("x")),
        ..op("CREATE_WORKPLACE")
    });
    let listed = run(&f, bad).await;
    let dup = listed.items[4].error.as_ref().unwrap();
    assert_eq!(
        (dup.code, dup.existing_id),
        ("already_exists", Some(f.entity))
    );
    assert_eq!(
        listed.items[5].error.as_ref().unwrap().fields[0].code,
        "unknown_ref"
    );

    batch.dry_run = false;
    let err = f
        .store
        .entity_setup_batch(&cmd(&f.actor), batch.clone(), port())
        .await
        .unwrap_err();
    assert_eq!(code(err).1, vec![("preview_digest".to_owned(), "required")]);
    batch.preview_digest = Some(preview.preview_digest.clone());
    let applied = run(&f, batch.clone()).await;
    assert!(applied.batch_id.is_some());
    assert_eq!(applied.preview_digest, preview.preview_digest);
    let a = f.store.get_entity(&f.actor, f.entity, true).await.unwrap();
    assert_eq!(a.current.unwrap().capital_won, Some(500_000_000));
    assert_eq!(a.head_office_workplace_id, Some(f.branch));
    assert_eq!(
        f.store.list_entities(&f.actor, true).await.unwrap().len(),
        2
    );

    // The same sheet again: the digest moved with the versions.
    let err = f
        .store
        .entity_setup_batch(&cmd(&f.actor), batch, port())
        .await
        .unwrap_err();
    assert_eq!(code(err).0, "rows_changed_since_preview");

    // A row that changes nothing is reported and never written.
    let v = version(&f).await;
    let mut same = corporation("주식회사 가나", "000211-0006241");
    same.capital_won = Some(500_000_000);
    let unchanged = revise_a(&f, same, v).await;
    assert_eq!(
        (unchanged.items[0].outcome, unchanged.items[0].version),
        ("UNCHANGED", Some(v))
    );
    assert_eq!(version(&f).await, v, "nothing written");
}

async fn version(f: &Fixture) -> i32 {
    let a = f.store.get_entity(&f.actor, f.entity, true).await.unwrap();
    a.current.unwrap().version
}

/// Preview, then apply, one REVISE of 법인 A; the apply's result.
async fn revise_a(
    f: &Fixture,
    input: console_entity_domain::legal_entity::LegalEntityInput,
    v: i32,
) -> console_entity_application::EntitySetupResult {
    let mut batch = sheet(f).await;
    batch.ops = vec![EntitySetupOp {
        id: Some(f.entity),
        expected_version: Some(v),
        entity: Some(input),
        ..op("REVISE_ENTITY")
    }];
    batch.dry_run = true;
    let preview = run(f, batch.clone()).await;
    batch.dry_run = false;
    batch.preview_digest = Some(preview.preview_digest);
    run(f, batch).await
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_setup_undo_restores_the_exact_records_once_and_never_blindly(owner: PgPool) {
    let f = fixture(&owner).await;
    let before = plain(&f.store.get_entity(&f.actor, f.entity, true).await.unwrap());
    let mut batch = sheet(&f).await;
    batch.dry_run = true;
    batch.preview_digest = Some(run(&f, batch.clone()).await.preview_digest);
    batch.dry_run = false;
    let applied = run(&f, batch).await.batch_id.unwrap();
    assert!(f.store.list_entity_setup_batches(&f.actor).await.unwrap()[0].undoable);

    let undo = f
        .store
        .undo_entity_setup_batch(&cmd(&f.actor), applied, port())
        .await
        .unwrap();
    assert_eq!((undo.kind.as_str(), undo.undoes), ("UNDO", Some(applied)));
    let after = f.store.get_entity(&f.actor, f.entity, true).await.unwrap();
    assert_eq!(after.head_office_workplace_id, Some(f.head));
    assert_eq!(
        plain(&after),
        before,
        "the undo restores the records exactly"
    );
    assert_eq!(
        f.store.list_entities(&f.actor, true).await.unwrap().len(),
        1,
        "the created 법인 is voided"
    );
    let again = f
        .store
        .undo_entity_setup_batch(&cmd(&f.actor), applied, port())
        .await
        .unwrap_err();
    assert_eq!(code(again).0, "batch_already_undone");

    // A record changed after the batch: refused, nothing applied.
    let mut batch = sheet(&f).await;
    batch.ops.clear();
    let a = f.store.get_entity(&f.actor, f.entity, true).await.unwrap();
    let mut capital = corporation("주식회사 가나", "000211-0006241");
    capital.capital_won = Some(7);
    batch.ops.push(EntitySetupOp {
        id: Some(f.entity),
        expected_version: a.current.as_ref().map(|c| c.version),
        entity: Some(capital.clone()),
        ..op("REVISE_ENTITY")
    });
    batch.dry_run = true;
    batch.preview_digest = Some(run(&f, batch.clone()).await.preview_digest);
    batch.dry_run = false;
    let second = run(&f, batch).await.batch_id.unwrap();
    let v = f
        .store
        .get_entity(&f.actor, f.entity, true)
        .await
        .unwrap()
        .current
        .unwrap()
        .version;
    capital.capital_won = Some(8);
    let rev = LegalEntityRevision {
        expected_version: Some(v),
        effective_from: Some("2026-01-01".into()),
        reason_code: Some("FIX".into()),
        input: capital,
    };
    f.store
        .revise_entity(&cmd(&f.actor), f.entity, rev)
        .await
        .unwrap();
    let err = f
        .store
        .undo_entity_setup_batch(&cmd(&f.actor), second, port())
        .await
        .unwrap_err();
    assert_eq!(code(err).0, "undo_conflict");

    // After 운영 시작 the receipts stay; their undo is gone.
    set_operating(&owner, ORG).await;
    let err = f
        .store
        .undo_entity_setup_batch(&cmd(&f.actor), second, port())
        .await
        .unwrap_err();
    assert_eq!(code(err).0, "phase_not_setup");
    assert!(
        !f.store
            .list_entity_setup_batches(&f.actor)
            .await
            .unwrap()
            .iter()
            .any(|b| b.undoable)
    );
    // The bulk path stays open after 운영 시작, governed like the single routes.
    let mut capital = corporation("주식회사 가나", "000211-0006241");
    capital.capital_won = Some(9);
    // The pin is the newest version; the backdated revise above is not `current`.
    let newest: i32 = sqlx::query_scalar(
        "SELECT max(version) FROM legal_entity_revisions WHERE legal_entity_id = $1",
    )
    .bind(f.entity)
    .fetch_one(&owner)
    .await
    .unwrap();
    let governed = revise_a(&f, capital, newest).await;
    assert_eq!(
        (governed.change_mode.as_str(), governed.items[0].outcome),
        ("GOVERNED", "CHANGED")
    );
}

/// 0h N-1: the 법인's registration head `trade_name` (what the previous release reads).
async fn trade_name(owner: &PgPool, f: &Fixture) -> String {
    sqlx::query_scalar(
        "SELECT r.trade_name FROM business_registration_revisions r JOIN business_registrations b ON b.id = r.registration_id \
         WHERE b.legal_entity_id = $1 ORDER BY r.effective_from DESC, r.version DESC LIMIT 1",
    )
    .bind(f.entity)
    .fetch_one(owner)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_sheet_rename_and_its_undo_carry_the_name_to_the_registration(owner: PgPool) {
    let f = fixture(&owner).await;
    let v = version(&f).await;
    let applied = revise_a(&f, corporation("주식회사 누리", "000211-0006241"), v).await;
    assert_eq!(trade_name(&owner, &f).await, "주식회사 누리");
    f.store
        .undo_entity_setup_batch(&cmd(&f.actor), applied.batch_id.unwrap(), port())
        .await
        .unwrap();
    assert_eq!(trade_name(&owner, &f).await, "주식회사 가나");
}
