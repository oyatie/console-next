use crate::{
    GroupAccountSummary, GroupMemberSummary, GroupSummary, OrganizationSummary, ProvisioningError,
};
use sqlx::{Postgres, Row, Transaction, types::Json};
use uuid::Uuid;

pub(crate) fn group_from_row(
    row: sqlx::postgres::PgRow,
) -> Result<GroupSummary, ProvisioningError> {
    let Json(members): Json<Vec<GroupMemberSummary>> = row.try_get("members")?;
    Ok(GroupSummary {
        id: row.try_get("id")?,
        slug: row.try_get("slug")?,
        name: row.try_get("name")?,
        status: row.try_get("status")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        member_count: row.try_get("member_count")?,
        members,
    })
}

pub(crate) fn group_account_from_row(
    row: sqlx::postgres::PgRow,
) -> Result<GroupAccountSummary, ProvisioningError> {
    Ok(GroupAccountSummary {
        person_id: row.try_get("person_id")?,
        principal_kind: row.try_get("principal_kind")?,
        user_id: row.try_get("user_id")?,
        display_name: row.try_get("display_name")?,
        phone: row.try_get("phone")?,
        tenant_roles: row.try_get("tenant_roles")?,
        is_active: row.try_get("is_active")?,
        has_passkey: row.try_get("has_passkey")?,
        account_status: row.try_get("account_status")?,
        org_id: row.try_get("org_id")?,
        org_slug: row.try_get("org_slug")?,
        org_name: row.try_get("org_name")?,
        group_roles: row.try_get("group_roles")?,
        created_at: row.try_get("created_at")?,
    })
}

/// Read one platform group by id via the SECURITY DEFINER `platform_get_group`.
pub(crate) async fn fetch_group_tx(
    tx: &mut Transaction<'_, Postgres>,
    group_id: Uuid,
) -> Result<GroupSummary, ProvisioningError> {
    let row = sqlx::query(
        r#"
        SELECT id, slug, name, status, created_at, updated_at, member_count, members
        FROM platform_get_group($1)
        "#,
    )
    .bind(group_id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| ProvisioningError::NotFound("group not found".to_owned()))?;

    group_from_row(row)
}

/// Read one platform group account through the narrow account listing function.
pub(crate) async fn fetch_group_account_tx(
    tx: &mut Transaction<'_, Postgres>,
    group_id: Uuid,
    user_id: Uuid,
) -> Result<GroupAccountSummary, ProvisioningError> {
    let row = sqlx::query(
        r#"
        SELECT
            user_id, person_id, principal_kind, display_name, phone, tenant_roles, is_active,
            has_passkey, account_status, org_id, org_slug, org_name,
            group_roles, created_at
        FROM platform_list_group_person_accounts($1)
        WHERE user_id = $2
        "#,
    )
    .bind(group_id)
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| ProvisioningError::NotFound("group account not found".to_owned()))?;

    group_account_from_row(row)
}

pub(crate) fn map_group_write_error(err: sqlx::Error) -> ProvisioningError {
    if let sqlx::Error::Database(db) = &err {
        match db.code().as_deref() {
            Some("23505") => {
                return ProvisioningError::Conflict(
                    "group slug or organization membership already exists".to_owned(),
                );
            }
            Some("23514") => {
                return ProvisioningError::InvalidRoster(
                    "group input violates status or slug constraints".to_owned(),
                );
            }
            _ => {}
        }
    }
    ProvisioningError::Sqlx(err)
}

/// Read one organization by id via the SECURITY DEFINER `platform_get_organization`
/// so the platform path sees the row regardless of the tenant GUC state.
pub(crate) async fn fetch_org_tx(
    tx: &mut Transaction<'_, Postgres>,
    org_id: Uuid,
) -> Result<OrganizationSummary, ProvisioningError> {
    let row = sqlx::query(
        r#"
        SELECT
            id, slug, name, status, created_at, updated_at,
            group_id, group_slug, group_name, platform_organization_domain_aliases(id) AS domain_aliases, platform_organization_pending_domain(id) AS pending_domain, facts.*
        FROM platform_get_organization($1) CROSS JOIN LATERAL platform_tenant_facts(id) facts
        "#,
    )
    .bind(org_id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or(ProvisioningError::InvalidBootstrapCredential)?;

    Ok(OrganizationSummary {
        id: row.try_get("id")?,
        slug: row.try_get("slug")?,
        domain_aliases: row.try_get("domain_aliases")?,
        pending_domain: row.try_get("pending_domain")?,
        removable: row.try_get("removable")?,
        removal_refusal: row.try_get("removal_refusal")?,
        lifecycle: row.try_get("lifecycle")?,
        code_issued_count: row.try_get("code_issued_count")?,
        passkey_registered_count: row.try_get("passkey_registered_count")?,
        name: row.try_get("name")?,
        status: row.try_get("status")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        group_id: row.try_get("group_id")?,
        group_slug: row.try_get("group_slug")?,
        group_name: row.try_get("group_name")?,
    })
}
