//! BW-29 seeded-bypass tests of the eligible-second-person fact builder
//! (decisions D0.1 §5, D0.2; spec bw29 §5). Each holder below is one way a
//! requester could try to manufacture or hide a second person.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod second_person_support;

use std::collections::BTreeMap;

use console_identity_adapter_postgres::second_person::second_person_fact_in_tx;
use console_platform_test_support::runtime_role_pool;
use second_person_support::{MIN_GRANT_AGE_DAYS, fact, holder, org, query, set_roles};
use sqlx::PgPool;
use uuid::Uuid;

/// Every non-null reason by user, straight from the SQL function.
async fn reasons(owner: &PgPool, requester: Uuid, excluded: &[Uuid]) -> BTreeMap<Uuid, String> {
    sqlx::query_as::<_, (Uuid, String)>(
        "SELECT user_id, reason FROM second_person_candidates($1, 'role_manage', ARRAY['SUPER_ADMIN'], \
         ARRAY['SUPER_ADMIN','EXECUTIVE'], NULL, NULL, NULL, $2, $3, now(), make_interval(days => $4), \
         make_interval(days => 7)) WHERE reason IS NOT NULL AND user_id IS NOT NULL",
    )
    .bind(org())
    .bind(requester)
    .bind(excluded)
    .bind(MIN_GRANT_AGE_DAYS)
    .fetch_all(owner)
    .await
    .unwrap()
    .into_iter()
    .collect()
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn only_old_notified_independent_employees_count(owner: PgPool) {
    let runtime = runtime_role_pool(&owner).await;
    let requester = holder(&owner, None, &["SUPER_ADMIN"], true, 400, true).await;
    let counted = holder(&owner, None, &["SUPER_ADMIN"], true, 400, true).await;
    let drafter = holder(&owner, None, &["SUPER_ADMIN"], true, 400, true).await;
    let inactive = holder(&owner, None, &["SUPER_ADMIN"], true, 400, true).await;
    sqlx::query("UPDATE users SET is_active = false WHERE id = $1")
        .bind(inactive)
        .execute(&owner)
        .await
        .unwrap();
    let unlinked = holder(&owner, None, &["SUPER_ADMIN"], false, 400, true).await;
    let by_requester = holder(&owner, Some(requester), &["SUPER_ADMIN"], true, 0, true).await;
    let young = holder(&owner, Some(counted), &["SUPER_ADMIN"], true, 0, true).await;
    let unnotified = holder(&owner, None, &["SUPER_ADMIN"], true, 400, false).await;
    let branch_admin = holder(&owner, None, &["ADMIN"], true, 400, true).await;

    let got = fact(&runtime, &query(requester, &[drafter])).await;
    assert_eq!(got.other_eligible_holders, 1, "{got:?}");
    assert!(got.eligible.contains(&counted));
    assert!(got.review_flags.is_empty(), "{got:?}");

    let reasons = reasons(&owner, requester, &[drafter]).await;
    let expect = [
        (requester, "EXCLUDED_PARTY"),
        (drafter, "EXCLUDED_PARTY"),
        (inactive, "INACTIVE"),
        (unlinked, "NO_EMPLOYEE_LINK"),
        (by_requester, "ACCOUNT_CREATED_BY_REQUESTER"),
        (young, "GRANT_TOO_YOUNG"),
        (unnotified, "NOTICE_UNDELIVERED"),
    ];
    for (user, reason) in expect {
        assert_eq!(
            reasons.get(&user).map(String::as_str),
            Some(reason),
            "{user}"
        );
    }
    assert!(!reasons.contains_key(&branch_admin) && !reasons.contains_key(&counted));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn a_requester_cannot_become_sole_by_demoting_colleagues(owner: PgPool) {
    let runtime = runtime_role_pool(&owner).await;
    let requester = holder(&owner, None, &["SUPER_ADMIN"], true, 400, true).await;
    let demoted = holder(&owner, None, &["SUPER_ADMIN"], true, 400, true).await;
    let removed_unknown = holder(&owner, None, &["SUPER_ADMIN"], true, 400, true).await;
    set_roles(&owner, Some(requester), demoted, &["MEMBER"]).await;
    set_roles(&owner, None, removed_unknown, &["MEMBER"]).await;

    let got = fact(&runtime, &query(requester, &[])).await;
    assert_eq!(got.other_eligible_holders, 1, "{got:?}");
    assert!(got.eligible.contains(&demoted));
    let flagged: BTreeMap<Option<Uuid>, Option<String>> = got
        .review_flags
        .iter()
        .map(|row| (row.user_id, row.reason.clone()))
        .collect();
    assert_eq!(
        flagged.get(&Some(demoted)).cloned().flatten().as_deref(),
        Some("DEMOTED_BY_REQUESTER")
    );
    assert_eq!(
        flagged
            .get(&Some(removed_unknown))
            .cloned()
            .flatten()
            .as_deref(),
        Some("REMOVED_BY_UNKNOWN")
    );
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn a_demotion_waits_for_the_decision_and_the_ledger_is_notice_only(owner: PgPool) {
    let runtime = runtime_role_pool(&owner).await;
    let requester = holder(&owner, None, &["SUPER_ADMIN"], true, 400, true).await;
    let other = holder(&owner, None, &["SUPER_ADMIN"], true, 400, true).await;

    let mut decision = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org().to_string())
        .execute(decision.as_mut())
        .await
        .unwrap();
    let got = second_person_fact_in_tx(&mut decision, &query(requester, &[]))
        .await
        .unwrap();
    assert_eq!(got.other_eligible_holders, 1);
    let mut demotion = owner.begin().await.unwrap();
    sqlx::query("SET LOCAL lock_timeout = '300ms'")
        .execute(demotion.as_mut())
        .await
        .unwrap();
    let blocked = sqlx::query("UPDATE users SET roles = ARRAY['MEMBER'] WHERE id = $1")
        .bind(other)
        .execute(demotion.as_mut())
        .await;
    assert!(blocked.is_err(), "the demotion must wait for the decision");
    drop(demotion);

    // The notice first: the refused insert aborts the transaction.
    for (event, source, allowed) in [
        ("NOTICE_DELIVERED", "NOTIFIER", true),
        ("GRANTED", "TRIGGER", false),
    ] {
        let inserted = sqlx::query(
            "INSERT INTO authz_grant_ledger (org_id, user_id, grant_kind, grant_ref, event, source, channel) \
             VALUES ($1, $2, 'SYSTEM_ROLE', 'SUPER_ADMIN', $3, $4, 'IN_APP')",
        )
        .bind(org())
        .bind(other)
        .bind(event)
        .bind(source)
        .execute(decision.as_mut())
        .await;
        assert_eq!(inserted.is_ok(), allowed, "{event}: {inserted:?}");
    }
}
