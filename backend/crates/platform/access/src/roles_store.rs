//! SQL for tenant roles: the head row, its append-only versions and lines.

use console_kernel_core::OrgId;
use console_platform_authz::access::{Domain, Level};
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::dto::{LineOut, RoleOut};
use crate::error::{AccessError, AccessResult};

type Tx<'a, 'b> = &'a mut Transaction<'b, Postgres>;

const ROLE_COLUMNS: &str = "r.id, r.name_ko, r.name_en, r.description, r.status, r.version, \
     r.created_at, r.updated_at, \
     (SELECT count(DISTINCT g.account_id) FROM access_grants g \
       WHERE g.org_id = r.org_id AND g.role_id = r.id AND g.status = 'ACTIVE' \
         AND (g.valid_to IS NULL OR g.valid_to > now())) AS holder_count";

/// The fields a version records.
pub(crate) struct VersionFields<'a> {
    pub name_ko: &'a str,
    pub name_en: Option<&'a str>,
    pub description: Option<&'a str>,
    pub status: &'a str,
    pub change_mode: &'a str,
    pub reason_code: Option<&'a str>,
    pub reason_note: Option<&'a str>,
    pub lines: &'a [LineOut],
}

fn role_from(row: &sqlx::postgres::PgRow) -> Result<RoleOut, sqlx::Error> {
    Ok(RoleOut {
        id: row.try_get("id")?,
        name_ko: row.try_get("name_ko")?,
        name_en: row.try_get("name_en")?,
        description: row.try_get("description")?,
        status: row.try_get("status")?,
        version: row.try_get("version")?,
        lines: Vec::new(),
        holder_count: row.try_get("holder_count")?,
        holders_affected: None,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

pub(crate) async fn lines_of(
    tx: Tx<'_, '_>,
    org: OrgId,
    role: Uuid,
    version: i32,
) -> AccessResult<Vec<LineOut>> {
    let rows = sqlx::query(
        "SELECT domain, levels FROM access_role_lines
          WHERE org_id = $1 AND role_id = $2 AND version = $3 ORDER BY domain",
    )
    .bind(org.as_uuid())
    .bind(role)
    .bind(version)
    .fetch_all(tx.as_mut())
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let domain: String = row.try_get("domain")?;
        let levels: Vec<String> = row.try_get("levels")?;
        let domain =
            Domain::parse(&domain).map_err(|_| AccessError::internal("unknown stored domain"))?;
        let levels = levels
            .iter()
            .map(|l| Level::parse(l))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| AccessError::internal("unknown stored level"))?;
        out.push(LineOut { domain, levels });
    }
    out.sort_by_key(|l| l.domain);
    Ok(out)
}

pub(crate) async fn list(
    tx: Tx<'_, '_>,
    org: OrgId,
    status: Option<&str>,
) -> AccessResult<Vec<RoleOut>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {ROLE_COLUMNS} FROM access_roles r
          WHERE r.org_id = $1 AND ($2::text IS NULL OR r.status = $2)
          ORDER BY r.updated_at DESC, r.id"
    )))
    .bind(org.as_uuid())
    .bind(status)
    .fetch_all(tx.as_mut())
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut role = role_from(row)?;
        role.lines = lines_of(tx, org, role.id, role.version).await?;
        out.push(role);
    }
    Ok(out)
}

/// One role; `lock` takes the row lock a write needs.
pub(crate) async fn get(tx: Tx<'_, '_>, org: OrgId, id: Uuid, lock: bool) -> AccessResult<RoleOut> {
    let lock = if lock { " FOR UPDATE OF r" } else { "" };
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {ROLE_COLUMNS} FROM access_roles r WHERE r.org_id = $1 AND r.id = $2{lock}"
    )))
    .bind(org.as_uuid())
    .bind(id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| AccessError::not_found("role_not_found", "no such role"))?;
    let mut role = role_from(&row)?;
    role.lines = lines_of(tx, org, role.id, role.version).await?;
    Ok(role)
}

fn name_taken(err: sqlx::Error) -> AccessError {
    let taken = err
        .as_database_error()
        .and_then(|e| e.constraint())
        .is_some_and(|c| c == "access_roles_name_uniq");
    if taken {
        AccessError::conflict("role_name_taken", "a role with this name already exists")
    } else {
        AccessError::from(err)
    }
}

pub(crate) async fn insert_head(
    tx: Tx<'_, '_>,
    org: OrgId,
    id: Uuid,
    actor: Uuid,
    f: &VersionFields<'_>,
) -> AccessResult<()> {
    sqlx::query(
        "INSERT INTO access_roles (org_id, id, name_ko, name_en, description, status, version, created_by)
         VALUES ($1, $7, btrim($2), $3, $4, $5, 1, $6)",
    )
    .bind(org.as_uuid())
    .bind(f.name_ko)
    .bind(f.name_en)
    .bind(f.description)
    .bind(f.status)
    .bind(actor)
    .bind(id)
    .execute(tx.as_mut())
    .await
    .map_err(name_taken)?;
    Ok(())
}

