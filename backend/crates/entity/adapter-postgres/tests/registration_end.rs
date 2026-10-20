// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The registration preview follows certificate links, never unrelated employee placements.

mod common;

use common::*;
use console_entity_application::{Actor, EntityScope, VoidRecord};
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0C0D_0110);

fn mistake() -> VoidRecord {
    VoidRecord {
        reason_code: Some("DUPLICATE".into()),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn preview_matches_void_and_hides_missing_voided_and_out_of_scope_records(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "registration-preview").await;
    let mut input = corporation("주식회사 가나", "130111-0006246");
    input.vat_unit_mode = Some("PER_WORKPLACE".into());
    let entity = store
        .create_entity(&cmd(&actor), input)
        .await
        .unwrap()
        .record
        .id;
    let used = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    let workplace = store
        .create_workplace(&cmd(&actor), entity, workplace_from(used, "본사"), port())
        .await
        .unwrap()
        .record;
    person(
        &owner,
        &store,
        &actor,
        (entity, workplace.id, workplace.org_unit_id.unwrap()),
        "preview",
    )
    .await;
    assert_eq!(
        store
            .record_end_options(&actor, "legal_entity_id", entity)
            .await
            .unwrap()
            .delete
            .refusal,
        Some("record_in_use")
    );

    let spare = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00071"))
        .await
        .unwrap()
        .record
        .id;
    let preview = store.registration_end_options(&actor, spare).await.unwrap();
    assert!(preview.delete.allowed);
    assert_eq!(preview.revisions, 1);
    assert!(preview.linked_workplaces.is_empty());

    let preview = store.registration_end_options(&actor, used).await.unwrap();
    assert_eq!(preview.delete.refusal, Some("record_in_use"));
    assert_eq!(preview.linked_workplaces[0].id, workplace.id);
    assert_eq!(preview.linked_workplaces[0].name, "본사");
    assert_eq!(
        code(
            store
                .void_registration(&cmd(&actor), used, mistake())
                .await
                .unwrap_err()
        )
        .0,
        "record_in_use"
    );
    assert!(
        store
            .get_entity(&actor, entity, true)
            .await
            .unwrap()
            .registrations
            .iter()
            .any(|r| r.id == used)
    );

    let outside = Actor {
        scope: EntityScope::Only(vec![]),
        ..actor.clone()
    };
    assert_eq!(
        code(
            store
                .registration_end_options(&outside, spare)
                .await
                .unwrap_err()
        )
        .0,
        "registration_not_found"
    );
    let (_, other) = tenant(&owner, Uuid::new_v4(), "other").await;
    assert_eq!(
        code(
            store
                .registration_end_options(&other, spare)
                .await
                .unwrap_err()
        )
        .0,
        "registration_not_found"
    );
    assert_eq!(
        code(
            store
                .registration_end_options(&actor, Uuid::new_v4())
                .await
                .unwrap_err()
        )
        .0,
        "registration_not_found"
    );

    store
        .void_registration(&cmd(&actor), spare, mistake())
        .await
        .unwrap();
    assert_eq!(
        code(
            store
                .registration_end_options(&actor, spare)
                .await
                .unwrap_err()
        )
        .0,
        "registration_not_found"
    );
    assert!(
        store
            .get_entity(&actor, entity, true)
            .await
            .unwrap()
            .registrations
            .iter()
            .all(|r| r.id != spare)
    );
    set_operating(&owner, ORG).await;
    assert_eq!(
        store
            .registration_end_options(&actor, used)
            .await
            .unwrap()
            .delete
            .refusal,
        Some("phase_not_setup")
    );
    assert_eq!(
        code(
            store
                .void_registration(&cmd(&actor), used, mistake())
                .await
                .unwrap_err()
        )
        .0,
        "phase_not_setup"
    );
}
