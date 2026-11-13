// SPDX-License-Identifier: LicenseRef-Proprietary
use super::review_support::*;
use super::*;
use console_identity_adapter_postgres::self_binding_review::ReviewDecision;

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn confirm_then_revoke_retains_evidence_and_permanently_restores_two_person_rule(
    pool: PgPool,
) {
    let (store, actor, employee, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    review(&store, checker, receipt, ReviewDecision::Confirm)
        .await
        .unwrap();
    assert_eq!(counts(&pool, actor).await, (Some(employee), 1, 1));
    assert_eq!(decisions(&pool, receipt).await, (1, 1));
    assert_eq!(
        code(
            review(&store, checker, receipt, ReviewDecision::Confirm)
                .await
                .unwrap_err()
        ),
        "account_link.refuse.review_stale"
    );
    review(&store, checker, receipt, ReviewDecision::Revoke)
        .await
        .unwrap();
    assert_eq!(counts(&pool, actor).await, (None, 1, 1));
    assert_eq!(decisions(&pool, receipt).await, (2, 2));
    assert_eq!(
        code(
            review(&store, checker, receipt, ReviewDecision::Revoke)
                .await
                .unwrap_err()
        ),
        "account_link.refuse.review_stale"
    );
    sqlx::query("UPDATE users SET is_active=false WHERE id=$1")
        .bind(checker.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let mut key = SoftKey::enroll(store.pool(), OrgId::one(), actor).await;
    let fresh = envelope(store.pool(), actor, employee, &mut key).await;
    assert_eq!(
        code(bind(&store, actor, employee, fresh).await.unwrap_err()),
        "account_link.refuse.solo_ineligible"
    );
    assert_eq!(decisions(&pool, receipt).await, (2, 2));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn revoke_without_confirmation_and_after_deadline_is_allowed(pool: PgPool) {
    let (store, actor, _, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    sqlx::query("UPDATE account_link_self_attestations SET review_due_at=attested_at-interval '1 day' WHERE id=$1")
        .bind(receipt).execute(&pool).await.unwrap();
    review(&store, checker, receipt, ReviewDecision::Revoke)
        .await
        .unwrap();
    assert_eq!(counts(&pool, actor).await, (None, 1, 1));
    assert_eq!(decisions(&pool, receipt).await, (1, 1));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn self_review_and_same_person_alias_are_refused(pool: PgPool) {
    let (store, actor, _, receipt) = attested(&pool).await;
    assert_eq!(
        code(
            review(&store, actor, receipt, ReviewDecision::Confirm)
                .await
                .unwrap_err()
        ),
        "account_link.refuse.review_ineligible"
    );
    let alias = reviewer(&pool, actor, true, true).await;
    let alias_employee: Uuid = sqlx::query_scalar("SELECT employee_id FROM users WHERE id=$1")
        .bind(alias.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM employee_person_bindings WHERE org_id=$1 AND employee_id=$2")
        .bind(OrgId::one().as_uuid())
        .bind(alias_employee)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO employee_person_bindings(org_id,employee_id,person_id,actor_id,payload_digest) \
        SELECT org_id,$2,person_id,id,digest($2::text,'sha256') FROM users WHERE id=$1")
        .bind(actor.as_uuid()).bind(alias_employee).execute(&pool).await.unwrap();
    assert_eq!(
        code(
            review(&store, alias, receipt, ReviewDecision::Revoke)
                .await
                .unwrap_err()
        ),
        "account_link.refuse.review_ineligible"
    );
    assert_eq!(decisions(&pool, receipt).await, (0, 0));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn unbound_reviewer_is_refused(pool: PgPool) {
    let (store, actor, _, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, false, true).await;
    assert_eq!(
        code(
            review(&store, checker, receipt, ReviewDecision::Confirm)
                .await
                .unwrap_err()
        ),
        "account_link.refuse.identity_unbound"
    );
    assert_eq!(decisions(&pool, receipt).await, (0, 0));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn missing_permission_and_permission_removed_after_step_up_are_refused(pool: PgPool) {
    let (store, actor, _, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, false).await;
    assert_eq!(
        code(
            review(&store, checker, receipt, ReviewDecision::Confirm)
                .await
                .unwrap_err()
        ),
        "account_link.refuse.review_ineligible"
    );
    let checker = reviewer(&pool, actor, true, true).await;
    let proof = proof(&store, checker).await;
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$1 WHERE account_id=$2")
        .bind(actor.as_uuid()).bind(checker.as_uuid()).execute(&pool).await.unwrap();
    let result = scope_org(
        OrgId::one(),
        store.review_self_binding(
            receipt,
            ReviewDecision::Revoke,
            proof,
            TraceContext::generate(),
        ),
    )
    .await;
    assert_eq!(
        code(result.unwrap_err()),
        "account_link.refuse.review_ineligible"
    );
    assert_eq!(decisions(&pool, receipt).await, (0, 0));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn replacement_binding_is_never_changed_by_old_review(pool: PgPool) {
    let (store, actor, _, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    let replacement = employee(&pool).await;
    sqlx::query("UPDATE users SET employee_id=$2 WHERE id=$1")
        .bind(actor.as_uuid())
        .bind(replacement)
        .execute(&pool)
        .await
        .unwrap();
    for decision in [ReviewDecision::Confirm, ReviewDecision::Revoke] {
        assert_eq!(
            code(
                review(&store, checker, receipt, decision)
                    .await
                    .unwrap_err()
            ),
            "account_link.refuse.review_stale"
        );
    }
    assert_eq!(counts(&pool, actor).await, (Some(replacement), 1, 1));
    assert_eq!(decisions(&pool, receipt).await, (0, 0));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn missing_and_foreign_receipts_are_not_visible(pool: PgPool) {
    let (store, actor, _, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    assert_eq!(
        review(&store, checker, Uuid::new_v4(), ReviewDecision::Confirm)
            .await
            .unwrap_err()
            .kind(),
        console_kernel_core::ErrorKind::NotFound
    );
    let proof = proof(&store, checker).await;
    let result = scope_org(
        OrgId::new(),
        store.review_self_binding(
            receipt,
            ReviewDecision::Confirm,
            proof,
            TraceContext::generate(),
        ),
    )
    .await;
    assert_eq!(
        result.unwrap_err().kind(),
        console_kernel_core::ErrorKind::Forbidden
    );
    assert_eq!(decisions(&pool, receipt).await, (0, 0));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn concurrent_confirmations_write_one_decision_and_one_audit(pool: PgPool) {
    let (store, actor, employee, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    let first = proof(&store, checker).await;
    let second = proof(&store, checker).await;
    let (a, b) = tokio::join!(
        scope_org(
            OrgId::one(),
            store.review_self_binding(
                receipt,
                ReviewDecision::Confirm,
                first,
                TraceContext::generate()
            )
        ),
        scope_org(
            OrgId::one(),
            store.review_self_binding(
                receipt,
                ReviewDecision::Confirm,
                second,
                TraceContext::generate()
            )
        )
    );
    let loser = if a.is_ok() {
        b
    } else {
        assert!(b.is_ok());
        a
    };
    assert_eq!(code(loser.unwrap_err()), "account_link.refuse.review_stale");
    assert_eq!(counts(&pool, actor).await, (Some(employee), 1, 1));
    assert_eq!(decisions(&pool, receipt).await, (1, 1));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn audit_failure_rolls_back_revocation_and_decision(pool: PgPool) {
    let (store, actor, employee, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    sqlx::raw_sql("CREATE FUNCTION refuse_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
        IF NEW.action='account_link.revoked' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; \
        CREATE TRIGGER refuse_review_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION refuse_review_audit();")
        .execute(&pool).await.unwrap();
    let error = review(&store, checker, receipt, ReviewDecision::Revoke)
        .await
        .unwrap_err();
    assert!(format!("{error:?}").contains("synthetic audit failure"));
    assert_eq!(counts(&pool, actor).await, (Some(employee), 1, 1));
    assert_eq!(decisions(&pool, receipt).await, (0, 0));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn review_evidence_is_tenant_isolated_and_append_only_at_runtime(pool: PgPool) {
    let (store, actor, _, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    review(&store, checker, receipt, ReviewDecision::Confirm)
        .await
        .unwrap();
    let mut tx = store.pool().begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(OrgId::new().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM account_link_self_reviews")
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(visible, 0, "review evidence must be tenant isolated");
    tx.rollback().await.unwrap();
    for statement in [
        "UPDATE account_link_self_reviews SET decision='REVOKE'",
        "DELETE FROM account_link_self_reviews",
    ] {
        let mut tx = store.pool().begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(OrgId::one().to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        assert!(sqlx::query(statement).execute(tx.as_mut()).await.is_err());
        tx.rollback().await.unwrap();
    }
    assert_eq!(decisions(&pool, receipt).await, (1, 1));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn a_reviewer_without_permission_cannot_probe_revoked_binding_state(pool: PgPool) {
    let (store, actor, _, receipt) = attested(&pool).await;
    let checker = reviewer(&pool, actor, true, true).await;
    let outsider = reviewer(&pool, actor, true, false).await;
    review(&store, checker, receipt, ReviewDecision::Revoke)
        .await
        .unwrap();
    assert_eq!(
        code(
            review(&store, outsider, receipt, ReviewDecision::Confirm)
                .await
                .unwrap_err()
        ),
        "account_link.refuse.review_ineligible"
    );
    assert_eq!(decisions(&pool, receipt).await, (1, 1));
}
