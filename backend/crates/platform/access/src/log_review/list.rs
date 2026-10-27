// SPDX-License-Identifier: LicenseRef-Proprietary
//! SQL projections for the closed-month list and its frozen actor-day evidence.
//! Callers supply an armed tenant transaction after the Cedar tenant-wide gate.
#[path = "rules.rs"]
mod rules;

use console_kernel_core::OrgId;
use rules::Rules;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{PgConnection, QueryBuilder, Row};
use time::{Date, Month, OffsetDateTime};
use uuid::Uuid;

use super::SENSITIVE_READS;
use crate::{AccessError, AccessResult};

/// Prepared once at start, to be stored in the append-only review evidence.
/// Page reads reuse these actor-day aggregates and the same resolved rules.
#[derive(Debug, Serialize)]
pub struct Prepared {
    org: OrgId,
    #[serde(with = "time::serde::rfc3339")]
    from: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    to: OffsetDateTime,
    rules: Rules,
    #[serde(serialize_with = "serialize_actor_days")]
    actor_days: String,
    totals: Value,
}

// Keep the DB's JSON encoding for page binds; only decode when freezing the evidence.
fn serialize_actor_days<S: serde::Serializer>(
    text: &str,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let value: Value = serde_json::from_str(text).map_err(serde::ser::Error::custom)?;
    value.serialize(serializer)
}

impl Prepared {
    #[must_use]
    pub const fn totals(&self) -> &Value {
        &self.totals
    }
    #[must_use]
    pub fn disabled_flags(&self) -> Vec<&'static str> {
        self.rules.disabled_flags()
    }
}

#[derive(Debug, PartialEq, Eq, sqlx::FromRow)]
pub struct FlaggedEvent {
    pub event_id: Uuid,
    pub created_at: OffsetDateTime,
    pub flags: Vec<String>,
}

// `created_at` fixes the covered interval; occurred_at determines the local day/hour.
const EVENTS: &str = r#"
WITH rules AS (SELECT * FROM jsonb_to_record($4) AS r(time_zone text,start_hour bigint,
    end_hour bigint,off_hours_min bigint,bulk_subjects_min bigint,denied_min bigint,
    downloads_per_day_min bigint,every_download boolean)),
