// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_hr_adapter_postgres::directory::read_export::ExportPurposeQuery;
use futures::StreamExt;

struct Fixture {
    org: OrgId,
    people: Vec<Uuid>,
    cases: Vec<Uuid>,
    readers: Vec<(&'static str, Principal, Vec<Uuid>)>,
}

impl Fixture {
    async fn seed(pool: &PgPool) -> Self {
        let w = world::World::seed(pool, &[vec![1]]).await;
        // Export and every exit step use the same placement as directory read.
        sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) SELECT org_id,id,2,name_ko,status,'SETUP',created_by FROM access_roles WHERE org_id=$1")
            .bind(w.org.as_uuid()).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) SELECT org_id,id,2,'hr_basic',ARRAY['view','export'] FROM access_roles WHERE org_id=$1 UNION ALL SELECT org_id,id,2,'exit',ARRAY['edit','approve'] FROM access_roles WHERE org_id=$1")
            .bind(w.org.as_uuid()).execute(pool).await.unwrap();
        sqlx::query("UPDATE access_roles SET version=2 WHERE org_id=$1")
            .bind(w.org.as_uuid())
            .execute(pool)
            .await
            .unwrap();
        let tenant = UserId::from_uuid(w.holder(pool, Some(NodeKind::Tenant), false, 0).await);
        let scoped = UserId::from_uuid(w.holder(pool, Some(NodeKind::Workplace), false, 0).await);
        let ops = UserId::from_uuid(w.holder(pool, None, true, 0).await);
        let mut units: Vec<_> = w
            .nodes
            .iter()
            .filter(|n| n.kind == NodeKind::Department)
            .map(|n| n.id)
            .collect();
        let workplace = w
            .nodes
            .iter()
            .find(|n| n.kind == NodeKind::Workplace)
            .unwrap()
            .id;
        let entity = w
            .nodes
            .iter()
            .find(|n| n.kind == NodeKind::LegalEntity)
            .unwrap()
            .id;
        for dissolved in [false, true] {
            let unit = Uuid::new_v4();
            sqlx::query("INSERT INTO org_units (org_id,id) VALUES ($1,$2)")
                .bind(w.org.as_uuid())
                .bind(unit)
                .execute(pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES ($1,$2,1,gen_random_uuid(),$3,$4,'{\"kind\":\"department\",\"status\":\"active\"}','{}')")
                .bind(w.org.as_uuid()).bind(unit).bind(tenant.as_uuid()).bind(vec![0u8;32]).execute(pool).await.unwrap();
            if dissolved {
                sqlx::query("INSERT INTO org_unit_placements (org_id,org_unit_id,legal_entity_id,workplace_id,valid_from,change_mode,command_id) VALUES ($1,$2,$3,$4,'2020-01-01','MIGRATION',gen_random_uuid())")
                    .bind(w.org.as_uuid()).bind(unit).bind(entity).bind(workplace).execute(pool).await.unwrap();
                sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) SELECT org_id,org_unit_id,version+1,gen_random_uuid(),actor_id,payload_digest,attributes || '{\"status\":\"dissolved\"}',receipt FROM org_unit_revisions WHERE org_id=$1 AND org_unit_id=$2")
                    .bind(w.org.as_uuid()).bind(unit).execute(pool).await.unwrap();
            }
            units.push(unit);
        }
        let mut people = Vec::new();
        let mut cases = Vec::new();
        for (i, unit) in [
            Some(units[0]),
            Some(units[1]),
            Some(units[2]),
            None,
            None,
            Some(units[2]),
        ]
        .into_iter()
        .enumerate()
        {
            let employee: Uuid = sqlx::query_scalar("INSERT INTO employees (org_id,company,name,employee_number,source_filename,source_sheet,source_row,source_key,org_unit_id,hire_date) VALUES ($1,'회사',$2,$2,'console','console',1,$2,$3,'2020-01-01') RETURNING id")
                .bind(w.org.as_uuid()).bind(format!("placement-{i}")).bind(unit).fetch_one(pool).await.unwrap();
            if i < 4 {
                sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,command_id) VALUES ($1,$2,$3,$4,'2020-01-01','MIGRATION',gen_random_uuid())")
                    .bind(w.org.as_uuid()).bind(employee).bind(entity).bind(workplace).execute(pool).await.unwrap();
            }
            let case = sqlx::query_scalar("INSERT INTO employee_exit_cases (org_id,employee_id,status,effective_exit_date,site_manager_note,reported_by) VALUES ($1,$2,'REPORTED',CURRENT_DATE+1,'검증',$3) RETURNING id")
                .bind(w.org.as_uuid()).bind(employee).bind(tenant.as_uuid()).fetch_one(pool).await.unwrap();
            people.push(employee);
            cases.push(case);
        }
        let readers = vec![
            (
                "tenant",
                principal(pool, w.org, tenant, false).await,
                people.clone(),
            ),
            (
                "workplace",
                principal(pool, w.org, scoped, false).await,
                people[..4].iter().chain(&people[5..]).copied().collect(),
            ),
            (
                "ops",
                Principal::new(
                    ops,
                    w.org,
                    BTreeSet::from([Role::SuperAdmin]),
                    BranchScope::All,
                )
                .with_tenant_ops(true),
                people.clone(),
            ),
        ];
        Self {
            org: w.org,
            people,
            cases,
            readers,
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn incomplete_placements_keep_list_point_count_facets_and_export_visible(pool: PgPool) {
    let f = Fixture::seed(&pool).await;
    let hr = HrService::new(runtime_role_pool(&pool).await);
    for (label, reader, expected) in f.readers {
        let expected: BTreeSet<_> = expected.into_iter().collect();
        let list = hr
            .list_employees(reader.clone(), EmployeeListQuery::default())
            .await
            .unwrap();
        assert_eq!(
            list.items.iter().map(|e| e.id).collect::<BTreeSet<_>>(),
            expected,
            "list: {label}"
        );
        assert_eq!(list.total, expected.len() as i64, "count: {label}");
        let facets = hr
            .employee_facets(reader.clone(), EmployeeListQuery::default())
            .await
            .unwrap();
        assert_eq!(facets.total, expected.len() as i64, "facets: {label}");
        assert_eq!(
            facets.status.iter().map(|s| s.count).sum::<i64>(),
            facets.total,
            "status facets: {label}"
        );
        for person in &expected {
            let point = hr.employee_detail(reader.clone(), *person).await.unwrap();
            assert_eq!(point.employee.id, *person, "point: {label}");
        }
        let (_, chunks) = hr
            .export_employees_csv(
                reader,
                EmployeeListQuery::default(),
                ExportPurposeQuery {
                    export_purpose: Some("INTERNAL_REVIEW".into()),
                    layout: None,
                },
            )
            .await
            .unwrap();
        let csv = chunks
            .map(|c| c.unwrap())
            .collect::<Vec<_>>()
            .await
            .concat();
        assert_eq!(
            csv.lines().count(),
            expected.len() + 1,
            "export count: {label}: {csv}"
        );
        for (i, person) in f.people.iter().enumerate() {
            assert_eq!(
                csv.contains(&format!("placement-{i}")),
                expected.contains(person),
                "export person {i}: {label}"
            );
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn incomplete_placements_keep_home_exit_work_visible(pool: PgPool) {
    let f = Fixture::seed(&pool).await;
    let runtime = runtime_role_pool(&pool).await;
    let now = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await
        .unwrap();
    for (label, reader, expected) in f.readers {
        let home = page(&runtime, &reader, query(now, 20), &Default::default())
            .await
            .unwrap();
        let cases: BTreeSet<_> = f
            .people
            .iter()
            .zip(&f.cases)
            .filter(|(id, _)| expected.contains(id))
            .map(|(_, id)| format!("hr_exit:{id}"))
            .collect();
        assert_eq!(
            home.items
                .iter()
                .map(|i| i.id.clone())
                .collect::<BTreeSet<_>>(),
            cases,
            "Home: {label}"
        );
        assert_eq!(home.total, expected.len(), "Home count: {label}");
        assert!(home.total_is_exact);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn incomplete_placements_keep_every_exit_action_visible(pool: PgPool) {
    let f = Fixture::seed(&pool).await;
    let runtime = runtime_role_pool(&pool).await;
    for (label, reader, expected) in f.readers {
        let mut tx = runtime.begin().await.unwrap();
        world::arm(&mut tx, f.org).await;
        for employee in &f.people {
            for feature in [
                Feature::EmployeeDirectoryRead,
                Feature::ExitCaseReport,
                Feature::ExitCaseHrConfirm,
                Feature::ExitCaseHqConfirm,
                Feature::ExitSettlementManage,
            ] {
                let result = authorize_hr_case(&mut tx, &reader, feature, None, *employee).await;
                assert_eq!(
                    result.is_ok(),
                    expected.contains(employee),
                    "{feature:?} for {employee}: {label}: {result:?}"
                );
            }
        }
        tx.rollback().await.unwrap();
    }
}
