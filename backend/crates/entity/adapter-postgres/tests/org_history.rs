// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! History reads keep the recorded action and actor, including direct registrations.

mod common;
mod sheet_support;

use common::*;
use console_entity_application::{EntitySetupBatch, EntitySetupOp, OrgSetupOp};
use serde_json::{Value, json};
use sheet_support::*;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn history_department_rows_name_the_actor_and_what_changed(owner: PgPool) {
    let f = fixture(&owner).await;
    let created = f
        .store
        .apply_org_setup_batch(
            &cmd(&f.actor),
            vec![under_workplace("q", "품질팀", f.head)],
            port(),
        )
        .await
        .unwrap();
    let unit = created.units[0].org_unit_id;
    let changed = f
        .store
        .apply_org_setup_batch(
            &cmd(&f.actor),
            vec![
                OrgSetupOp::Rename {
                    org_unit_id: Some(unit),
                    expected_version: Some(1),
                    name: Some("품질관리팀".into()),
                },
                OrgSetupOp::SetDetails {
                    org_unit_id: Some(unit),
                    expected_version: Some(2),
                    code: Some("QUALITY".into()),
                    head_employee_id: None,
                },
            ],
            port(),
        )
        .await
        .unwrap();
    let rows =
        serde_json::to_value(f.store.list_org_setup_batches(&f.actor).await.unwrap()).unwrap();
    let row = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == changed.batch_id.to_string())
        .unwrap();
    assert_eq!(row["actor_name"], "Admin S");
    assert_eq!(
        row["actions"],
        json!(["org_unit.setup_details", "org_unit.setup_rename"])
    );
    assert_eq!(row["unit_names"], json!(["품질관리팀"]));
    let first = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == created.batch_id.to_string())
        .unwrap();
    assert_eq!(first["actions"], json!(["org_unit.setup_create"]));
    assert_eq!(
        first["unit_names"],
        json!(["품질팀"]),
        "names come from the batch's revision"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn history_includes_direct_registrations_once_with_their_actor_and_target(owner: PgPool) {
    let f = fixture(&owner).await;
    let actor = cmd(&f.actor);
    let input = corporation("주식회사 누리", "000111-1234560");
    let registered = f.store.create_entity(&actor, input.clone()).await.unwrap();
    f.store.create_entity(&actor, input).await.unwrap();
    let rows =
        serde_json::to_value(f.store.list_entity_setup_batches(&f.actor).await.unwrap()).unwrap();
    let rows = rows.as_array().unwrap();
    assert_eq!(
        rows.len(),
        4,
        "one entity and two workplaces from the fixture, plus one replayed registration"
    );
    let matching: Vec<&Value> = rows
        .iter()
        .filter(|r| r["target_names"] == json!(["주식회사 누리"]))
        .collect();
    assert_eq!(matching.len(), 1);
    assert_eq!(matching[0]["id"], actor.command_id.unwrap().to_string());
    assert_eq!(matching[0]["registration_action"], "legal_entity.create");
    assert_eq!(matching[0]["actor_name"], "Admin S");
    assert_eq!(matching[0]["actor_id"], f.actor.user.as_uuid().to_string());
    assert_eq!(matching[0]["undoable"], false);
    assert_ne!(registered.record.id, actor.command_id.unwrap());
    assert_eq!(
        rows.iter()
            .filter(|r| r["registration_action"] == "workplace.create")
            .count(),
        2
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn history_entity_batches_keep_action_names_and_recorded_target_names(owner: PgPool) {
    let f = fixture(&owner).await;
    let mut batch = sheet(&f).await;
    batch.dry_run = true;
    let preview = run(&f, batch.clone()).await;
    batch.dry_run = false;
    batch.preview_digest = Some(preview.preview_digest);
    let applied = run(&f, batch).await;
    let rows =
        serde_json::to_value(f.store.list_entity_setup_batches(&f.actor).await.unwrap()).unwrap();
    let row = rows
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == applied.batch_id.unwrap().to_string())
        .unwrap();
    assert_eq!(row["actor_name"], "Admin S");
    assert_eq!(
        row["actions"],
        json!([
            "CREATE_ENTITY",
            "CREATE_WORKPLACE",
            "REVISE_ENTITY",
            "REVISE_WORKPLACE"
        ])
    );
    let names = row["target_names"].as_array().unwrap();
    for name in ["주식회사 다라", "동탄공장", "주식회사 가나", "평택 제1공장"]
    {
        assert!(names.contains(&json!(name)), "{names:?}");
    }
    assert!(row["registration_action"].is_null());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn history_undo_refuses_a_created_workplace_with_a_member(owner: PgPool) {
    let f = fixture(&owner).await;
    let mut batch = EntitySetupBatch {
        dry_run: true,
        ops: vec![EntitySetupOp {
            op: Some("CREATE_WORKPLACE".into()),
            legal_entity_id: Some(f.entity),
            workplace: Some(site("음성공장")),
            ..EntitySetupOp::default()
        }],
        ..EntitySetupBatch::default()
    };
    let preview = run(&f, batch.clone()).await;
    batch.dry_run = false;
    batch.preview_digest = Some(preview.preview_digest);
    let applied = run(&f, batch).await;
    let workplace = applied.items[0].target_id.unwrap();
    let unit = sqlx::query_scalar("SELECT org_unit_id FROM org_unit_placements WHERE workplace_id = $1 AND represents_workplace AND valid_to IS NULL").bind(workplace).fetch_one(&owner).await.unwrap();
    person(
        &owner,
        &f.store,
        &f.actor,
        (f.entity, workplace, unit),
        "q1",
    )
    .await;
    let refused = f
        .store
        .undo_entity_setup_batch(&cmd(&f.actor), applied.batch_id.unwrap(), port())
        .await
        .unwrap_err();
    assert_eq!(code(refused).0, "record_in_use");
}
