//! SQL for grants and their preview receipts.

use console_kernel_core::{OrgId, TenantPhase};
use console_platform_authz::access::{GrantState, NodeKind};
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::dto::{GrantOut, ScopeOut};
use crate::error::{AccessError, AccessResult};

#[cfg(test)]
mod tests;

type Tx<'a, 'b> = &'a mut Transaction<'b, Postgres>;

/// One stored grant with what its checks need.
#[derive(Debug, Clone)]
pub(crate) struct GrantRow {
    pub id: Uuid,
    pub account_id: Uuid,
    pub role_id: Uuid,
    pub kind: NodeKind,
    pub node_id: Option<Uuid>,
    pub valid_from: OffsetDateTime,
    pub valid_to: Option<OffsetDateTime>,
    pub revoked: bool,
    pub effective_in_setup: bool,
}

const GRANT_COLUMNS: &str = "g.id, g.account_id, g.role_id, g.scope_kind, \
     COALESCE(g.legal_entity_id, g.workplace_id, g.org_unit_id) AS node_id, g.include_descendants, \
     g.valid_from, g.valid_to, g.status, CASE WHEN g.status = 'PENDING' THEN p.activates_at END AS activates_at, g.effective_in_setup, g.reason_code, g.reason_note, \
     g.granted_by, g.granted_at, g.revoked_by, g.revoked_at, \
     r.name_ko AS role_name_ko, r.status = 'ACTIVE' AS role_active, u.display_name, \
     u.is_active AS account_active, EXISTS (SELECT 1 FROM auth_webauthn_credentials c \
       WHERE c.org_id = g.org_id AND c.user_id = g.account_id) AS account_has_passkey, \
     e.org_unit AS account_unit, e.employee_number AS account_employee_number";

fn kind_of(row: &sqlx::postgres::PgRow) -> AccessResult<NodeKind> {
    let raw: String = row.try_get("scope_kind")?;
    NodeKind::parse(&raw).ok_or_else(|| AccessError::internal("unknown stored scope kind"))
}

pub(crate) async fn account(
    tx: Tx<'_, '_>,
    org: OrgId,
    id: Uuid,
) -> AccessResult<Option<(bool, bool)>> {
    let row =
        sqlx::query("SELECT is_active, is_tenant_ops FROM users WHERE org_id = $1 AND id = $2")
            .bind(org.as_uuid())
            .bind(id)
            .fetch_optional(tx.as_mut())
            .await?;
    row.map(|r| Ok((r.try_get("is_active")?, r.try_get("is_tenant_ops")?)))
        .transpose()
}

/// The role's status and current version.
pub(crate) async fn role_head(
    tx: Tx<'_, '_>,
    org: OrgId,
    id: Uuid,
) -> AccessResult<Option<(String, i32)>> {
    let row = sqlx::query("SELECT status, version FROM access_roles WHERE org_id = $1 AND id = $2")
        .bind(org.as_uuid())
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await?;
    row.map(|r| Ok((r.try_get("status")?, r.try_get("version")?)))
        .transpose()
}

pub(crate) async fn grant_row(
    tx: Tx<'_, '_>,
    org: OrgId,
    id: Uuid,
    lock: bool,
) -> AccessResult<Option<GrantRow>> {
    let lock = if lock { " FOR UPDATE" } else { "" };
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT id, account_id, role_id, scope_kind,
                COALESCE(legal_entity_id, workplace_id, org_unit_id) AS node_id,
                valid_from, valid_to, status, effective_in_setup
           FROM access_grants WHERE org_id = $1 AND id = $2{lock}"
    )))
    .bind(org.as_uuid())
    .bind(id)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(GrantRow {
        id: row.try_get("id")?,
        account_id: row.try_get("account_id")?,
        role_id: row.try_get("role_id")?,
        kind: kind_of(&row)?,
        node_id: row.try_get("node_id")?,
        valid_from: row.try_get("valid_from")?,
        valid_to: row.try_get("valid_to")?,
        revoked: row.try_get::<String, _>("status")? == "REVOKED",
        effective_in_setup: row.try_get("effective_in_setup")?,
    }))
}

