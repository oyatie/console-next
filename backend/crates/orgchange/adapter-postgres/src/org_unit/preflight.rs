use crate::*;

#[derive(Default)]
pub(crate) struct OrgUnitBlockers(BTreeMap<&'static str, (&'static str, Vec<Uuid>, i64)>);

impl OrgUnitBlockers {
    pub(crate) fn push(&mut self, code: &'static str, label: &'static str, id: Uuid, count: i64) {
        let entry = self.0.entry(code).or_insert((label, Vec::new(), 0));
        entry.1.push(id);
        entry.2 += count;
    }
}

/// Preflight blockers for the org-unit ops. One chip per code (the console keys
/// the list by code); every blocker is also a Restrict dependent so the
/// governance verdict agrees. Dissolve-with-members/children is a BLOCKER in
/// every change kind: settlement cannot move people out of a unit nobody may
/// dissolve yet.
pub(crate) async fn org_unit_preflight(
    tx: Tx<'_, '_>,
    org: OrgId,
    proposal: &[OrgProposalOp],
    blockers: &mut Vec<PreflightBlocker>,
    restrict: &mut Vec<Dependent>,
) -> Result<i64, PgOrgChangeError> {
    let mut found = OrgUnitBlockers::default();
    const UNAVAILABLE: (&str, &str) = (
        "ORG_UNIT_UNAVAILABLE",
        "대상 조직을 찾을 수 없거나 해산된 상태입니다.",
    );
    const PARENT: (&str, &str) = (
        "ORG_UNIT_PARENT_UNAVAILABLE",
        "상위 조직을 찾을 수 없거나 해산된 상태입니다.",
    );
    const NESTING: (&str, &str) = (
        "ORG_UNIT_KIND_NESTING",
        "조직 유형 계층 규칙 위반 (사업장 > 부서 > 팀).",
    );
    const CYCLE: (&str, &str) = ("ORG_UNIT_CYCLE", "상위 조직 이동이 순환을 만듭니다.");
    const MEMBERS: (&str, &str) = (
        "ORG_UNIT_ACTIVE_MEMBERS",
        "소속 직원(휴직자 포함) 전보 필요",
    );
    const CHILDREN: (&str, &str) = ("ORG_UNIT_ACTIVE_CHILDREN", "하위 조직 해산·이동 필요");
    // A 사업장's own unit is renamed and closed with its 사업장 (decisions #14.1, #18).
    const WORKPLACE: (&str, &str) = (
        "ORG_UNIT_SITE_IS_WORKPLACE",
        "rename or close the workplace instead",
    );
    // What earlier ops of this change carry out of a unit before it is
    // dissolved (one 폐지 sheet moves people and sub-units first, org-06).
    let mut carried_all: Vec<Uuid> = Vec::new();
    let mut carried_people: Vec<Uuid> = Vec::new();
    let mut carried_units: Vec<Uuid> = Vec::new();
    for op in proposal {
        match op {
            OrgProposalOp::ReassignOrgUnit {
                from_org_unit,
                employee_ids,
                ..
            } => {
                let Ok(from) = Uuid::parse_str(from_org_unit.trim()) else {
                    continue;
                };
                match employee_ids {
                    Some(ids) => carried_people.extend(ids),
                    None => carried_all.push(from),
                }
            }
            OrgProposalOp::CreateOrgUnit {
                kind, parent_id, ..
            } => match resolve_parent(tx, org, *parent_id).await? {
                Err(()) => found.push(PARENT.0, PARENT.1, parent_id.unwrap_or_default(), 1),
                Ok(parent) => {
                    if !kind.admits_parent(parent.as_ref().map(|p| p.kind)) {
                        found.push(NESTING.0, NESTING.1, parent_id.unwrap_or_default(), 1);
                    }
                }
            },
            OrgProposalOp::RenameOrgUnit { org_unit_id, .. } => {
                if !load_unit_head(tx, *org_unit_id)
                    .await?
                    .is_some_and(|head| !head.dissolved)
                {
                    found.push(UNAVAILABLE.0, UNAVAILABLE.1, *org_unit_id, 1);
                } else if represents_workplace(tx, *org_unit_id).await? {
                    found.push(WORKPLACE.0, WORKPLACE.1, *org_unit_id, 1);
                }
            }
            OrgProposalOp::MoveOrgUnit {
                org_unit_id,
                parent_id,
            } => {
                carried_units.push(*org_unit_id);
                let Some(head) = load_unit_head(tx, *org_unit_id)
                    .await?
                    .filter(|head| !head.dissolved)
                else {
                    found.push(UNAVAILABLE.0, UNAVAILABLE.1, *org_unit_id, 1);
                    continue;
                };
                match resolve_parent(tx, org, Some(*parent_id)).await? {
                    Err(()) => found.push(PARENT.0, PARENT.1, *parent_id, 1),
                    Ok(parent) => {
                        if !head.kind.admits_parent(parent.as_ref().map(|p| p.kind)) {
                            found.push(NESTING.0, NESTING.1, *parent_id, 1);
                        } else if parent.is_some()
                            && creates_cycle(tx, *org_unit_id, *parent_id).await?
                        {
                            found.push(CYCLE.0, CYCLE.1, *parent_id, 1);
                        }
                    }
                }
            }
            OrgProposalOp::DissolveOrgUnit { org_unit_id, .. } => {
                if !load_unit_head(tx, *org_unit_id)
                    .await?
                    .is_some_and(|head| !head.dissolved)
                {
                    found.push(UNAVAILABLE.0, UNAVAILABLE.1, *org_unit_id, 1);
                    continue;
                }
                if represents_workplace(tx, *org_unit_id).await? {
                    found.push(WORKPLACE.0, WORKPLACE.1, *org_unit_id, 1);
                }
                let all = carried_all.contains(org_unit_id);
                let members = members_left(tx, *org_unit_id, (all, &carried_people)).await?;
                if members > 0 {
                    found.push(MEMBERS.0, MEMBERS.1, *org_unit_id, members);
                }
                let children = children_left(tx, *org_unit_id, &carried_units).await?;
                if children > 0 {
                    found.push(CHILDREN.0, CHILDREN.1, *org_unit_id, children);
                }
            }
            _ => {}
        }
    }
    let mut total = 0;
    for (code, (label, ids, count)) in found.0 {
        blockers.push(PreflightBlocker {
            code: code.to_owned(),
            label: label.to_owned(),
            dependent_kind: "org_unit".to_owned(),
            count,
        });
        total += count;
        restrict.extend(ids.into_iter().map(|id| Dependent {
            kind: "org_unit".to_owned(),
            id: id.to_string(),
            on_delete: OnDelete::Restrict,
        }));
    }
    Ok(total)
}

pub(crate) fn port_refusal(error: KernelError) -> PgOrgChangeError {
    PgOrgChangeError::from(KernelError::new(
        error.kind,
        format!("org-unit write failed: {}", error.message),
    ))
}

/// Whether `unit` is a 사업장's own SITE unit (an open placement that
/// represents the 사업장; SELECT only, the entity face owns the writes).
pub(crate) async fn represents_workplace(
    tx: Tx<'_, '_>,
    unit: Uuid,
) -> Result<bool, PgOrgChangeError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM org_unit_placements \
         WHERE org_unit_id = $1 AND represents_workplace AND valid_to IS NULL)",
    )
    .bind(unit)
    .fetch_one(tx.as_mut())
    .await?)
}
