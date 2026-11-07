// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_entity_application::LegalEntityRevision;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_later_entered_certificate_establishes_an_unknown_employer_opening(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "certificate-opening").await;
    let input = console_entity_domain::legal_entity::LegalEntityInput {
        incorporated_on: None,
        ..corporation("주식회사 기준일", "000211-0006241")
    };
    let entity = store
        .create_entity(&cmd(&actor), input)
        .await
        .unwrap()
        .record;
    let recorded_from = entity.current.unwrap().effective_from;
    let before_certificate: time::OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&owner)
        .await
        .unwrap();
    let registration = store
        .create_registration(&cmd(&actor), entity.id, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    let workplace = store
        .create_workplace(
            &cmd(&actor),
            entity.id,
            workplace_from(registration, "본사"),
            port(),
        )
        .await
        .unwrap()
        .record;
    let opening = Date::from_calendar_date(2020, Month::March, 2).unwrap();
    assert!(recorded_from > opening);
    assert_eq!(workplace.placement_opens_on, Some(opening));

    let person = employee(&owner, &actor).await;
    let error = hire(
        &owner,
        &actor,
        person,
        workplace.id,
        opening.previous_day().unwrap(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Some("workplace_not_open_on_date"));
    assert_eq!(
        hire(&owner, &actor, person, workplace.id, opening)
            .await
            .unwrap()
            .legal_entity_id,
        entity.id
    );

    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(actor.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let previously_known: Option<Date> =
        sqlx::query_scalar("SELECT entity_workplace_opens_on($1,$2)")
            .bind(workplace.id)
            .bind(before_certificate)
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
    assert_eq!(
        previously_known,
        Some(recorded_from),
        "later certificate evidence must not leak into an earlier knowledge view"
    );
    sqlx::query("UPDATE business_registrations SET voided_at = now(), void_reason_code = 'MISTAKE' WHERE id = $1")
        .bind(registration)
        .execute(tx.as_mut())
        .await
        .unwrap();
    let without_certificate: Option<Date> =
        sqlx::query_scalar("SELECT entity_workplace_opens_on($1)")
            .bind(workplace.id)
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
    assert_eq!(
        without_certificate,
        Some(recorded_from),
        "a voided certificate is not opening evidence"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn recording_incorporation_as_a_correction_preserves_historical_hires(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "incorporation-opening").await;
    let input = console_entity_domain::legal_entity::LegalEntityInput {
        incorporated_on: None,
        ..corporation("주식회사 기준일", "000211-0006241")
    };
    let entity = store
        .create_entity(&cmd(&actor), input.clone())
        .await
        .unwrap()
        .record;
    let registration = store
        .create_registration(&cmd(&actor), entity.id, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    let mut workplace_input = workplace_from(registration, "본사");
    workplace_input.input.opened_on = Some("2010-03-02".into());
    let workplace = store
        .create_workplace(&cmd(&actor), entity.id, workplace_input, port())
        .await
        .unwrap()
        .record;
    let opening = Date::from_calendar_date(2020, Month::March, 2).unwrap();
    assert_eq!(workplace.placement_opens_on, Some(opening));
    let current = store
        .get_entity(&actor, entity.id, true)
        .await
        .unwrap()
        .current
        .unwrap();
    let before_correction: time::OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&owner)
        .await
        .unwrap();
    store
        .revise_entity(
            &cmd(&actor),
            entity.id,
            LegalEntityRevision {
                expected_version: Some(current.version),
                effective_from: Some(current.effective_from.to_string()),
                reason_code: Some("CORRECTION".into()),
                input: console_entity_domain::legal_entity::LegalEntityInput {
                    incorporated_on: Some("2015-01-05".into()),
                    ..input
                },
            },
        )
        .await
        .unwrap();

    let person = employee(&owner, &actor).await;
    let hired_on = Date::from_calendar_date(2026, Month::January, 2).unwrap();
    assert!(hired_on < current.effective_from);
    assert_eq!(
        hire(&owner, &actor, person, workplace.id, hired_on)
            .await
            .unwrap()
            .legal_entity_id,
        entity.id
    );
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(actor.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let boundaries: (Option<Date>, Option<Date>) =
        sqlx::query_as("SELECT entity_workplace_opens_on($1), entity_workplace_opens_on($1,$2)")
            .bind(workplace.id)
            .bind(before_correction)
            .fetch_one(tx.as_mut())
            .await
            .unwrap();
    assert_eq!(
        boundaries,
        (
            Some(Date::from_calendar_date(2015, Month::January, 5).unwrap()),
            Some(opening)
        )
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn another_employers_certificate_cannot_open_the_workplace(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "certificate-employer").await;
    let entity = store
        .create_entity(
            &cmd(&actor),
            console_entity_domain::legal_entity::LegalEntityInput {
                incorporated_on: None,
                ..corporation("주식회사 기준일", "000211-0006241")
            },
        )
        .await
        .unwrap()
        .record
        .id;
    let registration = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    let other = store
        .create_entity(
            &cmd(&actor),
            corporation("주식회사 다른법인", "000111-0012348"),
        )
        .await
        .unwrap()
        .record
        .id;
    let mut earlier = certificate(&console_kernel_core::kr::synthetic::brn(81, 4321));
    earlier.opened_on = Some("2010-03-02".into());
    store
        .create_registration(&cmd(&actor), other, earlier)
        .await
        .unwrap();
    let mut input = workplace_from(registration, "본사");
    input.input.opened_on = Some("2010-03-02".into());
    let workplace = store
        .create_workplace(&cmd(&actor), entity, input, port())
        .await
        .unwrap()
        .record;
    let opening = Date::from_calendar_date(2020, Month::March, 2).unwrap();
    assert_eq!(workplace.placement_opens_on, Some(opening));
    let person = employee(&owner, &actor).await;
    let error = hire(
        &owner,
        &actor,
        person,
        workplace.id,
        Date::from_calendar_date(2015, Month::January, 5).unwrap(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Some("workplace_not_open_on_date"));
    assert_eq!(
        hire(&owner, &actor, person, workplace.id, opening)
            .await
            .unwrap()
            .legal_entity_id,
        entity
    );
}