/// An ACTIVE grant of the same role over the same scope overlapping the period.
pub(crate) async fn overlaps(tx: Tx<'_, '_>, org: OrgId, g: &GrantRow) -> AccessResult<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM access_grants
          WHERE org_id = $1 AND account_id = $2 AND role_id = $3 AND status IN ('ACTIVE', 'PENDING') AND id <> $4
            AND scope_kind = $5 AND include_descendants
            AND COALESCE(legal_entity_id, workplace_id, org_unit_id) IS NOT DISTINCT FROM $6
            AND tstzrange(valid_from, valid_to) && tstzrange($7, $8))",
    )
    .bind(org.as_uuid())
    .bind(g.account_id)
    .bind(g.role_id)
    .bind(g.id)
    .bind(g.kind.as_str())
    .bind(g.node_id)
    .bind(g.valid_from)
    .bind(g.valid_to)
    .fetch_one(tx.as_mut())
    .await?)
}

/// The fields of a new grant beyond its [`GrantRow`].
pub(crate) struct NewGrant<'a> {
    pub row: &'a GrantRow,
    pub change_mode: &'a str,
    pub reason_code: &'a str,
    pub reason_note: Option<&'a str>,
    pub granted_by: Uuid,
}

fn overlap_conflict(err: sqlx::Error) -> AccessError {
    let overlap = err
        .as_database_error()
        .and_then(|e| e.constraint())
        .is_some_and(|c| c == "access_grants_no_overlap");
    if overlap {
        AccessError::conflict(
            "grant_overlap",
            "the account already holds this role over this scope then",
        )
    } else {
        AccessError::from(err)
    }
}

#[cfg(test)]
pub(crate) async fn insert(tx: Tx<'_, '_>, org: OrgId, g: &NewGrant<'_>) -> AccessResult<()> {
    let activates_at =
        crate::pending::deadline(tx, org, g.row.role_id, &console_kernel_core::SystemClock).await?;
    insert_with_deadline(tx, org, g, activates_at).await
}

pub(crate) async fn insert_with_deadline(
    tx: Tx<'_, '_>,
    org: OrgId,
    g: &NewGrant<'_>,
    activates_at: Option<OffsetDateTime>,
) -> AccessResult<()> {
    let node = g.row.node_id;
    let pick = |k: NodeKind| if g.row.kind == k { node } else { None };
    sqlx::query(
        "INSERT INTO access_grants (org_id, id, account_id, role_id, scope_kind, legal_entity_id,
                workplace_id, org_unit_id, include_descendants, valid_from, valid_to, effective_in_setup,
                change_mode, reason_code, reason_note, granted_by, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10, $11, $12, $13, $14, $15, $16)",
    )
    .bind(org.as_uuid())
    .bind(g.row.id)
    .bind(g.row.account_id)
    .bind(g.row.role_id)
    .bind(g.row.kind.as_str())
    .bind(pick(NodeKind::LegalEntity))
    .bind(pick(NodeKind::Workplace))
    .bind(pick(NodeKind::Department))
    .bind(g.row.valid_from)
    .bind(g.row.valid_to)
    .bind(g.row.effective_in_setup)
    .bind(g.change_mode)
    .bind(g.reason_code)
    .bind(g.reason_note)
    .bind(g.granted_by)
    .bind(if activates_at.is_some() { "PENDING" } else { "ACTIVE" })
    .execute(tx.as_mut())
    .await
    .map_err(overlap_conflict)?;
    if let Some(at) = activates_at {
        sqlx::query("INSERT INTO user_role_grants_pending (org_id, grant_id, activates_at) VALUES ($1,$2,$3)")
            .bind(org.as_uuid()).bind(g.row.id).bind(at).execute(tx.as_mut()).await?;
        crate::pending::event(tx, org, g.row.id, g.granted_by, "access.grant.pending", at).await?;
    }
    Ok(())
}

