// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::ProvisioningError;
use console_kernel_core::{OrgId, UserId};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use super::company_domain::{CompanyDomainAlias, TenantDomainRequestState};

pub(super) async fn load_state_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
) -> Result<TenantDomainRequestState, ProvisioningError> {
    let pending_row = sqlx::query(
        "SELECT r.slug, r.requested_by, r.requested_at, u.display_name AS requested_by_name
           FROM organization_domain_requests r
           LEFT JOIN person_accounts_current u
             ON u.org_id = r.org_id AND u.id = r.requested_by
          WHERE r.org_id = $1 AND r.resolved_at IS NULL",
    )
    .bind(org.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?;
    let current_domain: Option<String> =
        sqlx::query_scalar("SELECT slug FROM organizations WHERE id = $1")
            .bind(org.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?;
    let account_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM user_sign_in_ids WHERE org_id = $1 AND retired_at IS NULL",
    )
    .bind(org.as_uuid())
    .fetch_one(tx.as_mut())
    .await?;
    let alias_rows = sqlx::query(
        "SELECT slug, retired_at, alias_until
           FROM organization_domains
          WHERE org_id = $1 AND retired_at IS NOT NULL
          ORDER BY retired_at DESC, slug",
    )
    .bind(org.as_uuid())
    .fetch_all(tx.as_mut())
    .await?;
    let mut domain_aliases = Vec::with_capacity(alias_rows.len());
    for row in alias_rows {
        domain_aliases.push(CompanyDomainAlias {
            slug: row.try_get("slug")?,
            retired_at: row.try_get("retired_at")?,
            alias_until: row.try_get("alias_until")?,
        });
    }
    let requested_by: Option<Uuid> = pending_row
        .as_ref()
        .map(|r| r.try_get("requested_by"))
        .transpose()?;
    Ok(TenantDomainRequestState {
        pending_domain: pending_row
            .as_ref()
            .map(|r| r.try_get("slug"))
            .transpose()?,
        requested_by,
        requested_by_name: pending_row
            .as_ref()
            .map(|r| r.try_get("requested_by_name"))
            .transpose()?
            .flatten(),
        requested_at: pending_row
            .as_ref()
            .map(|r| r.try_get("requested_at"))
            .transpose()?,
        current_domain,
        account_count,
        domain_aliases,
    })
}

pub(super) async fn begin_domain_request(
    pool: &sqlx::PgPool,
    actor: UserId,
    org: OrgId,
) -> Result<Transaction<'static, Postgres>, ProvisioningError> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await?;
    console_platform_auth::lock_account_tx(&mut tx, org, *actor.as_uuid()).await?;
    let tenant_ops: Option<bool> = sqlx::query_scalar(
        "SELECT is_tenant_ops AND is_active FROM users WHERE id=$1 AND org_id=$2",
    )
    .bind(actor.as_uuid())
    .bind(org.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?;
    if !console_platform_authz::cedar_pbac::actions::company_domain_request::decide(
        &actor.to_string(),
        &org.to_string(),
        &org.to_string(),
        tenant_ops == Some(true),
    ) {
        return Err(ProvisioningError::DomainRequestForbidden);
    }
    sqlx::query("SELECT slug FROM platform_lock_organization($1)")
        .bind(org.as_uuid())
        .fetch_optional(tx.as_mut())
        .await?;
    Ok(tx)
}
