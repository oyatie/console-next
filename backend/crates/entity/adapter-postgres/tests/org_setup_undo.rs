#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! MR-12 undo (design OM §3.5, §5.4), as `console_rt`: a setup 부서 batch
//! is undone through the same writer (a move back takes people's 사업장
//! back), never blindly (later changes first), and only in setup. Plus the
//! 0262 data step that folds legacy `team` units into the one 부서 kind.

mod common;

use common::*;
use console_entity_application::{OrgParent, OrgSetupOp};
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0B13);

fn create(r: &str, name: &str, parent: OrgParent) -> OrgSetupOp {
    OrgSetupOp::Create {
        client_ref: Some(r.into()),
        name: Some(name.into()),
        parent,
        code: None,
        head_employee_id: None,
    }
}

fn at(workplace: Uuid) -> OrgParent {
    OrgParent {
        workplace_id: Some(workplace),
        ..OrgParent::default()
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn undo_reverts_a_batch_once_last_in_first_out_and_only_in_setup(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (entity, [(hq, hq_site), (plant, _)]) = two_workplaces(&store, &actor).await;

    // Batch 1 creates two levels; batch 2 moves the top one to the 공장.
    let b1 = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![
                create("a", "생산부", at(hq)),
                create(
                    "b",
                    "생산1팀",
                    OrgParent {
                        parent_ref: Some("a".into()),
                        ..OrgParent::default()
                    },
                ),
            ],
            port(),
        )
        .await
        .unwrap();
    let (dept, team) = (b1.units[0].org_unit_id, b1.units[1].org_unit_id);
    let kim = person(&owner, &store, &actor, (entity, hq, team), "k1").await;
    let mv = OrgSetupOp::Move {
        org_unit_id: Some(dept),
        expected_version: Some(1),
        parent: at(plant),
    };
    let b2 = store
        .apply_org_setup_batch(&cmd(&actor), vec![mv], port())
        .await
        .unwrap();
    assert_eq!(placed_at(&owner, kim).await, plant);

    // Batch 1 cannot go first: 생산부 changed after it.
    let (code_, fields, remedy) = code(
        store
            .undo_org_setup_batch(&cmd(&actor), b1.batch_id, port())
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, remedy),
        ("undo_conflict", Some("undo_later_batches_first"))
    );
    assert_eq!(fields, vec![(dept.to_string(), "changed_since_batch")]);

    // Undoing batch 2 moves 생산부 back, and 김직원's 사업장 with it.
    let undo2 = store
        .undo_org_setup_batch(&cmd(&actor), b2.batch_id, port())
        .await
        .unwrap();
    assert_eq!(undo2.units.len(), 1);
    assert_eq!(unit_head(&owner, dept).await.2, Some(hq_site.to_string()));
    assert_eq!(placed_at(&owner, kim).await, hq);
    let (code_, _, _) = code(
        store
            .undo_org_setup_batch(&cmd(&actor), b2.batch_id, port())
            .await
            .unwrap_err(),
    );
    assert_eq!(code_, "batch_already_undone");
    let (code_, _, _) = code(
        store
            .undo_org_setup_batch(&cmd(&actor), undo2.batch_id, port())
            .await
            .unwrap_err(),
    );
    assert_eq!(code_, "batch_not_undoable");

    // Batch 1 created 생산1팀, which holds 김직원 now: it stays.
    let (code_, _, remedy) = code(
        store
            .undo_org_setup_batch(&cmd(&actor), b1.batch_id, port())
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, remedy),
        ("undo_unit_in_use", Some("move_people_first"))
    );
    // Once 김직원 sits at the 사업장 itself, batch 1 undoes: the move was
    // undone, so 생산부 holds what batch 1 left (LIFO), children first.
    sqlx::query("UPDATE employees SET org_unit_id = $2 WHERE id = $1")
        .bind(kim)
        .bind(hq_site)
        .execute(&owner)
        .await
        .unwrap();
    let undo1 = store
        .undo_org_setup_batch(&cmd(&actor), b1.batch_id, port())
        .await
        .unwrap();
    assert_eq!(
        undo1
            .units
            .iter()
            .map(|u| u.org_unit_id)
            .collect::<Vec<_>>(),
        vec![team, dept]
    );
    assert_eq!(unit_head(&owner, dept).await.1, "dissolved");
    assert_eq!(placed_at(&owner, kim).await, hq);

    // Another two-level batch undoes the same way.
    let b3 = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![
                create("c", "품질부", at(hq)),
                create(
                    "d",
                    "품질1팀",
                    OrgParent {
                        parent_ref: Some("c".into()),
                        ..OrgParent::default()
                    },
                ),
            ],
            port(),
        )
        .await
        .unwrap();
    let undo3 = store
        .undo_org_setup_batch(&cmd(&actor), b3.batch_id, port())
        .await
        .unwrap();
    let order: Vec<Uuid> = undo3.units.iter().map(|u| u.org_unit_id).collect();
    assert_eq!(
        order,
        vec![b3.units[1].org_unit_id, b3.units[0].org_unit_id]
    );
    for u in &b3.units {
        assert_eq!(unit_head(&owner, u.org_unit_id).await.1, "dissolved");
    }
    let list = store.list_org_setup_batches(&actor).await.unwrap();
    let row = list.iter().find(|b| b.id == b3.batch_id).unwrap();
    assert_eq!((row.undoable, row.undone_by), (false, Some(undo3.batch_id)));
    assert!(
        !list
            .iter()
            .find(|b| b.id == undo3.batch_id)
            .unwrap()
            .undoable,
        "an undo is not undone"
    );

    // A dissolve undone restores the parent before the child.
    let b4 = store
        .apply_org_setup_batch(&cmd(&actor), vec![create("e", "물류부", at(hq))], port())
        .await
        .unwrap();
    let logistics = b4.units[0].org_unit_id;
    let child = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![create(
                "f",
                "물류1팀",
                OrgParent {
                    parent_org_unit_id: Some(logistics),
                    ..OrgParent::default()
                },
            )],
            port(),
        )
        .await
        .unwrap()
        .units[0]
        .org_unit_id;
    let gone = OrgSetupOp::Dissolve {
        org_unit_id: Some(logistics),
        expected_version: Some(1),
    };
    let b5 = store
        .apply_org_setup_batch(&cmd(&actor), vec![gone], port())
        .await
        .unwrap();
    store
        .undo_org_setup_batch(&cmd(&actor), b5.batch_id, port())
        .await
        .unwrap();
    assert_eq!(unit_head(&owner, logistics).await.1, "active");
    assert_eq!(unit_head(&owner, child).await.1, "active");

    // After 운영 시작 nothing is undone, and the list stops offering it.
    set_operating(&owner, ORG).await;
    let (code_, _, remedy) = code(
        store
            .undo_org_setup_batch(&cmd(&actor), b4.batch_id, port())
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, remedy),
        ("phase_not_setup", Some("submit_org_change"))
    );
    assert!(
        store
            .list_org_setup_batches(&actor)
            .await
            .unwrap()
            .iter()
            .all(|b| !b.undoable)
    );
}

