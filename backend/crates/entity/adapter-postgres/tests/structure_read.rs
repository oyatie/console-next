#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The 회사 구조 read model and labels (spec D1, D2, D19; review R13, R15,
//! R16, R17), as `console_rt` with the canonical OrgUnit owner behind the
//! port: counts per node (직속, 미배치, 법인 미정, 파견·협력), 부서 코드 and a
//! dated 부서장 with 「(겸)」, 사업장 code, and sibling order of 사업장 and 부서.

mod common;

use common::*;
use console_entity_application::{
    OrgSetupOp, OrgStructureNode, ReorderStructure, SetWorkplaceCode, StructureParent, VoidRecord,
};
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0C51);

/// A person with no 부서 and no assignment (법인 미정 until placed).
async fn bare_person(owner: &PgPool, key: &str, unit: Option<Uuid>) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key, org_unit_id) \
         VALUES ($1, '주식회사 가나', $2, 'x', 'x', 1, $2, $3) RETURNING id",
    )
    .bind(ORG)
    .bind(key)
    .bind(unit)
    .fetch_one(owner)
    .await
    .unwrap()
}

async fn employment_type(owner: &PgPool, employee: Uuid, kind: &str, by: Uuid) {
    sqlx::query(
        "INSERT INTO employee_employment_profiles (employee_id, org_id, employment_type, phone_e164, base_pay, \
           idempotency_key, request_hash, created_by) \
         VALUES ($1, $2, $3, '+821012345678', 0, $1::text, repeat('0', 64), $4)",
    )
    .bind(employee)
    .bind(ORG)
    .bind(kind)
    .bind(by)
    .execute(owner)
    .await
    .unwrap();
}

/// A migrated person known to the 법인 but at no 사업장 (미배치).
async fn unplaced_at(owner: &PgPool, employee: Uuid, entity: Uuid) {
    sqlx::query(
        "INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, cause, command_id) \
         VALUES ($1, $2, $3, NULL, '2026-01-02', 'MIGRATION', gen_random_uuid())",
    )
    .bind(ORG)
    .bind(employee)
    .bind(entity)
    .execute(owner)
    .await
    .unwrap();
}

