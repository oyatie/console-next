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
use super::model::{AccessSubject, GrantState, HeldGrant, NodeKind, NodePath, NodeRef, RoleLine};

fn db(err: sqlx::Error) -> KernelError {
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
    let phase = load_tenant_phase(tx, org).await?;
    let is_ops: bool = sqlx::query_scalar(
        "SELECT is_tenant_ops AND is_active FROM users WHERE org_id = $1 AND id = $2",
    )
    .bind(org.as_uuid())
    .bind(account)
    .fetch_optional(tx.as_mut())
    .await
    .map_err(db)?
    .unwrap_or(false);
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

/// The chain of a 부서: itself and its parent 부서 up to the 사업장 it sits
/// in (the nearest unit with an open placement on a live 사업장), then that
/// 법인 and the tenant. A dissolved 부서, or one under no 사업장, yields a
/// chain without the tenant: the grant still compiles, and the engine refuses
/// every decision on it (GR-27, fail closed).
///
/// # Errors
/// Internal on a query failure.
pub async fn dept_path(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    unit: Uuid,
) -> Result<NodePath, KernelError> {
    let rows = sqlx::query(
        "WITH RECURSIVE heads AS (SELECT DISTINCT ON (org_unit_id) org_unit_id, attributes \
            FROM org_unit_revisions WHERE org_id = $1 ORDER BY org_unit_id, version DESC), \
         up AS (SELECT org_unit_id, attributes, 0 AS depth FROM heads WHERE org_unit_id = $2 \
            UNION ALL SELECT h.org_unit_id, h.attributes, u.depth + 1 FROM heads h \
            JOIN up u ON h.org_unit_id::text = u.attributes->>'parent_id' WHERE u.depth < 64) \
         SELECT up.org_unit_id, up.attributes->>'status' = 'dissolved' AS dissolved, \
                p.workplace_id, COALESCE(p.represents_workplace, false) AS represents, w.legal_entity_id \
           FROM up LEFT JOIN org_unit_placements p ON p.org_id = $1 AND p.org_unit_id = up.org_unit_id \
                AND p.valid_to IS NULL AND p.workplace_id IS NOT NULL \
           LEFT JOIN workplaces w ON w.org_id = $1 AND w.id = p.workplace_id AND w.voided_at IS NULL \
          ORDER BY up.depth",
    )
    .bind(org.as_uuid())
    .bind(unit)
    .fetch_all(tx.as_mut())
    .await
    .map_err(db)?;
    let mut path = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let id: Uuid = row.try_get("org_unit_id").map_err(db)?;
        let dissolved: Option<bool> = row.try_get("dissolved").map_err(db)?;
        if i == 0 && dissolved == Some(true) {
            // The node alone: the grant compiles, its decisions are refused.
            return Ok(NodePath(vec![NodeRef {
                kind: NodeKind::Department,
                id,
            }]));
        }
        let wp: Option<Uuid> = row.try_get("workplace_id").map_err(db)?;
        let le: Option<Uuid> = row.try_get("legal_entity_id").map_err(db)?;
        let represents: bool = row.try_get("represents").map_err(db)?;
        if !(represents && wp.is_some()) {
            path.push(NodeRef {
                kind: NodeKind::Department,
                id,
            });
        }
        if let (Some(wp), Some(le)) = (wp, le) {
            path.extend(scope_path(org, NodeKind::Workplace, Some(wp), Some(le)).0);
            return Ok(NodePath(path));
        }
    }
    // No 사업장 above: the chain stops short of the tenant (refused).
    Ok(NodePath(path))
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