/// The data step of `migrations/0297_org_unit_one_department_kind.sql`, run
/// again over legacy `team` heads written after the migrator ran.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_team_units_become_departments_keeping_their_history(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (_, [(hq, _), _]) = two_workplaces(&store, &actor).await;
    let dept = store
        .apply_org_setup_batch(&cmd(&actor), vec![create("a", "생산부", at(hq))], port())
        .await
        .unwrap()
        .units[0]
        .org_unit_id;
    let team: Uuid = sqlx::query_scalar("INSERT INTO org_units (org_id) VALUES ($1) RETURNING id")
        .bind(ORG)
        .fetch_one(&owner)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
         VALUES ($1, $2, 1, gen_random_uuid(), $3, $4, $5, '{}'::jsonb)",
    )
    .bind(ORG)
    .bind(team)
    .bind(*actor.user.as_uuid())
    .bind([0_u8; 32].as_slice())
    .bind(serde_json::json!({ "name": "생산1팀", "kind": "team", "status": "active", "parent_id": dept.to_string() }))
    .execute(&owner)
    .await
    .unwrap();
    let sql = include_str!("../../../platform/db/migrations/0297_org_unit_one_department_kind.sql");
    let step = &sql[sql.find("DO $$").unwrap()..sql.find("END $$;").unwrap() + "END $$;".len()];
    sqlx::raw_sql(step).execute(&owner).await.unwrap();
    sqlx::raw_sql(step).execute(&owner).await.unwrap(); // idempotent
    let (kind, status, parent, version) = unit_head(&owner, team).await;
    assert_eq!(
        (kind.as_str(), status.as_str(), version),
        ("department", "active", 2)
    );
    assert_eq!(parent, Some(dept.to_string()));
    let history: i64 = sqlx::query_scalar("SELECT count(*) FROM org_unit_revisions WHERE org_unit_id = $1 AND attributes->>'kind' = 'team'")
        .bind(team)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(history, 1, "the team revision stays as history");
    // The relabelled unit takes setup ops like any 부서.
    let rename = OrgSetupOp::Rename {
        org_unit_id: Some(team),
        expected_version: Some(2),
        name: Some("조립팀".into()),
    };
    store
        .apply_org_setup_batch(&cmd(&actor), vec![rename], port())
        .await
        .unwrap();
}
