#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;
use common::*;
use console_onboarding_adapter_postgres::PgOnboardingError;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn roles_skip_is_recorded_and_refusals_leave_choices_unchanged(owner: PgPool) {
    let (store, a) = tenant(&owner).await;
    store.skip_step(&a, "roles").await.unwrap();
    let c = store.checklist(&a).await.unwrap();
    let roles = c.steps.iter().find(|s| s.key == "roles").unwrap();
    assert_eq!(roles.state, console_onboarding_domain::StepState::Done);
    assert_eq!(roles.remedy, Some("roles_skipped"));
    let before = snapshot(&owner, &a).await;
    refused(
        &owner,
        &a,
        before,
        store.skip_step(&a, "roles").await.unwrap_err(),
        "step_already_skipped",
    )
    .await;
    let before = snapshot(&owner, &a).await;
    refused(
        &owner,
        &a,
        before,
        store.skip_step(&a, "unknown").await.unwrap_err(),
        "step_not_skippable",
    )
    .await;
    operating(&owner, &a).await;
    let before = snapshot(&owner, &a).await;
    refused(
        &owner,
        &a,
        before,
        store.skip_step(&a, "roles").await.unwrap_err(),
        "phase_not_setup",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn only_setup_effective_grants_read_and_arm_their_step(owner: PgPool) {
    let (store, a) = tenant(&owner).await;
    let hr = hr(&owner, &a).await;
    let before = snapshot(&owner, &a).await;
    refused(
        &owner,
        &hr,
        before,
        store.checklist(&hr).await.unwrap_err(),
        "forbidden",
    )
    .await;
    grant_employees(&owner, &a, &hr, true).await;
    let c = store.checklist(&hr).await.unwrap();
    assert_eq!(
        c.steps
            .iter()
            .filter(|s| s.can_act)
            .map(|s| s.key)
            .collect::<Vec<_>>(),
        ["employees"]
    );
    store.skip_step(&hr, "employees").await.unwrap();
    for step in ["org", "roles"] {
        let before = snapshot(&owner, &a).await;
        refused(
            &owner,
            &hr,
            before,
            store.skip_step(&hr, step).await.unwrap_err(),
            "forbidden",
        )
        .await;
    }
    let before = snapshot(&owner, &a).await;
    refused(
        &owner,
        &hr,
        before,
        store.preview(&hr).await.unwrap_err(),
        "forbidden",
    )
    .await;
    let preview = store.preview(&a).await.unwrap();
    assert_eq!(preview.facts.non_ops_grants, 1);
    assert_eq!(preview.facts.grants_effective_in_setup, 1);
    assert_eq!(preview.facts.hr_accounts_invited, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn prepared_grants_count_their_holders_without_unlocking_the_setup_rail(owner: PgPool) {
    let (store, a) = tenant(&owner).await;
    let prepared = hr(&owner, &a).await;
    let ungranted = hr(&owner, &a).await;
    grant_employees(&owner, &a, &prepared, false).await;
    let before = snapshot(&owner, &a).await;
    refused(
        &owner,
        &prepared,
        before,
        store.checklist(&prepared).await.unwrap_err(),
        "forbidden",
    )
    .await;
    let p = store.preview(&a).await.unwrap();
    assert_eq!(p.facts.prepared_grants, 1);
    assert_eq!(p.facts.grants_effective_in_setup, 0);
    assert_eq!(p.facts.hr_accounts_invited, 2);
    assert_eq!(p.details.roles_becoming_active.len(), 1);
    let role = &p.details.roles_becoming_active[0];
    assert_eq!(role.role, "Test HR");
    assert_eq!(role.scope_kind, "TENANT");
    assert_eq!(role.holders.len(), 1);
    assert_eq!(role.holders[0].id, prepared.user.as_uuid().to_string());
    assert_eq!(p.details.hr_accounts_with_no_grant.len(), 1);
    assert_eq!(
        p.details.hr_accounts_with_no_grant[0].id,
        ungranted.user.as_uuid().to_string()
    );
    assert_eq!(p.details.access_admin_holders.len(), 1);
    assert_eq!(
        p.details.access_admin_holders[0].id,
        a.user.as_uuid().to_string()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn stale_preview_returns_a_fresh_digest_and_changed_codes_before_any_write(owner: PgPool) {
    let (store, a) = tenant(&owner).await;
    let p = store.preview(&a).await.unwrap();
    store.skip_step(&a, "roles").await.unwrap();
    let before = snapshot(&owner, &a).await;
    let err = store
        .go_live_with_lines(&a, p.digest, p.line_digests, false, true)
        .await
        .unwrap_err();
    assert_eq!(
        details(&err)["digest"],
        store.preview(&a).await.unwrap().digest
    );
    assert!(
        details(&err)["changed_codes"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("facts"))
    );
    refused(&owner, &a, before, err, "preview_stale").await;
    let p = store.preview(&a).await.unwrap();
    let before = snapshot(&owner, &a).await;
    let err = store.go_live(&a, p.digest, false, false).await.unwrap_err();
    assert!(
        matches!(&err, PgOnboardingError::Refused { fields, .. } if fields.contains(&"step_up") && fields.contains(&"terms_accepted"))
    );
    refused(&owner, &a, before, err, "go_live_blocked").await;
    operating(&owner, &a).await;
    let before = snapshot(&owner, &a).await;
    refused(
        &owner,
        &a,
        before,
        store
            .go_live(&a, "0".repeat(64), false, true)
            .await
            .unwrap_err(),
        "phase_not_setup",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_thousand_unplaced_people_have_consistent_summary_and_named_warnings(owner: PgPool) {
    let (store, a) = tenant(&owner).await;
    // rls-arming: ok owner-only scale fixture; all production reads below use console_rt and RLS.
    sqlx::query("INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key, employment_status) SELECT $1, 'Test company', 'Person ' || n, 'fixture.xlsx', 'Roster', n, 'scale-' || n, 'ACTIVE' FROM generate_series(1, 2000) n")
        .bind(a.org.as_uuid()).execute(&owner).await.unwrap();
    let c = store.checklist(&a).await.unwrap();
    assert_eq!(c.summary.people, 2000);
    assert_eq!(c.summary.placed, 0);
    assert_eq!(c.summary.unplaced, 2000);
    assert_eq!(c.summary.entity_unknown, 2000);
    let p = store.preview(&a).await.unwrap();
    for code in ["unplaced_people", "entity_unknown_people"] {
        let warning = p.warnings.iter().find(|w| w.code == code).unwrap();
        assert_eq!(warning.count, Some(2000));
        assert_eq!(warning.records.len(), 2000);
        assert!(
            warning
                .records
                .iter()
                .all(|r| r.legal_entity_id == uuid::Uuid::nil().to_string())
        );
        assert_eq!(warning.remedy, Some("place_people"));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_routed_sole_holder_refusal_names_the_ack_and_changes_no_business_state(owner: PgPool) {
    let (store, a) = tenant(&owner).await;
    // rls-arming: ok owner-only fixture opts into the tenant's routed org-change policy.
    sqlx::query("INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) VALUES ($1, 'approval.policy.org_structure', '\"route\"', $2, 'BW01')")
        .bind(a.org.as_uuid()).bind(a.user.as_uuid()).execute(&owner).await.unwrap();
    let p = store.preview(&a).await.unwrap();
    assert!(p.facts.sole_holder_ack_required());
    let before = snapshot(&owner, &a).await;
    let error = store.go_live(&a, p.digest, false, true).await.unwrap_err();
    assert!(
        matches!(&error, PgOnboardingError::Refused { fields, .. } if fields.contains(&"sole_holder_acknowledged"))
    );
    refused(&owner, &a, before, error, "go_live_blocked").await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn concurrent_skips_and_terms_commit_without_phase_lock_upgrades(owner: PgPool) {
    let (store, actor) = tenant(&owner).await;
    let hash = publish(&owner, "concurrent", "Concurrent terms", 0).await;
    let before = snapshot(&owner, &actor).await;
    // KEY SHARE lets the old admission SHARE lock through but blocks its later UPDATE upgrade.
    let mut blocker = owner.begin().await.unwrap();
    sqlx::query("SELECT phase FROM tenant_phase WHERE org_id = $1 FOR KEY SHARE")
        .bind(actor.org.as_uuid())
        .fetch_one(blocker.as_mut())
        .await
        .unwrap();
    let mut commands = Vec::new();
    for step in ["org", "employees", "roles"] {
        let store = store.clone();
        let actor = actor.clone();
        commands.push(tokio::spawn(
            async move { store.skip_step(&actor, step).await },
        ));
    }
    let terms_store = store.clone();
    let terms_actor = actor.clone();
    commands.push(tokio::spawn(async move {
        terms_store
            .accept_terms(&terms_actor, "concurrent".into(), hash)
            .await
    }));
    let waiting = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'SELECT phase FROM tenant_phase%FOR UPDATE'")
                .fetch_one(&owner).await.unwrap();
            if count == 4 { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await;
    blocker.commit().await.unwrap();
    waiting.expect("all four commands reached their phase lock");
    for command in commands {
        command
            .await
            .unwrap()
            .expect("concurrent setup command commits");
    }
    assert_eq!(
        snapshot(&owner, &actor).await,
        ("SETUP".into(), 1, before.2 + 4)
    );
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id = $1 AND action IN ('tenant.setup_step_skip', 'tenant.terms_accept')")
        .bind(actor.org.as_uuid()).fetch_one(&owner).await.unwrap();
    assert_eq!(audits, 4, "every choice and its audit commit together");
}
