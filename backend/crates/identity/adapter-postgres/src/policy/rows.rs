use crate::PgOrgError;
use console_identity_application::{
    PolicyRoleAssignmentSummary, PolicyRoleCondition, PolicyRolePermission, PolicyRoleSummary,
};
use console_kernel_core::{KernelError, UserId};
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use sqlx::{PgPool, Postgres, Row, Transaction};

pub(crate) async fn fetch_policy_role(
    pool: &PgPool,
    role_id: uuid::Uuid,
) -> Result<PolicyRoleSummary, PgOrgError> {
    let org = current_org().map_err(KernelError::from)?;
    let row = with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
        Box::pin(async move {
            Ok(sqlx::query(
                r#"
                SELECT id, role_key, display_name, description, status, is_system, created_at, updated_at
                FROM policy_roles
                WHERE id = $1
                "#,
            )
            .bind(role_id)
            .fetch_one(tx.as_mut())
            .await?)
        })
    })
    .await?;
    let permissions = fetch_policy_role_permissions(pool, role_id).await?;
    let conditions = fetch_policy_role_conditions(pool, role_id).await?;
    policy_role_from_row(&row, permissions, conditions)
}

pub(crate) async fn fetch_policy_role_tx(
    tx: &mut Transaction<'_, Postgres>,
    role_id: uuid::Uuid,
) -> Result<PolicyRoleSummary, PgOrgError> {
    let row = sqlx::query(
        r#"
        SELECT id, role_key, display_name, description, status, is_system, created_at, updated_at
        FROM policy_roles
        WHERE id = $1
        "#,
    )
    .bind(role_id)
    .fetch_one(tx.as_mut())
    .await?;
    let permissions = fetch_policy_role_permissions_tx(tx, role_id).await?;
    let conditions = fetch_policy_role_conditions_tx(tx, role_id).await?;
    policy_role_from_row(&row, permissions, conditions)
}

async fn fetch_policy_role_permissions(
    pool: &PgPool,
    role_id: uuid::Uuid,
) -> Result<Vec<PolicyRolePermission>, PgOrgError> {
    let org = current_org().map_err(KernelError::from)?;
    with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
        Box::pin(async move { fetch_policy_role_permissions_tx(tx, role_id).await })
    })
    .await
}

async fn fetch_policy_role_permissions_tx(
    tx: &mut Transaction<'_, Postgres>,
    role_id: uuid::Uuid,
) -> Result<Vec<PolicyRolePermission>, PgOrgError> {
    let rows = sqlx::query(
        r#"
        SELECT feature_key, permission_level
        FROM policy_role_permissions
        WHERE role_id = $1
        ORDER BY feature_key
        "#,
    )
    .bind(role_id)
    .fetch_all(tx.as_mut())
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(PolicyRolePermission {
                feature_key: row.try_get("feature_key")?,
                permission_level: row.try_get("permission_level")?,
            })
        })
        .collect()
}

async fn fetch_policy_role_conditions(
    pool: &PgPool,
    role_id: uuid::Uuid,
) -> Result<Vec<PolicyRoleCondition>, PgOrgError> {
    let org = current_org().map_err(KernelError::from)?;
    with_org_conn::<_, _, PgOrgError>(pool, org, move |tx| {
        Box::pin(async move { fetch_policy_role_conditions_tx(tx, role_id).await })
    })
    .await
}

async fn fetch_policy_role_conditions_tx(
    tx: &mut Transaction<'_, Postgres>,
    role_id: uuid::Uuid,
) -> Result<Vec<PolicyRoleCondition>, PgOrgError> {
    let rows = sqlx::query(
        r#"
        SELECT condition_key, attribute, operator, condition_values
        FROM policy_role_conditions
        WHERE role_id = $1
        ORDER BY condition_key
        "#,
    )
    .bind(role_id)
    .fetch_all(tx.as_mut())
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(PolicyRoleCondition {
                condition_key: row.try_get("condition_key")?,
                attribute: row.try_get("attribute")?,
                operator: row.try_get("operator")?,
                values: row.try_get("condition_values")?,
            })
        })
        .collect()
}

pub(crate) async fn fetch_policy_role_assignments_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<Vec<PolicyRoleAssignmentSummary>, PgOrgError> {
    let rows = sqlx::query(
        r#"
        SELECT
            ura.user_id,
            ura.role_id,
            pr.role_key,
            pr.display_name,
            pr.status,
            ura.assigned_by,
            ura.created_at
        FROM user_role_assignments ura
        JOIN policy_roles pr
          ON pr.id = ura.role_id
         AND pr.org_id = ura.org_id
        WHERE ura.user_id = $1
        ORDER BY pr.role_key
        "#,
    )
    .bind(*user_id.as_uuid())
    .fetch_all(tx.as_mut())
    .await?;
    rows.into_iter()
        .map(|row| {
            let assigned_by: Option<uuid::Uuid> = row.try_get("assigned_by")?;
            Ok(PolicyRoleAssignmentSummary {
                user_id: UserId::from_uuid(row.try_get("user_id")?),
                role_id: row.try_get("role_id")?,
                role_key: row.try_get("role_key")?,
                display_name: row.try_get("display_name")?,
                status: row.try_get("status")?,
                assigned_by: assigned_by.map(UserId::from_uuid),
                created_at: row.try_get("created_at")?,
            })
        })
        .collect()
}

fn policy_role_from_row(
    row: &sqlx::postgres::PgRow,
    permissions: Vec<PolicyRolePermission>,
    conditions: Vec<PolicyRoleCondition>,
) -> Result<PolicyRoleSummary, PgOrgError> {
    Ok(PolicyRoleSummary {
        id: row.try_get("id")?,
        role_key: row.try_get("role_key")?,
        display_name: row.try_get("display_name")?,
        description: row.try_get("description")?,
        status: row.try_get("status")?,
        is_system: row.try_get("is_system")?,
        permissions,
        conditions,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

pub(crate) fn validate_policy_role_status_transition(
    current_status: &str,
    requested_status: &str,
) -> Result<(), PgOrgError> {
    if current_status == requested_status {
        return Ok(());
    }
    match (current_status, requested_status) {
        ("DRAFT", "ACTIVE") | ("ACTIVE", "DRAFT") | ("ACTIVE", "RETIRED") => Ok(()),
        _ => Err(PgOrgError::Domain(KernelError::validation(
            "policy role status transition is not allowed",
        ))),
    }
}
