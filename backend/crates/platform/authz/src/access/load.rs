//! Load the [`AccessSubject`] of one account inside a tenant-armed transaction:
//! the phase, the ops flag, and only the grants that count now, each with its
//! role version's lines, its scope chain and the branches it projects to.
//! A 부서 grant's chain runs 부서 → … → the 사업장 it sits in → 법인 →
//! tenant (AX-5); a chain that does not reach the tenant (a dissolved 부서, one
//! under no 사업장) is refused by the engine. 「이 조직만」 grants are never
//! loaded (the API refuses them, so this is a second net).

use std::collections::{BTreeMap, BTreeSet};

use console_kernel_core::{BranchId, BranchScope, KernelError, OrgId, TenantPhase, Timestamp};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use super::catalog::{Domain, Level};
use super::cedar::AccessSlice;
pub use super::dept::dept_path;
pub(crate) use super::dept::dept_paths;
use super::model::{AccessSubject, GrantState, HeldGrant, NodeKind, NodePath, NodeRef, RoleLine};

pub(super) fn db(err: sqlx::Error) -> KernelError {
    KernelError::internal(format!("access grants unavailable: {err}"))
}

/// The tenant's phase (a missing row reads as OPERATING, kernel rule).
///
/// # Errors
/// Internal on a query failure.
pub async fn load_tenant_phase(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
) -> Result<TenantPhase, KernelError> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT phase FROM tenant_phase WHERE org_id = $1")
            .bind(org.as_uuid())
            .fetch_optional(tx.as_mut())
            .await
            .map_err(db)?;
    Ok(TenantPhase::from_db(raw.as_deref()))
}

/// The scope chain of a grant's node, nearest first (tenant last).
#[must_use]
pub fn scope_path(org: OrgId, kind: NodeKind, node: Option<Uuid>, le: Option<Uuid>) -> NodePath {
    let tenant = NodeRef {
        kind: NodeKind::Tenant,
        id: *org.as_uuid(),
    };
    let le = le.map(|id| NodeRef {
        kind: NodeKind::LegalEntity,
        id,
    });
    let path = match (kind, node) {
        (NodeKind::Workplace, Some(id)) => vec![
            Some(NodeRef {
                kind: NodeKind::Workplace,
                id,
            }),
            le,
            Some(tenant),
        ],
        (NodeKind::LegalEntity, _) => vec![le, Some(tenant)],
        _ => vec![Some(tenant)],
    };
    // A missing link leaves a chain without its parent; the engine refuses it.
    NodePath(path.into_iter().flatten().collect())
}

/// Load the subject of `account` at `now`.
///
/// # Errors
/// Internal on a query failure (the caller fails closed).
pub async fn load_access_subject(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    account: Uuid,
    now: Timestamp,
) -> Result<AccessSubject, KernelError> {
    load_access_subject_inner(tx, org, account, now, false).await
}

/// Load and compile an active account's request-sized Cedar facts.
///
/// # Errors
/// Refuses a missing or inactive account; database and Cedar failures are internal.
pub async fn load_active_access_slice(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    account: Uuid,
    now: Timestamp,
) -> Result<AccessSlice, KernelError> {
    let subject = load_access_subject_inner(tx, org, account, now, true).await?;
    AccessSlice::compile(&subject)
        .map_err(|error| KernelError::internal(format!("access grants unavailable: {error}")))
}

