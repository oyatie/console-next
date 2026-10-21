#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! LANE ENTITY-FIX (parity S3 dead ends, 2026-10-07): sequential edits on a
//! 법인 with a 등록증 — a scheduled 대표자 변경, then a 대표전화 정정, then a
//! 개업연월일 정정 — as the runtime role `console_rt` (FORCE RLS). What must
//! keep failing (a stale version, a 발급일 before the 개업연월일) is refused
//! with its code, writes no revision and no audit row.

mod common;

use common::*;
use console_entity_application::{
    LegalEntityRevision, RegistrationRevision, RegistrationStatusInput,
};
use console_entity_domain::legal_entity::LegalEntityInput;
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0E71);

fn revision(
    expected: i32,
    from: &str,
    reason: &str,
    input: LegalEntityInput,
) -> LegalEntityRevision {
    LegalEntityRevision {
        expected_version: Some(expected),
        effective_from: Some(from.into()),
        reason_code: Some(reason.into()),
        input,
    }
}

async fn count(owner: &PgPool, sql: &str, id: Uuid) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .bind(id)
        .fetch_one(owner)
        .await
        .unwrap()
}

/// A 법인 with its 등록증 (the VAT unit derived from it is v2); returns the
/// entity, the 등록증 and the newest entity version read.
async fn entity_with_certificate(
    owner: &PgPool,
) -> (
    console_entity_adapter_postgres::PgEntityStore,
    console_entity_application::Actor,
    Uuid,
    Uuid,
    i32,
) {
    let (store, actor) = tenant(owner, ORG, "EF").await;
    let entity = store
        .create_entity(
            &cmd(&actor),
            corporation("주식회사 새온정밀", "000211-0006241"),
        )
        .await
        .unwrap()
        .record
        .id;
    let mut cert = certificate("000-81-00009");
    cert.cert_issued_on = Some("2020-03-02".into());
    let reg = store
        .create_registration(&cmd(&actor), entity, cert)
        .await
        .unwrap()
        .record
        .id;
    let read = store.get_entity(&actor, entity, true).await.unwrap();
    let newest = read.current.as_ref().unwrap().version;
    (store, actor, entity, reg, newest)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_correction_after_a_scheduled_change_saves_on_the_newest_version_and_lists_only_its_field(
    owner: PgPool,
) {
    let (store, actor, entity, _, read) = entity_with_certificate(&owner).await;
    let today = store
        .get_entity(&actor, entity, true)
        .await
        .unwrap()
        .current
        .unwrap()
        .effective_from
        .to_string();
    let mut two = corporation("주식회사 새온정밀", "000211-0006241");
    two.representatives = vec!["홍길동".into(), "한지원".into()];
    two.representation_mode = Some("SEVERAL".into());
    store
        .revise_entity(
            &cmd(&actor),
            entity,
            revision(read, "2030-01-01", "CHANGE", two),
        )
        .await
        .unwrap();
    let audits = "SELECT count(*) FROM audit_events WHERE target_id = $1::text AND action = 'legal_entity.revise'";
    let revisions = "SELECT count(*) FROM legal_entity_revisions WHERE legal_entity_id = $1";
    let (audited, written) = (
        count(&owner, audits, entity).await,
        count(&owner, revisions, entity).await,
    );

    // Negative: the version read before the change is stale (409), and nothing is written.
    let mut phone = corporation("주식회사 새온정밀", "000211-0006241");
    phone.main_phone = Some("025550142".into());
    let (stale, _, _) = code(
        store
            .revise_entity(
                &cmd(&actor),
                entity,
                revision(read, &today, "CORRECTION", phone.clone()),
            )
            .await
            .unwrap_err(),
    );
    assert_eq!(stale, "stale_revision");
    assert_eq!(
        count(&owner, revisions, entity).await,
        written,
        "a stale save writes no revision"
    );
    assert_eq!(
        count(&owner, audits, entity).await,
        audited,
        "a stale save writes no audit row"
    );

    // On the newest version (current or scheduled) the 정정 of today saves.
    store
        .revise_entity(
            &cmd(&actor),
            entity,
            revision(read + 1, &today, "CORRECTION", phone),
        )
        .await
        .unwrap();
    let after = store.get_entity(&actor, entity, true).await.unwrap();
    assert_eq!(
        after
            .current
            .as_ref()
            .unwrap()
            .main_phone
            .as_ref()
            .map(|p| p.value.as_str()),
        Some("+8225550142")
    );
    assert_eq!(
        after.scheduled.len(),
        1,
        "the scheduled 대표자 변경 is kept"
    );

    // Regression: the 정정 lists only what it changed, not the scheduled 대표자.
    let history = store.entity_history(&actor, entity, true).await.unwrap();
    let fields: Vec<&str> = history[0]
        .changes
        .iter()
        .map(|c| c.field.as_str())
        .collect();
    assert_eq!(fields, vec!["main_phone"], "{:?}", history[0].changes);
    let scheduled: Vec<&str> = history[1]
        .changes
        .iter()
        .map(|c| c.field.as_str())
        .collect();
    assert!(
        scheduled.contains(&"representatives") && scheduled.contains(&"representation_mode"),
        "{scheduled:?}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_opening_date_after_the_issue_date_is_refused_by_field_and_saves_with_both_corrected(
    owner: PgPool,
) {
    let (store, actor, _, reg, _) = entity_with_certificate(&owner).await;
    let fix = |opened: &str, issued: &str| {
        let mut input = certificate("000-81-00009");
        input.opened_on = Some(opened.into());
        input.cert_issued_on = Some(issued.into());
        RegistrationRevision {
            expected_version: Some(1),
            effective_from: Some("2020-03-02".into()),
            reason_code: Some("CORRECTION".into()),
            input,
        }
    };
    let audits = "SELECT count(*) FROM audit_events WHERE target_id = $1::text AND action = 'business_registration.revise'";
    let revisions =
        "SELECT count(*) FROM business_registration_revisions WHERE registration_id = $1";
    let (top, fields, _) = code(
        store
            .revise_registration(
                &cmd(&actor),
                reg,
                fix("2020-03-03", "2020-03-02"),
                RegistrationStatusInput {
                    status: Some("CONTINUING".into()),
                    status_since: None,
                    status_until: None,
                },
            )
            .await
            .unwrap_err(),
    );
    assert_eq!(top, "validation_failed");
    assert_eq!(
        fields,
        vec![("cert_issued_on".to_owned(), "issued_before_opened")]
    );
    assert_eq!(
        count(&owner, revisions, reg).await,
        1,
        "a refused 정정 writes no revision"
    );
    assert_eq!(
        count(&owner, audits, reg).await,
        0,
        "a refused 정정 writes no audit row"
    );

    let saved = store
        .revise_registration(
            &cmd(&actor),
            reg,
            fix("2020-03-03", "2020-03-03"),
            RegistrationStatusInput {
                status: Some("CONTINUING".into()),
                status_since: None,
                status_until: None,
            },
        )
        .await
        .unwrap()
        .record;
    let c = saved.current.unwrap();
    assert_eq!(
        (
            c.opened_on.map(|d| d.to_string()),
            c.cert_issued_on.map(|d| d.to_string())
        ),
        (Some("2020-03-03".into()), Some("2020-03-03".into()))
    );
    assert_eq!(count(&owner, audits, reg).await, 1);
}
