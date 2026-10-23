//! 「권한 요청」 (governance-22): a refused screen files a request record; the
//! holders of 권한 관리 see the open ones and close them; the requester sees
//! and may withdraw its own. Also who can grant — the count and names a
//! refusal shows (「이 범위의 권한을 가진 사람 n명」).

use console_kernel_core::OrgId;
use console_platform_authz::Principal;
use console_platform_authz::access::Level;
use console_platform_db::{with_audits, with_org_conn};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use crate::AccessService;
use crate::actor::{Actor, audit};
use crate::error::{AccessError, AccessResult};

const REASONS: [&str; 4] = ["NEW_DUTY", "COVER", "NEEDED_NOW", "OTHER"];
const COLUMNS: &str = "r.id, r.requested_by, u.display_name, r.screen, r.reason_code, r.note, \
     r.status, r.created_at, r.closed_by, r.closed_at";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewRequest {
    screen: String,
    #[serde(deserialize_with = "deserialize_enum_30")]
    reason_code: String,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Close {
    #[serde(deserialize_with = "deserialize_enum_29")]
    status: String,
}

fn out(row: &sqlx::postgres::PgRow) -> AccessResult<Value> {
    let at = |c: &str| -> AccessResult<Option<String>> {
        let t: Option<time::OffsetDateTime> = row.try_get(c)?;
        t.map(|t| t.format(&time::format_description::well_known::Rfc3339))
            .transpose()
            .map_err(AccessError::internal)
    };
    Ok(json!({
        "id": row.try_get::<Uuid, _>("id")?,
        "requested_by": row.try_get::<Uuid, _>("requested_by")?,
        "requester_name": row.try_get::<Option<String>, _>("display_name")?,
        "screen": row.try_get::<String, _>("screen")?,
        "reason_code": row.try_get::<String, _>("reason_code")?,
        "note": row.try_get::<Option<String>, _>("note")?,
        "status": row.try_get::<String, _>("status")?,
        "created_at": at("created_at")?,
        "closed_by": row.try_get::<Option<Uuid>, _>("closed_by")?,
        "closed_at": at("closed_at")?,
    }))
}

async fn one(tx: &mut Transaction<'_, Postgres>, org: OrgId, id: Uuid) -> AccessResult<Value> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM access_requests r JOIN person_accounts_current u ON u.org_id = r.org_id AND u.id = r.requested_by \
          WHERE r.org_id = $1 AND r.id = $2"
    )))
    .bind(org.as_uuid())
    .bind(id)
    .fetch_optional(tx.as_mut())
    .await?
    .ok_or_else(|| AccessError::not_found("access_request_not_found", "no such request"))?;
    out(&row)
}

/// File a request (201), or answer the open one for the same screen (200).
pub async fn create(
    s: &AccessService,
    p: Principal,
    body: NewRequest,
) -> AccessResult<(bool, Value)> {
    let screen = body.screen.trim().to_owned();
    if screen.is_empty() || screen.chars().count() > 200 {
        return Err(AccessError::invalid(
            "validation",
            "screen must be 1-200 characters",
        ));
    }
    if !REASONS.contains(&body.reason_code.as_str()) {
        return Err(AccessError::invalid("validation", "unknown reason_code"));
    }
    let note = body
        .note
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty());
    if note.as_ref().is_some_and(|n| n.chars().count() > 500) {
        return Err(AccessError::invalid(
            "validation",
            "note is at most 500 characters",
        ));
    }
    if body.reason_code == "OTHER" && note.is_none() {
        return Err(AccessError::invalid(
            "access_request_note_required",
            "기타는 사유를 적어 주세요",
        ));
    }
    with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            let open: Option<Uuid> = sqlx::query_scalar(
                "SELECT id FROM access_requests WHERE org_id = $1 AND requested_by = $2 \
                  AND status = 'OPEN' AND lower(btrim(screen)) = lower($3)",
            )
            .bind(p.org_id.as_uuid())
            .bind(p.user_id.as_uuid())
            .bind(&screen)
            .fetch_optional(tx.as_mut())
            .await?;
            if let Some(id) = open {
                return Ok(((false, one(tx, p.org_id, id).await?), Vec::new()));
            }
            let id: Uuid = sqlx::query_scalar(
                "INSERT INTO access_requests (org_id, requested_by, screen, reason_code, note) \
                 VALUES ($1, $2, $3, $4, $5) RETURNING id",
            )
            .bind(p.org_id.as_uuid())
            .bind(p.user_id.as_uuid())
            .bind(&screen)
            .bind(&body.reason_code)
            .bind(&note)
            .fetch_one(tx.as_mut())
            .await?;
            let event = audit(&p, "access.request.create", "access_request", id)?;
            Ok(((true, one(tx, p.org_id, id).await?), vec![event]))
        })
    })
    .await
}

