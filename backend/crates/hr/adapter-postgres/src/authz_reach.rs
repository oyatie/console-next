//! AX-5: what an HR door may touch, decided per resource over the caller's
//! grant set. Cedar decides the held nodes; assignments and department subtrees
//! determine membership. Dated read models supply their dated department.
//!
//! One predicate serves the roster (list, count, facets, export), a single
//! person, and a target unit, so what a holder sees is what they may act on.

use console_kernel_core::BranchScope;
use console_platform_authz::access::NodeKind;
use console_platform_authz::{Action, Feature, Principal, authorize_org_wide};
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder, Transaction};
use uuid::Uuid;

use crate::HrError;
use crate::scope_sql::push_branch_scope_column;

/// The scope nodes one operation key is held over (no tenant node: that is
/// [`HrReach::All`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HrScope {
    pub entities: Vec<Uuid>,
    pub workplaces: Vec<Uuid>,
    /// 부서 subtree roots.
    pub units: Vec<Uuid>,
}

impl HrScope {
    pub fn is_empty(&self) -> bool {
        self.entities.is_empty() && self.workplaces.is_empty() && self.units.is_empty()
    }
}

/// Who a door may touch for one operation key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HrReach {
    /// The whole tenant (ops, a 전체 grant, a legacy org-wide role).
    All,
    /// The grant set's nodes, or — for a legacy branch role holding no grant
    /// for the key — the people homed in its branches.
    Within {
        scope: HrScope,
        branches: Option<BranchScope>,
    },
}

impl From<&BranchScope> for HrReach {
    fn from(scope: &BranchScope) -> Self {
        match scope {
            BranchScope::All => Self::All,
            BranchScope::Branches(_) => Self::Within {
                scope: HrScope::default(),
                branches: Some(scope.clone()),
            },
        }
    }
}

/// The nodes `principal` holds `feature` over, or `None` when one of them is
/// the tenant.
fn scope_of(principal: &Principal, feature: Feature) -> Option<HrScope> {
    let mut out = HrScope::default();
    for g in principal.scopes_for(feature) {
        match g.kind {
            NodeKind::Tenant => return None,
            NodeKind::LegalEntity => out.entities.push(g.id),
            NodeKind::Workplace => out.workplaces.push(g.id),
            NodeKind::Department => out.units.push(g.id),
        }
    }
    Some(out)
}

/// Whether `principal` holds `feature` anywhere in its grant set.
pub fn holds_scoped(principal: &Principal, feature: Feature) -> bool {
    principal.scopes_for(feature).next().is_some()
}

/// 403 `out_of_scope`: the record or unit is outside every node the caller
/// holds the key over. The same answer whether or not the record exists (no
/// existence leak); it names only what the caller holds.
pub fn out_of_scope(principal: &Principal, feature: Feature) -> HrError {
    HrError {
        errors: None,
        status: StatusCode::FORBIDDEN,
        code: "out_of_scope",
        message: "this is outside the scope this account holds".to_owned(),
        refusals: Some(Box::new(held_scopes(principal, feature))),
    }
}

/// 403 `scope_tenant_wide_only`: the door acts on the whole tenant, and the
/// caller holds the key only over part of it.
pub fn scope_tenant_wide_only(principal: &Principal, feature: Feature) -> HrError {
    HrError {
        errors: None,
        status: StatusCode::FORBIDDEN,
        code: "scope_tenant_wide_only",
        message: "this works on the whole tenant; a grant over 전체 is needed".to_owned(),
        refusals: Some(Box::new(held_scopes(principal, feature))),
    }
}

fn held_scopes(principal: &Principal, feature: Feature) -> Value {
    Value::Array(
        principal
            .scopes_for(feature)
            .map(|g| json!({ "kind": g.kind, "node_id": g.id }))
            .collect(),
    )
}

/// The reach of `feature` for `principal`, or the door's refusal when it
/// holds the key nowhere. `legacy` is the branch-tier check the door used
/// before AX-5; it decides only for a principal that holds no grant for the
/// key (the grant set is authoritative for everyone who has one).
pub fn hr_reach_with(
    principal: &Principal,
    feature: Feature,
    legacy: impl FnOnce() -> Result<(), HrError>,
) -> Result<HrReach, HrError> {
    if authorize_org_wide(principal, Action::new(feature)).is_ok() {
        return Ok(HrReach::All);
    }
    let Some(scope) = scope_of(principal, feature) else {
        return Ok(HrReach::All);
    };
    if !scope.is_empty() {
        return Ok(HrReach::Within {
            scope,
            branches: None,
        });
    }
    legacy()?;
    Ok(HrReach::from(&principal.branch_scope))
}

/// `( <the reach> )` over the aliases `e` (employees) and `ea` (the
/// `assignment_lateral!`).
pub fn push_reach(builder: &mut QueryBuilder<Postgres>, reach: &HrReach) {
    push_reach_at_unit(builder, reach, "e.org_unit_id");
}

/// Dated read models supply the department at their own reference date.
pub fn push_reach_at_unit(builder: &mut QueryBuilder<Postgres>, reach: &HrReach, unit: &str) {
    let (scope, branches) = match reach {
        HrReach::All => {
            builder.push(" TRUE ");
            return;
        }
        HrReach::Within { scope, branches } => (scope, branches),
    };
    builder.push(" (FALSE");
    if let Some(branches) = branches {
        builder.push(" OR ");
        push_branch_scope_column(builder, branches, "e.home_branch_id");
    }
    if !scope.is_empty() {
        builder.push(" OR ");
        push_scope(
            builder,
            scope,
            "ea.legal_entity_id",
            "ea.workplace_id",
            unit,
        );
    }
    builder.push(") ");
}

