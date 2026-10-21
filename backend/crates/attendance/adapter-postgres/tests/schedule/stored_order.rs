//! 근태 lists 법인 › 사업장 › 부서 in the chart's stored order, never by name
//! (org-sibling-order): the 근무 일정 scope tree (and every picker built from
//! it) and the 일별 board's 사업장 › 부서 groups.

use super::support::{World, seed, world};

use console_attendance_adapter_postgres::BoardQuery;
use console_attendance_domain::schedule::Level;
use sqlx::PgPool;
use uuid::Uuid;

/// By name 서울 본사 sorts before 평택공장 and 가공부 before 생산부; the
/// stored order says the opposite at both levels. 황정우 moves to 가공부.
async fn ordered(owner: PgPool) -> (World, Uuid) {
    let w = world(owner).await;
    let site: Uuid = sqlx::query_scalar(
        "SELECT org_unit_id FROM org_unit_placements WHERE workplace_id = $1 AND represents_workplace",
    )
    .bind(w.workplaces[0])
    .fetch_one(&w.owner)
    .await
    .unwrap();
    let (org, admin, ga) = (w.org, w.admin, Uuid::new_v4());
    let (pyeongtaek, seoul, dept, moved) = (w.workplaces[0], w.workplaces[1], w.dept, w.people[1]);
    seed(
        &w.owner,
        format!(
            "UPDATE workplaces SET sort_order = 0 WHERE id = '{pyeongtaek}'; \
             UPDATE workplaces SET sort_order = 1 WHERE id = '{seoul}'; \
             INSERT INTO org_units (org_id, id) VALUES ('{org}', '{ga}'); \
             INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
             VALUES ('{org}', '{ga}', 1, gen_random_uuid(), '{admin}', decode(repeat('ab', 32), 'hex'), \
             '{{\"kind\": \"department\", \"name\": \"가공부\", \"status\": \"active\", \"parent_id\": \"{site}\"}}', '{{}}'); \
             INSERT INTO org_unit_positions (org_id, org_unit_id, position, updated_by) VALUES \
             ('{org}', '{dept}', 0, '{admin}'), ('{org}', '{ga}', 1, '{admin}'); \
             UPDATE employees SET org_unit_id = '{ga}' WHERE id = '{moved}';"
        ),
    )
    .await;
    (w, ga)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_schedule_tree_follows_the_stored_order(owner: PgPool) {
    let (w, ga) = ordered(owner).await;
    let tree = w.store.schedule_tree(&w.hr(), None).await.unwrap();
    let of = |kind: Level| -> Vec<Uuid> {
        tree.nodes
            .iter()
            .filter(|n| n.kind == kind)
            .map(|n| n.id)
            .collect()
    };
    assert_eq!(of(Level::Workplace), w.workplaces.to_vec());
    // Depth first: 생산부, its 생산1팀, then 가공부.
    assert_eq!(of(Level::Department), vec![w.dept, w.team, ga]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_day_board_groups_follow_the_stored_order(owner: PgPool) {
    let (w, ga) = ordered(owner).await;
    let board = w
        .store
        .day_board(&w.hr(), BoardQuery::default())
        .await
        .unwrap();
    let groups: Vec<(Option<Uuid>, Option<Uuid>)> = board
        .groups
        .iter()
        .map(|g| (g.workplace_id, g.unit_id))
        .collect();
    let [pyeongtaek, seoul] = w.workplaces;
    assert_eq!(
        groups,
        vec![
            (Some(pyeongtaek), Some(w.team)),
            (Some(pyeongtaek), Some(ga)),
            (Some(seoul), None),
        ]
    );
}
