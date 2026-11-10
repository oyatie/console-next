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
        matches!(error, console_orgchange_adapter_postgres::PgOrgChangeError::Domain(e) if e.kind == console_kernel_core::ErrorKind::Conflict && e.code==Some("lifecycle.refuse.stale_version"))
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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn another_account_of_the_actor_keeps_the_self_receipt(pool: PgPool) {
    let w = world(&pool).await;
    let alias = seed_active_user(&pool, *w.org.as_uuid(), "MEMBER", "alias").await;
    let person: Uuid = sqlx::query_scalar("SELECT person_id FROM users WHERE id=$1")
        .bind(w.actor.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    person_fixtures::bind_user_to_person(&pool, alias, person).await;
    org_change_fixtures::grant_org_levels(&pool, alias, &["view"]).await;
    let consent = scope_org(w.org, w.store.sole_holder_consent(w.actor, w.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(consent["recipients"], json!([w.actor]));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn recipient_accounts_are_deduplicated_by_person(pool: PgPool) {
    let w = world(&pool).await;
    let reader = seed_active_user(&pool, *w.org.as_uuid(), "MEMBER", "reader").await;
    let alias = seed_active_user(&pool, *w.org.as_uuid(), "MEMBER", "alias").await;
    let (_, person) = person_fixtures::bind_user_to_distinct_person(&pool, reader).await;
    person_fixtures::bind_user_to_person(&pool, alias, person).await;
    for account in [reader, alias] {
        org_change_fixtures::grant_org_levels(&pool, account, &["view"]).await;
    }
    let consent = scope_org(w.org, w.store.sole_holder_consent(w.actor, w.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(consent["payload"]["notice_count"], 1);
    assert_eq!(consent["recipients"].as_array().unwrap().len(), 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn consent_read_does_not_lock_the_request(pool: PgPool) {
    let w = world(&pool).await;
    let mut writer = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM org_change_requests WHERE id=$1 FOR NO KEY UPDATE")
        .bind(w.id)
        .execute(writer.as_mut())
        .await
        .unwrap();
    let read = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        scope_org(w.org, w.store.sole_holder_consent(w.actor, w.id)),
    )
    .await;
    writer.rollback().await.unwrap();
    assert!(
        read.expect("consent read waited for the writer")
            .unwrap()
            .is_some()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn concurrent_document_edit_omits_an_offer_for_the_old_detail(pool: PgPool) {
    let w = world(&pool).await;
    let mut writer = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(w.actor.as_uuid())
        .execute(writer.as_mut())
        .await
        .unwrap();
    let store = w.store.clone();
    let org = w.org;
    let actor = w.actor;
    let id = w.id;
    let read = tokio::spawn(async move { scope_org(org, store.get_for_viewer(actor, id)).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%CROSS JOIN LATERAL public.console_decision_people%')")
                .fetch_one(&pool).await.unwrap();
            if waiting { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("viewer did not reach the identity read");
    sqlx::query("UPDATE org_change_requests SET reason=reason||' amended',updated_at=clock_timestamp() WHERE id=$1")
        .bind(w.id).execute(writer.as_mut()).await.unwrap();
    writer.commit().await.unwrap();
    let detail = read.await.unwrap().unwrap();
    assert!(detail.sole_holder_decision.is_none());
}
