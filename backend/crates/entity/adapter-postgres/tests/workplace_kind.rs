#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! 사업장 kind (decisions #18, MR-19), as `console_rt` (FORCE RLS): the
//! platform defaults with the tenant's own kinds and overrides, the kind at
//! create and as a direct, audited change in both phases.

mod common;

use common::*;
use console_entity_application::{CreateWorkplaceKind, SetWorkplaceKind, UpdateWorkplaceKind};
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0E19);

fn kind(code: Option<&str>) -> SetWorkplaceKind {
    SetWorkplaceKind {
        kind_code: code.map(str::to_owned),
    }
}

fn label(text: Option<&str>) -> UpdateWorkplaceKind {
    UpdateWorkplaceKind {
        label: Some(text.map(str::to_owned)),
        active: None,
    }
}

fn active(on: bool) -> UpdateWorkplaceKind {
    UpdateWorkplaceKind {
        label: None,
        active: Some(on),
    }
}

fn field_code(err: console_entity_adapter_postgres::PgEntityError) -> (String, &'static str) {
    code(err).1.into_iter().next().expect("a field issue")
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn kinds_are_platform_defaults_plus_the_tenants_own(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "K").await;
    let list = store.list_workplace_kinds(&actor).await.unwrap();
    let codes: Vec<&str> = list.iter().map(|k| k.code.as_str()).collect();
    assert_eq!(
        codes,
        [
            "HEAD_OFFICE",
            "WORKPLACE",
            "FACTORY",
            "BRANCH",
            "SALES_OFFICE",
            "RESEARCH_LAB",
            "LOGISTICS_CENTER",
            "STORE"
        ]
    );
    assert!(
        list.iter()
            .all(|k| k.platform && k.active && k.label.is_none())
    );
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM workplace_kinds")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(rows, 0, "no seed rows: the defaults are constants");

    // A tenant kind: generated code, own label; one command id applies once.
    let add = cmd(&actor);
    let depot = store
        .create_workplace_kind(
            &add,
            CreateWorkplaceKind {
                label: Some(" 창고 ".into()),
            },
        )
        .await
        .unwrap();
    let again = store
        .create_workplace_kind(
            &add,
            CreateWorkplaceKind {
                label: Some(" 창고 ".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        (depot.label.as_deref(), depot.platform, depot.active),
        (Some("창고"), false, true)
    );
    assert_eq!(again.code, depot.code, "a replay returns the first kind");
    assert!(Uuid::parse_str(&depot.code).is_ok());
    for taken in ["창고", "Depot", "depot"] {
        let res = store
            .create_workplace_kind(
                &cmd(&actor),
                CreateWorkplaceKind {
                    label: Some(taken.into()),
                },
            )
            .await;
        if taken == "Depot" {
            res.unwrap();
        } else {
            assert_eq!(
                field_code(res.unwrap_err()),
                ("label".into(), "label_taken"),
                "{taken}"
            );
        }
    }
    let err = store
        .create_workplace_kind(
            &cmd(&actor),
            CreateWorkplaceKind {
                label: Some("  ".into()),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(field_code(err), ("label".into(), "required"));

    // A platform default is relabelled and reset through an override row.
    let store_kind = store
        .update_workplace_kind(&cmd(&actor), "STORE".into(), label(Some("점포")))
        .await
        .unwrap();
    assert_eq!(
        (store_kind.label.as_deref(), store_kind.platform),
        (Some("점포"), true)
    );
    let reset = store
        .update_workplace_kind(&cmd(&actor), "STORE".into(), label(None))
        .await
        .unwrap();
    assert_eq!(reset.label, None);
    let err = store
        .update_workplace_kind(&cmd(&actor), depot.code.clone(), label(None))
        .await
        .unwrap_err();
    assert_eq!(
        field_code(err),
        ("label".into(), "required"),
        "a tenant kind keeps a label"
    );
    let err = store
        .update_workplace_kind(&cmd(&actor), "TEAM".into(), active(false))
        .await
        .unwrap_err();
    assert_eq!(code(err).0, "workplace_kind_not_found");

    // The kind at create; a deactivated kind is not offered.
    store
        .update_workplace_kind(&cmd(&actor), "FACTORY".into(), active(false))
        .await
        .unwrap();
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
    let mut factory = workplace_from(reg, "공장");
    factory.kind_code = Some("FACTORY".into());
    let err = store
        .create_workplace(&cmd(&actor), entity, factory.clone(), port())
        .await
        .unwrap_err();
    assert_eq!(field_code(err), ("kind_code".into(), "inactive_choice"));
    factory.kind_code = Some(depot.code.clone());
    let wp = store
        .create_workplace(&cmd(&actor), entity, factory, port())
        .await
        .unwrap()
        .record;
    assert_eq!(wp.kind_code.as_deref(), Some(depot.code.as_str()));

    // A direct change, refused for unknown codes; a deactivated kind the
    // 사업장 already has stays valid; null clears it.
    for bad in ["factory", "TEAM", &Uuid::new_v4().to_string()] {
        let err = store
            .set_workplace_kind(&cmd(&actor), wp.id, kind(Some(bad)))
            .await
            .unwrap_err();
        assert_eq!(
            field_code(err),
            ("kind_code".into(), "invalid_choice"),
            "{bad}"
        );
    }
    store
        .update_workplace_kind(&cmd(&actor), depot.code.clone(), active(false))
        .await
        .unwrap();
    let kept = store
        .set_workplace_kind(&cmd(&actor), wp.id, kind(Some(&depot.code)))
        .await
        .unwrap();
    assert_eq!(kept.record.kind_code.as_deref(), Some(depot.code.as_str()));
    let cleared = store
        .set_workplace_kind(&cmd(&actor), wp.id, kind(None))
        .await
        .unwrap();
    assert_eq!(cleared.record.kind_code, None);

    // After 운영 시작 it stays direct (a label changes no rule), audited GOVERNED.
    set_operating(&owner, ORG).await;
    let branch = store
        .set_workplace_kind(&cmd(&actor), wp.id, kind(Some("BRANCH")))
        .await
        .unwrap();
    assert_eq!(
        (
            branch.record.kind_code.as_deref(),
            branch.change_mode.as_str()
        ),
        (Some("BRANCH"), "GOVERNED")
    );
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action IN ('workplace.kind', 'workplace_kind.create', 'workplace_kind.update')",
    )
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        audited, 9,
        "every applied kind write is audited once (replays add none)"
    );
    let tree = store.org_structure(&actor).await.unwrap();
    assert_eq!(
        tree.entities[0].children[0].workplace_kind.as_deref(),
        Some("BRANCH")
    );
}
