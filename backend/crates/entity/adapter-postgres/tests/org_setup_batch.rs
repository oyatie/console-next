#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! MR-12 (decisions #18), as `console_rt` with the canonical OrgUnit owner
//! behind the port: one 부서 kind nesting to any depth, setup batches with a
//! per-op version pin, move (people's 사업장 follow), dissolve, and the
//! go-live refusal.

mod common;

use common::*;
use console_entity_application::{CreateSetupOrgUnit, OrgParent, OrgSetupOp, RenameSetupOrgUnit};
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0B12);

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn one_department_kind_nests_at_any_depth_in_one_batch(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (_, [(hq, hq_site), _]) = two_workplaces(&store, &actor).await;
    let ops = vec![
        under_workplace("a", "생산본부", hq),
        under_ref("b", "생산부", "a"),
        under_ref("c", "생산1팀", "b"),
        under_ref("d", "A파트", "c"),
    ];
    let receipt = store
        .apply_org_setup_batch(&cmd(&actor), ops, port())
        .await
        .unwrap();
    assert_eq!(receipt.change_mode, "SETUP");
    assert_eq!(receipt.units.len(), 4);
    let ids: Vec<Uuid> = receipt.units.iter().map(|u| u.org_unit_id).collect();
    let mut parent = hq_site;
    for id in &ids {
        let (kind, status, p, version) = unit_head(&owner, *id).await;
        assert_eq!(
            (kind.as_str(), status.as_str(), version),
            ("department", "active", 1)
        );
        assert_eq!(p, Some(parent.to_string()));
        parent = *id;
    }
    // The tree shows four DEPARTMENT levels under the 사업장, each with its version.
    let tree = store.org_structure(&actor).await.unwrap();
    let wp = &tree.entities[0].children[0];
    assert_eq!(wp.org_unit_id, Some(hq_site));
    let mut node = &wp.children[0];
    for depth in 0..4 {
        assert_eq!(
            (node.kind, node.version),
            ("DEPARTMENT", Some(1)),
            "depth {depth}"
        );
        if depth < 3 {
            node = &node.children[0];
        }
    }

    // The single-unit route infers the level too; the retired TEAM is accepted.
    let team = store
        .create_setup_org_unit(
            &cmd(&actor),
            CreateSetupOrgUnit {
                name: Some("생산2팀".into()),
                kind: Some("TEAM".into()),
                workplace_id: None,
                parent_org_unit_id: Some(ids[1]),
            },
            port(),
        )
        .await
        .unwrap();
    assert_eq!(
        unit_head(&owner, team.units[0].org_unit_id).await.0,
        "department"
    );
    let bad = CreateSetupOrgUnit {
        name: Some("x".into()),
        kind: Some("SITE".into()),
        workplace_id: Some(hq),
        parent_org_unit_id: None,
    };
    let (code_, fields, _) = code(
        store
            .create_setup_org_unit(&cmd(&actor), bad, port())
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, fields),
        ("validation_failed", vec![("kind".into(), "invalid_choice")])
    );

    // Same name twice under one parent, a dangling ref, a move into its own subtree.
    for (op, field, want) in [
        (
            under_workplace("z", "생산본부", hq),
            "ops[0].name",
            "name_taken_in_parent",
        ),
        (
            under_ref("z", "x", "nope"),
            "ops[0].parent_ref",
            "unknown_ref",
        ),
        (
            OrgSetupOp::Move {
                org_unit_id: Some(ids[1]),
                expected_version: Some(1),
                parent: OrgParent {
                    parent_org_unit_id: Some(ids[3]),
                    ..OrgParent::default()
                },
            },
            "ops[0].parent_org_unit_id",
            "move_into_own_subtree",
        ),
    ] {
        let (_, fields, _) = code(
            store
                .apply_org_setup_batch(&cmd(&actor), vec![op], port())
                .await
                .unwrap_err(),
        );
        assert_eq!(fields, vec![(field.to_owned(), want)]);
    }

    // A replayed command answers with the same receipt and writes nothing.
    let again = cmd(&actor);
    let ops = vec![under_workplace("e", "품질부", hq)];
    let first = store
        .apply_org_setup_batch(&again, ops.clone(), port())
        .await
        .unwrap();
    let replayed = store
        .apply_org_setup_batch(&again, ops, port())
        .await
        .unwrap();
    assert_eq!(
        (first.batch_id, &first.units),
        (replayed.batch_id, &replayed.units)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn ops_are_pinned_moves_carry_people_and_dissolve_needs_an_empty_subtree(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (entity, [(hq, _), (plant, plant_site)]) = two_workplaces(&store, &actor).await;
    let ops = vec![
        under_workplace("a", "생산부", hq),
        under_ref("b", "생산1팀", "a"),
    ];
    let made = store
        .apply_org_setup_batch(&cmd(&actor), ops, port())
        .await
        .unwrap();
    let (dept, team) = (made.units[0].org_unit_id, made.units[1].org_unit_id);
    let kim = person(&owner, &store, &actor, (entity, hq, team), "k1").await;

    // A stale pin is a per-op 409 naming the op.
    let rename = |v| OrgSetupOp::Rename {
        org_unit_id: Some(dept),
        expected_version: Some(v),
        name: Some("제조부".into()),
    };
    store
        .apply_org_setup_batch(&cmd(&actor), vec![rename(1)], port())
        .await
        .unwrap();
    let err = store
        .apply_org_setup_batch(&cmd(&actor), vec![rename(1)], port())
        .await
        .unwrap_err();
    let (code_, fields, remedy) = code(err);
    assert_eq!(code_, "stale_revision");
    assert_eq!(
        fields,
        vec![("ops[0].expected_version".into(), "stale_revision")]
    );
    assert_eq!(remedy, Some("reload_and_reapply"));
    // A batch op without a pin is refused; the legacy route may omit it.
    let unpinned = OrgSetupOp::Rename {
        org_unit_id: Some(dept),
        expected_version: None,
        name: Some("x".into()),
    };
    let (_, fields, _) = code(
        store
            .apply_org_setup_batch(&cmd(&actor), vec![unpinned], port())
            .await
            .unwrap_err(),
    );
    assert_eq!(fields, vec![("ops[0].expected_version".into(), "required")]);

    // Moving the 부서 to the 공장 moves its people's 사업장 placement with it.
    let to_plant = RenameSetupOrgUnit {
        name: None,
        expected_version: Some(2),
        parent: OrgParent {
            workplace_id: Some(plant),
            ..OrgParent::default()
        },
    };
    let moved = store
        .rename_setup_org_unit(&cmd(&actor), dept, to_plant, port())
        .await
        .unwrap();
    assert_eq!(moved.units[0].version, 3);
    assert_eq!(
        unit_head(&owner, dept).await.2,
        Some(plant_site.to_string())
    );
    assert_eq!(placed_at(&owner, kim).await, plant);
    let superseded: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employment_assignments WHERE employee_id = $1 AND superseded_at IS NOT NULL AND workplace_id = $2",
    )
    .bind(kim)
    .bind(hq)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(superseded, 1, "the old placement is kept, superseded");

    // Dissolve is refused while anyone who has not left is under the 부서 …
    let dissolve = OrgSetupOp::Dissolve {
        org_unit_id: Some(dept),
        expected_version: Some(3),
    };
    let (code_, _, remedy) = code(
        store
            .apply_org_setup_batch(&cmd(&actor), vec![dissolve.clone()], port())
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, remedy),
        ("org_unit_has_members", Some("move_people_first"))
    );
    // … and takes the whole empty subtree once they have.
    sqlx::query("UPDATE employees SET employment_status = 'EXITED' WHERE id = $1")
        .bind(kim)
        .execute(&owner)
        .await
        .unwrap();
    let gone = store
        .apply_org_setup_batch(&cmd(&actor), vec![dissolve], port())
        .await
        .unwrap();
    assert_eq!(
        gone.units.iter().map(|u| u.org_unit_id).collect::<Vec<_>>(),
        vec![team, dept],
        "deepest first"
    );
    assert_eq!(unit_head(&owner, dept).await.1, "dissolved");
    assert_eq!(unit_head(&owner, team).await.1, "dissolved");

    // A 사업장's own unit is changed through the 사업장.
    let site_op = OrgSetupOp::Dissolve {
        org_unit_id: Some(plant_site),
        expected_version: Some(1),
    };
    let (code_, _, _) = code(
        store
            .apply_org_setup_batch(&cmd(&actor), vec![site_op], port())
            .await
            .unwrap_err(),
    );
    assert_eq!(code_, "site_is_a_workplace");

    // After 운영 시작 the setup routes refuse and point at the governed path.
    set_operating(&owner, ORG).await;
    let late = vec![under_workplace("x", "신규부", hq)];
    let (code_, _, remedy) = code(
        store
            .apply_org_setup_batch(&cmd(&actor), late, port())
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, remedy),
        ("phase_not_setup", Some("submit_org_change"))
    );
}
