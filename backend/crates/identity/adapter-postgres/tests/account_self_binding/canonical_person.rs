// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

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
