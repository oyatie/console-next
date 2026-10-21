//! Pure future fold, ported from the org-asof lane; explicit member subsets are retained.
use crate::OrgProposalOp;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use time::Date;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ProjectedChange {
    pub id: Uuid,
    pub code: String,
    pub effective_date: Date,
}
#[derive(Debug, Clone)]
pub struct MemberMove {
    pub from: Uuid,
    pub to: Uuid,
    pub employees: Option<Vec<Uuid>>,
}
pub type ProjectionMarks = BTreeMap<Uuid, ProjectedChange>;

#[must_use]
pub fn projected_unit_id(change: Uuid, index: usize) -> Uuid {
    Uuid::from_u128(change.as_u128() ^ (index as u128 + 1).rotate_left(64))
}

/// Replay approved operations in the same stable effective-date/code order as the scheduler.
#[must_use]
pub fn project_units(
    units: &mut BTreeMap<Uuid, Value>,
    changes: &[(ProjectedChange, Vec<OrgProposalOp>)],
) -> (ProjectionMarks, Vec<MemberMove>) {
    let mut ordered: Vec<_> = changes.iter().collect();
    ordered.sort_by_key(|(c, _)| (c.effective_date, &c.code));
    let mut marks = BTreeMap::new();
    let mut moves = Vec::new();
    for (change, ops) in ordered {
        for (index, op) in ops.iter().enumerate() {
            let touched = match op {
                OrgProposalOp::CreateOrgUnit {
                    kind,
                    parent_id,
                    name,
                } => {
                    let id = projected_unit_id(change.id, index);
                    units.insert(id, json!({"name":name,"kind":kind.as_attr(),"parent_id":parent_id,"status":"active","effective_from":change.effective_date.to_string()}));
                    Some(id)
                }
                OrgProposalOp::RenameOrgUnit { org_unit_id, name } => {
                    units.get_mut(org_unit_id).map(|a| {
                        a["name"] = json!(name);
                        *org_unit_id
                    })
                }
                OrgProposalOp::MoveOrgUnit {
                    org_unit_id,
                    parent_id,
                } => units.get_mut(org_unit_id).map(|a| {
                    a["parent_id"] = json!(parent_id);
                    *org_unit_id
                }),
                OrgProposalOp::DissolveOrgUnit { org_unit_id, .. } => {
                    units.get_mut(org_unit_id).map(|a| {
                        a["status"] = json!("dissolved");
                        *org_unit_id
                    })
                }
                OrgProposalOp::ReassignOrgUnit {
                    from_org_unit,
                    to_org_unit,
                    employee_ids,
                    ..
                } => {
                    if let (Ok(from), Ok(to)) =
                        (Uuid::parse_str(from_org_unit), Uuid::parse_str(to_org_unit))
                        && units.contains_key(&from)
                        && units.contains_key(&to)
                    {
                        marks.insert(from, change.clone());
                        marks.insert(to, change.clone());
                        moves.push(MemberMove {
                            from,
                            to,
                            employees: employee_ids.clone(),
                        });
                    }
                    None
                }
                _ => None,
            };
            if let Some(id) = touched {
                marks.insert(id, change.clone());
            }
        }
    }
    (marks, moves)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fold_replays_by_effective_date_and_keeps_subset_moves() {
        let id = Uuid::from_u128(1);
        let target = Uuid::from_u128(2);
        let person = Uuid::from_u128(3);
        let mut units = BTreeMap::from([
            (id, json!({"name":"old"})),
            (target, json!({"name":"target"})),
        ]);
        let c = |n| ProjectedChange {
            id: Uuid::from_u128(n),
            code: format!("OC-{n}"),
            effective_date: time::macros::date!(2026 - 11 - 01),
        };
        let changes = vec![
            (
                c(5),
                vec![
                    OrgProposalOp::RenameOrgUnit {
                        org_unit_id: id,
                        name: "last".into(),
                    },
                    OrgProposalOp::ReassignOrgUnit {
                        from_org_unit: id.to_string(),
                        to_org_unit: target.to_string(),
                        scope: crate::ReassignScope {
                            company: "ANOTHER".into(),
                        },
                        employee_ids: None,
                    },
                ],
            ),
            (
                c(4),
                vec![
                    OrgProposalOp::RenameOrgUnit {
                        org_unit_id: id,
                        name: "first".into(),
                    },
                    OrgProposalOp::ReassignOrgUnit {
                        from_org_unit: id.to_string(),
                        to_org_unit: target.to_string(),
                        scope: crate::ReassignScope {
                            company: "SAE".into(),
                        },
                        employee_ids: Some(vec![person]),
                    },
                ],
            ),
        ];
        let (marks, moves) = project_units(&mut units, &changes);
        assert_eq!(units[&id]["name"], "last");
        assert_eq!(marks[&id].code, "OC-5");
        assert_eq!(moves.len(), 2);
        assert_eq!(moves[0].employees, Some(vec![person]));
        // Company is audit context; an unfiltered move keeps the entire source unit.
        assert_eq!((moves[1].from, moves[1].to), (id, target));
        assert_eq!(moves[1].employees, None);
        assert_eq!(
            projected_unit_id(Uuid::from_u128(4), 0),
            projected_unit_id(Uuid::from_u128(4), 0)
        );
    }
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod absorbed_tests;
