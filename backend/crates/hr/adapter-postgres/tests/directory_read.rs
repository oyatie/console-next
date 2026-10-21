#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! PEOPLE-B directory reads: the employee_number filter, employment_type and
//! expected_return_date on the row, the facet counts, and the 접속기록 row
//! every list and detail read writes (INF-02, GOV-PEO-1 self-read capture).

mod support;

use std::collections::BTreeSet;

use console_kernel_core::{BranchScope, OrgId};
use console_platform_authz::{Principal, Role};
use serde_json::json;
use sqlx::PgPool;
use support::{access_rows, employee, no_filters, principal, query, tenant, user};
use uuid::Uuid;

async fn exec(pool: &PgPool, sql: &'static str, org: Uuid, employee: Uuid, actor: Uuid) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(sql)
        .bind(org)
        .bind(employee)
        .bind(actor)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn list_filters_by_employee_numbers_and_carries_type_and_return(pool: PgPool) {
    let t = tenant(&pool).await;
    let a = employee(&pool, t.org, "Kim", "A-1", "ACTIVE").await;
    let b = employee(&pool, t.org, "Lee", "A-2", "ON_LEAVE").await;
    employee(&pool, t.org, "Park", "A-3", "ACTIVE").await;
    let hr_user = user(&pool, t.org, None).await;
    exec(
        &pool,
        "INSERT INTO employee_employment_profiles (employee_id, org_id, employment_type, \
         phone_e164, base_pay, idempotency_key, request_hash, created_by) \
         VALUES ($2, $1, 'PART_TIME', '+821012345678', 0, 'profile-key', repeat('a', 64), $3)",
        t.org,
        a,
        *hr_user.as_uuid(),
    )
    .await;
    exec(
        &pool,
        "INSERT INTO employee_lifecycle_events (org_id, employee_id, event_type, to_status, \
         effective_date, expected_return_date, comment, created_by) \
         VALUES ($1, $2, 'LEAVE_OF_ABSENCE', 'ON_LEAVE', '2026-09-01', '2027-03-02', 'leave', $3)",
        t.org,
        b,
        *hr_user.as_uuid(),
    )
    .await;
    let reader = || principal(t.org, hr_user);

    let page =
        t.hr.list_employees(
            reader(),
            query(json!({ "employee_number": " A-1, A-2 ,," })),
        )
        .await
        .unwrap();
    assert_eq!(page.total, 2);
    let by_id = |id| page.items.iter().find(|e| e.id == id).unwrap();
    assert_eq!(by_id(a).employment_type.as_deref(), Some("PART_TIME"));
    assert_eq!(by_id(a).expected_return_date, None);
    assert_eq!(by_id(b).employment_type, None);
    assert_eq!(by_id(b).expected_return_date.as_deref(), Some("2027-03-02"));

    let too_many = (0..501)
        .map(|n| format!("N-{n}"))
        .collect::<Vec<_>>()
        .join(",");
    let err =
        t.hr.list_employees(reader(), query(json!({ "employee_number": too_many })))
            .await
            .unwrap_err();
    assert_eq!(err.status.as_u16(), 422, "{}", err.message);

    let detail = t.hr.employee_detail(reader(), b).await.unwrap();
    assert_eq!(
        detail.employee.expected_return_date.as_deref(),
        Some("2027-03-02")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn facets_count_each_chip_group_without_its_own_filter(pool: PgPool) {
    let t = tenant(&pool).await;
    for (name, status) in [
        ("A", "ACTIVE"),
        ("B", "ACTIVE"),
        ("C", "ON_LEAVE"),
        ("D", "EXITED"),
    ] {
        employee(&pool, t.org, name, name, status).await;
    }
    let hr_user = user(&pool, t.org, None).await;
    sqlx::query(
        "UPDATE employees SET identity_review_required = (name IN ('A', 'D')) WHERE org_id = $1",
    )
    .bind(t.org)
    .execute(&pool)
    .await
    .unwrap();

    let facets =
        t.hr.employee_facets(
            principal(t.org, hr_user),
            query(json!({ "status": "ACTIVE", "identity_review_required": true })),
        )
        .await
        .unwrap();
    // Every filter: A only.
    assert_eq!(facets.total, 1);
    // Status ignores the status filter: A (ACTIVE) and D (EXITED) need review.
    let status = facets
        .status
        .iter()
        .map(|f| (f.value.clone().unwrap(), f.count))
        .collect::<Vec<_>>();
    assert_eq!(
        status,
        vec![("ACTIVE".to_owned(), 1), ("EXITED".to_owned(), 1)]
    );
    // Review ignores the review filters but keeps status: A and B are ACTIVE.
    assert_eq!(facets.review.identity_review_required, 1);
    assert_eq!(facets.review.home_branch_review_required, 2);
    assert_eq!(facets.review.contract_ending_before, None);
    assert_eq!(facets.employment_type.len(), 1);
    assert_eq!(facets.employment_type[0].value, None);
    // A count read names no one: no 접속기록 row.
    assert!(access_rows(&pool, t.org).await.is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn list_and_detail_reads_write_one_access_row_each_including_self_reads(pool: PgPool) {
    let t = tenant(&pool).await;
    let me = employee(&pool, t.org, "Me", "M-1", "ACTIVE").await;
    let other = employee(&pool, t.org, "Other", "O-1", "ACTIVE").await;
    let hr_user = user(&pool, t.org, Some(me)).await;
    let reader = || principal(t.org, hr_user);

    let page = t.hr.list_employees(reader(), no_filters()).await.unwrap();
    assert_eq!(page.items.len(), 2);
    t.hr.employee_detail(reader(), other).await.unwrap();
    t.hr.employee_detail(reader(), me).await.unwrap();

    let rows = access_rows(&pool, t.org).await;
    assert_eq!(rows.len(), 3, "{rows:?}");
    let (action, target, after) = &rows[0];
    assert_eq!(
        (action.as_str(), target.as_str()),
        ("employee.list_read", "query")
    );
    let mut listed = after["subject_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().parse::<Uuid>().unwrap())
        .collect::<Vec<_>>();
    listed.sort();
    let mut expected = vec![me, other];
    expected.sort();
    assert_eq!(listed, expected);
    assert_eq!(after["self_read"], false);
    assert_eq!(after["principal_type"], "TENANT_USER");

    assert_eq!(rows[1].0, "employee.read");
    assert_eq!(rows[1].1, other.to_string());
    assert_eq!(rows[1].2["self_read"], false);
    // GOV-PEO-1: a 취급자 reading their own record is logged too.
    assert_eq!(rows[2].1, me.to_string());
    assert_eq!(rows[2].2["self_read"], true);
    assert_eq!(rows[2].2["actor_employee_id"], me.to_string());

    let actors: Vec<Option<Uuid>> = sqlx::query_scalar(
        "SELECT actor FROM audit_events WHERE org_id = $1 AND action LIKE 'employee.%'",
    )
    .bind(t.org)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(
        actors
            .iter()
            .all(|actor| *actor == Some(*hr_user.as_uuid()))
    );
}

/// G11: a directory reader without `employee_directory_manage` (EXECUTIVE)
/// sees the work email and never the registered personal phone.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reader_sees_the_work_email_and_never_the_personal_phone(pool: PgPool) {
    let t = tenant(&pool).await;
    let a = employee(&pool, t.org, "Kim", "A-1", "ACTIVE").await;
    let hr_user = user(&pool, t.org, None).await;
    exec(
        &pool,
        "INSERT INTO employee_employment_profiles (employee_id, org_id, employment_type, \
         phone_e164, base_pay, idempotency_key, request_hash, created_by) \
         VALUES ($2, $1, 'REGULAR', '+821012345678', 0, 'profile-key', repeat('a', 64), $3)",
        t.org,
        a,
        *hr_user.as_uuid(),
    )
    .await;
    exec(
        &pool,
        "UPDATE employees SET work_email = 'kim@example.test' WHERE org_id = $1 AND id = $2 \
         AND $3::uuid IS NOT NULL",
        t.org,
        a,
        *hr_user.as_uuid(),
    )
    .await;
    let executive = Principal::new(
        hr_user,
        OrgId::from_uuid(t.org),
        BTreeSet::from([Role::Executive]),
        BranchScope::All,
    );

    let page =
        t.hr.list_employees(executive.clone(), no_filters())
            .await
            .unwrap();
    let row = serde_json::to_string(&page.items[0]).unwrap();
    assert!(row.contains("\"work_email\":\"kim@example.test\""), "{row}");
    assert!(!row.contains("+8210"), "{row}");

    let detail = t.hr.employee_detail(executive, a).await.unwrap();
    assert_eq!(
        detail.employee.work_email.as_deref(),
        Some("kim@example.test")
    );
    let body = serde_json::to_string(&detail).unwrap();
    assert!(
        !body.contains("phone_e164") && !body.contains("+8210"),
        "{body}"
    );

    let manager =
        t.hr.employee_detail(principal(t.org, hr_user), a)
            .await
            .unwrap();
    assert_eq!(
        manager.employment.unwrap().phone_e164.as_deref(),
        Some("+821012345678")
    );
}