pub(crate) async fn revoke(tx: Tx<'_, '_>, org: OrgId, id: Uuid, by: Uuid) -> AccessResult<()> {
    sqlx::query(
        "UPDATE access_grants SET status = 'REVOKED', revoked_by = $3, revoked_at = now()
          WHERE org_id = $1 AND id = $2",
    )
    .bind(org.as_uuid())
    .bind(id)
    .bind(by)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

pub(crate) async fn set_end(
    tx: Tx<'_, '_>,
    org: OrgId,
    id: Uuid,
    to: Option<OffsetDateTime>,
) -> AccessResult<()> {
    sqlx::query("UPDATE access_grants SET valid_to = $3 WHERE org_id = $1 AND id = $2")
        .bind(org.as_uuid())
        .bind(id)
        .bind(to)
        .execute(tx.as_mut())
        .await
        .map_err(overlap_conflict)?;
    Ok(())
}

/// Filters for [`list`].
#[derive(Debug, Default)]
pub(crate) struct ListFilter {
    pub account_id: Option<Uuid>,
    pub role_id: Option<Uuid>,
    pub ids: Option<Vec<Uuid>>,
    pub include_ended: bool,
}

pub(crate) async fn list(
    tx: Tx<'_, '_>,
    org: OrgId,
    f: &ListFilter,
    phase: TenantPhase,
    now: OffsetDateTime,
) -> AccessResult<Vec<GrantOut>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {GRANT_COLUMNS}
           FROM access_grants g
           LEFT JOIN user_role_grants_pending p ON p.org_id=g.org_id AND p.grant_id=g.id
           JOIN access_roles r ON r.org_id = g.org_id AND r.id = g.role_id
           JOIN person_accounts_current u ON u.org_id = g.org_id AND u.id = g.account_id
           LEFT JOIN employees e ON e.org_id = u.org_id AND e.id = u.employee_id
          WHERE g.org_id = $1
            AND ($2::uuid IS NULL OR g.account_id = $2)
            AND ($3::uuid IS NULL OR g.role_id = $3)
            AND ($4::uuid[] IS NULL OR g.id = ANY($4))
            AND ($5 OR (g.status IN ('ACTIVE', 'PENDING') AND (g.valid_to IS NULL OR g.valid_to > $6)))
          ORDER BY g.granted_at DESC, g.id"
    )))
    .bind(org.as_uuid())
    .bind(f.account_id)
    .bind(f.role_id)
    .bind(f.ids.as_deref())
    .bind(f.include_ended)
    .bind(now)
    .fetch_all(tx.as_mut())
    .await?;
    rows.iter()
        .map(|row| {
            let state = GrantState {
                revoked: row.try_get::<String, _>("status")? == "REVOKED",
                role_active: row.try_get("role_active")?,
                valid_from: row.try_get("valid_from")?,
                valid_to: row.try_get("valid_to")?,
                effective_in_setup: row.try_get("effective_in_setup")?,
            };
            Ok(GrantOut {
                id: row.try_get("id")?,
                account_id: row.try_get("account_id")?,
                account_display_name: row.try_get("display_name")?,
                account_active: row.try_get("account_active")?,
                account_has_passkey: row.try_get("account_has_passkey")?,
                account_unit: row.try_get("account_unit")?,
                account_employee_number: row.try_get("account_employee_number")?,
                role_id: row.try_get("role_id")?,
                role_name_ko: row.try_get("role_name_ko")?,
                scope: ScopeOut {
                    kind: kind_of(row)?,
                    node_id: row.try_get("node_id")?,
                    include_descendants: row.try_get("include_descendants")?,
                },
                valid_from: state.valid_from,
                valid_to: state.valid_to,
                activates_at: row.try_get("activates_at")?,
                effective_in_setup: state.effective_in_setup,
                enforcement: if row.try_get::<String, _>("status")? == "PENDING" {
                    console_platform_authz::access::Enforcement::Scheduled
                } else {
                    state.enforcement(phase, now)
                },
                reason_code: row.try_get("reason_code")?,
                reason_note: row.try_get("reason_note")?,
                granted_by: row.try_get("granted_by")?,
                granted_at: row.try_get("granted_at")?,
                revoked_by: row.try_get("revoked_by")?,
                revoked_at: row.try_get("revoked_at")?,
            })
        })
        .collect()
}
