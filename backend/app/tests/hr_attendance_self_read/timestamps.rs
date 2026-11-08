// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn linked_member_reads_only_own_attendance(pool: PgPool) {
    let keys = keys();

    let alice = UserId::new();
    let alice_employee = seed_linked_employee(&pool, alice, "MEMBER", "alice").await;
    let bob = UserId::new();
    let bob_employee = seed_linked_employee(&pool, bob, "MEMBER", "bob").await;
    empty_grants::assert_empty_grants(&pool, alice).await;

    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());

    for (user, employee) in [(alice, alice_employee), (bob, bob_employee)] {
        account_link::seed_record(&pool, user, employee).await;
    }

    // Alice sees exactly one record — her own, never bob's.
    let alice_read = get(
        service,
        ME_PATH,
        &bearer(&pool, &keys, alice, "MEMBER").await,
    )
    .await;
    assert_eq!(alice_read.status, StatusCode::OK, "{:?}", alice_read.json);
    assert_eq!(alice_read.json["total"], 1);
    let items = alice_read.json["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["employee_display_name"], "alice");
    let wire = items[0]["occurred_at"].as_str().expect("RFC 3339 string");
    assert!(wire.ends_with('Z'), "{wire}");
    OffsetDateTime::parse(wire, &time::format_description::well_known::Rfc3339).unwrap();
}
