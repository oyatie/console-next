// SPDX-License-Identifier: LicenseRef-Proprietary
//! Search the displayed projection after classifying flags over the full month.
use super::{FLAG_CODES, Prepared};
use crate::AccessResult;
use serde_json::json;
use sqlx::PgConnection;
use std::collections::BTreeSet;
use time::OffsetDateTime;
use uuid::Uuid;

impl Prepared {
    pub(in crate::log_review) async fn search(
        &mut self,
        conn: &mut PgConnection,
        search: &str,
        as_of: OffsetDateTime,
    ) -> AccessResult<()> {
        let flag_matches: Vec<_> = self
            .flagged
            .iter()
            .filter(|r| r.flags.iter().any(|f| f.contains(search)))
            .map(|r| r.event_id)
            .collect();
        let mut sql = sqlx::QueryBuilder::new(
            include_str!("search.sql").replace("{outcome}", include_str!("outcome.sql")),
        );
        let matches: Vec<Uuid> = sql
            .build_query_scalar()
            .bind(self.org.as_uuid())
            .bind(self.from)
            .bind(self.to)
            .bind(as_of)
            .bind(search)
            .bind(flag_matches)
            .bind(&self.rules.time_zone)
            .fetch_all(conn)
            .await?;
        let ids: BTreeSet<_> = matches.iter().copied().collect();
        self.flagged.retain(|r| ids.contains(&r.event_id));
        let by_flag: serde_json::Map<_, _> = FLAG_CODES
            .iter()
            .map(|flag| {
                (
                    flag.to_string(),
                    json!(
                        self.flagged
                            .iter()
                            .filter(|r| r.flags.iter().any(|f| f == flag))
                            .count()
                    ),
                )
            })
            .collect();
        self.totals =
            json!({"events":matches.len(),"flagged":self.flagged.len(),"by_flag":by_flag});
        self.matches = Some(matches);
        Ok(())
    }
}
