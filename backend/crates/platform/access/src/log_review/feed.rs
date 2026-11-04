// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant-wide Cedar-gated access-log projection; personal snapshots stay private.
use console_kernel_core::OrgId;
use console_platform_authz::{Principal, access::Level};
use console_platform_db::with_audits;
use console_platform_request_context::audit_context::access_log::{AccessRecord, access_event};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::BTreeSet;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use super::{list, record::require};
use crate::{AccessError, AccessResult, AccessService};

#[cfg(test)]
mod tests;

type Cursor = (OffsetDateTime, OffsetDateTime, Uuid);

#[derive(Debug, Deserialize)]
pub struct Query {
    pub period: Option<String>,
    #[serde(default)]
    pub flagged: bool,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

impl Query {
    fn prefix(&self, org: OrgId, period: &str) -> String {
        format!("{}~{}~{}~", org, period, self.flagged)
    }

    fn cursor(&self, org: OrgId, period: &str) -> AccessResult<Option<Cursor>> {
        self.cursor
            .as_deref()
            .map(|cursor| {
                let invalid =
                    || AccessError::invalid("cursor_invalid", "cursor does not match this query");
                let (as_of, rest) = cursor
                    .strip_prefix(&self.prefix(org, period))
                    .and_then(|s| s.split_once('~'))
                    .ok_or_else(invalid)?;
                let (at, id) = rest.split_once('~').ok_or_else(invalid)?;
                Ok((
                    OffsetDateTime::from_unix_timestamp_nanos(
                        as_of.parse().map_err(|_| invalid())?,
                    )
                    .map_err(|_| invalid())?,
                    OffsetDateTime::from_unix_timestamp_nanos(at.parse().map_err(|_| invalid())?)
                        .map_err(|_| invalid())?,
                    id.parse().map_err(|_| invalid())?,
                ))
            })
            .transpose()
    }
}

/// Read one month with stable `(created_at, id)` keyset paging and full-month totals.
/// # Errors
/// Cedar refusal, invalid period/limit/cursor, or failed database/access-record storage.
pub async fn get(s: &AccessService, p: Principal, q: Query) -> AccessResult<Value> {
    with_audits::<_, _, AccessError>(&s.pool, p.org_id, move |tx| Box::pin(async move {
        require(tx, &p, Level::View).await?;
        let limit = q.limit.unwrap_or(super::MAX_PAGE_SIZE);
        list::validate_limit(limit)?;
        let period = if let Some(period) = &q.period { period.clone() } else {
            let rules = list::Rules::load(tx.as_mut(), p.org_id).await?;
            sqlx::query_scalar("SELECT to_char(now() AT TIME ZONE $1,'YYYY-MM')")
                .bind(rules.time_zone).fetch_one(tx.as_mut()).await?
        };
        let cursor = q.cursor(p.org_id, &period)?;
        // The read's audit row shares transaction now(); exclude that boundary from every page.
        let as_of = if let Some(c) = cursor { c.0 } else {
            sqlx::query_scalar("SELECT now()").fetch_one(tx.as_mut()).await?
        };
        let prepared = list::prepare(tx.as_mut(), p.org_id, &period, false, Some(as_of)).await?;
        let keys = list::page_at(tx.as_mut(), &prepared, cursor.map(|c| (c.1,c.2)), limit, q.flagged, Some(as_of)).await?;
        let last = keys.last().map(|r| (r.created_at, r.event_id));
        let more = if keys.len() == limit as usize {
            !list::page_at(tx.as_mut(), &prepared, last, 1, q.flagged, Some(as_of)).await?.is_empty()
        } else { false };
        let next = last.filter(|_| more).map(|(at,id)| format!("{}{}~{}~{id}", q.prefix(p.org_id, &period), as_of.unix_timestamp_nanos(), at.unix_timestamp_nanos()));
        let ids: Vec<_> = keys.iter().map(|r| r.event_id).collect();
        let rows = sqlx::query(
            "SELECT a.id,a.actor,a.created_at,a.occurred_at,COALESCE(a.actor_display,u.display_name,'') AS actor_name,\
             COALESCE(a.principal_type,a.after_snap->>'principal_type','') AS principal_type,a.action,a.target_type,COALESCE((a.after_snap->>'subject_count')::bigint,0) AS subject_count,\
             a.ip,COALESCE(a.outcome,CASE WHEN a.after_snap->>'denied'='true' OR a.action ~ '([.]refused$|_refused$|[.]denied$)' THEN 'DENIED' ELSE 'ALLOWED' END) AS outcome,a.after_snap->>'export_purpose' AS export_purpose,(a.after_snap->>'row_count')::bigint AS row_count \
             FROM audit_events a LEFT JOIN person_accounts_current u ON u.org_id=a.org_id AND u.id=a.actor \
             WHERE a.org_id=$1 AND a.id=ANY($2) ORDER BY a.created_at,a.id")
            .bind(p.org_id.as_uuid()).bind(ids).fetch_all(tx.as_mut()).await?;
        let mut subjects = BTreeSet::new();
        let mut items = Vec::with_capacity(rows.len());
        for (row, key) in rows.iter().zip(&keys) {
            let actor: Option<Uuid> = row.try_get("actor")?;
            subjects.extend(actor);
            items.push(json!({
                "event_id":key.event_id,"created_at":key.created_at.format(&Rfc3339).map_err(AccessError::internal)?,
                "occurred_at":row.try_get::<OffsetDateTime,_>("occurred_at")?.format(&Rfc3339).map_err(AccessError::internal)?,
                "actor_id":actor,"actor_name":row.try_get::<String,_>("actor_name")?,
                "principal_type":row.try_get::<String,_>("principal_type")?,"action":row.try_get::<String,_>("action")?,
                "target_type":row.try_get::<String,_>("target_type")?,"subject_count":row.try_get::<i64,_>("subject_count")?,
                "ip":row.try_get::<Option<String>,_>("ip")?,"outcome":row.try_get::<String,_>("outcome")?,
                "export_purpose":row.try_get::<Option<String>,_>("export_purpose")?,"row_count":row.try_get::<Option<i64>,_>("row_count")?,
                "flags":key.flags}));
        }
        let subjects: Vec<_> = subjects.into_iter().collect();
        let audit = access_event(&p, AccessRecord {action:"access_log.review_read",target_type:"access_log",target_id:period.clone(),
            subject_ids:&subjects,reader_subject:Some(*p.user_id.as_uuid()),details:json!({"period":period,"flagged":q.flagged,"rows":items.len()})})?;
        Ok((json!({"period":prepared.period(&period)?,"totals":prepared.totals(),"items":items,"next_cursor":next}),vec![audit]))
    })).await
}