/// Whether a place (its 법인, 사업장 and 부서 columns) is inside `scope`.
fn push_scope(
    builder: &mut QueryBuilder<Postgres>,
    scope: &HrScope,
    le: &str,
    wp: &str,
    unit: &str,
) {
    builder.push(format!(
        "((({le} IS NOT NULL OR {wp} IS NOT NULL) AND ({le} = ANY("
    ));
    builder.push_bind(scope.entities.clone());
    builder.push(format!(") OR {wp} = ANY("));
    builder.push_bind(scope.workplaces.clone());
    builder.push(format!(
        "))) OR ({le} IS NULL AND {wp} IS NULL AND {unit} = ANY("
    ));
    push_placed_units(builder, scope);
    builder.push(format!(")) OR {unit} = ANY("));
    push_subtree(builder, &scope.units);
    builder.push("))");
}

/// The tree heads (latest revision per unit), as a CTE named `heads`.
const HEADS: &str = "heads AS (SELECT DISTINCT ON (org_unit_id) org_unit_id, \
     attributes->>'parent_id' AS parent FROM org_unit_revisions \
     ORDER BY org_unit_id, version DESC)";

/// `(<subquery>)`: the 부서 placed in one of the scope's 법인/사업장 and the
/// units under them, stopping at a unit placed somewhere else (uncorrelated:
/// planned once, hashed).
fn push_placed_units(builder: &mut QueryBuilder<Postgres>, scope: &HrScope) {
    builder.push(format!(
        "(WITH RECURSIVE {HEADS}, pl AS (SELECT org_unit_id, \
           COALESCE(legal_entity_id = ANY("
    ));
    builder.push_bind(scope.entities.clone());
    builder.push(") OR workplace_id = ANY(");
    builder.push_bind(scope.workplaces.clone());
    builder.push(
        "), false) AS inside FROM org_unit_placements WHERE valid_to IS NULL), \
         down AS (SELECT org_unit_id, 0 AS d FROM pl WHERE inside \
           UNION SELECT h.org_unit_id, down.d + 1 FROM heads h JOIN down \
             ON h.parent = down.org_unit_id::text \
           WHERE down.d < 64 AND NOT EXISTS (SELECT 1 FROM pl \
             WHERE pl.org_unit_id = h.org_unit_id AND NOT pl.inside)) \
         SELECT org_unit_id FROM down)",
    );
}

/// `(<subquery>)`: `roots` and every unit under them (uncorrelated).
fn push_subtree(builder: &mut QueryBuilder<Postgres>, roots: &[Uuid]) {
    builder.push(format!(
        "(WITH RECURSIVE {HEADS}, sub AS (SELECT org_unit_id, 0 AS d FROM heads \
           WHERE org_unit_id = ANY("
    ));
    builder.push_bind(roots.to_vec());
    builder.push(
        ") UNION SELECT h.org_unit_id, sub.d + 1 FROM heads h JOIN sub \
           ON h.parent = sub.org_unit_id::text WHERE sub.d < 64) \
         SELECT org_unit_id FROM sub)",
    );
}

/// `(<a change request's subject is a person inside reach>)` over columns
/// `subject_type` / `subject_id` of `alias`.
pub fn push_subject_in_reach(builder: &mut QueryBuilder<Postgres>, reach: &HrReach, alias: &str) {
    if *reach == HrReach::All {
        builder.push(" TRUE ");
        return;
    }
    builder.push(format!(
        " ({alias}subject_type = 'EMPLOYEE' AND {alias}subject_id IN (SELECT e.id FROM employees e"
    ));
    builder.push(crate::assignment_lateral!());
    builder.push(" WHERE ");
    push_reach(builder, reach);
    builder.push(")) ");
}

/// Whether employee `id` is inside `reach` (false when no such employee).
pub async fn person_in_reach(
    tx: &mut Transaction<'_, Postgres>,
    reach: &HrReach,
    id: Uuid,
) -> Result<bool, HrError> {
    if *reach == HrReach::All {
        return Ok(true);
    }
    let mut q = QueryBuilder::<Postgres>::new("SELECT EXISTS (SELECT 1 FROM employees e");
    q.push(crate::assignment_lateral!());
    q.push(" WHERE e.id = ");
    q.push_bind(id);
    q.push(" AND ");
    push_reach(&mut q, reach);
    q.push(")");
    Ok(q.build_query_scalar().fetch_one(tx.as_mut()).await?)
}

/// Whether a place someone would be registered or moved into (any of its 법인,
/// 사업장, 부서) is inside `reach`.
pub async fn place_in_reach(
    tx: &mut Transaction<'_, Postgres>,
    reach: &HrReach,
    entity: Option<Uuid>,
    workplace: Option<Uuid>,
    unit: Option<Uuid>,
) -> Result<bool, HrError> {
    let scope = match reach {
        HrReach::All => return Ok(true),
        HrReach::Within { scope, .. } if !scope.is_empty() => scope,
        // A legacy branch role holds no place (fail closed).
        HrReach::Within { .. } => return Ok(false),
    };
    // A 사업장 named alone counts in its 법인 too.
    let mut q = QueryBuilder::<Postgres>::new("SELECT EXISTS (SELECT 1 FROM (SELECT COALESCE(");
    q.push_bind(entity);
    q.push("::uuid, (SELECT w.legal_entity_id FROM workplaces w WHERE w.id = ");
    q.push_bind(workplace);
    q.push("::uuid)) AS le, ");
    q.push_bind(workplace);
    q.push("::uuid AS wp, ");
    q.push_bind(unit);
    q.push("::uuid AS unit) p WHERE ");
    push_scope(&mut q, scope, "p.le", "p.wp", "p.unit");
    q.push(")");
    Ok(q.build_query_scalar().fetch_one(tx.as_mut()).await?)
}
