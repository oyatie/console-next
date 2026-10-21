#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Knowledge snapshots keep profile types and late transaction closures out of earlier reads.
mod common;
use common::*;
use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::{Actor, OrgStructure, ReadOptions};
use serde_json::Value;
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

async fn today(owner: &PgPool) -> Date {
    sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(owner)
        .await
        .unwrap()
}
async fn known(owner: &PgPool) -> OffsetDateTime {
    sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(owner)
        .await
        .unwrap()
}
async fn read(
    store: &PgEntityStore,
    actor: &Actor,
    date: Date,
    known_at: Option<OffsetDateTime>,
) -> OrgStructure {
    store
        .org_structure_at(
            actor,
            ReadOptions {
                as_of: Some(date),
                known_at,
            },
        )
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn later_profile_classification_does_not_change_prior_known_dispatched_counts(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "asof-profile-knowledge").await;
    let d = today(&owner).await;
    let (entity, [(wp, site), _]) = two_workplaces(&store, &actor).await;
    let p = person(&owner, &store, &actor, (entity, wp, site), "classification").await;
    sqlx::query(
        "INSERT INTO employee_employment_profiles (employee_id,org_id,employment_type,phone_e164, \
        base_pay,idempotency_key,request_hash,created_by) \
        VALUES ($1,$2,'REGULAR','+821012345678',0,$1::text,repeat('a',64),$3)",
    )
    .bind(p)
    .bind(*actor.org.as_uuid())
    .bind(*actor.user.as_uuid())
    .execute(&owner)
    .await
    .unwrap();
    // Native ONBOARD deliberately has no type delta: its initial type is the profile.
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,from_status,to_status, \
        to_org_unit_id,to_org_unit,effective_date,comment,created_by,state) \
        VALUES ($1,$2,'ONBOARD','PRE_HIRE','ACTIVE',$3,$3::text,$4,'Native onboarding',$5,'APPLIED')")
        .bind(*actor.org.as_uuid()).bind(p).bind(site).bind((d-Duration::days(60)).to_string())
        .bind(*actor.user.as_uuid()).execute(&owner).await.unwrap();
    let cutoff = known(&owner).await;
    let mut tx = owner.begin().await.unwrap();
    // The same profile mutation and type-delta shape as the native classification writer.
    sqlx::query("UPDATE employee_employment_profiles SET employment_type='DISPATCHED_IN' WHERE employee_id=$1")
        .bind(p).execute(tx.as_mut()).await.unwrap();
    sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,from_status,to_status, \
        from_employment_type,to_employment_type,effective_date,comment,created_by,state) \
        VALUES ($1,$2,'EMPLOYMENT_TYPE_CHANGE','ACTIVE','ACTIVE','REGULAR','DISPATCHED_IN',$3, \
        'Native classification change',$4,'APPLIED')")
        .bind(*actor.org.as_uuid()).bind(p).bind(d.to_string()).bind(*actor.user.as_uuid())
        .execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let current = read(&store, &actor, d, None).await;
    assert_eq!(
        (
            current.entities[0].headcount,
            current.entities[0].dispatched_headcount
        ),
        (1, 1)
    );
    for date in [d, d + Duration::days(30)] {
        let prior = read(&store, &actor, date, Some(cutoff)).await;
        assert_eq!(
            (
                prior.entities[0].headcount,
                prior.entities[0].dispatched_headcount
            ),
            (1, 0)
        );
    }
    let history: Value = sqlx::query_scalar(
        "SELECT asof_history FROM employee_employment_profiles WHERE employee_id=$1",
    )
    .bind(p)
    .fetch_one(&owner)
    .await
    .unwrap();
    let entries = history.as_array().unwrap();
    assert_eq!(entries.len(), 2);
    for entry in entries {
        let snapshot = entry["value"].as_object().unwrap();
        assert!(snapshot.contains_key("employment_type"));
        // Chart knowledge history must not duplicate contact or compensation facts.
        assert!(snapshot.keys().all(|k| matches!(
            k.as_str(),
            "employee_id" | "org_id" | "created_at" | "employment_type"
        )));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn closures_record_statement_time_after_cutoff_even_when_transaction_started_before_it(
    owner: PgPool,
) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "asof-window-knowledge").await;
    let d = today(&owner).await;
    let (entity, [(wp, site), _]) = two_workplaces(&store, &actor).await;
    let p = person(&owner, &store, &actor, (entity, wp, site), "window").await;
    let mut tx = owner.begin().await.unwrap();
    let began: OffsetDateTime = sqlx::query_scalar("SELECT now()")
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    let cutoff = known(&owner).await;
    assert!(began < cutoff);
    let close = d + Duration::days(10);
    let assignment_recorded: OffsetDateTime = sqlx::query_scalar(
        "UPDATE employment_assignments SET valid_to=$2 WHERE employee_id=$1 AND valid_to IS NULL \
         AND superseded_at IS NULL RETURNING valid_to_recorded_at",
    )
    .bind(p)
    .bind(close)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    let placement_recorded: OffsetDateTime = sqlx::query_scalar(
        "UPDATE org_unit_placements SET valid_to=$2 WHERE org_unit_id=$1 AND valid_to IS NULL \
         AND represents_workplace RETURNING valid_to_recorded_at",
    )
    .bind(site)
    .bind(close)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    assert!(assignment_recorded > cutoff);
    assert!(placement_recorded > cutoff);
    tx.commit().await.unwrap();
    let prior = read(&store, &actor, close, Some(cutoff)).await;
    let prior_wp = prior.entities[0]
        .children
        .iter()
        .find(|w| w.id == wp)
        .unwrap();
    assert_eq!((prior_wp.headcount, prior_wp.org_unit_id), (1, Some(site)));
    let current = read(&store, &actor, close, None).await;
    let current_wp = current.entities[0]
        .children
        .iter()
        .find(|w| w.id == wp)
        .unwrap();
    assert_eq!((current_wp.headcount, current_wp.org_unit_id), (0, None));
    assert_eq!(current.entity_unknown_headcount, Some(1));
    let range = (d + Duration::days(1), d + Duration::days(20));
    let current_dates = store
        .structure_change_dates(&actor, range.0, range.1, ReadOptions::default())
        .await
        .unwrap();
    let prior_dates = store
        .structure_change_dates(
            &actor,
            range.0,
            range.1,
            ReadOptions {
                as_of: None,
                known_at: Some(cutoff),
            },
        )
        .await
        .unwrap();
    assert!(current_dates.contains(&close.to_string()));
    assert!(!prior_dates.contains(&close.to_string()));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn first_legacy_header_update_preserves_the_value_known_since_tracking_started(
    owner: PgPool,
) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "asof-legacy-header").await;
    let (entity, _) = two_workplaces(&store, &actor).await;
    // Simulate the migration's empty history for a row that already existed at deployment.
    sqlx::query("ALTER TABLE legal_entities DISABLE TRIGGER zz_record_knowledge")
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("UPDATE legal_entities SET asof_history='[]',asof_history_started_at=clock_timestamp(),needs_confirmation=false WHERE id=$1")
        .bind(entity).execute(&owner).await.unwrap();
    sqlx::query("ALTER TABLE legal_entities ENABLE TRIGGER zz_record_knowledge")
        .execute(&owner)
        .await
        .unwrap();
    let cutoff = known(&owner).await;
    let read_pool = &owner;
    let value = |at| async move {
        sqlx::query_scalar::<_, Option<Value>>(
            "SELECT entity_known_row(to_jsonb(e),$2) FROM legal_entities e WHERE id=$1",
        )
        .bind(entity)
        .bind(at)
        .fetch_one(read_pool)
        .await
        .unwrap()
    };
    assert_eq!(value(cutoff).await.unwrap()["needs_confirmation"], false);
    sqlx::query("UPDATE legal_entities SET needs_confirmation=true WHERE id=$1")
        .bind(entity)
        .execute(&owner)
        .await
        .unwrap();
    let prior = value(cutoff)
        .await
        .expect("first update retains the tracking-start baseline");
    assert_eq!(prior["needs_confirmation"], false);
    assert_eq!(
        value(known(&owner).await).await.unwrap()["needs_confirmation"],
        true
    );
    let started: OffsetDateTime =
        sqlx::query_scalar("SELECT asof_history_started_at FROM legal_entities WHERE id=$1")
            .bind(entity)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(value(started - Duration::seconds(1)).await.is_none());
}
