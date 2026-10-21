#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! One stored order per sibling set (org-sibling-order): the tenant's 법인
//! reorder like 사업장 and 부서, every read shows it, a stale order is 409
//! `children_changed` (no lost reorder), and a moved 부서 lands last.

mod common;

use common::*;
use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::{Actor, OrgParent, OrgSetupOp, ReorderStructure, StructureParent};
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0C61);

/// The 법인 order as the 법인 list and the 조직도 read it.
async fn listed(store: &PgEntityStore, actor: &Actor) -> (Vec<Uuid>, Vec<Uuid>) {
    let list = store
        .list_entities(actor, false)
        .await
        .unwrap()
        .iter()
        .map(|e| e.id)
        .collect();
    let tree = store
        .org_structure(actor)
        .await
        .unwrap()
        .entities
        .iter()
        .map(|e| e.id)
        .collect();
    (list, tree)
}

fn tenant_order(children: Vec<Uuid>, expected: Option<Vec<Uuid>>) -> ReorderStructure {
    ReorderStructure {
        parent: StructureParent::default(),
        children,
        expected_children: expected,
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_tenants_entities_reorder_and_every_read_shows_it(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "O").await;
    let (first, _) = two_workplaces(&store, &actor).await;
    let second = store
        .create_entity(&cmd(&actor), corporation("주식회사 다라", "000111-0000013"))
        .await
        .unwrap()
        .record
        .id;
    // Creation order until an order is given.
    assert_eq!(
        listed(&store, &actor).await,
        (vec![first, second], vec![first, second])
    );

    // A partial set or a stale order is refused and writes nothing.
    let partial = store
        .reorder_structure(&cmd(&actor), tenant_order(vec![second], None))
        .await
        .unwrap_err();
    assert_eq!(code(partial).0, "children_changed");
    let stale = store
        .reorder_structure(
            &cmd(&actor),
            tenant_order(vec![second, first], Some(vec![second, first])),
        )
        .await
        .unwrap_err();
    assert_eq!(code(stale).0, "children_changed");
    assert_eq!(listed(&store, &actor).await.0, vec![first, second]);

    // Two parents named at once are refused.
    let both = ReorderStructure {
        parent: StructureParent {
            legal_entity_id: Some(first),
            workplace_id: Some(Uuid::new_v4()),
            ..StructureParent::default()
        },
        children: vec![],
        expected_children: None,
    };
    let both = store
        .reorder_structure(&cmd(&actor), both)
        .await
        .unwrap_err();
    assert_eq!(
        code(both).1,
        vec![("legal_entity_id".to_owned(), "one_parent_required")]
    );

    // The order read is the precondition: it applies, in either phase.
    set_operating(&owner, ORG).await;
    let saved = store
        .reorder_structure(
            &cmd(&actor),
            tenant_order(vec![second, first], Some(vec![first, second])),
        )
        .await
        .unwrap();
    assert_eq!(
        (saved.children.clone(), saved.change_mode.as_str()),
        (vec![second, first], "GOVERNED")
    );
    assert_eq!(
        listed(&store, &actor).await,
        (vec![second, first], vec![second, first])
    );
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action = 'org_structure.reorder' AND target_type = 'tenant'",
    )
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(audited, 1);

    // A reorder from the order before it (another person's stale view) loses nothing.
    let lost = store
        .reorder_structure(
            &cmd(&actor),
            tenant_order(vec![first, second], Some(vec![first, second])),
        )
        .await
        .unwrap_err();
    assert_eq!(code(lost).0, "children_changed");
    assert_eq!(listed(&store, &actor).await.0, vec![second, first]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_moved_department_lands_last_among_its_new_siblings(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "M").await;
    let (_, [(hq, _), (plant, _)]) = two_workplaces(&store, &actor).await;
    let receipt = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![
                under_workplace("a", "가부", hq),
                under_workplace("b", "나부", hq),
                under_workplace("c", "다부", plant),
                under_workplace("d", "라부", plant),
            ],
            port(),
        )
        .await
        .unwrap();
    let [a, b, c, d] = [0, 1, 2, 3].map(|i| receipt.units[i].org_unit_id);
    // 가부 sat first in 본사 (position 0); moved to 공장 it goes after 다부, 라부.
    store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![OrgSetupOp::Move {
                org_unit_id: Some(a),
                expected_version: Some(1),
                parent: OrgParent {
                    workplace_id: Some(plant),
                    ..OrgParent::default()
                },
            }],
            port(),
        )
        .await
        .unwrap();
    let tree = store.org_structure(&actor).await.unwrap();
    let kids = |i: usize| {
        tree.entities[0].children[i]
            .children
            .iter()
            .map(|n| n.id)
            .collect::<Vec<_>>()
    };
    assert_eq!((kids(0), kids(1)), (vec![b], vec![c, d, a]));
}

/// A 사업장 close plan lists its 부서 as the chart does: stored order (not
/// name), each 부서 followed by those under it.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_close_plan_lists_departments_in_the_charts_order(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "P").await;
    let (_, [(hq, site), _]) = two_workplaces(&store, &actor).await;
    let receipt = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![
                under_workplace("a", "나부", hq),
                under_workplace("b", "가부", hq),
                under_ref("a1", "나부1팀", "a"),
            ],
            port(),
        )
        .await
        .unwrap();
    let [a, b, a1] = [0, 1, 2].map(|i| receipt.units[i].org_unit_id);
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(ORG.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    let units = console_entity_adapter_postgres::workplace_close_plan::units_under(&mut tx, site)
        .await
        .unwrap();
    let ids: Vec<Uuid> = units.iter().map(|u| u.org_unit_id).collect();
    assert_eq!(ids, vec![a, a1, b]);
}

/// A 부서 left at the tenant root (a legacy or migrated unit no 사업장 holds)
/// follows the same sibling rule: its stored 순서 first, never only the name.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unplaced_departments_follow_the_stored_order(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "O").await;
    let (na, ga, da) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let user = actor.user.as_uuid();
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    for (id, name, position) in [
        (na, "나부", Some(0)),
        (ga, "가부", Some(1)),
        (da, "다부", None),
    ] {
        sqlx::query("INSERT INTO org_units (org_id, id) VALUES ($1, $2)")
            .bind(ORG)
            .bind(id)
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO org_unit_revisions (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
             VALUES ($1, $2, 1, gen_random_uuid(), $3, decode(repeat('ab', 32), 'hex'), \
             jsonb_build_object('kind', 'department', 'name', $4::text, 'status', 'active'), '{}')",
        )
        .bind(ORG)
        .bind(id)
        .bind(user)
        .bind(name)
        .execute(tx.as_mut())
        .await
        .unwrap();
        if let Some(position) = position {
            sqlx::query("INSERT INTO org_unit_positions (org_id, org_unit_id, position, updated_by) VALUES ($1, $2, $3, $4)")
                .bind(ORG)
                .bind(id)
                .bind(position)
                .bind(user)
                .execute(tx.as_mut())
                .await
                .unwrap();
        }
    }
    tx.commit().await.unwrap();
    let unplaced: Vec<Uuid> = store
        .org_structure(&actor)
        .await
        .unwrap()
        .unplaced
        .iter()
        .map(|n| n.id)
        .collect();
    assert_eq!(unplaced, vec![na, ga, da]);
}
