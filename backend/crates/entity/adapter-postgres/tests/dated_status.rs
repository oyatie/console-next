#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! UX-R1 ENTITY company-06 (catalog company-07) as `console_rt`: business suspension is a
//! dated status revision of a workplace or a business registration with its expected end,
//! and resumption a later revision back to continuing. A wrong expected end is refused
//! with nothing written.

mod common;

use common::*;
use console_entity_application::{RegistrationStatusInput, Revision, WorkplaceRevision};
use console_entity_domain::codes::OperatingStatus;
use console_entity_domain::workplace::WorkplaceInput;
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0D06);

async fn versions(owner: &PgPool, table: &str, _col: &str, id: Uuid) -> i64 {
    let sql = if table == "workplace_revisions" {
        "SELECT count(*) FROM workplace_revisions WHERE workplace_id = $1"
    } else {
        "SELECT count(*) FROM business_registration_revisions WHERE registration_id = $1"
    };
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_one(owner)
        .await
        .unwrap()
}

fn suspend(
    reg: Uuid,
    version: i32,
    status: &str,
    since: Option<&str>,
    until: Option<&str>,
) -> WorkplaceRevision {
    Revision {
        expected_version: Some(version),
        effective_from: Some("2026-02-01".into()),
        reason_code: Some("SUSPENSION".into()),
        input: WorkplaceInput {
            status: Some(status.into()),
            status_since: since.map(Into::into),
            status_until: until.map(Into::into),
            ..workplace_from(reg, "본사").input
        },
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_workplace_suspends_with_its_expected_end_and_resumes(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "S").await;
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
        .record
        .id;

    // Refusals: an end before the start, and an end on a continuing status. Nothing is written.
    for (status, since, until, field_code) in [
        (
            "SUSPENDED",
            Some("2026-02-01"),
            "2026-01-31",
            "status_until_before_since",
        ),
        ("CONTINUING", None, "2026-12-31", "not_applicable"),
    ] {
        let err = store
            .revise_workplace(
                &cmd(&actor),
                wp,
                suspend(reg, 1, status, since, Some(until)),
                port(),
            )
            .await
            .unwrap_err();
        assert_eq!(code(err).1, vec![("status_until".into(), field_code)]);
        assert_eq!(
            versions(&owner, "workplace_revisions", "workplace_id", wp).await,
            1
        );
    }

    let saved = store
        .revise_workplace(
            &cmd(&actor),
            wp,
            suspend(reg, 1, "SUSPENDED", Some("2026-02-01"), Some("2026-12-31")),
            port(),
        )
        .await
        .unwrap()
        .record;
    let now = saved.current.unwrap();
    assert_eq!(now.status, OperatingStatus::Suspended);
    assert_eq!(
        now.status_until.map(|d| d.to_string()),
        Some("2026-12-31".into())
    );

    // Resumption: back to continuing; the expected end goes with the business suspension.
    let mut back = suspend(reg, 2, "CONTINUING", None, None);
    back.effective_from = Some("2026-03-02".into());
    let resumed = store
        .revise_workplace(&cmd(&actor), wp, back, port())
        .await
        .unwrap()
        .record
        .current
        .unwrap();
    assert_eq!(
        (resumed.status, resumed.status_until),
        (OperatingStatus::Continuing, None)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_registration_suspends_with_its_expected_end(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "R").await;
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
    let rev = |version| Revision {
        expected_version: Some(version),
        effective_from: Some("2026-02-01".into()),
        reason_code: Some("SUSPENSION".into()),
        input: certificate("000-81-00009"),
    };
    let status = |until: &str| RegistrationStatusInput {
        status: Some("SUSPENDED".into()),
        status_since: Some("2026-02-01".into()),
        status_until: Some(until.into()),
    };
    let err = store
        .revise_registration(&cmd(&actor), reg, rev(1), status("2026-01-01"))
        .await
        .unwrap_err();
    assert_eq!(
        code(err).1,
        vec![("status_until".into(), "status_until_before_since")]
    );
    assert_eq!(
        versions(
            &owner,
            "business_registration_revisions",
            "registration_id",
            reg
        )
        .await,
        1
    );
    let saved = store
        .revise_registration(&cmd(&actor), reg, rev(1), status("2026-06-30"))
        .await
        .unwrap()
        .record
        .current
        .unwrap();
    assert_eq!(saved.status, OperatingStatus::Suspended);
    assert_eq!(
        saved.status_until.map(|d| d.to_string()),
        Some("2026-06-30".into())
    );
}