fn names(nodes: &[OrgStructureNode]) -> Vec<&str> {
    nodes.iter().map(|n| n.name.as_str()).collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_chart_reads_counts_codes_heads_and_order(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let user = *actor.user.as_uuid();
    let (entity, [(hq, hq_site), (plant, _)]) = two_workplaces(&store, &actor).await;
    let receipt = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![
                under_workplace("a", "생산부", hq),
                under_workplace("b", "가공부", hq),
                under_workplace("c", "나눔부", hq),
            ],
            port(),
        )
        .await
        .unwrap();
    let [made, cut, share] = [0, 1, 2].map(|i| receipt.units[i].org_unit_id);

    // Two in 생산부 (one 파견), one 사업장 직속, one 미배치, one 법인 미정.
    let worker = person(&owner, &store, &actor, (entity, hq, made), "p1").await;
    let dispatched = person(&owner, &store, &actor, (entity, hq, made), "p2").await;
    employment_type(&owner, dispatched, "DISPATCHED_IN", user).await;
    person(&owner, &store, &actor, (entity, hq, hq_site), "p3").await;
    let unplaced = bare_person(&owner, "p4", None).await;
    unplaced_at(&owner, unplaced, entity).await;
    bare_person(&owner, "p5", None).await;

    // 부서 코드 and a 부서장 from another 부서 (「(겸)」), in one setup batch.
    store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![OrgSetupOp::SetDetails {
                org_unit_id: Some(cut),
                expected_version: Some(1),
                code: Some("P-02".into()),
                head_employee_id: Some(worker),
            }],
            port(),
        )
        .await
        .unwrap();
    let taken = store
        .apply_org_setup_batch(
            &cmd(&actor),
            vec![OrgSetupOp::SetDetails {
                org_unit_id: Some(share),
                expected_version: Some(1),
                code: Some("P-02".into()),
                head_employee_id: None,
            }],
            port(),
        )
        .await
        .unwrap_err();
    assert_eq!(code(taken).1, vec![("ops[0].code".into(), "code_taken")]);

    // 사업장 code; a code a voided 사업장 held comes back with a warning.
    let set = |c: &str| SetWorkplaceCode {
        code: Some(c.into()),
    };
    store
        .set_workplace_code(&cmd(&actor), plant, set("W-2"))
        .await
        .unwrap();
    let clash = store
        .set_workplace_code(&cmd(&actor), hq, set("W-2"))
        .await
        .unwrap_err();
    assert_eq!(code(clash).1, vec![("code".into(), "code_taken")]);
    let bad = store
        .set_workplace_code(&cmd(&actor), hq, set("본사"))
        .await
        .unwrap_err();
    assert_eq!(code(bad).1, vec![("code".into(), "invalid_format")]);
    store
        .void_workplace(
            &cmd(&actor),
            plant,
            VoidRecord {
                reason_code: Some("MISTAKE".into()),
            },
            port(),
        )
        .await
        .unwrap();
    let saved = store
        .set_workplace_code(&cmd(&actor), hq, set("W-2"))
        .await
        .unwrap();
    assert_eq!(saved.record.code.as_deref(), Some("W-2"));
    assert_eq!(
        saved.warnings.iter().map(|w| w.code).collect::<Vec<_>>(),
        vec!["code_reused"]
    );

    // 부서 order: 나눔부 first; the versions setup batches pin do not move.
    let order = |children| ReorderStructure {
        parent: StructureParent {
            workplace_id: Some(hq),
            ..StructureParent::default()
        },
        children,
        expected_children: None,
    };
    let stale = store
        .reorder_structure(&cmd(&actor), order(vec![share, made]))
        .await
        .unwrap_err();
    assert_eq!(code(stale).0, "children_changed");
    let ghost = ReorderStructure {
        parent: StructureParent {
            org_unit_id: Some(Uuid::new_v4()),
            ..StructureParent::default()
        },
        children: vec![],
        expected_children: None,
    };
    let ghost = store
        .reorder_structure(&cmd(&actor), ghost)
        .await
        .unwrap_err();
    assert_eq!(code(ghost).0, "parent_not_found");
    store
        .reorder_structure(&cmd(&actor), order(vec![share, made, cut]))
        .await
        .unwrap();
    assert_eq!(unit_head(&owner, share).await.3, 1);

    let tree = store.org_structure(&actor).await.unwrap();
    assert_eq!(tree.entity_unknown_headcount, Some(1));
    let e = &tree.entities[0];
    // 법인 = 사업장 (3) + 미배치 (1); 파견 counted where they sit.
    assert_eq!(
        (e.headcount, e.direct_headcount, e.dispatched_headcount),
        (4, 1, 1)
    );
    let w = &e.children[0];
    assert_eq!(
        (
            w.code.as_deref(),
            w.headcount,
            w.direct_headcount,
            w.dispatched_headcount
        ),
        (Some("W-2"), 3, 1, 1)
    );
    assert_eq!(names(&w.children), vec!["나눔부", "생산부", "가공부"]);
    let made_node = &w.children[1];
    assert_eq!(
        (
            made_node.headcount,
            made_node.direct_headcount,
            made_node.dispatched_headcount
        ),
        (2, 2, 1)
    );
    let cut_node = &w.children[2];
    assert_eq!(cut_node.code.as_deref(), Some("P-02"));
    let head = cut_node.head.as_ref().unwrap();
    assert_eq!(
        (head.employee_id, head.name.as_deref(), head.concurrent),
        (worker, Some("김직원"), true)
    );
    assert!(head.since.is_some());
    assert!(made_node.head.is_none());

    // Undo of the details batch takes the code and the head away again.
    let batches = store.list_org_setup_batches(&actor).await.unwrap();
    let details = batches
        .iter()
        .find(|b| {
            b.undoable
                && b.units
                    .iter()
                    .any(|u| u.org_unit_id == cut && u.version == 2)
        })
        .unwrap();
    store
        .undo_org_setup_batch(&cmd(&actor), details.id, port())
        .await
        .unwrap();
    let tree = store.org_structure(&actor).await.unwrap();
    let cut_node = &tree.entities[0].children[0].children[2];
    assert_eq!(
        (cut_node.name.as_str(), cut_node.code.as_deref()),
        ("가공부", None)
    );
    assert!(cut_node.head.is_none());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn workplaces_reorder_inside_their_entity_in_both_phases(owner: PgPool) {
    const ORG2: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0C52);
    let (store, actor) = tenant(&owner, ORG2, "B").await;
    let (entity, [(hq, _), (plant, _)]) = two_workplaces(&store, &actor).await;
    set_operating(&owner, ORG2).await;
    let saved = store
        .reorder_structure(
            &cmd(&actor),
            ReorderStructure {
                parent: StructureParent {
                    legal_entity_id: Some(entity),
                    ..StructureParent::default()
                },
                children: vec![plant, hq],
                expected_children: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(saved.change_mode, "GOVERNED");
    let tree = store.org_structure(&actor).await.unwrap();
    assert_eq!(names(&tree.entities[0].children), vec!["공장", "본사"]);
    assert_eq!(
        store
            .get_entity(&actor, entity, false)
            .await
            .unwrap()
            .workplaces[0]
            .id,
        plant
    );
    assert_eq!(tree.entity_unknown_headcount, Some(0));
    // A scoped reader never sees 법인 미정: they belong to no 법인.
    let scoped = console_entity_application::Actor {
        scope: console_entity_application::EntityScope::Only(vec![entity]),
        ..actor.clone()
    };
    assert_eq!(
        store
            .org_structure(&scoped)
            .await
            .unwrap()
            .entity_unknown_headcount,
        None
    );
}