/// The open requests for a 권한 관리 holder; otherwise the caller's own.
pub async fn list(s: &AccessService, p: Principal) -> AccessResult<Vec<Value>> {
    with_org_conn::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            let admin = Actor::load(tx, &p).await?.require_some_access(Level::View).is_ok();
            let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
                "SELECT {COLUMNS} FROM access_requests r JOIN person_accounts_current u ON u.org_id = r.org_id AND u.id = r.requested_by \
                  WHERE r.org_id = $1 AND (($3 AND r.status = 'OPEN') OR r.requested_by = $2) \
                  ORDER BY r.created_at DESC, r.id LIMIT 200"
            )))
            .bind(p.org_id.as_uuid())
            .bind(p.user_id.as_uuid())
            .bind(admin)
            .fetch_all(tx.as_mut())
            .await?;
            rows.iter().map(out).collect()
        })
    })
    .await
}

/// DONE / DECLINED by a 권한 관리 editor; WITHDRAWN by the requester.
pub async fn close(s: &AccessService, p: Principal, id: Uuid, body: Close) -> AccessResult<Value> {
    let status = body.status;
    if !["DONE", "DECLINED", "WITHDRAWN"].contains(&status.as_str()) {
        return Err(AccessError::invalid(
            "validation",
            "status must be DONE, DECLINED or WITHDRAWN",
        ));
    }
    with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            let row: Option<(Uuid, String)> = sqlx::query_as(
                "SELECT requested_by, status FROM access_requests WHERE org_id = $1 AND id = $2 FOR UPDATE",
            )
            .bind(p.org_id.as_uuid())
            .bind(id)
            .fetch_optional(tx.as_mut())
            .await?;
            let (by, current) =
                row.ok_or_else(|| AccessError::not_found("access_request_not_found", "no such request"))?;
            let mine = by == *p.user_id.as_uuid();
            let allowed = if status == "WITHDRAWN" {
                mine
            } else {
                Actor::load(tx, &p).await?.require_some_access(Level::Edit).is_ok()
            };
            if !allowed {
                return Err(AccessError::access_denied());
            }
            if current != "OPEN" {
                return Err(AccessError::conflict("access_request_closed", "the request is already closed"));
            }
            sqlx::query(
                "UPDATE access_requests SET status = $3, closed_by = $4, closed_at = now() \
                  WHERE org_id = $1 AND id = $2",
            )
            .bind(p.org_id.as_uuid())
            .bind(id)
            .bind(&status)
            .bind(p.user_id.as_uuid())
            .execute(tx.as_mut())
            .await?;
            let event = audit(&p, "access.request.close", "access_request", id)?;
            Ok((one(tx, p.org_id, id).await?, vec![event]))
        })
    })
    .await
}

/// Who can grant (the ops account and every account holding 권한 관리
/// 등록·수정 that counts now): a count and up to five names, for a refusal.
pub async fn granters(s: &AccessService, p: Principal) -> AccessResult<Value> {
    with_org_conn::<_, _, AccessError>(&s.pool, p.org_id, move |tx| {
        Box::pin(async move {
            let names: Vec<String> = sqlx::query_scalar(
                "SELECT u.display_name FROM person_accounts_current u WHERE u.org_id = $1 AND u.is_active AND (u.is_tenant_ops \
                   OR EXISTS (SELECT 1 FROM access_grants g \
                     JOIN access_roles r ON r.org_id = g.org_id AND r.id = g.role_id AND r.status = 'ACTIVE' \
                     JOIN access_role_lines l ON l.org_id = r.org_id AND l.role_id = r.id AND l.version = r.version \
                    WHERE g.org_id = u.org_id AND g.account_id = u.id AND g.status = 'ACTIVE' \
                      AND l.domain = 'access' AND l.levels @> ARRAY['edit']::text[] \
                      AND g.valid_from <= now() AND (g.valid_to IS NULL OR now() < g.valid_to) \
                      AND (g.effective_in_setup OR COALESCE((SELECT t.phase FROM tenant_phase t \
                           WHERE t.org_id = u.org_id), 'OPERATING') = 'OPERATING'))) \
                 ORDER BY u.is_tenant_ops DESC, u.display_name",
            )
            .bind(p.org_id.as_uuid())
            .fetch_all(tx.as_mut())
            .await?;
            Ok(json!({ "count": names.len(), "names": names.iter().take(5).collect::<Vec<_>>() }))
        })
    })
    .await
}

fn deserialize_enum_29<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["DONE", "DECLINED", "WITHDRAWN"],
    )
}

fn deserialize_enum_30<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["NEW_DUTY", "COVER", "NEEDED_NOW", "OTHER"],
    )
}
