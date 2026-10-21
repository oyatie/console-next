//! The caller's reach over 법인 · 사업장 (decisions #15; worst-case-08): the
//! ops account and a whole-tenant reach see everything; anyone else reaches
//! only the 법인 and 사업장 their grants that count now name, plus the 사업장
//! their legacy branches back. Reads, counts and Cedar scope facts all take
//! it, so an out-of-scope 사업장 is neither listed nor counted.

use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::EntityScope;
use console_kernel_core::{BranchScope, KernelError};
use console_platform_authz::Principal;
use console_platform_authz::access::{NodeKind, load_access_subject};
use console_platform_db::{DbError, with_org_conn};
use time::OffsetDateTime;
use uuid::Uuid;

struct Load(String);

impl From<DbError> for Load {
    fn from(err: DbError) -> Self {
        Self(err.to_string())
    }
}

/// What the grants alone decide: the whole tenant, or the named nodes.
fn granted(nodes: impl IntoIterator<Item = (NodeKind, Uuid)>) -> Option<Vec<Uuid>> {
    let mut ids = Vec::new();
    for (kind, id) in nodes {
        match kind {
            NodeKind::Tenant => return None,
            NodeKind::LegalEntity | NodeKind::Workplace => ids.push(id),
            // Never loaded in the pilot (load.rs); a 부서 never widens.
            NodeKind::Department => {}
        }
    }
    Some(ids)
}

/// # Errors
/// The grants or the 사업장 could not be read (the request fails closed).
pub(crate) async fn reach(
    store: &PgEntityStore,
    p: &Principal,
) -> Result<EntityScope, KernelError> {
    let branches = match &p.branch_scope {
        _ if p.is_tenant_ops => return Ok(EntityScope::Tenant),
        BranchScope::All => return Ok(EntityScope::Tenant),
        BranchScope::Branches(set) => set.iter().map(|b| *b.as_uuid()).collect::<Vec<_>>(),
    };
    let (org, account) = (p.org_id, *p.user_id.as_uuid());
    let subject = with_org_conn::<_, _, Load>(store.pool(), org, move |tx| {
        Box::pin(async move {
            load_access_subject(tx, org, account, OffsetDateTime::now_utc())
                .await
                .map_err(|e| Load(e.to_string()))
        })
    })
    .await
    .map_err(|Load(e)| KernelError::internal(format!("access grants unavailable: {e}")))?;
    let nodes = subject
        .grants
        .iter()
        .filter_map(|g| g.scope.node())
        .map(|n| (n.kind, n.id));
    let Some(mut ids) = granted(nodes) else {
        return Ok(EntityScope::Tenant);
    };
    ids.extend(
        store
            .workplaces_on_branches(org, &branches)
            .await
            .map_err(|e| KernelError::internal(format!("workplaces unavailable: {e}")))?,
    );
    ids.sort_unstable();
    ids.dedup();
    Ok(EntityScope::Only(ids))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tenant_grant_reaches_everything_and_a_department_never_widens() {
        let (le, wp, dept) = (Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3));
        assert_eq!(
            granted([(NodeKind::LegalEntity, le), (NodeKind::Tenant, Uuid::nil())]),
            None
        );
        assert_eq!(
            granted([
                (NodeKind::LegalEntity, le),
                (NodeKind::Workplace, wp),
                (NodeKind::Department, dept)
            ]),
            Some(vec![le, wp])
        );
        assert_eq!(granted([]), Some(vec![]));
    }
}