pub(crate) async fn update_head(
    tx: Tx<'_, '_>,
    org: OrgId,
    role: Uuid,
    version: i32,
    f: &VersionFields<'_>,
) -> AccessResult<OffsetDateTime> {
    sqlx::query_scalar(
        "UPDATE access_roles SET name_ko = btrim($3), name_en = $4, description = $5, status = $6,
                version = $7, updated_at = now()
          WHERE org_id = $1 AND id = $2 RETURNING updated_at",
    )
    .bind(org.as_uuid())
    .bind(role)
    .bind(f.name_ko)
    .bind(f.name_en)
    .bind(f.description)
    .bind(f.status)
    .bind(version)
    .fetch_one(tx.as_mut())
    .await
    .map_err(name_taken)
}

/// Append version `version` with its lines.
pub(crate) async fn insert_version(
    tx: Tx<'_, '_>,
    org: OrgId,
    role: Uuid,
    version: i32,
    actor: Uuid,
    f: &VersionFields<'_>,
) -> AccessResult<()> {
    sqlx::query(
        "INSERT INTO access_role_versions (org_id, role_id, version, name_ko, name_en, description,
                status, change_mode, reason_code, reason_note, created_by)
         VALUES ($1, $2, $3, btrim($4), $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(org.as_uuid())
    .bind(role)
    .bind(version)
    .bind(f.name_ko)
    .bind(f.name_en)
    .bind(f.description)
    .bind(f.status)
    .bind(f.change_mode)
    .bind(f.reason_code)
    .bind(f.reason_note)
    .bind(actor)
    .execute(tx.as_mut())
    .await?;
    for line in f.lines {
        let levels: Vec<&str> = line.levels.iter().map(|l| l.as_str()).collect();
        sqlx::query(
            "INSERT INTO access_role_lines (org_id, role_id, version, domain, levels)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(org.as_uuid())
        .bind(role)
        .bind(version)
        .bind(line.domain.as_str())
        .bind(&levels)
        .execute(tx.as_mut())
        .await?;
    }
    Ok(())
}

/// Accounts holding a grant of `role` that is not revoked and not ended.
pub(crate) async fn live_holders(
    tx: Tx<'_, '_>,
    org: OrgId,
    role: Uuid,
) -> AccessResult<Vec<Uuid>> {
    Ok(sqlx::query_scalar(
        "SELECT DISTINCT account_id FROM access_grants
          WHERE org_id = $1 AND role_id = $2 AND status = 'ACTIVE'
            AND (valid_to IS NULL OR valid_to > now()) ORDER BY account_id",
    )
    .bind(org.as_uuid())
    .bind(role)
    .fetch_all(tx.as_mut())
    .await?)
}

pub(crate) async fn delete_draft(tx: Tx<'_, '_>, org: OrgId, role: Uuid) -> AccessResult<()> {
    sqlx::query("DELETE FROM access_roles WHERE org_id = $1 AND id = $2 AND status = 'DRAFT'")
        .bind(org.as_uuid())
        .bind(role)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

pub(crate) async fn versions(
    tx: Tx<'_, '_>,
    org: OrgId,
    role: Uuid,
) -> AccessResult<Vec<serde_json::Value>> {
    let rows = sqlx::query(
        "SELECT version, name_ko, name_en, description, status, change_mode, reason_code,
                created_at, created_by
           FROM access_role_versions WHERE org_id = $1 AND role_id = $2 ORDER BY version DESC",
    )
    .bind(org.as_uuid())
    .bind(role)
    .fetch_all(tx.as_mut())
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let version: i32 = row.try_get("version")?;
        let at: OffsetDateTime = row.try_get("created_at")?;
        out.push(serde_json::json!({
            "version": version,
            "name_ko": row.try_get::<String, _>("name_ko")?,
            "name_en": row.try_get::<Option<String>, _>("name_en")?,
            "description": row.try_get::<Option<String>, _>("description")?,
            "status": row.try_get::<String, _>("status")?,
            "lines": lines_of(tx, org, role, version).await?,
            "change_mode": row.try_get::<String, _>("change_mode")?,
            "reason_code": row.try_get::<Option<String>, _>("reason_code")?,
            "created_at": at.format(&time::format_description::well_known::Rfc3339).map_err(AccessError::internal)?,
            "created_by": row.try_get::<Uuid, _>("created_by")?,
        }));
    }
    Ok(out)
}
