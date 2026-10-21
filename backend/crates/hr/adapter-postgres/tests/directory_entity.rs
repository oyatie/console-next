#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! E-S3a: the directory list, detail, facets and org chart read 법인 and
//! 사업장 by id from the employee's employment assignment.

mod support;

use serde_json::json;
use sqlx::PgPool;
use support::{employee, principal, query, tenant, user};
use uuid::Uuid;

/// A MIGRATION-mode 법인 (needs_confirmation) with one revision named `label`.
async fn legal_entity(pool: &PgPool, org: Uuid, label: &str) -> Uuid {
    let id = Uuid::new_v4();
    seed(
        pool,
        &format!(
            "INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) \
             VALUES ('{org}', '{id}', true, 'MIGRATION'); \
             INSERT INTO legal_entity_revisions (org_id, legal_entity_id, version, command_id, \
               effective_from, name, display_name, change_mode, reason_code, payload_digest, \
               settings_snapshot) \
             VALUES ('{org}', '{id}', 1, gen_random_uuid(), '2020-01-01', '{label} 주식회사', \
               '{label}', 'MIGRATION', 'test', sha256('x'::bytea), '{{}}')"
        ),
    )
    .await;
    id
}

async fn workplace(pool: &PgPool, org: Uuid, entity: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    seed(
        pool,
        &format!(
            "INSERT INTO workplaces (org_id, id, legal_entity_id, needs_confirmation, \
             created_change_mode) VALUES ('{org}', '{id}', '{entity}', true, 'MIGRATION')"
        ),
    )
    .await;
    id
}

/// One assignment row; `superseded` rows must never count.
async fn assign(
    pool: &PgPool,
    org: Uuid,
    employee: Uuid,
    entity: Uuid,
    workplace: Option<Uuid>,
    (from, to): (&str, Option<&str>),
    superseded: bool,
) {
    let workplace = workplace.map_or("NULL".to_owned(), |id| format!("'{id}'"));
    let to = to.map_or("NULL".to_owned(), |date| format!("'{date}'"));
    let superseded = if superseded { "now()" } else { "NULL" };
    seed(
        pool,
        &format!(
            "INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, \
             workplace_id, valid_from, valid_to, cause, superseded_at, command_id) \
             VALUES ('{org}', '{employee}', '{entity}', {workplace}, '{from}', {to}, \
             'MIGRATION', {superseded}, gen_random_uuid())"
        ),
    )
    .await;
}

async fn seed(pool: &PgPool, sql: &str) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    // Test fixture SQL built from generated ids only.
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned()))
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn directory_reads_filter_count_and_group_by_entity_and_workplace_id(pool: PgPool) {
    let t = tenant(&pool).await;
    let ga = legal_entity(&pool, t.org, "가나").await;
    let da = legal_entity(&pool, t.org, "다라").await;
    let seoul = workplace(&pool, t.org, ga).await;
    let busan = workplace(&pool, t.org, da).await;
    let kim = employee(&pool, t.org, "Kim", "A-1", "ACTIVE").await;
    let lee = employee(&pool, t.org, "Lee", "A-2", "EXITED").await;
    let park = employee(&pool, t.org, "Park", "A-3", "ACTIVE").await;
    let choi = employee(&pool, t.org, "Choi", "A-4", "ACTIVE").await;
    let jung = employee(&pool, t.org, "Jung", "A-5", "ACTIVE").await;
    assign(
        &pool,
        t.org,
        kim,
        ga,
        Some(seoul),
        ("2020-01-01", None),
        false,
    )
    .await;
    // Exited: the last assignment still names the 법인.
    let last = ("2020-01-01", Some("2021-01-01"));
    assign(&pool, t.org, lee, da, None, last, false).await;
    // A remapped row is superseded; a transfer scheduled far ahead is not yet live.
    assign(&pool, t.org, park, ga, None, ("2020-01-01", None), true).await;
    let until_transfer = ("2020-01-01", Some("2999-01-01"));
    assign(&pool, t.org, park, da, Some(busan), until_transfer, false).await;
    assign(
        &pool,
        t.org,
        park,
        ga,
        Some(seoul),
        ("2999-01-01", None),
        false,
    )
    .await;
    // A pre-hire: only a future assignment.
    assign(
        &pool,
        t.org,
        jung,
        ga,
        Some(seoul),
        ("2999-01-01", None),
        false,
    )
    .await;
    let hr_user = user(&pool, t.org, None).await;
    let hr = || principal(t.org, hr_user);
    let ids = |page: &console_hr_adapter_postgres::directory::types::EmployeePage| {
        let mut ids = page.items.iter().map(|e| e.id).collect::<Vec<_>>();
        ids.sort();
        ids
    };
    let sorted = |mut ids: Vec<Uuid>| {
        ids.sort();
        ids
    };

    let page =
        t.hr.list_employees(hr(), query(json!({ "legal_entity_id": ga })))
            .await
            .unwrap();
    assert_eq!(ids(&page), sorted(vec![kim, jung]));
    let row = page.items.iter().find(|e| e.id == kim).unwrap();
    assert_eq!(
        (row.legal_entity_id, row.workplace_id),
        (Some(ga), Some(seoul))
    );
    let page =
        t.hr.list_employees(hr(), query(json!({ "legal_entity_id": da })))
            .await
            .unwrap();
    assert_eq!(ids(&page), sorted(vec![lee, park]));
    let page =
        t.hr.list_employees(hr(), query(json!({ "workplace_id": busan })))
            .await
            .unwrap();
    assert_eq!(ids(&page), vec![park]);
    let detail = t.hr.employee_detail(hr(), choi).await.unwrap();
    assert_eq!(detail.employee.legal_entity_id, None);

    let facets =
        t.hr.employee_facets(hr(), query(json!({ "legal_entity_id": ga })))
            .await
            .unwrap();
    let counts = |facets: &[console_hr_adapter_postgres::directory::read_facets::FacetCount]| {
        facets
            .iter()
            .map(|facet| (facet.value.clone(), facet.count))
            .collect::<Vec<_>>()
    };
    let mut by_entity = counts(&facets.legal_entity);
    by_entity.sort();
    let mut expected = vec![
        (Some(ga.to_string()), 2),
        (Some(da.to_string()), 2),
        (None, 1),
    ];
    expected.sort();
    assert_eq!(by_entity, expected);
    assert_eq!(facets.total, 2);
    let mut by_workplace = counts(&facets.workplace);
    by_workplace.sort();
    assert_eq!(by_workplace, vec![(Some(seoul.to_string()), 2)]);

    let chart = t.hr.org_chart(hr()).await.unwrap();
    let group = |id: Option<Uuid>| {
        let group = chart
            .companies
            .iter()
            .find(|company| company.legal_entity_id == id)
            .unwrap();
        (group.company.as_str(), group.total)
    };
    assert_eq!(group(Some(ga)), ("가나 주식회사", 2));
    assert_eq!(group(Some(da)), ("다라 주식회사", 2));
    assert_eq!(group(None), ("Test", 1));
}
