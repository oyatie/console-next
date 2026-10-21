#![allow(clippy::unwrap_used)]
//! Pure comparison validation and removed-node placement regressions.
use super::*;
#[test]
fn reversed_and_malformed_dates_refuse_validation_failed() {
    for (a, b) in [("2026-04-02", "2026-04-01"), ("2026-02-30", "2026-04-01")] {
        assert_eq!(
            CompareQuery {
                a: a.into(),
                b: b.into(),
                known_at: None
            }
            .parse()
            .unwrap_err()
            .code,
            "validation_failed"
        );
    }
    assert!(
        CompareQuery {
            a: "2026-04-01".into(),
            b: "2026-04-01".into(),
            known_at: None
        }
        .parse()
        .is_ok()
    );
}
fn node(id: u128, name: &str, children: Vec<OrgStructureNode>) -> OrgStructureNode {
    OrgStructureNode {
        id: Uuid::from_u128(id),
        name: name.into(),
        kind: "DEPARTMENT",
        children,
        scheduled_by: None,
        changed_after: false,
        version: Some(1),
        org_unit_id: None,
        workplace_kind: None,
        code: None,
        head: None,
        headcount: 3,
        direct_headcount: 3,
        dispatched_headcount: 0,
        chips: vec![],
    }
}
fn structure(entities: Vec<OrgStructureNode>) -> OrgStructure {
    OrgStructure {
        tenant_name: "Tenant".into(),
        phase: "OPERATING".into(),
        entities,
        unplaced: vec![],
        entity_unknown_headcount: Some(0),
        read: crate::ReadStamp {
            as_of: "2026-10-09".into(),
            known_at: None,
            read_only: false,
        },
    }
}
#[test]
fn comparison_keeps_all_marks_and_removed_children_below_a_moved_parent() {
    let before = structure(vec![node(
        1,
        "root",
        vec![
            node(
                2,
                "left",
                vec![node(4, "parent", vec![node(5, "gone", vec![])])],
            ),
            node(3, "right", vec![]),
        ],
    )]);
    let after = structure(vec![node(
        1,
        "root",
        vec![
            node(2, "left", vec![node(6, "new", vec![])]),
            node(3, "right", vec![node(4, "renamed", vec![])]),
        ],
    )]);
    let marks = compare(&before, &after);
    assert_eq!(
        marks
            .iter()
            .find(|m| m.id == Uuid::from_u128(4))
            .unwrap()
            .marks,
        ["moved", "renamed"]
    );
    assert_eq!(
        marks
            .iter()
            .find(|m| m.id == Uuid::from_u128(5))
            .unwrap()
            .marks,
        ["gone"]
    );
    assert_eq!(
        marks
            .iter()
            .find(|m| m.id == Uuid::from_u128(6))
            .unwrap()
            .marks,
        ["new"]
    );
    let chart = with_gone(&before, after);
    let all = nodes(&chart);
    assert_eq!(all[&Uuid::from_u128(5)].1, Some(Uuid::from_u128(4)));
    assert_eq!(all[&Uuid::from_u128(5)].0.headcount, 0);
    assert_eq!(all[&Uuid::from_u128(4)].0.name, "renamed");
    assert!(chart.read.read_only);
}

fn assert_removed_child_crosses_collection(unplaced_to_entity: bool) {
    let mut removed = node(5, "gone", vec![]);
    removed.dispatched_headcount = 2;
    let parent = node(4, "parent", vec![removed]);
    let mut before = structure(vec![node(1, "entity", vec![])]);
    let mut after = structure(vec![node(1, "entity", vec![])]);
    if unplaced_to_entity {
        before.unplaced.push(parent);
        after.entities[0].children.push(node(4, "parent", vec![]));
    } else {
        before.entities[0].children.push(parent);
        after.unplaced.push(node(4, "parent", vec![]));
    }
    let chart = with_gone(&before, after);
    let all = nodes(&chart);
    let (ghost, parent_id) = all[&Uuid::from_u128(5)];
    assert_eq!(parent_id, Some(Uuid::from_u128(4)));
    assert_eq!(
        (
            ghost.headcount,
            ghost.direct_headcount,
            ghost.dispatched_headcount
        ),
        (0, 0, 0)
    );
    assert_eq!(
        all[&Uuid::from_u128(4)]
            .0
            .children
            .iter()
            .map(|n| n.id)
            .collect::<Vec<_>>(),
        [Uuid::from_u128(5)]
    );
    assert_eq!(
        chart.entities.iter().map(|n| n.id).collect::<Vec<_>>(),
        [Uuid::from_u128(1)],
        "the removed child must not appear as another entity root"
    );
    assert_eq!(
        chart.unplaced.iter().map(|n| n.id).collect::<Vec<_>>(),
        if unplaced_to_entity {
            vec![]
        } else {
            vec![Uuid::from_u128(4)]
        },
        "the removed child must not appear as another unplaced root"
    );
    assert_eq!(all.len(), 3);
}

#[test]
fn removed_child_stays_under_parent_moved_from_unplaced_to_entities() {
    assert_removed_child_crosses_collection(true);
}

#[test]
fn removed_child_stays_under_parent_moved_from_entities_to_unplaced() {
    assert_removed_child_crosses_collection(false);
}
