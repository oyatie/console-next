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
    let exit_date = w.d - Duration::days(1);
    let last_working_day = exit_date - Duration::days(1);
    lifecycle(&owner, &w, p, "TERMINATE", exit_date).await;
    sqlx::query("UPDATE employees SET employment_status='EXITED',exit_date=$2 WHERE id=$1")
        .bind(p)
        .bind(exit_date.to_string())
        .execute(&owner)
        .await
        .unwrap();
    for date in [exit_date, w.d, w.d + Duration::days(30)] {
        assert_eq!(counts(&read(&w, &w.actor, date, None).await, &w), [0, 0]);
    }
    assert_eq!(
        counts(&read(&w, &w.actor, last_working_day, None).await, &w),
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
    // 퇴직일 = 마지막 근무일 + 1 = 4대보험 상실일: the exit's effective date is not counted.
    let exit_date = w.d;
    let last_working_day = exit_date - Duration::days(1);
    lifecycle(&owner, &w, p, "TERMINATE", exit_date).await;
    assert_eq!(
        counts(&read(&w, &w.actor, last_working_day, None).await, &w),
        [1, 0]
    );
    for date in [exit_date, exit_date + Duration::days(1)] {
        assert_eq!(counts(&read(&w, &w.actor, date, None).await, &w), [0, 0]);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn compare_at_today_and_list_share_the_live_chart_exit_boundary(owner: PgPool) {
    let w = world(&owner, "asof-exit-count-rule").await;
    let p = source_person(&owner, &w, "exiting-person").await;
    let exit_date = w.d;
    let last_working_day = exit_date - Duration::days(1);
    lifecycle(&owner, &w, p, "TERMINATE", exit_date).await;
    let live = counts(&w.store.org_structure(&w.actor).await.unwrap(), &w);
    assert_eq!(live, [0, 0]);
    assert_eq!(counts(&read(&w, &w.actor, w.d, None).await, &w), live);
    let listed = |date: Date| {
        let store = &w.store;
        let actor = &w.actor;
        async move {
            store
                .list_entities_at(
                    actor,
                    false,
                    ReadOptions {
                        as_of: Some(date),
                        known_at: None,
                    },
                )
                .await
                .unwrap()
                .remove(0)
                .workplaces
                .iter()
                .map(|wp| wp.headcount)
                .sum::<i64>()
        }
    };
    assert_eq!(listed(last_working_day).await, 1);
    assert_eq!(listed(exit_date).await, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn recorded_exit_date_without_events_is_the_first_uncounted_day(owner: PgPool) {
    let w = world(&owner, "asof-exit-date-only").await;
    let p = source_person(&owner, &w, "exit-date-only").await;
    let exit_date = w.d - Duration::days(5);
    sqlx::query("UPDATE employees SET employment_status='EXITED',exit_date=$2 WHERE id=$1")
        .bind(p)
        .bind(exit_date.to_string())
        .execute(&owner)
        .await
        .unwrap();
    let last_working_day = exit_date - Duration::days(1);
    assert_eq!(
        counts(&read(&w, &w.actor, last_working_day, None).await, &w),
        [1, 0]
    );
    assert_eq!(
        counts(&read(&w, &w.actor, exit_date, None).await, &w),
        [0, 0]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn lifecycle_events_do_not_bypass_the_hire_date(owner: PgPool) {
    let w = world(&owner, "asof-hire-boundary").await;
    let hire = w.d - Duration::days(10);
    for (key, event, effective, canonical) in [
        ("canonical-exit", "TERMINATE", w.d + Duration::days(5), true),
        ("legacy-exit", "TERMINATE", w.d + Duration::days(5), false),
        (
            "early-transfer",
            "TRANSFER",
            hire - Duration::days(2),
            false,
        ),
        ("onboarding", "ONBOARD", hire, false),
    ] {
        let p: Uuid = sqlx::query_scalar(
            "INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key,org_unit_id,hire_date) \
             VALUES ($1,'Test Corp','Person','test','test',1,$2,$3,$4) RETURNING id",
        )
        .bind(*w.actor.org.as_uuid())
        .bind(key)
        .bind(w.units[0])
        .bind(hire.to_string())
        .fetch_one(&owner)
        .await
        .unwrap();
        w.store
            .bind_assignment(
                &cmd(&w.actor),
                BindAssignment {
                    employee_id: p,
                    legal_entity_id: Some(w.entity),
                    workplace_id: Some(w.workplaces[0]),
                    valid_from: Some(hire.to_string()),
                },
            )
            .await
            .unwrap();
        if canonical {
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
        }
        lifecycle(&owner, &w, p, event, effective).await;
    }
    let cutoff = known(&owner).await;
    for known_at in [None, Some(cutoff)] {
        let before = read(&w, &w.actor, hire - Duration::days(1), known_at).await;
        assert_eq!(counts(&before, &w), [0, 0]);
        assert_eq!(before.entity_unknown_headcount, Some(0));
        assert_eq!(
            counts(&read(&w, &w.actor, hire, known_at).await, &w),
            [4, 0]
        );
        let listed = w
            .store
            .list_entities_at(
                &w.actor,
                false,
                ReadOptions {
                    as_of: Some(hire - Duration::days(1)),
                    known_at,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            listed[0]
                .workplaces
                .iter()
                .map(|w| w.headcount)
                .sum::<i64>(),
            0
        );
    }
}
