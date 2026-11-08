// SPDX-License-Identifier: LicenseRef-Proprietary
//! Options and exact filters share the authorized, snapshot-bounded month.
use super::Prepared;
use crate::{AccessError, AccessResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::{Date, OffsetDateTime, macros::format_description};

#[derive(Debug, Default, Deserialize, Serialize)]
pub struct Filters {
    pub actor: Option<String>,
    pub action: Option<String>,
    pub target_type: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

impl Filters {
    pub(in crate::log_review) fn active(&self) -> bool {
        self.actor.is_some()
            || self.action.is_some()
            || self.target_type.is_some()
            || self.from.is_some()
            || self.to.is_some()
    }

    pub(in crate::log_review) fn validate(
        &self,
        period: &str,
        options: &Value,
    ) -> AccessResult<()> {
        let invalid = || {
            AccessError::invalid(
                "filter_invalid",
                "choose an available option and dates within the review month",
            )
        };
        for (value, choices) in [
            (&self.actor, "actors"),
            (&self.action, "actions"),
            (&self.target_type, "target_types"),
        ] {
            if let Some(value) = value
                && !options[choices]
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|row| row["id"].as_str() == Some(value)))
            {
                return Err(invalid());
            }
        }
        // PostgreSQL date text has no year zero.
        for value in [&self.from, &self.to].into_iter().flatten() {
            if !value.starts_with(&format!("{period}-"))
                || Date::parse(value, format_description!("[year]-[month]-[day]"))
                    .map_or(true, |day| day.year() == 0)
            {
                return Err(invalid());
            }
        }
        if let (Some(from), Some(to)) = (&self.from, &self.to)
            && from > to
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub(in crate::log_review) fn fingerprint(&self) -> String {
        use sha2::{Digest, Sha256};
        if self.active() {
            format!(
                "filters:{}~",
                hex::encode(Sha256::digest(json!(self).to_string()))
            )
        } else {
            String::new()
        }
    }
}

impl Prepared {
    pub(in crate::log_review) async fn filter_options(
        &self,
        conn: &mut PgConnection,
        as_of: OffsetDateTime,
    ) -> AccessResult<Value> {
        Ok(sqlx::query_scalar(
            "WITH events AS MATERIALIZED (SELECT a.actor,a.action,a.target_type,a.created_at,a.id, \
             a.actor_display FROM audit_events a \
             WHERE a.org_id=$1 AND a.created_at >= $2 AND a.created_at < $3 \
             AND a.created_at < $4 AND a.after_snap ? 'self_read'), \
             actors AS (SELECT DISTINCT ON(actor) actor,actor_display FROM events WHERE actor IS NOT NULL ORDER BY actor,(actor_display IS NULL),created_at DESC,id DESC), \
             named AS (SELECT actor,COALESCE(actor_display,u.display_name,'') AS name FROM actors \
             LEFT JOIN person_accounts_current u ON u.org_id=$1 AND u.id=actor) \
             SELECT jsonb_build_object( \
             'actors',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',actor,'label', \
               CASE WHEN name='' THEN actor::text WHEN duplicates>1 THEN name||' · '||actor::text ELSE name END) ORDER BY name,actor) \
               FROM (SELECT *,count(*) OVER(PARTITION BY name) AS duplicates FROM named) labeled),'[]'::jsonb), \
             'actions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',action,'label_key','accessLog.action.'||action) ORDER BY action) \
               FROM (SELECT DISTINCT action FROM events) a),'[]'::jsonb), \
             'target_types',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',target_type,'label_key','accessLog.target.'||target_type) ORDER BY target_type) \
               FROM (SELECT DISTINCT target_type FROM events) t),'[]'::jsonb))")
            .bind(self.org.as_uuid()).bind(self.from).bind(self.to).bind(as_of).fetch_one(conn).await?)
    }
}
