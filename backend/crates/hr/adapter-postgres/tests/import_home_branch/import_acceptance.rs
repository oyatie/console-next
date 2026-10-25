// SPDX-License-Identifier: LicenseRef-Proprietary
use console_hr_adapter_postgres::directory::read_list::EmployeeListQuery;
use sqlx::PgPool;
use uuid::Uuid;

use super::shared::{setup_headquarters, stage_roster};
use crate::harness::importer;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn test_import_sheet_placing_people_sets_home_branch_and_clears_review_and_resolves_routing(
    pool: PgPool,
) {
    let i = importer(pool).await;
    let default_branch = i.f.branch;
    let _workplace = setup_headquarters(&i, default_branch).await;

    let (run, digest) = stage_roster(
        &i,
        "본사 명단",
        &[
            &["E-101", "김일", "2024-03-04", "정규직", "본사", "", "사원"],
            &["E-102", "김이", "2024-03-04", "정규직", "본사", "", "대리"],
            &["E-103", "김삼", "2024-03-04", "정규직", "본사", "", "과장"],
        ],
    )
    .await;

    let report = i.apply(run, &digest).await.unwrap();
    assert_eq!(report.inserted, 3);

    // 1. Each imported person has home_branch_id = 본사's default branch
    let branches: Vec<(String, Option<Uuid>)> = sqlx::query_as(
        "SELECT name, home_branch_id FROM employees WHERE org_id = $1 AND employee_number IN ('E-101', 'E-102', 'E-103') ORDER BY employee_number",
    )
    .bind(i.org())
    .fetch_all(&i.owner)
    .await
    .unwrap();

    assert_eq!(branches.len(), 3);
    for (name, branch) in &branches {
        assert_eq!(
            *branch,
            Some(default_branch),
            "employee {name} should have home_branch_id = {default_branch}"
        );
    }

    // 2. home_branch_review_required lists 0 of them
    let list_req = EmployeeListQuery {
        home_branch_review_required: Some(true),
        ..Default::default()
    };
    let review_list =
        i.f.hr
            .list_employees(i.f.principal.clone(), list_req)
            .await
            .unwrap();
    assert_eq!(
        review_list.total, 0,
        "home_branch_review_required list must have 0 employees, found {}",
        review_list.total
    );

    let facets =
        i.f.hr
            .employee_facets(i.f.principal.clone(), EmployeeListQuery::default())
            .await
            .unwrap();
    assert_eq!(
        facets.review.home_branch_review_required, 0,
        "home_branch_review_required facet count must be 0, found {}",
        facets.review.home_branch_review_required
    );

    // 3. Attendance/leave routing read for an imported person resolves the branch
    let e1: (Uuid, Option<Uuid>) = sqlx::query_as(
        "SELECT id, home_branch_id FROM employees WHERE org_id = $1 AND employee_number = 'E-101'",
    )
    .bind(i.org())
    .fetch_one(&i.owner)
    .await
    .unwrap();

    let mut tx = i.owner.begin().await.unwrap();
    sqlx::query("UPDATE users SET employee_id = $1 WHERE id = $2 AND org_id = $3")
        .bind(e1.0)
        .bind(*i.f.principal.user_id.as_uuid())
        .bind(i.org())
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let routing = console_platform_request_context::scope_org(
        i.f.principal.org_id,
        i.store.resolve_self_filing_context(i.f.principal.user_id),
    )
    .await
    .unwrap();
    assert_eq!(routing, (e1.0, default_branch));

    // HR detail exposes the same routing branch.
    let detail =
        i.f.hr
            .employee_detail(i.f.principal.clone(), e1.0)
            .await
            .unwrap();
    assert_eq!(
        detail.employee_home_branch_id(),
        Some(default_branch),
        "employee_detail must resolve home_branch_id"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn test_import_unplaced_keeps_home_branch_null_and_review_required(pool: PgPool) {
    let i = importer(pool).await;
    let default_branch = i.f.branch;
    let _workplace = setup_headquarters(&i, default_branch).await;

    let (run, digest) = stage_roster(
        &i,
        "미배치 명단",
        &[&["E-201", "미배치인", "2024-03-04", "정규직", "", "", "사원"]],
    )
    .await;

    let report = i.apply(run, &digest).await.unwrap();
    assert_eq!(report.inserted, 1);

    let branch: Option<Uuid> = sqlx::query_scalar(
        "SELECT home_branch_id FROM employees WHERE org_id = $1 AND employee_number = 'E-201'",
    )
    .bind(i.org())
    .fetch_one(&i.owner)
    .await
    .unwrap();
    assert_eq!(
        branch, None,
        "unplaced employee must keep NULL home_branch_id"
    );

    let list_req = EmployeeListQuery {
        home_branch_review_required: Some(true),
        ..Default::default()
    };
    let review_list =
        i.f.hr
            .list_employees(i.f.principal.clone(), list_req)
            .await
            .unwrap();
    assert_eq!(
        review_list.total, 1,
        "home_branch_review_required list must have 1 unplaced employee"
    );
}
