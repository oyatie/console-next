use crate::policy::rows::{fetch_policy_role_tx, validate_policy_role_status_transition};
use crate::policy::validate::validate_owner_policy_permissions;
use crate::policy::versions::bump_policy_version_tx;
use crate::{PgOrgError, PgOrgStore};
use console_identity_application::{
    CreatePolicyRoleCommand, PolicyRoleSummary, UpdatePolicyRoleStatusCommand,
    policy_role_audit_event,
};
use console_kernel_core::{KernelError, TraceContext};
use console_platform_db::{insert_audit_event, with_audit};
use console_platform_request_context::current_org;
use sqlx::Row;

impl PgOrgStore {
    /// Create a tenant-owned custom role definition and bump the tenant policy
    /// version in the same audited transaction. G016-P0 definitions do not yet
    /// become effective login grants; they are durable policy catalog rows.
    pub async fn create_policy_role(
        &self,
        command: CreatePolicyRoleCommand,
    ) -> Result<PolicyRoleSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let role_id = uuid::Uuid::new_v4();
        let role_key = command.role_key;
        let display_name = command.display_name;
        let description = command.description;
        let permissions = command.permissions;
        let conditions = command.conditions;
        let occurred_at = command.occurred_at;
        let actor = command.actor;

        validate_owner_policy_permissions(&permissions, false)?;

        let event = policy_role_audit_event(
            "policy.role.create",
            Some(actor),
            role_id,
            command.trace,
            occurred_at,
        )?
        .with_org(org)
        .with_snapshots(
            None,
            Some(serde_json::json!({
                "role_key": &role_key,
                "display_name": &display_name,
                "description": &description,
                "status": "DRAFT",
                "permissions": &permissions,
                "conditions": &conditions,
            })),
        );

        with_audit::<_, PolicyRoleSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                sqlx::query(
                    r#"
                    INSERT INTO policy_roles (
                        id, org_id, role_key, display_name, description, status,
                        is_system, created_by, updated_by, created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, 'DRAFT', false, $6, $6, $7, $7)
                    "#,
                )
                .bind(role_id)
                .bind(org_uuid)
                .bind(&role_key)
                .bind(&display_name)
                .bind(description.as_deref())
                .bind(*actor.as_uuid())
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;

                for permission in &permissions {
                    sqlx::query(
                        r#"
                        INSERT INTO policy_role_permissions (
                            org_id, role_id, feature_key, permission_level
                        ) VALUES ($1, $2, $3, $4)
                        "#,
                    )
                    .bind(org_uuid)
                    .bind(role_id)
                    .bind(&permission.feature_key)
                    .bind(&permission.permission_level)
                    .execute(tx.as_mut())
                    .await?;
                }

                for condition in &conditions {
                    sqlx::query(
                        r#"
                        INSERT INTO policy_role_conditions (
                            org_id, role_id, condition_key, attribute, operator, condition_values
                        ) VALUES ($1, $2, $3, $4, $5, $6)
                        "#,
                    )
                    .bind(org_uuid)
                    .bind(role_id)
                    .bind(&condition.condition_key)
                    .bind(&condition.attribute)
                    .bind(&condition.operator)
                    .bind(&condition.values)
                    .execute(tx.as_mut())
                    .await?;
                }

                bump_policy_version_tx(tx, org_uuid, occurred_at).await?;
                fetch_policy_role_tx(tx, role_id).await
            })
        })
        .await
    }

    /// Change a custom role lifecycle state. The REST layer owns the passkey
    /// step-up; this adapter owns the RLS-scoped mutation, audit snapshot, and
    /// policy-version bump.
    pub async fn update_policy_role_status(
        &self,
        command: UpdatePolicyRoleStatusCommand,
    ) -> Result<PolicyRoleSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let role_id = command.role_id;
        let status = command.status;
        let actor = command.actor;
        let occurred_at = command.occurred_at;

        let event = policy_role_audit_event(
            "policy.role.status_update",
            Some(actor),
            role_id,
            command.trace,
            occurred_at,
        )?
        .with_org(org);

        with_audit::<_, PolicyRoleSummary, PgOrgError>(&self.pool, event, |tx| {
            Box::pin(async move {
                let row = sqlx::query(
                    r#"
                    SELECT is_system
                    FROM policy_roles
                    WHERE id = $1
                    FOR UPDATE
                    "#,
                )
                .bind(role_id)
                .fetch_optional(tx.as_mut())
                .await?;

                let Some(row) = row else {
                    return Err(PgOrgError::Domain(KernelError::not_found(
                        "policy role not found",
                    )));
                };
                if row.try_get::<bool, _>("is_system")? {
                    return Err(PgOrgError::Domain(KernelError::validation(
                        "system policy roles cannot be changed",
                    )));
                }

                let previous = fetch_policy_role_tx(tx, role_id).await?;
                validate_policy_role_status_transition(&previous.status, &status)?;
                if previous.status != status {
                    sqlx::query(
                        r#"
                        UPDATE policy_roles
                        SET status = $2, updated_by = $3, updated_at = $4
                        WHERE id = $1 AND is_system = false
                        "#,
                    )
                    .bind(role_id)
                    .bind(&status)
                    .bind(*actor.as_uuid())
                    .bind(occurred_at)
                    .execute(tx.as_mut())
                    .await?;
                    bump_policy_version_tx(tx, org_uuid, occurred_at).await?;
                }

                let next = fetch_policy_role_tx(tx, role_id).await?;
                let snapshot_event = policy_role_audit_event(
                    "policy.role.status_update.snapshot",
                    Some(actor),
                    role_id,
                    TraceContext::generate(),
                    occurred_at,
                )?
                .with_org(org)
                .with_snapshots(
                    Some(serde_json::json!({ "role": &previous })),
                    Some(serde_json::json!({ "role": &next })),
                );
                insert_audit_event(tx, &snapshot_event).await?;
                Ok(next)
            })
        })
        .await
    }
}
