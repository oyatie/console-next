use super::*;
use crate::{OrgUnitKind, ReassignScope};
use time::macros::date;

const ROOT: Uuid = Uuid::from_u128(0x100);
const SITE: Uuid = Uuid::from_u128(0x1);
const TEAM: Uuid = Uuid::from_u128(0x2);

fn unit(id: Uuid, kind: &str, name: &str, parent: Uuid) -> (Uuid, Value) {
    (
        id,
        json!({"kind":kind,"name":name,"parent_id":parent,"status":"active"}),
    )
}

fn change(id: u128, code: &str, on: Date) -> ProjectedChange {
    ProjectedChange {
        id: Uuid::from_u128(id),
        code: code.to_owned(),
        effective_date: on,
    }
}

#[test]
fn approved_changes_fold_in_effective_date_order_with_marks() {
    let mut units = BTreeMap::from([
        unit(SITE, "site", "서울", ROOT),
        unit(TEAM, "team", "물류팀", SITE),
    ]);
    let later = change(0x20, "OC-2", date!(2026 - 11 - 01));
    let earlier = change(0x10, "OC-1", date!(2026 - 10 - 15));
    let changes = vec![
        (
            later.clone(),
            vec![OrgProposalOp::RenameOrgUnit {
                org_unit_id: TEAM,
                name: "운송팀".to_owned(),
            }],
        ),
        (
            earlier.clone(),
            vec![
                OrgProposalOp::CreateOrgUnit {
                    kind: OrgUnitKind::Department,
                    parent_id: Some(SITE),
                    name: "신규팀".to_owned(),
                },
                OrgProposalOp::RenameOrgUnit {
                    org_unit_id: TEAM,
                    name: "물류1팀".to_owned(),
                },
            ],
        ),
    ];
    let (marks, moves) = project_units(&mut units, &changes);
    let created = projected_unit_id(earlier.id, 0);
    assert_eq!(units[&created]["name"], "신규팀");
    assert_eq!(units[&created]["parent_id"], SITE.to_string());
    assert_eq!(
        units[&created]["effective_from"],
        earlier.effective_date.to_string()
    );
    assert_eq!(units[&TEAM]["name"], "운송팀", "the later rename wins");
    assert_eq!(marks[&created].id, earlier.id);
    assert_eq!(marks[&TEAM].id, later.id);
    assert_eq!(marks.len(), 2);
    assert!(moves.is_empty());
}

#[test]
fn a_reassign_moves_headcount_and_a_dissolve_marks_the_unit() {
    let other = Uuid::from_u128(0x3);
    let mut units = BTreeMap::from([
        unit(TEAM, "team", "A", SITE),
        unit(other, "team", "B", SITE),
    ]);
    let c = change(0x30, "OC-3", date!(2026 - 12 - 01));
    let ops = vec![
        OrgProposalOp::ReassignOrgUnit {
            from_org_unit: TEAM.to_string(),
            to_org_unit: other.to_string(),
            employee_ids: None,
            scope: ReassignScope {
                company: "본사".to_owned(),
            },
        },
        OrgProposalOp::DissolveOrgUnit {
            org_unit_id: TEAM,
            merged_into: None,
        },
    ];
    let (marks, moves) = project_units(&mut units, &[(c.clone(), ops)]);
    assert_eq!(units[&TEAM]["status"], "dissolved");
    assert_eq!((moves[0].from, moves[0].to), (TEAM, other));
    assert_eq!(moves[0].employees, None);
    assert_eq!(marks[&TEAM].id, c.id);
    assert_eq!(marks[&other].id, c.id);
}

#[test]
fn an_op_on_a_unit_the_projection_lacks_is_skipped() {
    let c = change(0x40, "OC-4", date!(2026 - 12 - 01));
    let ops = vec![OrgProposalOp::RenameOrgUnit {
        org_unit_id: Uuid::from_u128(0x99),
        name: "x".to_owned(),
    }];
    let mut units = BTreeMap::new();
    let (marks, _) = project_units(&mut units, &[(c, ops)]);
    assert!(units.is_empty() && marks.is_empty());
}
