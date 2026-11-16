// SPDX-License-Identifier: LicenseRef-Proprietary
use super::review_support::*;
use super::*;
use console_identity_adapter_postgres::self_binding_review::ReviewDecision;

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn operations_account_uses_the_linked_employees_canonical_person(pool: PgPool) {
    let (store, actor, employee, mut key) = fixture(&pool).await;
    let proof = envelope(store.pool(), actor, employee, &mut key).await;
    bind(&store, actor, employee, proof).await.unwrap();
    let (account_person, employee_person): (Option<Uuid>, Option<Uuid>) = sqlx::query_as(
        "SELECT u.person_id,b.person_id FROM users u LEFT JOIN employee_person_bindings b ON b.org_id=u.org_id AND b.employee_id=u.employee_id WHERE u.id=$1")
        .bind(actor.as_uuid()).fetch_one(&pool).await.unwrap();
    assert!(employee_person.is_some());
    assert_eq!(account_person, employee_person);
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
    let person: Option<Uuid> = sqlx::query_scalar("SELECT person_id FROM users WHERE id=$1")
        .bind(actor.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(person, Some(*actor.as_uuid()));
    assert_eq!(decisions(&pool, receipt).await, (1, 1));
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn revocation_restores_saved_person_instead_of_account_fallback(pool: PgPool) {
    restore_saved_person(&pool, ReviewDecision::Revoke).await;
}

#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn withdrawal_restores_saved_person_instead_of_account_fallback(pool: PgPool) {
    restore_saved_person(&pool, ReviewDecision::Withdraw).await;
}

async fn restore_saved_person(pool: &PgPool, decision: ReviewDecision) {
    let (store, actor, employee, mut key) = fixture(pool).await;
    sqlx::query("UPDATE employees SET identity_review_required=false WHERE id=$1")
        .bind(employee)
        .execute(pool)
        .await
        .unwrap();
    let previous = Uuid::new_v4();
    sqlx::query("INSERT INTO persons(org_id,id) VALUES($1,$2)")
        .bind(OrgId::one().as_uuid())
        .bind(previous)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET person_id=$2 WHERE id=$1")
        .bind(actor.as_uuid())
        .bind(previous)
        .execute(pool)
        .await
        .unwrap();
    let proof = envelope(store.pool(), actor, employee, &mut key).await;
    let receipt = bind(&store, actor, employee, proof).await.unwrap();
    let checker = if matches!(decision, ReviewDecision::Withdraw) {
        actor
    } else {
        reviewer(pool, actor, true, true).await
    };
    review(&store, checker, receipt, decision).await.unwrap();
    let identity: (Option<Uuid>, Option<Uuid>) =
        sqlx::query_as("SELECT employee_id,person_id FROM users WHERE id=$1")
            .bind(actor.as_uuid())
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(identity, (None, Some(previous)));
}
