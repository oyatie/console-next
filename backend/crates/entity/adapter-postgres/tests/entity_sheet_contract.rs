// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The browser's sheet contract preserves full state and requires dated intent.
mod common;
mod sheet_support;
use common::*;
use console_entity_application::{EntitySetupBatch, EntitySetupOp};
use sheet_support::*;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn dated_revisions_keep_unmapped_facts_and_unit_serial(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "sheet").await;
    let mut input = corporation("주식회사 가나", "000211-0006241");
    input.opened_on = Some("2020-03-02".into());
    input.capital_won = Some(300_000_000);
    input.main_phone = Some("+82212345678".into());
    input.incorporated_on = Some("2019-04-03".into());
    let entity = store
        .create_entity(&cmd(&actor), input.clone())
        .await
        .unwrap()
        .record
        .id;
    let mut cert = certificate("000-81-00009");
    cert.unit_taxation = Some(true);
    let reg = store
        .create_registration(&cmd(&actor), entity, cert)
        .await
        .unwrap()
        .record
        .id;
    store
        .create_workplace(&cmd(&actor), entity, workplace_from(reg, "본사"), port())
        .await
        .unwrap();
    let mut factory = workplace_from(reg, "공장");
    factory.is_head_office = None;
    factory.input.sub_serial = Some("0001".into());
    factory.input.phone = Some("+82212345678".into());
    factory.input.main_product = Some("부품".into());
    factory.input.independent_lsa_unit = Some(true);
    factory.input.independent_lsa_evidence = Some("별도 취업규칙과 노무관리".into());
    let w = store
        .create_workplace(&cmd(&actor), entity, factory.clone(), port())
        .await
        .unwrap()
        .record;
    let before = store.get_entity(&actor, entity, true).await.unwrap();
    input.name = Some("주식회사 누리".into());
    factory.input.name = Some("제1공장".into());
    factory.input.insurance = None;
    factory.input.status = Some("CONTINUING".into());
    let today: time::Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(&owner)
        .await
        .unwrap();
    let mut batch = EntitySetupBatch {
        dry_run: true,
        effective_from: Some(today.to_string()),
        reason_code: Some("이름 변경".into()),
        ops: vec![
            EntitySetupOp {
                id: Some(entity),
                expected_version: before.current.as_ref().map(|c| c.version),
                entity: Some(input),
                ..op("REVISE_ENTITY")
            },
            EntitySetupOp {
                id: Some(w.id),
                expected_version: w.current.as_ref().map(|c| c.version),
                workplace: Some(factory.input),
                ..op("REVISE_WORKPLACE")
            },
        ],
        ..EntitySetupBatch::default()
    };
    let preview = store
        .entity_setup_batch(&cmd(&actor), batch.clone(), port())
        .await
        .unwrap();
    assert!(
        preview.items.iter().all(|i| i.outcome == "CHANGED"),
        "{preview:?}"
    );
    assert_eq!(
        plain(&store.get_entity(&actor, entity, true).await.unwrap()),
        plain(&before)
    );
    batch.dry_run = false;
    batch.preview_digest = Some(preview.preview_digest);
    let applied = store
        .entity_setup_batch(&cmd(&actor), batch, port())
        .await
        .unwrap();
    assert!(
        applied.items.iter().all(|i| i.outcome == "CHANGED"),
        "{applied:?}"
    );
    let after = store.get_entity(&actor, entity, true).await.unwrap();
    let c = after.current.as_ref().unwrap();
    assert_eq!(c.capital_won, Some(300_000_000));
    assert_eq!(c.main_phone.as_ref().unwrap().value, "+82212345678");
    assert_eq!(
        c.incorporated_on.map(|d| d.to_string()).as_deref(),
        Some("2019-04-03")
    );
    let revised = after.workplaces.iter().find(|p| p.id == w.id).unwrap();
    let facts = revised.current.as_ref().unwrap();
    assert_eq!(revised.sub_serial.as_deref(), Some("0001"));
    assert_eq!(revised.registration_id, Some(reg));
    assert_eq!(
        facts.opened_on.map(|d| d.to_string()).as_deref(),
        Some("2020-03-02")
    );
    assert_eq!(facts.phone.as_ref().unwrap().value, "+82212345678");
    assert_eq!(facts.main_product.as_deref(), Some("부품"));
    assert_eq!(
        facts.independent_lsa_evidence.as_deref(),
        Some("별도 취업규칙과 노무관리")
    );
    assert_eq!(plain(&revised.insurance), plain(&w.insurance));
    store
        .undo_entity_setup_batch(&cmd(&actor), applied.batch_id.unwrap(), port())
        .await
        .unwrap();
    assert_eq!(
        plain(&store.get_entity(&actor, entity, true).await.unwrap()),
        plain(&before)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn revisions_require_date_reason_and_current_version(owner: PgPool) {
    let f = fixture(&owner).await;
    let before = plain(&f.store.get_entity(&f.actor, f.entity, true).await.unwrap());
    for (field, want) in [
        ("effective_from", "required"),
        ("reason_code", "required"),
        ("expected_version", "stale_revision"),
    ] {
        let mut batch = sheet(&f).await;
        batch.ops = vec![batch.ops[2].clone()];
        match field {
            "effective_from" => batch.effective_from = None,
            "reason_code" => batch.reason_code = None,
            _ => batch.ops[0].expected_version = Some(999),
        }
        batch.dry_run = true;
        let refused = run(&f, batch).await;
        let error = refused.items[0].error.as_ref().unwrap();
        assert!(
            error.code == want
                || error
                    .fields
                    .iter()
                    .any(|i| i.field == field && i.code == want),
            "{refused:?}"
        );
        assert_eq!(
            plain(&f.store.get_entity(&f.actor, f.entity, true).await.unwrap()),
            before
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn workplace_creation_needs_insurance_and_keeps_answered_opening_date(owner: PgPool) {
    let f = fixture(&owner).await;
    let mut input = site("새 공장");
    input.insurance = None;
    let mut batch = EntitySetupBatch {
        dry_run: true,
        ops: vec![EntitySetupOp {
            legal_entity_id: Some(f.entity),
            workplace: Some(input),
            ..op("CREATE_WORKPLACE")
        }],
        ..EntitySetupBatch::default()
    };
    let refused = run(&f, batch.clone()).await;
    assert!(
        refused.items[0]
            .error
            .as_ref()
            .unwrap()
            .fields
            .iter()
            .any(|i| i.field == "insurance" && i.code == "required")
    );
    batch.ops[0].workplace = Some(site("새 공장"));
    let preview = run(&f, batch.clone()).await;
    assert_eq!(preview.items[0].outcome, "CREATED", "{preview:?}");
    batch.dry_run = false;
    batch.preview_digest = Some(preview.preview_digest);
    let applied = run(&f, batch).await;
    let e = f.store.get_entity(&f.actor, f.entity, true).await.unwrap();
    let w = e
        .workplaces
        .iter()
        .find(|w| Some(w.id) == applied.items[0].target_id)
        .unwrap();
    assert_eq!(
        w.current
            .as_ref()
            .unwrap()
            .opened_on
            .map(|d| d.to_string())
            .as_deref(),
        Some("2021-04-01")
    );
    assert_eq!(w.insurance.len(), 4);
}
