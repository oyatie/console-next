use crate::policy::rows::fetch_policy_role_assignments_tx;
use crate::policy::validate::{
    normalize_policy_role_ids, normalize_system_roles, validate_custom_policy_roles_tx,
};
use crate::policy::versions::lock_policy_version_tx;
use crate::users::rows::fetch_user_branch_uuid_ids_tx;
use crate::{PgOrgError, PgOrgStore};
use console_identity_application::{
    CreatePolicyAssignmentPreviewReceiptCommand, PolicyAssignmentPreviewReceiptSummary,
};
use console_kernel_core::{KernelError, UserId};
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use sqlx::Row;

impl PgOrgStore {
    /// Persist a short-lived receipt for an assignment impact preview. The
    /// mutating assignment replacement consumes this receipt inside the write
    /// transaction so a client cannot skip preview by sending only a boolean.
    pub async fn create_policy_assignment_preview_receipt(
        &self,
        command: CreatePolicyAssignmentPreviewReceiptCommand,
    ) -> Result<PolicyAssignmentPreviewReceiptSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let actor = command.actor;
        let user_id = command.user_id;
        let current_branch_ids = normalize_policy_role_ids(command.current_branch_ids);
        let current_system_roles = normalize_system_roles(command.current_system_roles);
        let current_role_ids = normalize_policy_role_ids(command.current_role_ids);
        let branch_ids = normalize_policy_role_ids(command.branch_ids);
        let system_roles = normalize_system_roles(command.system_roles);
        let role_ids = normalize_policy_role_ids(command.role_ids);
        let policy_version = command.policy_version;
        let expires_at = command.expires_at;
        with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let row = sqlx::query("SELECT roles FROM users WHERE id = $1 FOR UPDATE")
                        .bind(*user_id.as_uuid())
                        .fetch_optional(tx.as_mut())
                        .await?;
                let Some(row) = row else {
                    return Err(PgOrgError::Domain(KernelError::not_found("user not found")));
                };
                let locked_current_system_roles = normalize_system_roles(row.try_get("roles")?);
                if locked_current_system_roles != current_system_roles {
                    return Err(stale_policy_assignment_preview_error());
                }
                let locked_branch_ids = fetch_user_branch_uuid_ids_tx(tx, user_id).await?;
                if locked_branch_ids != current_branch_ids {
                    return Err(stale_policy_assignment_preview_error());
                }
                let locked_current_role_ids = normalize_policy_role_ids(
                    fetch_policy_role_assignments_tx(tx, user_id)
                        .await?
                        .into_iter()
                        .map(|assignment| assignment.role_id)
                        .collect(),
                );
                if locked_current_role_ids != current_role_ids {
                    return Err(stale_policy_assignment_preview_error());
                }
                let locked_policy_version = lock_policy_version_tx(tx, org_uuid).await?;
                if locked_policy_version != policy_version {
                    return Err(stale_policy_assignment_preview_error());
                }
                validate_custom_policy_roles_tx(tx, &role_ids).await?;
                let row: (uuid::Uuid, time::OffsetDateTime) = sqlx::query_as(
                    r#"
                    INSERT INTO policy_assignment_preview_receipts (
                        org_id, actor_id, user_id, current_branch_ids,
                        current_system_roles, current_role_ids, branch_ids,
                        system_roles, role_ids, policy_version, expires_at
                    ) VALUES ($1, $2, $3, $4::uuid[], $5::text[], $6::uuid[], $7::uuid[], $8::text[], $9::uuid[], $10, $11)
                    RETURNING id, expires_at
                    "#,
                )
                .bind(org_uuid)
                .bind(*actor.as_uuid())
                .bind(*user_id.as_uuid())
                .bind(&current_branch_ids)
                .bind(&current_system_roles)
                .bind(&current_role_ids)
                .bind(&branch_ids)
                .bind(&system_roles)
                .bind(&role_ids)
                .bind(policy_version)
                .bind(expires_at)
                .fetch_one(tx.as_mut())
                .await?;
                Ok(PolicyAssignmentPreviewReceiptSummary {
                    id: row.0,
                    expires_at: row.1,
                })
            })
        })
        .await
    }
}

pub(crate) fn stale_policy_assignment_preview_error() -> PgOrgError {
    PgOrgError::Domain(KernelError::validation(
        "assignment preview receipt is missing, expired, consumed, or no longer matches",
    ))
}

pub(crate) struct AssignmentPreviewReceiptConsumption<'a> {
    pub(crate) actor: UserId,
    pub(crate) user_id: UserId,
    pub(crate) current_branch_ids: &'a [uuid::Uuid],
    pub(crate) current_system_roles: &'a [String],
    pub(crate) current_role_ids: &'a [uuid::Uuid],
    pub(crate) branch_ids: &'a [uuid::Uuid],
    pub(crate) system_roles: &'a [String],
    pub(crate) role_ids: &'a [uuid::Uuid],
    pub(crate) policy_version: i64,
    pub(crate) receipt_id: uuid::Uuid,
    pub(crate) occurred_at: time::OffsetDateTime,
    pub(crate) org_uuid: uuid::Uuid,
}
