// SPDX-License-Identifier: LicenseRef-Proprietary
//! Scope defaults and actual unscheduled populations share the ledger's resolver.

use super::support::{assign, key, office, seed, today, world};
use console_attendance_adapter_postgres::BoardQuery;
use console_attendance_domain::schedule::Level;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

fn node(tree: &Value, id: Uuid) -> &Value {
    tree["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == id.to_string())
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_scope_count_opens_exactly_its_unscheduled_subtree(owner: PgPool) {
    let w = world(owner).await;
    let (org, sibling, team, person, wp) =
        (w.org, Uuid::new_v4(), w.team, w.people[2], w.workplaces[0]);
    seed(&w.owner, format!(
        "INSERT INTO org_units (org_id, id) VALUES ('{org}', '{sibling}');
         INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt)
         SELECT org_id, '{sibling}', 1, gen_random_uuid(), actor_id, payload_digest,
           attributes || jsonb_build_object('name', '생산2팀'), receipt FROM org_unit_revisions WHERE org_unit_id = '{team}';
         UPDATE employees SET org_unit_id = '{sibling}' WHERE id = '{person}';
         UPDATE employment_assignments SET workplace_id = '{wp}' WHERE employee_id = '{person}';"
    )).await;
    let tree = w.store.schedule_tree(&w.hr(), None).await.unwrap();
    for n in tree
        .nodes
        .iter()
        .filter(|n| matches!(n.kind, Level::Workplace | Level::Department))
    {
        // Read the actual link fields, so a missing workplace is a regression too.
        let json = serde_json::to_value(n).unwrap();
        let workplace_id = if n.kind == Level::Workplace {
            Some(n.id)
        } else {
            json["workplace_id"]
                .as_str()
                .map(|s| Uuid::parse_str(s).unwrap())
        };
        let board = w
            .store
            .day_board(
                &w.hr(),
                BoardQuery {
                    date: Some(tree.date),
                    workplace_id,
                    unit_id: (n.kind == Level::Department).then_some(n.id),
                    no_schedule_only: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            usize::try_from(n.unscheduled).unwrap(),
            board.groups.iter().map(|g| g.rows.len()).sum::<usize>(),
            "{}",
            n.name
        );
        if n.kind == Level::Department {
            // The board's existing unit-only group links use the same subtree filter.
            let unit_only = w
                .store
                .day_board(
                    &w.hr(),
                    BoardQuery {
                        date: Some(tree.date),
                        unit_id: Some(n.id),
                        no_schedule_only: true,
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            assert_eq!(
                usize::try_from(n.unscheduled).unwrap(),
                unit_only.groups.iter().map(|g| g.rows.len()).sum::<usize>()
            );
        }
    }
    for n in tree.nodes.iter().filter(|n| n.kind == Level::Department) {
        assert_eq!(
            serde_json::to_value(n).unwrap()["workplace_id"],
            wp.to_string(),
            "{}",
            n.name
        );
    }
    let compact = w
        .store
        .day_board(
            &w.hr(),
            BoardQuery {
                date: Some(tree.date),
                unit_id: Some(team),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        compact.ledger.people, 3,
        "unit still expands the compact board without filtering it"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tree_defaults_and_unscheduled_counts_follow_each_scope_chain(owner: PgPool) {
    let w = world(owner).await;
    let sibling = Uuid::new_v4();
    let (org, admin, entity, wp, team, dept, direct) = (
        w.org,
        w.admin,
        w.entity,
        w.workplaces[0],
        w.team,
        w.dept,
        w.people[2],
    );
    seed(&w.owner, format!(
        "INSERT INTO org_units (org_id, id) VALUES ('{org}', '{sibling}');
         INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt)
         SELECT org_id, '{sibling}', 1, gen_random_uuid(), actor_id, payload_digest,
           attributes || jsonb_build_object('name', '생산2팀'), receipt FROM org_unit_revisions WHERE org_unit_id = '{team}';
         UPDATE employment_assignments SET workplace_id = '{wp}' WHERE employee_id = '{direct}';
         WITH added AS (
           INSERT INTO employees (id, org_id, company, name, position, source_filename, source_sheet, source_row, source_key,
             hire_date, hire_on, employee_number, org_unit_id, employment_status)
           SELECT gen_random_uuid(), '{org}', 'Co', '추가' || n, '사원', 'console', 'console', n, 'tree-' || n,
             '2020-01-02', '2020-01-02', 'TREE-' || n, '{sibling}', 'ACTIVE' FROM generate_series(1, 3) n RETURNING id
         ) INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, cause, actor_id, command_id)
           SELECT '{org}', id, '{entity}', '{wp}', '2020-01-02', 'HIRE', '{admin}', gen_random_uuid() FROM added;"
    )).await;
    let (p, _) = w
        .store
        .create_pattern(&w.hr(), &key(), office("팀 일정"))
        .await
        .unwrap();
    w.store
        .assign_schedule(
            &w.hr(),
            &key(),
            assign(Level::Department, team, p.id, today()),
        )
        .await
        .unwrap();
    let tree = serde_json::to_value(w.store.schedule_tree(&w.hr(), None).await.unwrap()).unwrap();
    assert_eq!(
        (
            tree["people_total"].as_i64(),
            tree["people_unscheduled"].as_i64()
        ),
        (Some(6), Some(4))
    );
    assert_eq!(
        node(&tree, team)["effective"]["pattern_id"],
        p.id.to_string()
    );
    assert_eq!(node(&tree, team)["effective"]["from"], "DEPARTMENT");
    assert_eq!(node(&tree, team)["unscheduled"], 0);
    assert_eq!(node(&tree, sibling)["effective"], Value::Null);
    assert_eq!(node(&tree, sibling)["unscheduled"], 3);
    assert_eq!(node(&tree, dept)["unscheduled"], 3);
    assert_eq!(node(&tree, wp)["unscheduled"], 4);
    assert_eq!(node(&tree, entity)["unscheduled"], 4);
    let root_total: i64 = tree["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| n["parent_id"].is_null())
        .map(|n| n["unscheduled"].as_i64().unwrap())
        .sum();
    assert_eq!(tree["people_unscheduled"], root_total);

    let (q, _) = w
        .store
        .create_pattern(&w.hr(), &key(), office("법인 일정"))
        .await
        .unwrap();
    w.store
        .assign_schedule(
            &w.hr(),
            &key(),
            assign(Level::LegalEntity, entity, q.id, today()),
        )
        .await
        .unwrap();
    let tree = serde_json::to_value(w.store.schedule_tree(&w.hr(), None).await.unwrap()).unwrap();
    assert_eq!(
        node(&tree, sibling)["effective"]["pattern_id"],
        q.id.to_string()
    );
    assert_eq!(node(&tree, sibling)["effective"]["from"], "LEGAL_ENTITY");
    assert_eq!(node(&tree, sibling)["layer"], Value::Null);
    assert_eq!(node(&tree, sibling)["unscheduled"], 0);
    assert_eq!(
        node(&tree, team)["effective"]["pattern_id"],
        p.id.to_string()
    );
    assert_eq!(tree["people_unscheduled"], 0);
    // The date and caller's scope also govern every node's value and count.
    let past = serde_json::to_value(
        w.store
            .schedule_tree(&w.hr(), Some(today().previous_day().unwrap()))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(node(&past, team)["effective"], Value::Null);
    assert_eq!(node(&past, entity)["unscheduled"], 6);
    let scoped =
        serde_json::to_value(w.store.schedule_tree(&w.seoul_hr(), None).await.unwrap()).unwrap();
    assert_eq!(scoped["people_total"], 0);
    assert_eq!(node(&scoped, entity)["unscheduled"], 0);
    assert!(
        !scoped["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["id"] == wp.to_string())
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn one_tree_read_counts_two_thousand_people_without_loading_client_rows(owner: PgPool) {
    let w = world(owner).await;
    let (org, admin, entity, wp, team) = (w.org, w.admin, w.entity, w.workplaces[0], w.team);
    seed(&w.owner, format!(
        "WITH added AS (
           INSERT INTO employees (id, org_id, company, name, position, source_filename, source_sheet, source_row, source_key,
             hire_date, hire_on, employee_number, org_unit_id, employment_status)
           SELECT gen_random_uuid(), '{org}', 'Co', '규모' || n, '사원', 'console', 'console', n, 'scale-' || n,
             '2020-01-02', '2020-01-02', 'SCALE-' || n, '{team}', 'ACTIVE' FROM generate_series(1, 1997) n RETURNING id
         ) INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, cause, actor_id, command_id)
           SELECT '{org}', id, '{entity}', '{wp}', '2020-01-02', 'HIRE', '{admin}', gen_random_uuid() FROM added;"
    )).await;
    let started = std::time::Instant::now();
    let tree = serde_json::to_value(w.store.schedule_tree(&w.hr(), None).await.unwrap()).unwrap();
    eprintln!("schedule_tree 2000 people: {:?}", started.elapsed());
    assert_eq!(tree["people_total"], 2000);
    assert_eq!(tree["people_unscheduled"], 2000);
    assert_eq!(node(&tree, entity)["unscheduled"], 2000);
    assert_eq!(node(&tree, wp)["unscheduled"], 1999);
    assert_eq!(node(&tree, team)["unscheduled"], 1999);
    assert!(tree["nodes"].as_array().unwrap().len() < 10);
    assert_eq!(node(&tree, team)["effective"], json!(null));
}
