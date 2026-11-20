// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{PgOrgError, PgOrgStore};
use console_identity_application::{MyAccessLogEvent, MyAccessLogPage, MyAccessLogQuery};
use console_kernel_core::{KernelError, OrgId, UserId};
use console_platform_authz::Principal;
use console_platform_db::with_org_conn;
use sqlx::Row;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 100;

fn scope_tag(org_id: OrgId, user_id: UserId) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in org_id
        .as_uuid()
        .as_bytes()
        .iter()
        .chain(user_id.as_uuid().as_bytes())
    {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn parse_cursor(
    cursor: &str,
    org_id: OrgId,
    user_id: UserId,
) -> Result<(OffsetDateTime, Uuid), PgOrgError> {
    let invalid = || KernelError::validation("cursor is invalid").with_code("cursor_invalid");
    let expected = scope_tag(org_id, user_id);
    let rest = cursor
        .strip_prefix(&expected)
        .and_then(|s| s.strip_prefix('~'))
        .ok_or_else(invalid)?;
    let (nanos_str, id_str) = rest.split_once('~').ok_or_else(invalid)?;
    let nanos: i128 = nanos_str.parse().map_err(|_| invalid())?;
    let created_at = OffsetDateTime::from_unix_timestamp_nanos(nanos).map_err(|_| invalid())?;
    let event_id: Uuid = id_str.parse().map_err(|_| invalid())?;
    Ok((created_at, event_id))
}

fn format_cursor(org_id: OrgId, user_id: UserId, created_at: OffsetDateTime, id: Uuid) -> String {
    format!(
        "{}~{}~{}",
        scope_tag(org_id, user_id),
        created_at.unix_timestamp_nanos(),
        id
    )
}

impl PgOrgStore {
    pub async fn list_my_access_log(
        &self,
        principal: &Principal,
        query: MyAccessLogQuery,
    ) -> Result<MyAccessLogPage, PgOrgError> {
        let limit = query.limit.unwrap_or(DEFAULT_LIMIT);
        if !(1..=MAX_LIMIT).contains(&limit) {
            return Err(KernelError::validation("limit must be between 1 and 100")
                .with_code("limit_out_of_range")
                .into());
        }
        let cursor = query
            .cursor
            .as_deref()
            .map(|raw| parse_cursor(raw, principal.org_id, principal.user_id))
            .transpose()?;
        if principal.support.is_some() {
            return Ok(MyAccessLogPage {
                items: Vec::new(),
                next_cursor: None,
            });
        }

        let org_id = principal.org_id;
        let user_id = principal.user_id;
        with_org_conn(&self.pool, org_id, move |tx| {
            Box::pin(async move {
                let employee_id: Option<Uuid> = sqlx::query_scalar(
                    "SELECT employee_id FROM users WHERE org_id = $1 AND id = $2",
                )
                .bind(org_id.as_uuid())
                .bind(user_id.as_uuid())
                .fetch_optional(tx.as_mut())
                .await?
                .flatten();

                let (cursor_at, cursor_id) = match cursor {
                    Some((at, id)) => (Some(at), Some(id)),
                    None => (None, None),
                };

                let rows = sqlx::query(
                    r#"
                    SELECT a.id, a.occurred_at, a.created_at, a.action, a.target_type,
                           COALESCE(NULLIF(a.actor_display, ''), u.display_name, '') AS actor_name,
                           COALESCE(
                               NULLIF(btrim(unit.unit_name), ''),
                               NULLIF(btrim(e.org_unit), ''),
                               NULLIF(btrim(u.team), ''),
                               NULLIF(btrim(a.actor_employer), '')
                           ) AS actor_team,
                           COALESCE(
                               NULLIF(a.after_snap->>'field', ''),
                               NULLIF(a.after_snap->>'section', '')
                           ) AS field,
                           COALESCE(
                               NULLIF(a.after_snap->>'reason_code', ''),
                               NULLIF(a.after_snap->>'purpose_code', ''),
                               NULLIF(a.after_snap->>'export_purpose', ''),
                               NULLIF(a.reason_code, '')
                           ) AS reason_code
                    FROM audit_events a
                    LEFT JOIN person_accounts_current u
                           ON u.org_id = a.org_id AND u.id = a.actor
                    LEFT JOIN employees e
                           ON e.org_id = u.org_id AND e.id = u.employee_id
                    LEFT JOIN LATERAL (
                        SELECT r.attributes->>'name' AS unit_name
                        FROM org_unit_revisions r
                        WHERE r.org_id = e.org_id AND r.org_unit_id = e.org_unit_id
                        ORDER BY r.version DESC
                        LIMIT 1
                    ) unit ON e.org_unit_id IS NOT NULL
                    WHERE a.org_id = $1
                      AND a.after_snap ? 'self_read'
                      AND CASE
                          WHEN jsonb_typeof(a.after_snap->'self_read') = 'boolean'
                          THEN (a.after_snap->>'self_read')::boolean
                          ELSE false
                      END = false
                      AND COALESCE(
                          a.outcome,
                          CASE
                              WHEN a.after_snap->>'denied' = 'true'
                                OR a.action ~ '([.]refused$|_refused$|[.]denied$)'
                              THEN 'DENIED'
                              ELSE 'ALLOWED'
                          END
                      ) = 'ALLOWED'
                      AND (
                          ($3::uuid IS NOT NULL AND a.after_snap->'subject_ids' ? $3::text)
                          OR (a.target_type = 'user' AND a.after_snap->'subject_ids' ? $2::text)
                          OR (a.after_snap->'user_subject_ids' ? $2::text)
                      )
                      AND ($4::timestamptz IS NULL OR (a.created_at, a.id) < ($4, $5))
                    ORDER BY a.created_at DESC, a.id DESC
                    LIMIT $6
                    "#,
                )
                .bind(org_id.as_uuid())
                .bind(user_id.as_uuid())
                .bind(employee_id)
                .bind(cursor_at)
                .bind(cursor_id)
                .bind(limit + 1)
                .fetch_all(tx.as_mut())
                .await?;

                let limit_usize = usize::try_from(limit).unwrap_or(0);
                let has_more = rows.len() > limit_usize;
                let mut items = Vec::with_capacity(limit_usize.min(rows.len()));
                let mut last_key: Option<(OffsetDateTime, Uuid)> = None;

                for row in rows.iter().take(limit_usize) {
                    let event_id: Uuid = row.try_get("id")?;
                    let created_at: OffsetDateTime = row.try_get("created_at")?;
                    let occurred_at: OffsetDateTime = row.try_get("occurred_at")?;
                    let occurred_at = occurred_at
                        .format(&Rfc3339)
                        .map_err(|err| KernelError::internal(err.to_string()))?;
                    last_key = Some((created_at, event_id));
                    items.push(MyAccessLogEvent {
                        event_id,
                        occurred_at,
                        actor_name: row.try_get("actor_name")?,
                        actor_team: row.try_get("actor_team")?,
                        action: row.try_get("action")?,
                        field: row.try_get("field")?,
                        reason_code: row.try_get("reason_code")?,
                        target_type: row.try_get("target_type")?,
                    });
                }

                let next_cursor = last_key
                    .filter(|_| has_more)
                    .map(|(created_at, id)| format_cursor(org_id, user_id, created_at, id));
                Ok(MyAccessLogPage { items, next_cursor })
            })
        })
        .await
    }
}
