//! D0.2 over the 권한 screen's grants (155): an access grant (role × scope ×
//! dates) makes its holder an eligible second person only while it is live,
//! old enough, noticed, and reaches the act's scope on its own.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod second_person_support;

use console_identity_adapter_postgres::second_person::SecondPersonQuery;
use console_kernel_core::UserId;
use console_platform_test_support::runtime_role_pool;
use second_person_support::access::{CLOSE, Grant, close, go_live, grant, reasons};
use second_person_support::{fact, holder, org};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn a_live_old_noticed_tenant_wide_grant_counts_and_nothing_less(owner: PgPool) {
    let runtime = runtime_role_pool(&owner).await;
    let requester = holder(&owner, None, &[], true, 400, true).await;
    let grantor = holder(&owner, None, &[], true, 400, true).await;
    let counted = holder(&owner, None, &[], true, 400, true).await;
    let unnoticed = holder(&owner, None, &[], true, 400, true).await;
    let young = holder(&owner, None, &[], true, 400, true).await;
    let by_requester = holder(&owner, None, &[], true, 400, true).await;
    let other_line = holder(&owner, None, &[], true, 400, true).await;
    let g_counted = grant(&owner, org(), grantor, counted, CLOSE).await;
    let g_unnoticed = grant(
        &owner,
        org(),
        grantor,
        unnoticed,
        Grant {
            notified: false,
            ..CLOSE
        },
    )
    .await;
    let g_young = grant(
        &owner,
        org(),
        grantor,
        young,
        Grant {
            age_days: 1,
            ..CLOSE
        },
    )
    .await;
    let g_by_requester = grant(
        &owner,
        org(),
        requester,
        by_requester,
        Grant {
            age_days: 2,
            ..CLOSE
        },
    )
    .await;
    grant(
        &owner,
        org(),
        grantor,
        other_line,
        Grant {
            level: "view",
            ..CLOSE
        },
    )
    .await;
    let g_own = grant(&owner, org(), grantor, requester, CLOSE).await;

    let ask = SecondPersonQuery {
        requester: UserId::from_uuid(requester),
        ..close()
    };
    let got = fact(&runtime, &ask).await;
    assert!(
        got.eligible.is_empty(),
        "prepared in setup, not in force: {got:?}"
    );
    go_live(&owner, org(), grantor).await;
    let got = fact(&runtime, &ask).await;
    assert_eq!(got.eligible, [counted].into(), "{got:?}");
    assert_eq!(got.other_eligible_holders, 1);

    let reasons = reasons(&owner, requester).await;
    for (g, reason) in [
        (g_unnoticed, "NOTICE_UNDELIVERED"),
        (g_young, "GRANT_TOO_YOUNG"),
        (g_by_requester, "GRANTED_BY_REQUESTER"),
        (g_own, "EXCLUDED_PARTY"),
    ] {
        assert_eq!(
            reasons.get(&g.to_string()).map(String::as_str),
            Some(reason),
            "{g}"
        );
    }
    assert!(!reasons.contains_key(&g_counted.to_string()));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn a_revoked_ended_or_narrow_grant_does_not_count(owner: PgPool) {
    let runtime = runtime_role_pool(&owner).await;
    let requester = holder(&owner, None, &[], true, 400, true).await;
    let grantor = holder(&owner, None, &[], true, 400, true).await;
    let revoked = holder(&owner, None, &[], true, 400, true).await;
    let ended = holder(&owner, None, &[], true, 400, true).await;
    let narrow = holder(&owner, None, &[], true, 400, true).await;
    let entity = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) \
         VALUES ($1, $2, true, 'MIGRATION')",
    )
    .bind(org())
    .bind(entity)
    .execute(&owner)
    .await
    .unwrap();
    let g_revoked = grant(&owner, org(), grantor, revoked, CLOSE).await;
    let g_ended = grant(&owner, org(), grantor, ended, CLOSE).await;
    grant(
        &owner,
        org(),
        grantor,
        narrow,
        Grant {
            entity: Some(entity),
            ..CLOSE
        },
    )
    .await;
    // Per grant, not per holder: an unnoticed 회사 전체 grant never lends the
    // noticed 법인 grant its scope.
    grant(
        &owner,
        org(),
        grantor,
        narrow,
        Grant {
            notified: false,
            ..CLOSE
        },
    )
    .await;
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_actor', $1, true)")
        .bind(grantor.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(
        "UPDATE access_grants SET status = 'REVOKED', revoked_by = $2, revoked_at = now() WHERE id = $1",
    )
    .bind(g_revoked)
    .bind(grantor)
    .execute(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();
    // An end that already passed (written as the past it is: a fixture, no screen allows it).
    sqlx::query("ALTER TABLE access_grants DISABLE TRIGGER trg_access_grants_guard")
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("UPDATE access_grants SET valid_to = now() - interval '1 day' WHERE id = $1")
        .bind(g_ended)
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE access_grants ENABLE TRIGGER trg_access_grants_guard")
        .execute(&owner)
        .await
        .unwrap();

    go_live(&owner, org(), grantor).await;
    let got = fact(
        &runtime,
        &SecondPersonQuery {
            requester: UserId::from_uuid(requester),
            ..close()
        },
    )
    .await;
    assert!(got.eligible.is_empty(), "{got:?}");
    let flags: std::collections::BTreeSet<_> = got
        .review_flags
        .iter()
        .map(|f| (f.user_id, f.reason.clone()))
        .collect();
    // The revoke and the end moved into the past, both by someone else: review
    // flags, never a count.
    let removed = Some("REMOVED_BY_OTHER".to_owned());
    assert_eq!(
        flags,
        [(Some(revoked), removed.clone()), (Some(ended), removed)].into()
    );
}
