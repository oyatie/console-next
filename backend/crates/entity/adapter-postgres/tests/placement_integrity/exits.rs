//! Confirmed exits share live and dated membership through the last working day.
use super::*;
use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::{Actor, ReadOptions};
use time::{Date, Duration, OffsetDateTime};

async fn counts(
    store: &PgEntityStore,
    actor: &Actor,
    entity: Uuid,
    workplace: Uuid,
    q: ReadOptions,
    expected: i64,
) {
    let tree = store.org_structure_at(actor, q).await.unwrap();
    let e = tree.entities.iter().find(|e| e.id == entity).unwrap();
    let w = e.children.iter().find(|w| w.id == workplace).unwrap();
    assert_eq!(
        (e.headcount, w.headcount, w.direct_headcount),
        (expected, expected, expected)
    );
    let list = store.list_entities_at(actor, false, q).await.unwrap();
    let record = store.get_entity_at(actor, entity, false, q).await.unwrap();
    for e in [list.iter().find(|e| e.id == entity).unwrap(), &record] {
        assert_eq!(
            e.workplaces.iter().map(|w| w.headcount).sum::<i64>(),
            expected
        );
    }
    assert_eq!(
        store
            .get_workplace_at(actor, workplace, false, q)
            .await
            .unwrap()
            .headcount,
        expected
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn confirmed_exit_counts_agree_without_changing_dated_placement(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "placement-exit").await;
    let (entity, [(workplace, site), _]) = two_workplaces(&store, &actor).await;
    let p = person(&owner, &store, &actor, (entity, workplace, site), "leaver").await;
    let today: Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(&owner)
        .await
        .unwrap();
    let before: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&owner)
        .await
        .unwrap();
    let event: Uuid = sqlx::query_scalar(
        "INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,from_status,to_status, \
         from_org_unit_id,to_org_unit_id,effective_date,comment,created_by,state) \
         VALUES ($1,$2,'TERMINATE','ACTIVE','EXITED',$5,$5,$3,'Confirmed exit',$4,'SCHEDULED') RETURNING id",
    ).bind(*actor.org.as_uuid()).bind(p).bind(today.to_string()).bind(*actor.user.as_uuid()).bind(site).fetch_one(&owner).await.unwrap();
    for (q, expected) in [
        (ReadOptions::default(), 1),
        (
            ReadOptions {
                as_of: Some(today),
                known_at: None,
            },
            1,
        ),
        (
            ReadOptions {
                as_of: Some(today + Duration::days(1)),
                known_at: None,
            },
            0,
        ),
        (
            ReadOptions {
                as_of: None,
                known_at: Some(before),
            },
            1,
        ),
    ] {
        counts(&store, &actor, entity, workplace, q, expected).await;
    }
    sqlx::query("UPDATE employee_lifecycle_events SET state='CANCELLED',cancelled_at=now(),cancelled_by=$2,cancel_reason='Withdrawn' WHERE id=$1")
        .bind(event)
        .bind(*actor.user.as_uuid())
        .execute(&owner)
        .await
        .unwrap();
    counts(&store, &actor, entity, workplace, ReadOptions::default(), 1).await;
    assert_eq!(placed_at(&owner, p).await, workplace);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn imported_exit_uses_live_status_and_retains_last_day_membership(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "placement-imported-exit").await;
    let (entity, [(workplace, site), _]) = two_workplaces(&store, &actor).await;
    let p = person(
        &owner,
        &store,
        &actor,
        (entity, workplace, site),
        "imported",
    )
    .await;
    let today: Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(&owner)
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET employment_status='EXITED',exit_date=$2 WHERE id=$1")
        .bind(p)
        .bind(today.to_string())
        .execute(&owner)
        .await
        .unwrap();
    counts(&store, &actor, entity, workplace, ReadOptions::default(), 0).await;
    counts(
        &store,
        &actor,
        entity,
        workplace,
        ReadOptions {
            as_of: Some(today),
            known_at: None,
        },
        1,
    )
    .await;
}
