// SPDX-License-Identifier: LicenseRef-Proprietary
//! Live Cedar admission precedes the isolated SQL writer.
use super::*;
use console_platform_authz::{
    Feature,
    access::{NodeKind, NodeRef},
    cedar_pbac::{
        actions::leave_manage,
        visible::{EmployeePlacement, load_facts},
    },
};
use sqlx::types::Json;
use uuid::Uuid;

impl PgLeaveStore {
    pub(super) async fn require_management(
        &self,
        actor: UserId,
        employee: Uuid,
        request_branch: Option<Uuid>,
        target_branch: Option<Uuid>,
    ) -> Result<(), PgLeaveError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn::<_, _, PgLeaveError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let facts = load_facts(tx, org, *actor.as_uuid()).await?;
                let (home, Json(placement)) =
                    sqlx::query_as::<_, (Option<Uuid>, Json<EmployeePlacement>)>(
                        "SELECT e.home_branch_id, jsonb_build_object('org_unit_id',e.org_unit_id, \
                         'workplace_id',ea.workplace_id,'legal_entity_id',ea.legal_entity_id) \
                         FROM person_employees_current e LEFT JOIN employment_resolved_assignments ea \
                         ON ea.org_id=e.org_id AND ea.employee_id=e.id WHERE e.org_id=$1 AND e.id=$2",
                    )
                    .bind(org.as_uuid())
                    .bind(employee)
                    .fetch_optional(tx.as_mut())
                    .await?
                    .ok_or_else(|| {
                        KernelError::forbidden("leave management requires an employee in this tenant")
                    })?;
                let source = if target_branch.is_some() {
                    home
                } else {
                    request_branch
                };
                let roles: Vec<_> = facts.roles().iter().map(String::as_str).collect();
                let tenant = NodeRef {
                    kind: NodeKind::Tenant,
                    id: *org.as_uuid(),
                };
                let mut nodes = vec![(placement.node(org, &facts), source)];
                if let Some(target) = target_branch {
                    if home.is_none() {
                        nodes.push((tenant, None));
                    }
                    for branch in home.into_iter().chain(std::iter::once(target)) {
                        let workplace: Option<Uuid> = sqlx::query_scalar(
                            "SELECT id FROM workplaces WHERE org_id=$1 AND default_branch_id=$2 AND voided_at IS NULL",
                        )
                        .bind(org.as_uuid())
                        .bind(branch)
                        .fetch_optional(tx.as_mut())
                        .await?;
                        let node = workplace.map_or(tenant, |id| NodeRef {
                            kind: NodeKind::Workplace,
                            id,
                        });
                        nodes.push((node, Some(branch)));
                    }
                }
                for (node, branch) in nodes {
                    let manages = facts
                        .authorize(Feature::EmployeeDirectoryManage.as_str(), node)
                        .map_err(|error| KernelError::internal(error.to_string()))?;
                    let member: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM user_branches WHERE org_id=$1 AND user_id=$2 AND branch_id=$3)",
                    )
                    .bind(org.as_uuid())
                    .bind(actor.as_uuid())
                    .bind(branch)
                    .fetch_one(tx.as_mut())
                    .await?;
                    if !leave_manage::decide(
                        &actor.to_string(),
                        &org.to_string(),
                        &roles,
                        manages,
                        member,
                    )
                    .map_err(KernelError::internal)?
                    {
                        return Err(KernelError::forbidden(
                            "leave management is not permitted at this employee or routing scope",
                        )
                        .into());
                    }
                }
                Ok(())
            })
        })
        .await
    }
}
