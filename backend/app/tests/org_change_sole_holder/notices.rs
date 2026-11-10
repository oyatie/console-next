// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_role_reader_receives_notice_but_inactive_reader_does_not(pool: PgPool) {
    let mut w = world(&pool).await;
    let reader = seed_active_user(&pool, *w.org.as_uuid(), "MEMBER", "reader").await;
    let inactive = seed_active_user(&pool, *w.org.as_uuid(), "EXECUTIVE", "inactive").await;
    seed_active_user(&pool, *w.org.as_uuid(), "EXECUTIVE", "no-authority").await;
    for user in [reader, inactive] {
        org_change_fixtures::grant_org_levels(&pool, user, &["view"]).await;
    }
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(inactive.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let body = command(&pool, &mut w).await;
    scope_org(
        w.org,
        w.store.decide_step_command(w.actor, w.id, w.steps[0], body),
    )
    .await
    .unwrap();
    let recipients: Vec<Uuid> =
        sqlx::query_scalar("SELECT recipient_user_id FROM notifications WHERE org_id=$1")
            .bind(w.org.as_uuid())
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(recipients, vec![*reader.as_uuid()]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn solo_decision_has_a_self_receipt(pool: PgPool) {
    let mut w = world(&pool).await;
    let body = command(&pool, &mut w).await;
    scope_org(
        w.org,
        w.store.decide_step_command(w.actor, w.id, w.steps[0], body),
    )
    .await
    .unwrap();
    let recipients: Vec<Uuid> =
        sqlx::query_scalar("SELECT recipient_user_id FROM notifications WHERE org_id=$1")
            .bind(w.org.as_uuid())
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(recipients, vec![*w.actor.as_uuid()]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn equal_count_recipient_replacement_invalidates_consent(pool: PgPool) {
    let mut w = world(&pool).await;
    let reader = seed_active_user(&pool, *w.org.as_uuid(), "EXECUTIVE", "reader").await;
    let replacement = seed_active_user(&pool, *w.org.as_uuid(), "EXECUTIVE", "replacement").await;
    org_change_fixtures::grant_org_levels(&pool, reader, &["view"]).await;
    let consent = scope_org(w.org, w.store.sole_holder_consent(w.actor, w.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(consent["payload"]["notice_count"], 1);
    assert_eq!(
        consent["payload"]["recipients_hash"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    assert!(consent["payload"].get("recipients").is_none());
    let body = command(&pool, &mut w).await;
    sqlx::query("WITH revoked AS (UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=granted_by WHERE account_id=$1 RETURNING *) INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) SELECT org_id,$2,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by FROM revoked")
        .bind(reader.as_uuid())
        .bind(replacement.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let before = snapshot(&pool, &w).await;
    let error = scope_org(
        w.org,
        w.store.decide_step_command(w.actor, w.id, w.steps[0], body),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(error, console_orgchange_adapter_postgres::PgOrgChangeError::Domain(e) if e.code==Some("step_up_failed"))
    );
    assert_eq!(snapshot(&pool, &w).await, before);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_hundred_readers_stay_within_the_locked_decision_budget(pool: PgPool) {
    let mut w = world(&pool).await;
    let reader = seed_active_user(&pool, *w.org.as_uuid(), "EXECUTIVE", "reader").await;
    org_change_fixtures::grant_org_levels(&pool, reader, &["view"]).await;
    sqlx::query("WITH readers AS (INSERT INTO users(org_id,display_name,roles) SELECT $1,'reader-'||n,ARRAY['EXECUTIVE'] FROM generate_series(1,199) n RETURNING id) INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) SELECT g.org_id,r.id,g.role_id,g.scope_kind,g.valid_from,g.effective_in_setup,g.change_mode,g.reason_code,g.granted_by FROM readers r CROSS JOIN access_grants g WHERE g.account_id=$2")
        .bind(w.org.as_uuid()).bind(reader.as_uuid()).execute(&pool).await.unwrap();
    let mut elapsed = std::time::Duration::MAX;
    // Match the holder benchmark's best-of-three sampling under runner contention.
    let steps = w.steps.clone();
    for step in steps.into_iter().take(3) {
        let body = command(&pool, &mut w).await;
        let start = std::time::Instant::now();
        scope_org(
            w.org,
            w.store.decide_step_command(w.actor, w.id, step, body),
        )
        .await
        .unwrap();
        let sample = start.elapsed();
        eprintln!("200-reader locked decision: {sample:?}");
        elapsed = elapsed.min(sample);
    }
    assert!(
        elapsed < std::time::Duration::from_secs(2),
        "locked decision exceeded 2s budget: {elapsed:?}"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM notifications WHERE org_id=$1")
        .bind(w.org.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 600);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn duplicate_notice_delivery_and_exception_reuse_are_guarded(pool: PgPool) {
    let mut w = world(&pool).await;
    let reader = seed_active_user(&pool, *w.org.as_uuid(), "EXECUTIVE", "reader").await;
    org_change_fixtures::grant_org_levels(&pool, reader, &["view"]).await;
    // Simulate a delivery already present when the enclosing insert retries it.
    sqlx::raw_sql("CREATE FUNCTION duplicate_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF pg_trigger_depth()=1 THEN INSERT INTO notifications(org_id,recipient_user_id,category,body,link,dedup_key) VALUES(NEW.org_id,NEW.recipient_user_id,NEW.category,NEW.body,NEW.link,NEW.dedup_key); END IF; RETURN NEW; END $$; CREATE TRIGGER duplicate_notice BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION duplicate_notice();")
        .execute(&pool).await.unwrap();
    let body = command(&pool, &mut w).await;
    scope_org(
        w.org,
        w.store.decide_step_command(w.actor, w.id, w.steps[0], body),
    )
    .await
    .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM notifications WHERE org_id=$1")
        .bind(w.org.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let error = sqlx::query("UPDATE org_change_approval_steps SET sole_holder_exception_id=(SELECT sole_holder_exception_id FROM org_change_approval_steps WHERE id=$1) WHERE id=$2")
        .bind(w.steps[0]).bind(w.steps[1]).execute(&pool).await.unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().constraint(),
        Some("org_change_step_exception_once")
    );
}