async fn load_access_subject_inner(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    account: Uuid,
    now: Timestamp,
    require_active: bool,
) -> Result<AccessSubject, KernelError> {
    let phase = load_tenant_phase(tx, org).await?;
    let account_state: Option<(bool, bool)> =
        sqlx::query_as("SELECT is_tenant_ops, is_active FROM users WHERE org_id = $1 AND id = $2")
            .bind(org.as_uuid())
            .bind(account)
            .fetch_optional(tx.as_mut())
            .await
            .map_err(db)?;
    if require_active && !account_state.is_some_and(|(_, active)| active) {
        return Err(KernelError::forbidden(
            "access facts require an active account",
        ));
    }
    let is_ops = account_state.is_some_and(|(ops, active)| ops && active);
    let rows = sqlx::query(
        "SELECT g.id, g.role_id, r.version, r.status = 'ACTIVE' AS role_active, g.scope_kind,
                COALESCE(g.legal_entity_id, w.legal_entity_id) AS le_id, g.workplace_id, g.org_unit_id,
                w.default_branch_id, g.valid_from, g.valid_to, g.effective_in_setup
           FROM access_grants g
           JOIN access_roles r ON r.org_id = g.org_id AND r.id = g.role_id
           LEFT JOIN workplaces w ON w.org_id = g.org_id AND w.id = g.workplace_id AND w.voided_at IS NULL
          WHERE g.org_id = $1 AND g.account_id = $2 AND g.status = 'ACTIVE'
            AND g.include_descendants",
    )
    .bind(org.as_uuid())
    .bind(account)
    .fetch_all(tx.as_mut())
    .await
    .map_err(db)?;

    let mut held = Vec::new();
    for row in rows {
        let state = GrantState {
            revoked: false,
            role_active: row.try_get("role_active").map_err(db)?,
            valid_from: row.try_get("valid_from").map_err(db)?,
            valid_to: row.try_get("valid_to").map_err(db)?,
            effective_in_setup: row.try_get("effective_in_setup").map_err(db)?,
        };
        if state.enforcement(phase, now) != super::model::Enforcement::Enforced {
            continue;
        }
        let kind_raw: String = row.try_get("scope_kind").map_err(db)?;
        let kind = NodeKind::parse(&kind_raw).unwrap_or(NodeKind::Department);
        let le: Option<Uuid> = row.try_get("le_id").map_err(db)?;
        let wp: Option<Uuid> = row.try_get("workplace_id").map_err(db)?;
        let wp_branch: Option<Uuid> = row.try_get("default_branch_id").map_err(db)?;
        let unit: Option<Uuid> = row.try_get("org_unit_id").map_err(db)?;
        let branches = match kind {
            NodeKind::Tenant => BranchScope::All,
            NodeKind::Workplace => {
                BranchScope::Branches(wp_branch.map(BranchId::from_uuid).into_iter().collect())
            }
            // Filled below from the 법인's live 사업장.
            NodeKind::LegalEntity | NodeKind::Department => BranchScope::Branches(BTreeSet::new()),
        };
        held.push(HeldGrant {
            grant_id: row.try_get("id").map_err(db)?,
            role_id: row.try_get("role_id").map_err(db)?,
            role_version: row.try_get("version").map_err(db)?,
            lines: Vec::new(),
            scope: match (kind, unit) {
                (NodeKind::Department, Some(unit)) => dept_path(tx, org, unit).await?,
                _ => scope_path(org, kind, wp.or(le), le),
            },
            branches,
        });
    }
    attach_lines(tx, org, &mut held).await?;
    attach_entity_branches(tx, org, &mut held).await?;
    Ok(AccessSubject {
        org,
        account,
        is_ops,
        phase,
        grants: held,
    })
}

async fn attach_lines(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    held: &mut [HeldGrant],
) -> Result<(), KernelError> {
    let roles: Vec<Uuid> = held.iter().map(|g| g.role_id).collect();
    let rows = sqlx::query(
        "SELECT role_id, version, domain, levels FROM access_role_lines
          WHERE org_id = $1 AND role_id = ANY($2) ORDER BY domain",
    )
    .bind(org.as_uuid())
    .bind(&roles)
    .fetch_all(tx.as_mut())
    .await
    .map_err(db)?;
    let mut by_version: BTreeMap<(Uuid, i32), Vec<RoleLine>> = BTreeMap::new();
    for row in rows {
        let domain: String = row.try_get("domain").map_err(db)?;
        let levels: Vec<String> = row.try_get("levels").map_err(db)?;
        // An unknown stored value drops the line (never widens).
        let Ok(domain) = Domain::parse(&domain) else {
            continue;
        };
        let levels: Vec<Level> = levels.iter().filter_map(|l| Level::parse(l).ok()).collect();
        by_version
            .entry((
                row.try_get("role_id").map_err(db)?,
                row.try_get("version").map_err(db)?,
            ))
            .or_default()
            .push(RoleLine { domain, levels });
    }
    for grant in held {
        grant.lines = by_version
            .get(&(grant.role_id, grant.role_version))
            .cloned()
            .unwrap_or_default();
    }
    Ok(())
}

async fn attach_entity_branches(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    held: &mut [HeldGrant],
) -> Result<(), KernelError> {
    let entities: Vec<Uuid> = held
        .iter()
        .filter(|g| {
            g.scope
                .node()
                .is_some_and(|n| n.kind == NodeKind::LegalEntity)
        })
        .filter_map(|g| g.scope.node().map(|n| n.id))
        .collect();
    if entities.is_empty() {
        return Ok(());
    }
    let rows = sqlx::query(
        "SELECT legal_entity_id, default_branch_id FROM workplaces
          WHERE org_id = $1 AND legal_entity_id = ANY($2)
            AND voided_at IS NULL AND default_branch_id IS NOT NULL",
    )
    .bind(org.as_uuid())
    .bind(&entities)
    .fetch_all(tx.as_mut())
    .await
    .map_err(db)?;
    let mut by_entity: BTreeMap<Uuid, BTreeSet<BranchId>> = BTreeMap::new();
    for row in rows {
        by_entity
            .entry(row.try_get("legal_entity_id").map_err(db)?)
            .or_default()
            .insert(BranchId::from_uuid(
                row.try_get("default_branch_id").map_err(db)?,
            ));
    }
    for grant in held {
        if let Some(node) = grant
            .scope
            .node()
            .filter(|n| n.kind == NodeKind::LegalEntity)
        {
            grant.branches =
                BranchScope::Branches(by_entity.get(&node.id).cloned().unwrap_or_default());
        }
    }
    Ok(())
}
