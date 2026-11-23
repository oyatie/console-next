// SPDX-License-Identifier: LicenseRef-Proprietary
use console_attendance_adapter_postgres::GridQuery;
use console_attendance_domain::schedule::Level;
use sqlx::PgPool;
use time::macros::date;

use super::support::{TestReads, assign, key, office, seed, world};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn month_grid_includes_position_work_pattern_summary_and_month_summary(owner: PgPool) {
    let w = world(owner).await;
    let title_id = uuid::Uuid::new_v4();
    seed(
        &w.owner,
        format!(
            "INSERT INTO job_titles (id, org_id, kind, label, grade_rank, active, created_by) \
             VALUES ('{title_id}', '{org}', 'POSITION', 'Lead', NULL, TRUE, '{admin}'); \
             UPDATE employees SET job_title_id = '{title_id}', position = 'fallback' WHERE id = '{p0}'; \
             UPDATE employees SET position = 'Senior Manager' WHERE id = '{p1}';",
            org = w.org,
            admin = w.admin,
            p0 = w.people[0],
            p1 = w.people[1],
        ),
    )
    .await;

    let (pattern, _) = w
        .store
        .create_pattern(&w.hr(), &key(), office("Office 09-18"))
        .await
        .unwrap();
    w.store
        .assign_schedule(
            &w.hr(),
            &key(),
            assign(
                Level::LegalEntity,
                w.entity,
                pattern.id,
                date!(2026 - 01 - 01),
            ),
        )
        .await
        .unwrap();

    let grid = w
        .store
        .month_grid(
            &w.hr(),
            GridQuery {
                month: "2026-06".to_owned(),
                limit: 50,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(grid.work_pattern_summary.as_deref(), Some("Office 09-18"));
    let summary = grid.summary.expect("month summary populated");
    assert!(summary.scheduled_days > 0);
    let r0 = grid
        .rows
        .iter()
        .find(|r| r.employee_id == w.people[0])
        .unwrap();
    assert_eq!(r0.position.as_deref(), Some("Lead"));
    let r1 = grid
        .rows
        .iter()
        .find(|r| r.employee_id == w.people[1])
        .unwrap();
    assert_eq!(r1.position.as_deref(), Some("Senior Manager"));

    // Cross-tenant isolation: another org cannot see this tenant's grid or positions.
    let mut foreign = w.hr();
    foreign.org_id = uuid::Uuid::new_v4();
    let empty_grid = w
        .store
        .month_grid(
            &foreign,
            GridQuery {
                month: "2026-06".to_owned(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(empty_grid.people_total, 0);
    assert!(empty_grid.rows.is_empty());
}
