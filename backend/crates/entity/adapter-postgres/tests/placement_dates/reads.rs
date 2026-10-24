// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

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
