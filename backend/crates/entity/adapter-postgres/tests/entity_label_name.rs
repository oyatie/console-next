// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use console_entity_adapter_postgres::employment_moves::entity_label;
use console_entity_application::{
    CreateWorkplace, LegalEntityRevision, RegistrationRevision, RegistrationStatusInput, VoidRecord,
};
use console_entity_domain::insurance::InsuranceSetupInput;
use console_entity_domain::workplace::WorkplaceInput;
use console_kernel_core::kr::synthetic;
use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

fn unlinked_primary_workplace(name: &str) -> CreateWorkplace {
    CreateWorkplace {
        input: WorkplaceInput {
            name: Some(name.into()),
            registration_id: None,
            same_address_as_registration: false,
            address: Some(address("서울특별시 강남구 테헤란로 152")),
            opened_on: Some("2020-03-02".into()),
            insurance: Some(InsuranceSetupInput {
                shortcut: Some("ALL_ESTABLISHED_NUMBERS_LATER".into()),
                insurers: vec![],
            }),
            ..WorkplaceInput::default()
        },
        is_primary: Some(true),
        is_head_office: Some(true),
        default_branch_id: None,
        kind_code: None,
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn entity_label_returns_name_with_multiple_confirmed_registrations_and_unlinked_primary_workplace(
    owner: PgPool,
) {
    let org = Uuid::new_v4();
    let (store, actor) = tenant(&owner, org, "entity-label-multi-reg").await;
    let mut input = corporation("주식회사 가나", &synthetic::crn(11, 1));
    input.incorporated_on = Some("2020-01-01".into());
    input.vat_unit_mode = Some("PER_WORKPLACE".into());
    let entity = store
        .create_entity(&cmd(&actor), input)
        .await
        .unwrap()
        .record
        .id;

    store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap();
    let mut branch = certificate("000-85-00050");
    branch.classification_reason = Some(Some("지점 등록증".into()));
    store
        .create_registration(&cmd(&actor), entity, branch)
        .await
        .unwrap();

    store
        .create_workplace(
            &cmd(&actor),
            entity,
            unlinked_primary_workplace("본사"),
            port(),
        )
        .await
        .unwrap();

    let mut conn = owner.acquire().await.unwrap();
    let label = entity_label(&mut conn, org, entity, date!(2026 - 09 - 01))
        .await
        .unwrap();
    assert_eq!(label.as_deref(), Some("주식회사 가나"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn entity_label_follows_dated_rename_revision_regardless_of_primary_workplace_link(
    owner: PgPool,
) {
    let org = Uuid::new_v4();
    let (store, actor) = tenant(&owner, org, "entity-label-rename").await;
    let mut input = corporation("주식회사 가나", &synthetic::crn(11, 1));
    input.incorporated_on = Some("2020-01-01".into());
    input.vat_unit_mode = Some("PER_WORKPLACE".into());
    let entity = store
        .create_entity(&cmd(&actor), input)
        .await
        .unwrap()
        .record
        .id;

    let reg1 = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    let mut branch = certificate("000-85-00050");
    branch.classification_reason = Some(Some("지점 등록증".into()));
    store
        .create_registration(&cmd(&actor), entity, branch)
        .await
        .unwrap();

    let wp = store
        .create_workplace(
            &cmd(&actor),
            entity,
            unlinked_primary_workplace("본사"),
            port(),
        )
        .await
        .unwrap()
        .record
        .id;

    let current_ver = store
        .get_entity(&actor, entity, true)
        .await
        .unwrap()
        .current
        .unwrap()
        .version;
    let mut renamed = corporation("주식회사 다라", &synthetic::crn(11, 1));
    renamed.incorporated_on = Some("2020-01-01".into());
    renamed.vat_unit_mode = Some("PER_WORKPLACE".into());
    store
        .revise_entity(
            &cmd(&actor),
            entity,
            LegalEntityRevision {
                expected_version: Some(current_ver),
                effective_from: Some("2026-09-02".into()),
                reason_code: Some("RENAME".into()),
                input: renamed,
            },
        )
        .await
        .unwrap();

    let mut conn = owner.acquire().await.unwrap();
    assert_eq!(
        entity_label(&mut conn, org, entity, date!(2026 - 09 - 01))
            .await
            .unwrap()
            .as_deref(),
        Some("주식회사 가나")
    );
    assert_eq!(
        entity_label(&mut conn, org, entity, date!(2026 - 09 - 02))
            .await
            .unwrap()
            .as_deref(),
        Some("주식회사 다라")
    );

    // Direct SQL on owner pool: also verify when primary_workplace.registration_id is linked.
    sqlx::query("UPDATE workplaces SET registration_id = $2 WHERE id = $1")
        .bind(wp)
        .bind(reg1)
        .execute(&mut *conn)
        .await
        .unwrap();
    assert_eq!(
        entity_label(&mut conn, org, entity, date!(2026 - 09 - 01))
            .await
            .unwrap()
            .as_deref(),
        Some("주식회사 가나")
    );
    assert_eq!(
        entity_label(&mut conn, org, entity, date!(2026 - 09 - 02))
            .await
            .unwrap()
            .as_deref(),
        Some("주식회사 다라")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn entity_label_returns_none_when_registrations_are_unconfirmed_voided_or_closed(
    owner: PgPool,
) {
    let org = Uuid::new_v4();
    let (store, actor) = tenant(&owner, org, "entity-label-neg").await;
    let mut input = corporation("주식회사 가나", &synthetic::crn(11, 1));
    input.incorporated_on = Some("2020-01-01".into());
    let entity = store
        .create_entity(&cmd(&actor), input)
        .await
        .unwrap()
        .record
        .id;
    let reg1 = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;

    let mut conn = owner.acquire().await.unwrap();

    // 1. All registrations need confirmation (direct SQL: store create_registration writes confirmed rows).
    sqlx::query("UPDATE business_registrations SET needs_confirmation = true WHERE id = $1")
        .bind(reg1)
        .execute(&mut *conn)
        .await
        .unwrap();
    assert_eq!(
        entity_label(&mut conn, org, entity, date!(2026 - 09 - 01))
            .await
            .unwrap(),
        None
    );

    // Restore confirmation, then void the registration via store command.
    sqlx::query("UPDATE business_registrations SET needs_confirmation = false WHERE id = $1")
        .bind(reg1)
        .execute(&mut *conn)
        .await
        .unwrap();
    store
        .void_registration(
            &cmd(&actor),
            reg1,
            VoidRecord {
                reason_code: Some("MISTAKEN_ENTRY".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        entity_label(&mut conn, org, entity, date!(2026 - 09 - 01))
            .await
            .unwrap(),
        None
    );

    // 3. Add a new registration and close it on 2026-09-01 via store command.
    let reg2 = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00014"))
        .await
        .unwrap()
        .record
        .id;
    store
        .revise_registration(
            &cmd(&actor),
            reg2,
            RegistrationRevision {
                expected_version: Some(1),
                effective_from: Some("2026-09-01".into()),
                reason_code: Some("CHANGE".into()),
                input: certificate("000-81-00014"),
            },
            RegistrationStatusInput {
                status: Some("CLOSED".into()),
                status_since: Some("2026-09-01".into()),
                status_until: None,
            },
        )
        .await
        .unwrap();

    // Before closed_on (2026-08-31) it is still open; on/after closed_on (2026-09-01, 2026-09-02) it is None.
    assert_eq!(
        entity_label(&mut conn, org, entity, date!(2026 - 08 - 31))
            .await
            .unwrap()
            .as_deref(),
        Some("주식회사 가나")
    );
    assert_eq!(
        entity_label(&mut conn, org, entity, date!(2026 - 09 - 01))
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        entity_label(&mut conn, org, entity, date!(2026 - 09 - 02))
            .await
            .unwrap(),
        None
    );
}
