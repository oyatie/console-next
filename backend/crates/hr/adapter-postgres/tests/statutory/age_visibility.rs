// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{QUERY_CAPTURE, age_scale, support, trail_queries, world};
use console_hr_adapter_postgres::statutory::FilingQuery;
use console_platform_authz::{
    Feature, Principal, Role,
    access::{NodeKind, ScopeGrant},
};
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

fn reader(w: &world::World, site: Uuid) -> Principal {
    let mut p = support::principal(w.tenant.org, w.user);
    p.roles = [Role::Member].into();
    p.with_scope_grants(vec![ScopeGrant {
        feature: Feature::EmployeeDirectoryManage,
        kind: NodeKind::Workplace,
        id: site,
    }])
}

fn assert_no_birthday_read(statements: &[String]) {
    assert!(
        statements.iter().any(|s| s.contains("SET LOCAL jit")),
        "missing SQL trace"
    );
    assert!(
        !statements
            .iter()
            .any(|s| s.contains("clock.year") || s.contains("age_placements AS")),
        "scoped inbox queried birthday data"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scoped_inbox_counts_only_its_scope(pool: PgPool) {
    let _capture = QUERY_CAPTURE.lock().await;
    let w = world::world(&pool).await;
    let site: Uuid = sqlx::query_scalar("INSERT INTO workplaces (org_id,legal_entity_id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION') RETURNING id")
        .bind(w.tenant.org).bind(w.entity).fetch_one(&pool).await.unwrap();
    age_scale::seed(&pool, w.tenant.org, w.user, w.entity, w.site, 1, 1).await;
    age_scale::seed(&pool, w.tenant.org, w.user, w.entity, site, 16, 1).await;
    let rules = world::register_rules(&pool).await;
    for expected in [60, 64] {
        let trace = trail_queries::Queries::default();
        let (page, exact) = w
            .tenant
            .hr
            .insurance_inbox_page(
                reader(&w, site),
                FilingQuery {
                    limit: Some(1),
                    ..Default::default()
                },
                rules.clone(),
                None,
            )
            .with_subscriber(trace.clone())
            .await
            .unwrap();
        assert!(exact);
        assert_eq!(page.total, expected);
        assert_eq!(page.pending, expected);
        assert_eq!(page.items.len(), 1);
        assert_ne!(page.items[0].kind, "AGE60");
        assert_no_birthday_read(&trace.statements());
        if expected == 60 {
            let mut tx = pool.begin().await.unwrap();
            sqlx::query("SET LOCAL session_replication_role=replica")
                .execute(tx.as_mut())
                .await
                .unwrap();
            sqlx::query("UPDATE employment_assignments SET workplace_id=$2 WHERE org_id=$1 AND employee_id IN (SELECT id FROM employees WHERE org_id=$1 AND source_key='age-window-1')")
                .bind(w.tenant.org).bind(site).execute(tx.as_mut()).await.unwrap();
            tx.commit().await.unwrap();
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn age60_follows_sensitivity_and_stores_no_birthday_instant(pool: PgPool) {
    let _capture = QUERY_CAPTURE.lock().await;
    let w = world::world(&pool).await;
    age_scale::seed(&pool, w.tenant.org, w.user, w.entity, w.site, 1, 1).await;
    let birthday: time::OffsetDateTime = sqlx::query_scalar("SELECT current_date::timestamp AT TIME ZONE time_zone FROM lifecycle_country_packs WHERE is_default")
        .fetch_one(&pool).await.unwrap();
    let rules = world::register_rules(&pool).await;
    for (as_of, expected) in [(birthday - time::Duration::seconds(1), 0), (birthday, 1)] {
        let query = FilingQuery {
            kind: Some("AGE60".into()),
            inbox_as_of: Some(as_of),
            ..Default::default()
        };
        let (page, exact) = w
            .tenant
            .hr
            .insurance_inbox_page(
                support::principal(w.tenant.org, w.user),
                query.clone(),
                rules.clone(),
                None,
            )
            .await
            .unwrap();
        assert!(exact);
        assert_eq!(page.total, expected);
        assert_eq!(page.items.len(), expected as usize);
        let trace = trail_queries::Queries::default();
        let (page, exact) = w
            .tenant
            .hr
            .insurance_inbox_page(reader(&w, w.site), query, rules.clone(), None)
            .with_subscriber(trace.clone())
            .await
            .unwrap();
        assert!(exact && page.items.is_empty());
        assert_eq!(page.total, 0);
        assert_no_birthday_read(&trace.statements());
    }
}