events AS (
 SELECT a.id,a.created_at,COALESCE(a.actor::text,'') AS actor_key,a.action,
    (a.occurred_at AT TIME ZONE r.time_zone)::date AS day,
    COALESCE((a.after_snap->>'subject_count')::bigint,0) AS subjects,
    a.after_snap ? 'export_purpose' AS download,a.outcome='DENIED' AS denied,
    (a.after_snap->>'self_read')='false' AND a.action<>'access_log.review_read' AS eligible,
    (extract(hour FROM a.occurred_at AT TIME ZONE r.time_zone)>=r.start_hour OR
     extract(hour FROM a.occurred_at AT TIME ZONE r.time_zone)<r.end_hour OR
     extract(isodow FROM a.occurred_at AT TIME ZONE r.time_zone)>5) AS off_hours
 FROM audit_events a CROSS JOIN rules r
 WHERE a.org_id=$1 AND a.created_at >= $2 AND a.created_at < $3
   AND a.after_snap ? 'self_read'
"#;

// shortcut: no public holidays in off_hours, until a tenant holiday reader exists.
// These are the only flag predicates, shared by preparation/totals and page reads.
const FLAGS: &str = r#"
, flagged AS (
 SELECT e.id AS event_id,e.created_at,CASE WHEN e.eligible THEN array_remove(ARRAY[
    CASE WHEN e.download AND r.every_download THEN 'download' END,
    CASE WHEN d.downloads>=r.downloads_per_day_min THEN 'download_repeat' END,
    CASE WHEN e.off_hours AND d.off_hours>=r.off_hours_min THEN 'off_hours' END,
    CASE WHEN d.subjects>=r.bulk_subjects_min THEN 'bulk_subjects' END,
    CASE WHEN e.action=ANY($5) THEN 'sensitive_read' END,
    CASE WHEN d.denials>=r.denied_min THEN 'repeated_denial' END
 ],NULL) ELSE ARRAY[]::text[] END AS flags
 FROM events e CROSS JOIN rules r
"#;

const AGGREGATE: &str = r#"
), days AS MATERIALIZED (
 SELECT actor_key,day,sum(subjects)::bigint AS subjects,count(*) FILTER(WHERE download) AS downloads,
    count(*) FILTER(WHERE denied) AS denials,
    sum(count(*) FILTER(WHERE off_hours)) OVER(PARTITION BY actor_key)::bigint AS off_hours
 FROM events WHERE eligible GROUP BY actor_key,day
)
"#;

/// Calculate the fallback evidence once; no review is created by this projection.
/// # Errors
/// Invalid/open periods, unresolved required settings, or a database failure.
pub async fn prepare_in_tx(
    conn: &mut PgConnection,
    org: OrgId,
    period: &str,
) -> AccessResult<Prepared> {
    let invalid = || AccessError::invalid("period_invalid", "expected YYYY-MM");
    let (year, month) = period.split_once('-').ok_or_else(invalid)?;
    if year.len() != 4
        || month.len() != 2
        || !year
            .bytes()
            .chain(month.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return Err(invalid());
    }
    let day = Date::from_calendar_date(
        year.parse().map_err(|_| invalid())?,
        Month::try_from(month.parse::<u8>().map_err(|_| invalid())?).map_err(|_| invalid())?,
        1,
    )
    .map_err(|_| invalid())?;
    let rules = Rules::load(conn, org).await?;
    let (from,to,closed): (OffsetDateTime,OffsetDateTime,bool) = sqlx::query_as(
        "SELECT f,t,t<=now() FROM (SELECT $1::date::timestamp AT TIME ZONE $2 AS f,($1::date+interval '1 month') AT TIME ZONE $2 AS t) b")
        .bind(day).bind(&rules.time_zone).fetch_one(&mut *conn).await?;
    if !closed {
        return Err(AccessError::invalid(
            "period_not_closed",
            "period is still open",
        ));
    }
    let mut sql = QueryBuilder::new(EVENTS);
    sql.push(AGGREGATE).push(FLAGS).push(r#"
        LEFT JOIN days d ON d.actor_key=e.actor_key AND d.day=e.day)
        SELECT COALESCE((SELECT jsonb_object_agg(actor_key,jsonb_build_object('off_hours',off_hours,'days',day_counts))
          FROM (SELECT actor_key,max(off_hours) AS off_hours,jsonb_object_agg(day,jsonb_build_object('subjects',subjects,'downloads',downloads,'denials',denials)) AS day_counts
            FROM days GROUP BY actor_key) actors),'{}'::jsonb)::text AS actor_days,
        jsonb_build_object('events',count(*),'flagged',count(*) FILTER(WHERE cardinality(flags)>0),
          'by_flag',(SELECT jsonb_object_agg(code,n) FROM (SELECT code,count(*) FILTER(WHERE code=ANY(f.flags)) AS n
            FROM unnest($6::text[]) code LEFT JOIN flagged f ON true GROUP BY code) counts)) AS totals FROM flagged"#);
    let row = sql
        .build()
        .bind(org.as_uuid())
        .bind(from)
        .bind(to)
        .bind(json!(rules))
        .bind(SENSITIVE_READS)
        .bind([
            "download",
            "download_repeat",
            "off_hours",
            "bulk_subjects",
            "sensitive_read",
            "repeated_denial",
        ])
        .fetch_one(conn)
        .await?;
    Ok(Prepared {
        org,
        from,
        to,
        rules,
        actor_days: row.try_get("actor_days")?,
        totals: row.try_get("totals")?,
    })
}

/// Keyset flag projection using the previously prepared evidence, without a month scan.
/// # Errors
/// Limits outside the list contract or a database failure. Cursor wire validation is the caller's job.
pub async fn page_in_tx(
    conn: &mut PgConnection,
    prepared: &Prepared,
    cursor: Option<(OffsetDateTime, Uuid)>,
    limit: i64,
    flagged: bool,
) -> AccessResult<Vec<FlaggedEvent>> {
    if !(1..=200).contains(&limit) {
        return Err(AccessError::invalid(
            "limit_out_of_range",
            "limit must be 1..200",
        ));
    }
    let mut sql = QueryBuilder::new(EVENTS);
    sql.push(r#" AND ($7::timestamptz IS NULL OR (a.created_at,a.id)>($7,$8))), snapshot AS MATERIALIZED (SELECT $6::text::jsonb AS actor_days)
        "#).push(FLAGS).push(r#" CROSS JOIN snapshot s LEFT JOIN LATERAL jsonb_to_record((s.actor_days->e.actor_key->'days'->e.day::text)||jsonb_build_object('off_hours',s.actor_days->e.actor_key->'off_hours')) AS d(subjects bigint,downloads bigint,denials bigint,off_hours bigint) ON true)
        SELECT event_id,created_at,flags FROM flagged WHERE NOT $9 OR cardinality(flags)>0 ORDER BY created_at,event_id LIMIT $10"#);
    Ok(sql
        .build_query_as()
        .bind(prepared.org.as_uuid())
        .bind(prepared.from)
        .bind(prepared.to)
        .bind(json!(prepared.rules))
        .bind(SENSITIVE_READS)
        .bind(&prepared.actor_days)
        .bind(cursor.map(|c| c.0))
        .bind(cursor.map(|c| c.1))
        .bind(flagged)
        .bind(limit)
        .fetch_all(conn)
        .await?)
}
