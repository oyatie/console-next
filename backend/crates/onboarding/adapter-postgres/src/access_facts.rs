//! One account read and one grant read for both current setup counts and prospective operating access.
use crate::PgOnboardingError;
use console_kernel_core::{BranchScope, OrgId, TenantPhase};
use console_onboarding_domain::{Account, PreviewDetails, RoleActivation, SetupFacts};
use console_platform_authz::access::{
    AccessSlice, AccessSubject, Domain, HeldGrant, Level, NodeKind, NodePath, RoleLine, scope_path,
};
use sqlx::{Postgres, Row, Transaction};
use std::collections::BTreeMap;
use uuid::Uuid;

pub(crate) async fn load(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
) -> Result<(SetupFacts, PreviewDetails), PgOnboardingError> {
    let accounts = sqlx::query("SELECT id, display_name, is_tenant_ops, EXISTS (SELECT 1 FROM auth_webauthn_credentials c WHERE c.user_id = users.id) AS enrolled FROM person_accounts_current users WHERE is_active ORDER BY id")
        .fetch_all(tx.as_mut()).await?;
    let mut subjects = BTreeMap::new();
    let mut names = BTreeMap::new();
    let mut facts = SetupFacts::default();
    for r in accounts {
        let id: Uuid = r.try_get("id")?;
        let is_ops: bool = r.try_get("is_tenant_ops")?;
        names.insert(
            id,
            Account {
                id: id.to_string(),
                name: r.try_get("display_name")?,
            },
        );
        subjects.insert(
            id,
            AccessSubject {
                org,
                account: id,
                is_ops,
                phase: TenantPhase::Operating,
                grants: Vec::new(),
            },
        );
        if !is_ops {
            facts.hr_accounts_invited += 1;
            facts.hr_accounts_enrolled += i64::from(r.try_get::<bool, _>("enrolled")?);
        }
    }
    let rows = sqlx::query(
        "SELECT g.id, g.account_id, g.role_id, r.version, r.name_ko AS role, g.effective_in_setup, \
         g.scope_kind, COALESCE(g.legal_entity_id, w.legal_entity_id) AS le_id, g.workplace_id, l.domain, l.levels, \
         COALESCE((SELECT name FROM workplace_revisions WHERE workplace_id = w.id ORDER BY version DESC LIMIT 1), \
                  (SELECT name FROM legal_entity_revisions WHERE legal_entity_id = g.legal_entity_id ORDER BY version DESC LIMIT 1), '') AS scope \
         FROM access_grants g JOIN access_roles r ON r.org_id = g.org_id AND r.id = g.role_id AND r.status = 'ACTIVE' \
         JOIN access_role_lines l ON l.org_id = r.org_id AND l.role_id = r.id AND l.version = r.version \
         LEFT JOIN workplaces w ON w.org_id = g.org_id AND w.id = g.workplace_id AND w.voided_at IS NULL AND w.closed_on IS NULL \
         WHERE g.status = 'ACTIVE' AND g.include_descendants AND g.scope_kind <> 'DEPARTMENT' \
           AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now()) ORDER BY g.account_id, g.id, l.domain"
    ).fetch_all(tx.as_mut()).await?;
    let mut grants: BTreeMap<(Uuid, Uuid), HeldGrant> = BTreeMap::new();
    let mut roles: BTreeMap<(Uuid, String, String), RoleActivation> = BTreeMap::new();
    for r in rows {
        let account: Uuid = r.try_get("account_id")?;
        let Some(subject) = subjects.get(&account) else {
            continue;
        };
        let grant_id: Uuid = r.try_get("id")?;
        let kind: String = r.try_get("scope_kind")?;
        let Some(node_kind) = NodeKind::parse(&kind) else {
            continue;
        };
        let le: Option<Uuid> = r.try_get("le_id")?;
        let wp: Option<Uuid> = r.try_get("workplace_id")?;
        if (node_kind == NodeKind::LegalEntity && le.is_none())
            || (node_kind == NodeKind::Workplace && (wp.is_none() || le.is_none()))
        {
            continue;
        }
        let domain: String = r.try_get("domain")?;
        let Ok(domain) = Domain::parse(&domain) else {
            continue;
        };
        let levels: Vec<String> = r.try_get("levels")?;
        let levels: Vec<Level> = levels.iter().filter_map(|l| Level::parse(l).ok()).collect();
        let role_id: Uuid = r.try_get("role_id")?;
        let role_version = r.try_get("version")?;
        let new_grant = !grants.contains_key(&(account, grant_id));
        grants
            .entry((account, grant_id))
            .or_insert_with(|| HeldGrant {
                grant_id,
                role_id,
                role_version,
                lines: Vec::new(),
                scope: scope_path(org, node_kind, wp.or(le), le),
                branches: BranchScope::Branches(Default::default()),
            })
            .lines
            .push(RoleLine { domain, levels });
        let setup: bool = r.try_get("effective_in_setup")?;
        if new_grant {
            facts.grants_effective_in_setup += i64::from(setup);
            facts.prepared_grants += i64::from(!setup);
            facts.non_ops_grants += i64::from(!subject.is_ops);
        }
        if !setup {
            let scope_id = wp.or(le).unwrap_or(*org.as_uuid()).to_string();
            let activation = roles
                .entry((role_id, kind.clone(), scope_id.clone()))
                .or_insert(RoleActivation {
                    role_id: role_id.to_string(),
                    role: r.try_get("role")?,
                    holders: Vec::new(),
                    scope_kind: kind,
                    scope_id,
                    scope: r.try_get("scope")?,
                });
            if let Some(holder) = names
                .get(&account)
                .filter(|a| !activation.holders.contains(a))
            {
                activation.holders.push(holder.clone());
            }
        }
    }
    for ((account, _), grant) in grants {
        if let Some(s) = subjects.get_mut(&account) {
            s.grants.push(grant);
        }
    }
    let mut details = PreviewDetails {
        roles_becoming_active: roles.into_values().collect(),
        ..PreviewDetails::default()
    };
    for (id, s) in subjects {
        if let Some(account) = names.get(&id) {
            if !s.is_ops && s.grants.is_empty() {
                details.hr_accounts_with_no_grant.push(account.clone());
            }
            if AccessSlice::compile(&s)
                .and_then(|slice| slice.allows("access::approve", &NodePath::tenant(org)))
                == Ok(true)
            {
                details.access_admin_holders.push(account.clone());
            }
        }
    }
    facts.access_admin_holders =
        i64::try_from(details.access_admin_holders.len()).unwrap_or(i64::MAX);
    Ok((facts, details))
}
