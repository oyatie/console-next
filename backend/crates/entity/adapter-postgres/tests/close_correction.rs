#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! UX-R1 ENTITY company-03 (catalog company-19) as `console_rt`: a closed
//! 법인's 종료일 / 종료 사유 is corrected, with the 사업장 and 사업자등록 that
//! closed with it, and nothing reopens. Refusals write nothing.

mod close_support;
mod common;

use close_support::*;
use common::*;
use console_entity_application::{CloseCorrection, CloseLegalEntity};
use console_entity_domain::codes::CloseReason;
use sqlx::PgPool;

fn fix(on: &str, reason: &str, why: Option<&str>) -> CloseCorrection {
    CloseCorrection {
        closed_on: Some(on.into()),
        reason_code: Some(reason.into()),
        why: why.map(Into::into),
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
async fn a_recorded_close_is_corrected_and_never_reopens(owner: PgPool) {
    let w = world(&owner).await;
    // Only a closed 법인's close is corrected.
    let open = w
        .store
        .correct_close(
            &cmd(&w.actor),
            w.entity,
            fix("2026-01-31", "DISSOLVED", Some("오기")),
        )
        .await
        .unwrap_err();
    assert_eq!(code(open).0, "legal_entity_not_closed");

    let close = CloseLegalEntity {
        closed_on: Some("2026-01-31".into()),
        reason_code: Some("DISSOLVED".into()),
    };
    w.store
        .close_entity(&cmd(&w.actor), w.entity, close, port())
        .await
        .unwrap();

    // A typed refusal per field, and the same close again: nothing is written.
    let (_, fields, _) = code(
        w.store
            .correct_close(&cmd(&w.actor), w.entity, fix("2999-01-01", "MERGED", None))
            .await
            .unwrap_err(),
    );
    assert_eq!(
        fields,
        vec![
            ("closed_on".to_owned(), "date_in_future"),
            ("reason_code".to_owned(), "invalid_option"),
            ("why".to_owned(), "required"),
        ]
    );
    let (_, same, _) = code(
        w.store
            .correct_close(
                &cmd(&w.actor),
                w.entity,
                fix("2026-01-31", "DISSOLVED", Some("확인")),
            )
            .await
            .unwrap_err(),
    );
    assert_eq!(same, vec![("closed_on".to_owned(), "close_unchanged")]);
    assert_eq!(audits(&owner, "legal_entity.close_correct").await, 0);
    assert_eq!(
        closed_on(&owner, "legal_entities", w.entity).await,
        Some(date("2026-01-31"))
    );

    // The right date and reason: the 법인, its 사업장 and its 등록증 move together.
    let once = cmd(&w.actor);
    let saved = w
        .store
        .correct_close(
            &once,
            w.entity,
            fix(
                "2026-01-15",
                "BUSINESS_CLOSED",
                Some("폐업 신고일을 잘못 적음"),
            ),
        )
        .await
        .unwrap()
        .record;
    assert_eq!(
        (saved.closed_on, saved.close_reason_code),
        (Some(date("2026-01-15")), Some(CloseReason::BusinessClosed))
    );
    for wp in [w.hq, w.branch] {
        assert_eq!(
            closed_on(&owner, "workplaces", wp).await,
            Some(date("2026-01-15"))
        );
        assert_eq!(head(&owner, wp).await.0, "CLOSED");
    }
    assert_eq!(
        closed_on(&owner, "business_registrations", w.reg).await,
        Some(date("2026-01-15"))
    );
    assert_eq!(audits(&owner, "legal_entity.close_correct").await, 1);
    // The same key replays; it is not a second correction.
    w.store
        .correct_close(
            &once,
            w.entity,
            fix(
                "2026-01-15",
                "BUSINESS_CLOSED",
                Some("폐업 신고일을 잘못 적음"),
            ),
        )
        .await
        .unwrap();
    assert_eq!(audits(&owner, "legal_entity.close_correct").await, 1);

    // The close stays set-once for every other writer (0266, kept by 0309).
    let direct = sqlx::query("UPDATE legal_entities SET closed_on = '2026-01-20' WHERE id = $1")
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
