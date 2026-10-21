use crate::policy::rows::fetch_policy_role_tx;
use crate::policy::validate::validate_owner_policy_permissions;
use crate::policy::versions::bump_policy_version_tx;
use crate::{PgOrgError, PgOrgStore};
use console_identity_application::{
    PolicyRoleSummary, UpdatePolicyRoleCommand, policy_role_audit_event,
};
use console_kernel_core::{KernelError, TraceContext};
use console_platform_authz::Feature;
use console_platform_db::{insert_audit_event, with_audit};
use console_platform_request_context::current_org;
use sqlx::Row;

impl PgOrgStore {
    /// Update a tenant-owned custom role definition. Runtime authorization is
    /// still unchanged in G016; this edits versioned policy-definition data and
    /// records before/after audit evidence.
    pub async fn update_policy_role(
        &self,
        command: UpdatePolicyRoleCommand,
    ) -> Result<PolicyRoleSummary, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let role_id = command.role_id;
        let display_name = command.display_name;
        let description = command.description;
        let permissions = command.permissions;
        let conditions = command.conditions;
        let actor = command.actor;
        let occurred_at = command.occurred_at;

        let event = policy_role_audit_event(
            "policy.role.update",
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
                let legacy_ai_only = previous
                    .permissions
                    .iter()
                    .any(|permission| permission.feature_key == Feature::AiAssist.as_str())
                    && previous
                        .permissions
                        .iter()
                        .all(|permission| permission.feature_key == Feature::AiAssist.as_str());
                validate_owner_policy_permissions(&permissions, legacy_ai_only)?;

                sqlx::query(
                    r#"
                    UPDATE policy_roles
                    SET display_name = $2,
                        description = $3,
                        updated_by = $4,
                        updated_at = $5
                    WHERE id = $1 AND is_system = false
                    "#,
                )
                .bind(role_id)
                .bind(&display_name)
                .bind(description.as_deref())
                .bind(*actor.as_uuid())
                .bind(occurred_at)
                .execute(tx.as_mut())
                .await?;

                sqlx::query(
                    r#"
                    DELETE FROM policy_role_permissions
                    WHERE org_id = $1 AND role_id = $2 AND feature_key <> 'ai_assist'
                    "#,
                )
                .bind(org_uuid)
                .bind(role_id)
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

                sqlx::query(
                    r#"
                    DELETE FROM policy_role_conditions
                    WHERE org_id = $1 AND role_id = $2
                    "#,
                )
                .bind(org_uuid)
                .bind(role_id)
                .execute(tx.as_mut())
                .await?;
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
                let next = fetch_policy_role_tx(tx, role_id).await?;
                let snapshot_event = policy_role_audit_event(
                    "policy.role.update.snapshot",
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
