// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_hr_adapter_postgres::{
    authz::authorize_hr_case, directory::read_list::EmployeeListQuery,
};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scoped_directory_home_and_exit_actions_share_the_current_node(pool: PgPool) {
    let runtime = runtime_role_pool(&pool).await;
    for (kind, choice, unit, assignment, allowed) in [
        (NodeKind::Workplace, 0, Some(1), Some((0, Some(0))), false),
        (NodeKind::Department, 0, Some(0), Some((1, Some(1))), true),
        (NodeKind::Department, 1, Some(0), Some((1, Some(1))), false),
        (NodeKind::Workplace, 1, Some(1), Some((0, Some(0))), true),
        (NodeKind::LegalEntity, 0, Some(1), Some((0, Some(0))), false),
        (NodeKind::LegalEntity, 1, Some(1), Some((0, Some(0))), true),
        (NodeKind::Department, 0, None, Some((0, Some(0))), false),
        (NodeKind::Workplace, 0, None, Some((0, Some(0))), true),
        (NodeKind::Workplace, 1, None, Some((0, Some(0))), false),
        (NodeKind::LegalEntity, 0, None, Some((0, Some(0))), true),
        (NodeKind::LegalEntity, 1, None, Some((0, Some(0))), false),
        (NodeKind::Workplace, 0, None, Some((0, None)), false),
        (NodeKind::LegalEntity, 0, None, Some((0, None)), true),
        (NodeKind::LegalEntity, 1, None, Some((0, None)), false),
        (NodeKind::LegalEntity, 0, None, None, false),
    ] {
        let w = world::World::seed(&pool, &[vec![1], vec![1]]).await;
        sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) SELECT org_id,org_unit_id,version+1,gen_random_uuid(),actor_id,payload_digest,attributes || '{\"kind\":\"department\"}',receipt FROM org_unit_revisions WHERE org_id=$1 AND version=1")
            .bind(w.org.as_uuid()).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) SELECT org_id,id,1,'exit',ARRAY['edit','approve'] FROM access_roles WHERE org_id=$1")
            .bind(w.org.as_uuid()).execute(&pool).await.unwrap();
        let actor = UserId::from_uuid(w.holder(&pool, Some(kind), false, choice).await);
        let nodes = |kind| {
            w.nodes
                .iter()
                .filter(|n| n.kind == kind)
                .map(|n| n.id)
                .collect::<Vec<_>>()
        };
        let units = nodes(NodeKind::Department);
        let workplaces = nodes(NodeKind::Workplace);
        let entities = nodes(NodeKind::LegalEntity);
        let employee: Uuid = sqlx::query_scalar("INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key,org_unit_id,hire_date) VALUES ($1,'회사','검증 직원','console','console',1,'placement',$2,'2020-01-01') RETURNING id")
            .bind(w.org.as_uuid()).bind(unit.map(|i| units[i])).fetch_one(&pool).await.unwrap();
        if let Some((entity, workplace)) = assignment {
            sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) VALUES ($1,$2,$3,$4,'2020-01-01','MIGRATION',gen_random_uuid())")
                .bind(w.org.as_uuid()).bind(employee).bind(entities[entity]).bind(workplace.map(|i| workplaces[i])).execute(&pool).await.unwrap();
        }
        let case: Uuid = sqlx::query_scalar("INSERT INTO employee_exit_cases (org_id,employee_id,status,effective_exit_date,site_manager_note,reported_by) VALUES ($1,$2,'REPORTED',CURRENT_DATE+1,'검증',$3) RETURNING id")
            .bind(w.org.as_uuid()).bind(employee).bind(actor.as_uuid()).fetch_one(&pool).await.unwrap();
        let p = principal(&pool, w.org, actor, false).await;
        assert_eq!(p.scopes_for(Feature::EmployeeDirectoryRead).count(), 1);
        assert!(
            p.scopes_for(Feature::EmployeeDirectoryRead)
                .all(|s| s.kind == kind)
        );
        let label = format!("{kind:?}/{choice}, department={unit:?}, assignment={assignment:?}");
        let hr = HrService::new(runtime.clone());
        let directory = hr
            .list_employees(p.clone(), EmployeeListQuery::default())
            .await
            .unwrap();
        assert_eq!(
            directory.items.iter().any(|e| e.id == employee),
            allowed,
            "directory: {label}"
        );
        assert_eq!(directory.total, i64::from(allowed), "count: {label}");
        let unplaced = EmployeeListQuery {
            department_missing: Some(true),
            ..Default::default()
        };
        let missing = hr.list_employees(p.clone(), unplaced).await.unwrap();
        assert_eq!(
            missing.items.len(),
            usize::from(allowed && unit.is_none()),
            "미배치: {label}"
        );
        let facets = hr
            .employee_facets(p.clone(), EmployeeListQuery::default())
            .await
            .unwrap();
        assert_eq!(facets.total, i64::from(allowed), "facets: {label}");
        let now = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let home = page(&runtime, &p, query(now, 5), &Default::default())
            .await
            .unwrap();
        assert_eq!(
            home.items.iter().any(|i| i.id == format!("hr_exit:{case}")),
            allowed,
            "Home: {label}"
        );
        let mut tx = runtime.begin().await.unwrap();
        world::arm(&mut tx, w.org).await;
        for feature in [
            Feature::ExitCaseReport,
            Feature::ExitCaseHrConfirm,
            Feature::ExitCaseHqConfirm,
            Feature::ExitSettlementManage,
        ] {
            let result = authorize_hr_case(&mut tx, &p, feature, None, employee).await;
            assert_eq!(result.is_ok(), allowed, "{feature:?}: {label}: {result:?}");
        }
        tx.rollback().await.unwrap();
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn no_directory_read_anywhere_costs_zero_statements(pool: PgPool) {
    let w = world::World::seed(&pool, &[vec![1]]).await;
    let actor = UserId::from_uuid(w.holder(&pool, None, false, 0).await);
    bounded::seed(&pool, w.org, actor, 10, None).await;
    let runtime = runtime_role_pool(&pool).await;
    let now = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await
        .unwrap();
    for exit_grant in [false, true] {
        if exit_grant {
            grant_exit(&pool, w.org, actor).await;
            sqlx::query("DELETE FROM access_role_lines WHERE org_id=$1 AND domain='hr_basic'")
                .bind(w.org.as_uuid())
                .execute(&pool)
                .await
                .unwrap();
        }
        let p = principal(&pool, w.org, actor, false).await;
        assert!(!p.is_tenant_ops);
        assert!(
            p.scopes_for(Feature::EmployeeDirectoryRead)
                .next()
                .is_none()
        );
        let queries = trail_queries::Queries::default();
        let result = page(&runtime, &p, query(now, 5), &Default::default())
            .with_subscriber(queries.clone())
            .await
            .unwrap();
        assert!(result.items.is_empty());
        assert!(result.total_is_exact);
        assert_eq!(queries.statements().len(), 0, "exit grant={exit_grant}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hidden_first_batches_do_not_lose_the_last_visible_case(pool: PgPool) {
    let w = world::World::seed(&pool, &[vec![1, 1]]).await;
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) SELECT org_id,id,1,'exit',ARRAY['edit'] FROM access_roles WHERE org_id=$1")
        .bind(w.org.as_uuid()).execute(&pool).await.unwrap();
    let actor = UserId::from_uuid(w.holder(&pool, Some(NodeKind::Department), false, 0).await);
    let units: Vec<_> = w
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Department)
        .map(|n| n.id)
        .collect();
    bounded::seed(&pool, w.org, actor, 29, Some(units[1])).await;
    bounded::seed(&pool, w.org, actor, 1, Some(units[0])).await;
    let visible: Uuid = sqlx::query_scalar("UPDATE employee_exit_cases c SET effective_exit_date=CURRENT_DATE+60 FROM employees e WHERE c.employee_id=e.id AND e.org_id=$1 AND e.org_unit_id=$2 RETURNING c.id")
        .bind(w.org.as_uuid()).bind(units[0]).fetch_one(&pool).await.unwrap();
    let p = principal(&pool, w.org, actor, false).await;
    let now = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let result = page(
        &runtime_role_pool(&pool).await,
        &p,
        query(now, 5),
        &Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].id, format!("hr_exit:{visible}"));
    assert_eq!(result.total, 1);
    assert!(result.total_is_exact, "all candidates were scanned");
    assert!(!result.has_more);
}
