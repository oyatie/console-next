// SPDX-License-Identifier: LicenseRef-Proprietary
//! SQL projections for the closed-month list and its frozen actor-day evidence.
//! Callers supply an armed tenant transaction after the Cedar tenant-wide gate.
#[path = "rules.rs"]
mod rules;

use console_kernel_core::OrgId;
use rules::Rules;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgConnection, QueryBuilder, Row};
use time::{Date, Month, OffsetDateTime};
use uuid::Uuid;

use super::{FLAG_CODES, SENSITIVE_READS};
use crate::{AccessError, AccessResult};

/// Prepared once at start, to be stored in the append-only review evidence.
/// Flagged pages reuse the exact frozen keyset, including row-level attribution.
#[derive(Debug, Serialize, Deserialize)]
pub struct Prepared {
    org: OrgId,
    #[serde(with = "time::serde::rfc3339")]
    from: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    to: OffsetDateTime,
    rules: Rules,
    flagged: Vec<FlaggedEvent>,
    summaries: Value,
    totals: Value,
}

impl Prepared {
    #[must_use]
    pub const fn totals(&self) -> &Value {
        &self.totals
    }
    #[must_use]
    pub const fn summaries(&self) -> &Value {
        &self.summaries
    }
    #[must_use]
    pub fn disabled_flags(&self) -> Vec<&'static str> {
        self.rules.disabled_flags()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, sqlx::FromRow)]
pub struct FlaggedEvent {
    pub event_id: Uuid,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub flags: Vec<String>,
}

// `created_at` fixes the covered interval; occurred_at determines the local day/hour.
const EVENTS: &str = r#"
WITH rules AS (SELECT * FROM jsonb_to_record($4) AS r(time_zone text,start_hour bigint,
    end_hour bigint,off_hours_min bigint,bulk_subjects_min bigint,denied_min bigint,
    downloads_per_day_min bigint,every_download boolean,weekend_isodays smallint[],holidays date[])),
events AS (
 SELECT a.id,a.created_at,COALESCE(a.actor::text,'') AS actor_key,a.action,
    (a.occurred_at AT TIME ZONE r.time_zone)::date AS day,
    COALESCE((a.after_snap->>'subject_count')::bigint,0) AS subjects,
    a.after_snap ? 'export_purpose' AS download,a.outcome='DENIED' AS denied,
    (a.after_snap->>'self_read')='false' AND a.action<>'access_log.review_read' AS eligible,
    (extract(hour FROM a.occurred_at AT TIME ZONE r.time_zone)>=r.start_hour OR
     extract(hour FROM a.occurred_at AT TIME ZONE r.time_zone)<r.end_hour OR
     extract(isodow FROM a.occurred_at AT TIME ZONE r.time_zone)=ANY(r.weekend_isodays) OR
     (a.occurred_at AT TIME ZONE r.time_zone)::date=ANY(r.holidays)) AS off_hours
 FROM audit_events a CROSS JOIN rules r
 WHERE a.org_id=$1 AND a.created_at >= $2 AND a.created_at < $3
   AND a.after_snap ? 'self_read'
"#;

// The only flag predicates; wire codes come from FLAG_CODES in predicate order.
const FLAGS: &str = r#"
, flagged AS (
 SELECT e.id AS event_id,e.created_at,e.actor_key,e.day,e.subjects,CASE WHEN e.eligible THEN array_remove(ARRAY[
    CASE WHEN e.download AND r.every_download THEN ($6::text[])[1] END,
    CASE WHEN e.download AND d.downloads>=r.downloads_per_day_min THEN ($6::text[])[2] END,
    CASE WHEN e.off_hours AND d.off_hours>=r.off_hours_min THEN ($6::text[])[3] END,
    CASE WHEN e.subjects>0 AND d.subjects>=r.bulk_subjects_min THEN ($6::text[])[4] END,
    CASE WHEN e.action=ANY($5) THEN ($6::text[])[5] END,
    CASE WHEN e.denied AND d.denials>=r.denied_min THEN ($6::text[])[6] END
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

/// Calculate the frozen evidence once; no review is created by this projection.
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
        SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('event_id',event_id,'created_at',created_at,'flags',flags) ORDER BY created_at,event_id)
          FROM flagged WHERE cardinality(flags)>0),'[]'::jsonb) AS flagged,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('actor',NULLIF(actor_key,''),'day',day,'flag',code,'count',n) ORDER BY actor_key,day,code)
          FROM (SELECT actor_key,day,code,sum(CASE WHEN code=($6::text[])[4] THEN subjects ELSE 1 END) AS n
            FROM flagged CROSS JOIN LATERAL unnest(flags) code
            WHERE code<>($6::text[])[1] AND code<>($6::text[])[5] GROUP BY actor_key,day,code) patterns),'[]'::jsonb) AS summaries,
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
        .bind(FLAG_CODES)
        .fetch_one(conn)
        .await?;
    Ok(Prepared {
        org,
        from,
        to,
        rules,
        flagged: serde_json::from_value(row.try_get("flagged")?).map_err(AccessError::internal)?,
        summaries: row.try_get("summaries")?,
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
    if flagged {
        let start = cursor.map_or(0, |c| {
            prepared
                .flagged
                .partition_point(|r| (r.created_at, r.event_id) <= c)
        });
        return Ok(prepared
            .flagged
            .iter()
            .skip(start)
            .take(limit as usize)
            .cloned()
            .collect());
    }
    let mut rows: Vec<FlaggedEvent> = sqlx::query_as(
        "SELECT id AS event_id,created_at,ARRAY[]::text[] AS flags FROM audit_events \
         WHERE org_id=$1 AND created_at >= $2 AND created_at < $3 AND after_snap ? 'self_read' \
         AND ($4::timestamptz IS NULL OR (created_at,id)>($4,$5)) ORDER BY created_at,id LIMIT $6",
    )
    .bind(prepared.org.as_uuid())
    .bind(prepared.from)
    .bind(prepared.to)
    .bind(cursor.map(|c| c.0))
    .bind(cursor.map(|c| c.1))
    .bind(limit)
    .fetch_all(conn)
    .await?;
    for row in &mut rows {
        if let Ok(i) = prepared
            .flagged
            .binary_search_by_key(&(row.created_at, row.event_id), |r| {
                (r.created_at, r.event_id)
            })
        {
            row.flags.clone_from(&prepared.flagged[i].flags);
        }
    }
    Ok(rows)
}
