// SPDX-License-Identifier: LicenseRef-Proprietary
//! Set-based current holders, evaluated once per distinct live role and scope.
use super::db_error;
use console_kernel_core::{BranchId, BranchScope, KernelError, OrgId};
use console_platform_authz::access::project;
use console_platform_authz::{Feature, PermissionLevel};
use sqlx::{Postgres, Row, Transaction};
use std::collections::BTreeSet;
use time::OffsetDateTime;
use uuid::Uuid;

/// What a live holder must be able to do. Case-age/notice eligibility remains
/// the separate D0.2 fact above; current-holder checks must not borrow that age.
#[derive(Clone, Copy)]
pub enum HolderCapability {
    Feature {
        feature: Feature,
        branch: Option<BranchId>,
    },
    OrgChangeDecide,
    AccessAdmin,
}

/// Identity's transaction-bound implementation of the application holder port.
pub struct PgHolderResolver<'a, 't> {
    pub tx: &'a mut Transaction<'t, Postgres>,
    pub org: OrgId,
    pub capability: HolderCapability,
    pub exclude_account: Option<Uuid>,
    pub exclude_employee: Option<Uuid>,
    pub include_ops: bool,
    pub now: OffsetDateTime,
}

impl console_identity_application::holders::HolderResolver for PgHolderResolver<'_, '_> {
    async fn resolve(&mut self) -> Result<BTreeSet<Uuid>, KernelError> {
        self.resolve_at_most(usize::MAX).await
    }
}

