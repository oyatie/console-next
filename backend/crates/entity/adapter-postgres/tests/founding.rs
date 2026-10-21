#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! UX-R1 ENTITY company-08 (catalog company-04) and company-21 as
//! `console_rt`: a 법인 recorded 설립 중 has no 법인등록번호 until its 설립등기;
//! entering the number ends the founding, once. A record created with its
//! certificate's 개업연월일 starts there, not today.

mod common;

use common::*;
use console_entity_application::Revision;
use console_entity_domain::legal_entity::LegalEntityInput;
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0F08);

fn founding(name: &str) -> LegalEntityInput {
    LegalEntityInput {
        crn: None,
        founding: Some(true),
        ..corporation(name, "000211-0006241")
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_founding_entity_takes_its_number_once(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "F").await;
    // A 법인 without a number is refused unless it is being founded.
    let err = store
        .create_entity(
            &cmd(&actor),
            LegalEntityInput {
                crn: None,
                ..corporation("주식회사 다라", "")
            },
        )
        .await
        .unwrap_err();
    assert_eq!(code(err).1, vec![("crn".into(), "required")]);
    // 설립 중 is a 법인's state only.
    let individual = LegalEntityInput {
        biz_kind: Some("INDIVIDUAL".into()),
        ..founding("가나상회")
    };
    let err = store
        .create_entity(&cmd(&actor), individual)
        .await
        .unwrap_err();
    assert_eq!(code(err).1, vec![("founding".into(), "not_applicable")]);
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM legal_entities")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(before, 0, "nothing written by a refusal");

    let e = store
        .create_entity(&cmd(&actor), founding("주식회사 가나"))
        .await
        .unwrap()
        .record;
    assert!(e.founding && e.crn.is_none());

    // A revise keeps it 설립 중 whatever the client says, until the number comes.
    let rev = |version, input| Revision {
        expected_version: Some(version),
        effective_from: Some("2026-03-02".into()),
        reason_code: Some("FOUNDED".into()),
        input,
    };
    let kept = store
        .revise_entity(
            &cmd(&actor),
            e.id,
            rev(
                1,
                LegalEntityInput {
                    founding: Some(false),
                    ..founding("주식회사 가나")
                },
            ),
        )
        .await
        .unwrap()
        .record;
    assert!(kept.founding);
    let founded = store
        .revise_entity(
            &cmd(&actor),
            e.id,
            rev(
                2,
                LegalEntityInput {
                    incorporated_on: Some("2026-03-02".into()),
                    ..corporation("주식회사 가나", "000211-0006241")
                },
            ),
        )
        .await
        .unwrap()
        .record;
    assert!(!founded.founding);
    assert_eq!(founded.crn.unwrap().value, "0002110006241");
    // Never founding again.
    let again = store
        .revise_entity(&cmd(&actor), e.id, rev(3, founding("주식회사 가나")))
        .await
        .unwrap_err();
    assert_eq!(code(again).1, vec![("crn".into(), "required")]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_record_starts_at_its_certificates_opening_date(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "O").await;
    let with_opening = LegalEntityInput {
        opened_on: Some("2020-03-02".into()),
        ..corporation("주식회사 가나", "000211-0006241")
    };
    let e = store
        .create_entity(&cmd(&actor), with_opening)
        .await
        .unwrap()
        .record;
    assert_eq!(e.current.unwrap().effective_from.to_string(), "2020-03-02");
    // A 설립일 still wins.
    let both = LegalEntityInput {
        opened_on: Some("2020-03-02".into()),
        incorporated_on: Some("2019-11-01".into()),
        ..corporation("주식회사 다라", "000111-0000003")
    };
    let e = store
        .create_entity(&cmd(&actor), both)
        .await
        .unwrap()
        .record;
    assert_eq!(e.current.unwrap().effective_from.to_string(), "2019-11-01");
    let future = LegalEntityInput {
        opened_on: Some("2999-01-01".into()),
        ..corporation("주식회사 마바", "000111-0000004")
    };
    let err = store.create_entity(&cmd(&actor), future).await.unwrap_err();
    assert_eq!(code(err).1, vec![("opened_on".into(), "date_in_future")]);
}
