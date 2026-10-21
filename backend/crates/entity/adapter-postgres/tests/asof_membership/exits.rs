use super::*;
use console_ontology_canonical_adapter_postgres::employment::appoint_legacy_head_in_tx;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn backdated_exit_overrides_the_earlier_recorded_canonical_snapshot(owner: PgPool) {
    let w = world(&owner, "asof-backdated-exit").await;
    let p = source_person(&owner, &w, "departing").await;
    // Without a hire date the canonical snapshot starts today, before HR records yesterday's exit.
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(w.actor.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    appoint_legacy_head_in_tx(&mut tx, w.actor.org, w.actor.user, p)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let cutoff = known(&owner).await;
    let last_day = w.d - Duration::days(1);
    lifecycle(&owner, &w, p, "TERMINATE", last_day).await;
    sqlx::query("UPDATE employees SET employment_status='EXITED',exit_date=$2 WHERE id=$1")
        .bind(p)
        .bind(last_day.to_string())
        .execute(&owner)
        .await
        .unwrap();
    for date in [w.d, w.d + Duration::days(30)] {
        assert_eq!(counts(&read(&w, &w.actor, date, None).await, &w), [0, 0]);
    }
    assert_eq!(
        counts(&read(&w, &w.actor, last_day, None).await, &w),
        [1, 0]
    );
    assert_eq!(
        counts(&read(&w, &w.actor, w.d, Some(cutoff)).await, &w),
        [1, 0]
    );
    for record in [
        w.store
            .get_entity_at(&w.actor, w.entity, false, ReadOptions::default())
            .await
            .unwrap(),
        w.store
            .list_entities_at(&w.actor, false, ReadOptions::default())
            .await
            .unwrap()
            .remove(0),
    ] {
        assert_eq!(
            record.workplaces.iter().map(|w| w.headcount).sum::<i64>(),
            0
        );
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn exit_scheduled_for_today_still_counts_on_its_last_working_day(owner: PgPool) {
    let w = world(&owner, "asof-last-working-day").await;
    let p = source_person(&owner, &w, "scheduled-exit").await;
    lifecycle(&owner, &w, p, "TERMINATE", w.d).await;
    assert_eq!(counts(&read(&w, &w.actor, w.d, None).await, &w), [1, 0]);
    assert_eq!(
        counts(&read(&w, &w.actor, w.d + Duration::days(1), None).await, &w),
        [0, 0]
    );
}
