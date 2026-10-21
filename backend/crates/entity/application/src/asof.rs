//! Effective-date and recording-time coordinates for entity reads.
use console_entity_domain::{Issues, Refusal};
use serde::{Deserialize, Serialize};
use time::{Date, OffsetDateTime};

#[derive(Debug, Clone, Default, Deserialize)]
pub struct AsOfQuery {
    pub as_of: Option<String>,
    pub known_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ReadOptions {
    pub as_of: Option<Date>,
    pub known_at: Option<OffsetDateTime>,
}

impl AsOfQuery {
    /// # Errors
    /// Invalid ISO calendar dates or recording timestamps.
    pub fn parse(&self) -> Result<ReadOptions, Refusal> {
        let mut issues = Issues::default();
        let as_of = issues.date("as_of", self.as_of.as_deref(), false, None);
        let known_at = self.known_at.as_deref().map(|raw| {
            if raw.len() == 10 {
                Date::parse(
                    raw,
                    &time::macros::format_description!("[year]-[month]-[day]"),
                )
                .ok()
                .map(|d| {
                    d.with_time(time::macros::time!(23:59:59.999_999_999))
                        .assume_offset(time::macros::offset!(+9))
                })
            } else {
                OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339).ok()
            }
        });
        if known_at == Some(None) {
            issues.push("known_at", "date_invalid");
        }
        issues.finish(|| ReadOptions {
            as_of,
            known_at: known_at.flatten(),
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ReadPoint {
    pub as_of: Date,
    pub today: Date,
    pub known_at: Option<OffsetDateTime>,
    /// Live counts exclude confirmed exits; dated membership includes the last working day.
    pub live: bool,
}

impl ReadPoint {
    #[must_use]
    pub fn new(today: Date, q: ReadOptions) -> Self {
        Self {
            as_of: q.as_of.unwrap_or(today),
            today,
            known_at: q.known_at,
            live: q.as_of.is_none() && q.known_at.is_none(),
        }
    }

    #[must_use]
    pub fn stamp(self) -> ReadStamp {
        ReadStamp {
            as_of: self.as_of.to_string(),
            known_at: self.known_at.and_then(|t| {
                t.format(&time::format_description::well_known::Rfc3339)
                    .ok()
            }),
            read_only: self.as_of != self.today || self.known_at.is_some(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ReadStamp {
    pub as_of: String,
    pub known_at: Option<String>,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScheduledBy {
    pub change_id: uuid::Uuid,
    pub code: String,
    pub effective_date: String,
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn live_reads_are_distinct_from_explicit_today_and_known_reads() {
        let today = time::macros::date!(2026 - 10 - 10);
        assert!(ReadPoint::new(today, ReadOptions::default()).live);
        for q in [
            ReadOptions {
                as_of: Some(today),
                known_at: None,
            },
            ReadOptions {
                as_of: None,
                known_at: Some(today.midnight().assume_utc()),
            },
        ] {
            let point = ReadPoint::new(today, q);
            assert_eq!(point.as_of, today);
            assert!(!point.live);
        }
    }

    #[test]
    fn knowledge_dates_include_the_whole_kst_day() {
        let q = AsOfQuery {
            as_of: Some("2026-03-01".into()),
            known_at: Some("2026-03-15".into()),
        }
        .parse()
        .unwrap();
        assert_eq!(
            q.known_at
                .unwrap()
                .to_offset(time::macros::offset!(+9))
                .date(),
            time::macros::date!(2026 - 03 - 15)
        );
    }

    #[test]
    fn malformed_coordinates_refuse_with_validation_failed_and_date_invalid() {
        for (a, k) in [("2026-02-30", "2026-03-15"), ("2026-03-01", "yesterday")] {
            let refusal = AsOfQuery {
                as_of: Some(a.into()),
                known_at: Some(k.into()),
            }
            .parse()
            .unwrap_err();
            assert_eq!(refusal.code, "validation_failed");
            assert_eq!(refusal.fields[0].code, "date_invalid");
        }
    }
}
