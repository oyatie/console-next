use console_kernel_core::BranchScope;
use console_platform_authz::access::{NodeKind, ScopeGrant};
use console_platform_authz::{Feature, Principal};
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

use super::fixture::fixture;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn followups_share_directory_scope_and_page_past_other_sources(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let mut body = f.body("inside", "REGULAR");
    body.name = "김범위".into();
    let inside = f.create(body).await.unwrap().employee;
    let mut outside = Vec::new();
    for (name, key) in [("김외부", "outside"), ("김마지막", "last")] {
        let body = serde_json::from_value(serde_json::json!({
            "name": name, "hire_date": "2026-09-01", "idempotency_key": key
        }))
        .unwrap();
        outside.push(f.create(body).await.unwrap().employee);
    }
    let as_of: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let scoped = |feature, unit| {
        Principal::new(
            f.principal.user_id,
            f.principal.org_id,
            Default::default(),
            BranchScope::All,
        )
        .with_scope_grants(vec![ScopeGrant {
            feature,
            kind: NodeKind::Department,
            id: unit,
        }])
    };
    let page =
        f.hr.register_review_inbox_page(
            &scoped(Feature::EmployeeDirectoryManage, f.unit),
            as_of,
            None,
            10,
        )
        .await
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.items[0].0, inside.id);
    assert!(!page.has_more);
    for principal in [
        scoped(Feature::EmployeeDirectoryManage, Uuid::new_v4()),
        scoped(Feature::EmployeeDirectoryRead, f.unit),
    ] {
        let page =
            f.hr.register_review_inbox_page(&principal, as_of, None, 10)
                .await
                .unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.total, 0, "a denied scope exposes no count");
    }
    let ids = [inside.id, outside[0].id, outside[1].id];
    let middle_created: OffsetDateTime =
        sqlx::query_scalar("SELECT created_at FROM employees WHERE id=$1")
            .bind(ids[1])
            .fetch_one(&pool)
            .await
            .unwrap();
    for (cursor, expected, more) in [
        (
            (Some(as_of), as_of, format!("support:{}", outside[0].id)),
            ids[0],
            true,
        ),
        (
            (None, middle_created, format!("hr_register:{}", ids[1])),
            ids[2],
            false,
        ),
    ] {
        let page =
            f.hr.register_review_inbox_page(&f.principal, as_of, Some(cursor), 1)
                .await
                .unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.items[0].0, expected);
        assert_eq!(page.has_more, more);
    }
}
