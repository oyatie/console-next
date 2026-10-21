#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! MR-15 as `console_rt`: a 법인 해산/폐업 closes its 사업장 and 사업자등록
//! with it, once, and is refused while people remain.

mod close_support;
mod common;

use close_support::*;
use common::*;
use console_entity_application::{CloseLegalEntity, Revision};
use console_entity_domain::codes::CloseReason;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn closing_an_entity_closes_its_workplaces_and_registrations_once(owner: PgPool) {
    let w = world(&owner).await;
    let kim = employee(&owner, "k1").await;
    w.store
        .bind_assignment(&cmd(&w.actor), bind(&w, kim, w.hq, "2025-01-01"))
        .await
        .unwrap();
    let close = |on: &str, reason: &str| CloseLegalEntity {
        closed_on: Some(on.into()),
        reason_code: Some(reason.into()),
    };

    // Typed input: no future date, a known reason.
    let (_, fields, _) = code(
        w.store
            .close_entity(
                &cmd(&w.actor),
                w.entity,
                close("2999-01-01", "LIQUIDATED"),
                port(),
            )
            .await
            .unwrap_err(),
    );
    assert_eq!(
        fields,
        vec![
            ("closed_on".to_owned(), "date_in_future"),
            ("reason_code".to_owned(), "invalid_option")
        ]
    );
    // People still placed: refused.
    let (code_, _, remedy) = code(
        w.store
            .close_entity(
                &cmd(&w.actor),
                w.entity,
                close("2026-01-31", "DISSOLVED"),
                port(),
            )
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, remedy),
        ("record_in_use", Some("move_people_first"))
    );

    // Kim's placement ended before the 해산일 (rows close set-once).
    sqlx::query("UPDATE employment_assignments SET valid_to = '2026-01-01' WHERE employee_id = $1")
        .bind(kim)
        .execute(&owner)
        .await
        .unwrap();
    let once = cmd(&w.actor);
    let saved = w
        .store
        .close_entity(&once, w.entity, close("2026-01-31", "DISSOLVED"), port())
        .await
        .unwrap()
        .record;
    assert_eq!(
        (saved.closed_on, saved.close_reason_code),
        (Some(date("2026-01-31")), Some(CloseReason::Dissolved))
    );
    for wp in [w.hq, w.branch] {
        assert_eq!(
            closed_on(&owner, "workplaces", wp).await,
            Some(date("2026-01-31"))
        );
        assert_eq!(head(&owner, wp).await, ("CLOSED".into(), false));
    }
    assert_eq!(
        closed_on(&owner, "business_registrations", w.reg).await,
        Some(date("2026-01-31"))
    );
    let (status, types): (String, i64) = sqlx::query_as(
        "SELECT r.status, (SELECT count(*) FROM business_registration_business_types t WHERE t.revision_id = r.id) \
         FROM business_registration_revisions r WHERE r.registration_id = $1 ORDER BY r.version DESC LIMIT 1",
    )
    .bind(w.reg)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        (status.as_str(), types),
        ("CLOSED", 1),
        "the CLOSED revision keeps its 업태·종목"
    );

    // The same command replays; a second close, a revise and a placement are refused.
    w.store
        .close_entity(&once, w.entity, close("2026-01-31", "DISSOLVED"), port())
        .await
        .unwrap();
    let (code_, _, _) = code(
        w.store
            .close_entity(
                &cmd(&w.actor),
                w.entity,
                close("2026-02-01", "BUSINESS_CLOSED"),
                port(),
            )
            .await
            .unwrap_err(),
    );
    assert_eq!(code_, "legal_entity_not_open");
    let rev = Revision {
        expected_version: Some(1),
        effective_from: Some("2026-02-01".into()),
        reason_code: Some("RENAME".into()),
        input: corporation("주식회사 가나다", "000211-0006241"),
    };
    assert_eq!(
        code(
            w.store
                .revise_entity(&cmd(&w.actor), w.entity, rev)
                .await
                .unwrap_err()
        )
        .0,
        "legal_entity_not_open"
    );
    let lee = employee(&owner, "k2").await;
    let (_, fields, _) = code(
        w.store
            .bind_assignment(&cmd(&w.actor), bind(&w, lee, w.hq, "2026-02-01"))
            .await
            .unwrap_err(),
    );
    assert_eq!(
        fields,
        vec![("workplace_id".to_owned(), "workplace_closed")]
    );
    // The close is set once, even for the table owner.
    let err = sqlx::query(
        "UPDATE legal_entities SET closed_on = NULL, close_reason_code = NULL WHERE id = $1",
    )
    .bind(w.entity)
    .execute(&owner)
    .await
    .unwrap_err();
    assert!(err.to_string().contains("legal_entity_closed"), "{err}");
}