impl PgHolderResolver<'_, '_> {
    /// Stop Cedar evaluation once the caller's required holder count is met.
    pub async fn resolve_at_most(&mut self, limit: usize) -> Result<BTreeSet<Uuid>, KernelError> {
        use console_kernel_core::TenantPhase;
        use console_platform_authz::access::{
            AccessSlice, AccessSubject, Domain, HeldGrant, Level, NodeKind, NodePath, RoleLine,
            action_group, scope_path,
        };
        // Role policies are permit-only. Equal live role/scope pairs need one Cedar
        // decision, independent of how many accounts hold that pair.
        let rows = sqlx::query(
            "WITH accounts AS MATERIALIZED (
                SELECT u.id, u.is_tenant_ops FROM users u WHERE u.org_id=$1 AND u.is_active
                  AND ($2::uuid IS NULL OR u.id<>$2)
                  AND ($3::uuid IS NULL OR u.employee_id IS DISTINCT FROM $3)
                  AND ($4 OR NOT u.is_tenant_ops) FOR SHARE OF u
             ), grouped AS (
                SELECT array_agg(DISTINCT u.id) AS accounts, u.is_tenant_ops,
                       r.id AS role_id, r.version, g.scope_kind,
                       COALESCE(g.legal_entity_id,w.legal_entity_id) AS le_id,
                       g.workplace_id, w.default_branch_id, COALESCE(p.phase,'OPERATING') AS phase
                  FROM accounts u
                  LEFT JOIN tenant_phase p ON p.org_id=$1
                  LEFT JOIN access_grants g ON g.org_id=$1 AND g.account_id=u.id
                    AND g.status='ACTIVE' AND g.include_descendants AND g.valid_from<=$5
                    AND (g.valid_to IS NULL OR g.valid_to>$5)
                    AND (COALESCE(p.phase,'OPERATING')<>'SETUP' OR g.effective_in_setup)
                  LEFT JOIN access_roles r ON r.org_id=$1 AND r.id=g.role_id AND r.status='ACTIVE'
                  LEFT JOIN workplaces w ON w.org_id=$1 AND w.id=g.workplace_id AND w.voided_at IS NULL
                 WHERE u.is_tenant_ops OR (r.id IS NOT NULL AND g.scope_kind<>'DEPARTMENT')
                 GROUP BY u.is_tenant_ops, r.id, r.version, g.scope_kind,
                          COALESCE(g.legal_entity_id,w.legal_entity_id), g.workplace_id,
                          w.default_branch_id, p.phase
             ) SELECT grouped.*,
                 (SELECT jsonb_agg(jsonb_build_object('domain',l.domain,'levels',l.levels) ORDER BY l.domain)
                    FROM access_role_lines l WHERE l.org_id=$1 AND l.role_id=grouped.role_id AND l.version=grouped.version) AS lines,
                 ARRAY(SELECT w.default_branch_id FROM workplaces w WHERE w.org_id=$1 AND w.legal_entity_id=grouped.le_id
                    AND w.voided_at IS NULL AND w.default_branch_id IS NOT NULL) AS entity_branches
               FROM grouped",
        )
        .bind(self.org.as_uuid())
        .bind(self.exclude_account)
        .bind(self.exclude_employee)
        .bind(self.include_ops)
        .bind(self.now)
        .fetch_all(self.tx.as_mut())
        .await
        .map_err(db_error)?;
        let mut holders = BTreeSet::new();
        for row in rows {
            if holders.len() >= limit {
                break;
            }
            let accounts: Vec<Uuid> = row.try_get("accounts").map_err(db_error)?;
            if row.try_get::<bool, _>("is_tenant_ops").map_err(db_error)? {
                holders.extend(accounts);
                continue;
            }
            let raw: String = row.try_get("scope_kind").map_err(db_error)?;
            let Some(kind) = NodeKind::parse(&raw) else {
                continue;
            };
            let le: Option<Uuid> = row.try_get("le_id").map_err(db_error)?;
            let wp: Option<Uuid> = row.try_get("workplace_id").map_err(db_error)?;
            let branch: Option<Uuid> = row.try_get("default_branch_id").map_err(db_error)?;
            let branches = match kind {
                NodeKind::Tenant => BranchScope::All,
                NodeKind::Workplace => {
                    BranchScope::Branches(branch.map(BranchId::from_uuid).into_iter().collect())
                }
                NodeKind::LegalEntity => BranchScope::Branches(
                    row.try_get::<Vec<Uuid>, _>("entity_branches")
                        .map_err(db_error)?
                        .into_iter()
                        .map(BranchId::from_uuid)
                        .collect(),
                ),
                // Departments project no branches, so cannot cover these holder queries.
                NodeKind::Department => continue,
            };
            let raw_lines: Option<serde_json::Value> = row.try_get("lines").map_err(db_error)?;
            let mut lines = Vec::new();
            for line in raw_lines
                .as_ref()
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(domain) = line["domain"].as_str().and_then(|s| Domain::parse(s).ok())
                else {
                    continue;
                };
                let levels = line["levels"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|l| l.as_str().and_then(|s| Level::parse(s).ok()))
                    .collect();
                lines.push(RoleLine { domain, levels });
            }
            let role_id: Uuid = row.try_get("role_id").map_err(db_error)?;
            let phase: String = row.try_get("phase").map_err(db_error)?;
            let subject = AccessSubject {
                org: self.org,
                account: role_id,
                is_ops: false,
                phase: TenantPhase::from_db(Some(&phase)),
                grants: vec![HeldGrant {
                    grant_id: role_id,
                    role_id,
                    role_version: row.try_get("version").map_err(db_error)?,
                    lines,
                    scope: scope_path(self.org, kind, wp.or(le), le),
                    branches,
                }],
            };
            let holds = match self.capability {
                HolderCapability::Feature { feature, branch } => {
                    project(&subject).grants.iter().any(|g| {
                        g.feature == feature
                            && g.permission == PermissionLevel::Allow
                            && branch.map_or(g.branch_scope == BranchScope::All, |b| {
                                g.branch_scope.allows(b)
                            })
                    })
                }
                HolderCapability::OrgChangeDecide | HolderCapability::AccessAdmin => {
                    let (domain, level) = match self.capability {
                        HolderCapability::OrgChangeDecide => (Domain::Org, Level::Approve),
                        _ => (Domain::Access, Level::Edit),
                    };
                    AccessSlice::compile(&subject)
                        .and_then(|s| {
                            s.allows(&action_group(domain, level), &NodePath::tenant(self.org))
                        })
                        .unwrap_or(false)
                }
            };
            if holds {
                holders.extend(accounts);
            }
        }
        tracing::debug!(business_event="authz.holders.resolved", org=%self.org, holders=holders.len(), "current holders resolved");
        Ok(holders.into_iter().take(limit).collect())
    }
}
