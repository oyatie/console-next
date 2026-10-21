#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! UX-R3 org-13: departments created in one batch (a pasted outline) keep the
//! order they were typed in, under a parent that already had 부서 in name
//! order; the chart and the list read the same order.

mod common;

use common::*;
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0C13);

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_pasted_outline_keeps_its_typed_order(owner: PgPool) {
    // regression: r3 org-13 — the preview showed 연구1실…연구12실, the chart 연구10실 first.
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (_, [(hq, _), _]) = two_workplaces(&store, &actor).await;
    // An earlier batch: those stay first, in the order they were made.
    let first = vec![
        under_workplace("x", "인사팀", hq),
        under_workplace("y", "경영지원팀", hq),
    ];
    store
        .apply_org_setup_batch(&cmd(&actor), first, port())
        .await
        .unwrap();
    let typed: Vec<String> = (1..=12).map(|n| format!("연구{n}실")).collect();
    let ops = typed
        .iter()
        .enumerate()
        .map(|(i, n)| under_workplace(&format!("r{i}"), n, hq))
        .collect();
    store
        .apply_org_setup_batch(&cmd(&actor), ops, port())
        .await
        .unwrap();

    let tree = store.org_structure(&actor).await.unwrap();
    let hq_node = tree.entities[0]
        .children
        .iter()
        .find(|w| w.id == hq)
        .unwrap();
    let names: Vec<&str> = hq_node.children.iter().map(|n| n.name.as_str()).collect();
    let mut want = vec!["인사팀", "경영지원팀"];
    want.extend(typed.iter().map(String::as_str));
    assert_eq!(names, want, "creation order, earlier units first");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn single_adds_stay_in_name_order(owner: PgPool) {
    // A create with no ref (one 부서 added on the chart) writes no place: name order until an order is given.
    let (store, actor) = tenant(&owner, ORG, "B").await;
    let (_, [(hq, _), _]) = two_workplaces(&store, &actor).await;
    for name in ["채용팀", "교육팀"] {
        let mut op = under_workplace("x", name, hq);
        if let console_entity_application::OrgSetupOp::Create { client_ref, .. } = &mut op {
            *client_ref = None;
        }
        store
            .apply_org_setup_batch(&cmd(&actor), vec![op], port())
            .await
            .unwrap();
    }
    let tree = store.org_structure(&actor).await.unwrap();
    let hq_node = tree.entities[0]
        .children
        .iter()
        .find(|w| w.id == hq)
        .unwrap();
    let names: Vec<&str> = hq_node.children.iter().map(|n| n.name.as_str()).collect();
    assert_eq!(names, ["교육팀", "채용팀"]);
}
