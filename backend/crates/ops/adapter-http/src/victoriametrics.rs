// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::num::NonZeroU64;

use console_ops_application::{
    InstantSample, ScrapeTarget, SourceError, SourceFuture, TargetHealth, VictoriaMetrics,
};
use serde::Deserialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::{HttpReadLimits, HttpSource};

pub struct HttpVictoriaMetrics {
    source: HttpSource,
}

impl HttpVictoriaMetrics {
    pub fn new(
        base_url: &str,
        interval_s: NonZeroU64,
        limits: HttpReadLimits,
    ) -> Result<Self, SourceError> {
        Ok(Self {
            source: HttpSource::new(base_url, interval_s, limits)?,
        })
    }
}

#[derive(Deserialize)]
#[serde(tag = "status", content = "data", rename_all = "lowercase")]
enum Response<T> {
    Success(T),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryData {
    result_type: String,
    result: Vec<RawSample>,
}

#[derive(Deserialize)]
struct RawSample {
    metric: BTreeMap<String, String>,
    value: (f64, String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetsData {
    active_targets: Vec<RawTarget>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTarget {
    #[serde(default)]
    labels: BTreeMap<String, String>,
    #[serde(default)]
    scrape_pool: String,
    health: String,
    #[serde(default)]
    last_error: String,
    #[serde(default)]
    last_scrape: String,
}

impl VictoriaMetrics for HttpVictoriaMetrics {
    fn query_instant(&self, query: &str) -> SourceFuture<'_, Vec<InstantSample>> {
        let query = query.to_owned();
        Box::pin(async move {
            let Response::Success(data) = self
                .source
                .get_with_query::<Response<QueryData>>("api/v1/query", &[("query", &query)])
                .await?;
            if data.result_type != "vector" {
                return Err(SourceError::Invalid);
            }
            let mut out = Vec::with_capacity(data.result.len());
            for item in data.result {
                if !item.value.0.is_finite() {
                    return Err(SourceError::Invalid);
                }
                let parsed = item
                    .value
                    .1
                    .parse::<f64>()
                    .map_err(|_| SourceError::Invalid)?;
                if !parsed.is_finite() {
                    return Err(SourceError::Invalid);
                }
                out.push(InstantSample {
                    metric: item.metric,
                    timestamp_s: item.value.0,
                    value: parsed,
                });
            }
            Ok(out)
        })
    }

    fn targets(&self) -> SourceFuture<'_, Vec<ScrapeTarget>> {
        Box::pin(async move {
            let Response::Success(data) = self
                .source
                .get::<Response<TargetsData>>("api/v1/targets")
                .await?;
            let mut out = Vec::with_capacity(data.active_targets.len());
            for item in data.active_targets {
                let health = match item.health.as_str() {
                    "up" => TargetHealth::Up,
                    "down" => TargetHealth::Down,
                    "unknown" => TargetHealth::Unknown,
                    _ => return Err(SourceError::Invalid),
                };
                let last_scrape =
                    if item.last_scrape.is_empty() || item.last_scrape.starts_with("0001-01-01") {
                        None
                    } else {
                        Some(
                            OffsetDateTime::parse(&item.last_scrape, &Rfc3339)
                                .map_err(|_| SourceError::Invalid)?,
                        )
                    };
                out.push(ScrapeTarget {
                    labels: item.labels,
                    scrape_pool: item.scrape_pool,
                    health,
                    last_error: item.last_error,
                    last_scrape,
                });
            }
            Ok(out)
        })
    }
}
