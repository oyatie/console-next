#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! UX-R3 STRUCT company-15 (catalog company-19) as `console_rt`: a closed
//! 법인's close is withdrawn (종료 취소) when the business goes on. The 법인,
//! the 사업장 and the 사업자등록 that closed with it read open again, each
//! 사업장 with its SITE unit; refusals write nothing, a replay is not a second
//! withdrawal, and the close stays set-once for every other writer.

mod close_support;
mod common;

use close_support::*;
use common::*;
use console_entity_application::{CloseLegalEntity, CloseWithdrawal};
use sqlx::PgPool;

fn why(text: Option<&str>) -> CloseWithdrawal {
    CloseWithdrawal {
        why: text.map(Into::into),
    }
}

async fn audits(owner: &PgPool, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action = $1")
        .bind(action)
        .fetch_one(owner)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_close_is_withdrawn_and_what_closed_with_it_reopens(owner: PgPool) {
    // regression: r3 company-15 — only 종료 정정 existed; a business that went on had no way back.
    let w = world(&owner).await;
    let open = w
        .store
        .withdraw_close(&cmd(&w.actor), w.entity, why(Some("계속 영업")), port())
        .await
        .unwrap_err();
    assert_eq!(code(open).0, "legal_entity_not_closed");

    let close = CloseLegalEntity {
        closed_on: Some("2026-01-31".into()),
        reason_code: Some("BUSINESS_CLOSED".into()),
    };
    w.store
        .close_entity(&cmd(&w.actor), w.entity, close, port())
        .await
        .unwrap();
    assert_eq!(head(&owner, w.hq).await, ("CLOSED".to_owned(), false));

    // No reason: refused on its field, nothing written.
    let (_, fields, _) = code(
        w.store
            .withdraw_close(&cmd(&w.actor), w.entity, why(None), port())
            .await
            .unwrap_err(),
    );
    assert_eq!(fields, vec![("why".to_owned(), "required")]);
    assert_eq!(audits(&owner, "legal_entity.close_withdraw").await, 0);
    assert!(
        closed_on(&owner, "legal_entities", w.entity)
            .await
            .is_some()
    );

    let once = cmd(&w.actor);
    let saved = w
        .store
        .withdraw_close(
            &once,
            w.entity,
            why(Some("폐업을 철회하고 계속 영업")),
            port(),
        )
        .await
        .unwrap()
        .record;
    assert_eq!((saved.closed_on, saved.close_reason_code), (None, None));
    for wp in [w.hq, w.branch] {
        assert_eq!(closed_on(&owner, "workplaces", wp).await, None);
        let (status, site) = head(&owner, wp).await;
        assert_ne!(status, "CLOSED", "the revision before the close is back");
        assert!(site, "the 사업장 has its own unit again");
    }
    assert_eq!(
        closed_on(&owner, "business_registrations", w.reg).await,
        None
    );
    assert_eq!(audits(&owner, "legal_entity.close_withdraw").await, 1);

    // The same key replays; a fresh one finds nothing closed.
    w.store
        .withdraw_close(
            &once,
            w.entity,
            why(Some("폐업을 철회하고 계속 영업")),
            port(),
        )
        .await
        .unwrap();
    assert_eq!(audits(&owner, "legal_entity.close_withdraw").await, 1);
    let again = w
        .store
        .withdraw_close(&cmd(&w.actor), w.entity, why(Some("한 번 더")), port())
        .await
        .unwrap_err();
    assert_eq!(code(again).0, "legal_entity_not_closed");

    // The 법인 closes again normally, and no other writer clears a close (0266, kept by 0336).
    let close = CloseLegalEntity {
        closed_on: Some("2026-02-28".into()),
        reason_code: Some("DISSOLVED".into()),
    };
    w.store
        .close_entity(&cmd(&w.actor), w.entity, close, port())
        .await
        .unwrap();
    let direct = sqlx::query(
        "UPDATE legal_entities SET closed_on = NULL, close_reason_code = NULL WHERE id = $1",
    )
    .bind(w.entity)
    .execute(&owner)
    .await;
    assert!(
        direct
            .unwrap_err()
            .to_string()
            .contains("legal_entity_closed")
    );
}
