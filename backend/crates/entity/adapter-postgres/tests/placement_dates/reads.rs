// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_bound_initial_placement_and_a_scheduled_move_keep_their_as_of_dates(owner: PgPool) {
    let w = world(&owner, "2000-03-02", "2001-05-01").await;
    let person = employee(&owner, &w.actor).await;
    let hired = Date::from_calendar_date(2016, Month::March, 2).unwrap();
    let effective = Date::from_calendar_date(2099, Month::November, 1).unwrap();
    w.store
        .bind_assignment(&cmd(&w.actor), bind(person, &w, hired))
        .await
        .unwrap();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(w.actor.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    move_in_tx(
        tx.as_mut(),
        write(&w.actor, person),
        MoveTarget {
            legal_entity_id: w.entity,
            workplace_id: w.source,
            group_transfer_id: None,
        },
        effective,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    for (on, target, source) in [
        (hired.previous_day().unwrap(), 0, 0),
        (hired, 1, 0),
        (effective.previous_day().unwrap(), 1, 0),
        (effective, 0, 1),
    ] {
        let records = w
            .store
            .list_entities_at(
                &w.actor,
                false,
                ReadOptions {
                    as_of: Some(on),
                    known_at: None,
                },
            )
            .await
            .unwrap();
        for (workplace, expected) in [(w.target, target), (w.source, source)] {
            let actual = records
                .iter()
                .flat_map(|e| &e.workplaces)
                .find(|p| p.id == workplace)
                .unwrap();
            assert_eq!(actual.headcount, expected, "workplace {workplace} at {on}");
        }
    }
}

async fn old_assignment(owner: &PgPool, w: &World) {
    let p = employee(owner, &w.actor).await;
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id, \
         valid_from,cause,actor_id,command_id) VALUES ($1,$2,$3,$4,'2016-03-02','HIRE',$5,$6)",
    )
    .bind(*w.actor.org.as_uuid())
    .bind(p)
    .bind(w.entity)
    .bind(w.target)
    .bind(*w.actor.user.as_uuid())
    .bind(Uuid::new_v4())
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn old_placements_count_only_from_the_workplace_opening_date(owner: PgPool) {
    let w = world(&owner, "2020-03-02", "2020-05-01").await;
    old_assignment(&owner, &w).await;
    let opening = Date::from_calendar_date(2020, Month::May, 1).unwrap();
    for (on, expected) in [(opening.previous_day().unwrap(), 0), (opening, 1)] {
        let q = ReadOptions {
            as_of: Some(on),
            known_at: None,
        };
        let chart = w.store.org_structure_at(&w.actor, q).await.unwrap();
        assert_eq!(
            chart.entities.iter().map(|e| e.headcount).sum::<i64>(),
            expected
        );
        let records = w.store.list_entities_at(&w.actor, false, q).await.unwrap();
        let workplace = records
            .iter()
            .flat_map(|e| &e.workplaces)
            .find(|wp| wp.id == w.target)
            .unwrap();
        assert_eq!(workplace.headcount, expected, "workplace at {on}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_chart_before_the_first_entity_has_no_records_or_people(owner: PgPool) {
    let w = world(&owner, "2020-03-02", "2020-05-01").await;
    old_assignment(&owner, &w).await;
    let chart = w
        .store
        .org_structure_at(
            &w.actor,
            ReadOptions {
                as_of: Some(Date::from_calendar_date(2020, Month::March, 1).unwrap()),
                known_at: None,
            },
        )
        .await
        .unwrap();
    assert!(chart.entities.is_empty(), "{:?}", chart.entities);
    assert!(chart.unplaced.is_empty());
    assert_eq!(chart.entity_unknown_headcount, Some(0));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_import_clamped_to_opening_does_not_become_unplaced_before_opening(owner: PgPool) {
    let w = world(&owner, "2020-03-02", "2020-05-01").await;
    let person = employee(&owner, &w.actor).await;
    let opening = Date::from_calendar_date(2020, Month::May, 1).unwrap();
    hire(&owner, &w.actor, person, w.target, opening)
        .await
        .unwrap();
    for on in [
        Date::from_calendar_date(2020, Month::March, 1).unwrap(),
        opening.previous_day().unwrap(),
        opening,
    ] {
        let chart = w
            .store
            .org_structure_at(
                &w.actor,
                ReadOptions {
                    as_of: Some(on),
                    known_at: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            chart.entities.iter().map(|e| e.headcount).sum::<i64>()
                + chart.entity_unknown_headcount.unwrap_or_default(),
            i64::from(on >= opening),
            "the original seniority date must not create a placement before {opening}: {on}",
        );
    }
}
