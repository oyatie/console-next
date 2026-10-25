// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! G2 consumes a stable owner-filtered page with an exclusive item cursor.

#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;

use std::collections::BTreeSet;

use console_hr_adapter_postgres::{cases::CaseItemQuery, clock::today_kst};
use console_kernel_core::{BranchScope, UserId};
use console_platform_authz::{EffectiveFeatureGrant, Feature, PermissionLevel, Principal, Role};
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_small_page_does_not_wait_for_an_unrelated_case_being_completed(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    for key in ["inbox-unlocked-hire", "inbox-locked-hire"] {
        let mut body = f.body(key, "REGULAR");
        body.hire_date = Some(today_kst().to_string());
        f.create(body).await.unwrap();
    }
    let all =
        f.hr.lifecycle_case_items(f.principal.clone(), CaseItemQuery::default())
            .await
            .unwrap();
    let first = &all.items[0];
    let other = all
        .items
        .iter()
        .find(|item| item.case_id != first.case_id)
        .unwrap();
    let mut held = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM lifecycle_cases WHERE id=$1 FOR UPDATE")
        .bind(other.case_id)
        .execute(held.as_mut())
        .await
        .unwrap();
    let page = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        f.hr.lifecycle_case_items(
            f.principal.clone(),
            CaseItemQuery {
                after: None,
                limit: Some(1),
            },
        ),
    )
    .await
    .expect("a page must not hydrate or lock cases outside that page")
    .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, first.id);
    held.rollback().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn case_item_page_filters_owners_and_advances_an_exclusive_cursor(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    for key in ["inbox-hire-one", "inbox-hire-two"] {
        let mut body = f.body(key, "REGULAR");
        body.hire_date = Some(today_kst().to_string());
        f.create(body).await.unwrap();
    }
    let all =
        f.hr.lifecycle_case_items(f.principal.clone(), CaseItemQuery::default())
            .await
            .unwrap();
    assert!(all.items.len() > 1);
    assert!(all.items.iter().all(|item| matches!(
        item.owner_line.as_deref(),
        Some("hr_basic.edit" | "access.edit")
    )));
    let first =
        f.hr.lifecycle_case_items(
            f.principal.clone(),
            CaseItemQuery {
                after: None,
                limit: Some(1),
            },
        )
        .await
        .unwrap();
    assert_eq!(first.items.len(), 1);
    assert_eq!(first.next, Some(first.items[0].id));
    let second =
        f.hr.lifecycle_case_items(
            f.principal.clone(),
            CaseItemQuery {
                after: first.next,
                limit: Some(1),
            },
        )
        .await
        .unwrap();
    assert_eq!(second.items.len(), 1);
    assert!(second.items[0].id > first.items[0].id);
    assert_eq!(first.items[0].id, all.items[0].id);
    assert_eq!(second.items[0].id, all.items[1].id);

    let user = UserId::new();
    sqlx::query("INSERT INTO users (id,org_id,display_name,roles) VALUES ($1,$2,'읽기 전용 담당자','{MEMBER}')")
        .bind(user.as_uuid()).bind(f.principal.org_id.as_uuid()).execute(&pool).await.unwrap();
    let reader = Principal::new(
        user,
        f.principal.org_id,
        BTreeSet::from([Role::Member]),
        BranchScope::All,
    )
    .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
        Feature::EmployeeDirectoryRead,
        PermissionLevel::Allow,
        BranchScope::All,
    )]);
    let page =
        f.hr.lifecycle_case_items(reader, CaseItemQuery::default())
            .await
            .unwrap();
    assert!(
        page.items.is_empty(),
        "read access cannot acquire an item's owner line"
    );
    assert!(page.next.is_none());
}
