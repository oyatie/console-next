// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;

use console_ops_domain::bundle::OpsSettings;
use console_ops_domain::ladders::PublicComponent;
use console_ops_domain::status::StatusV2Snapshot;
use console_ops_domain::{Observed, ObservedTimestamp, UtcTimestamp};
use serde::Serialize;
use time::OffsetDateTime;

use crate::SourceFuture;
use crate::sources_status::SourceSlot;
use crate::victoriametrics::{
    QUERY_OPS_EVIDENCE_OK, QUERY_OPS_TEXTFILE_AGE, QUERY_OPS_TEXTFILE_MAX_AGE,
    QUERY_SLI_PAGE_LOAD_ERRORS, QUERY_SLI_PAGE_LOADS, QUERY_SLO_ERROR_BUDGET_RATIO,
    QUERY_SLO_REQUESTS_1H, QUERY_SLO_REQUESTS_30D, QUERY_SLO_REQUESTS_30M, QUERY_SLO_SLI_ERROR_1H,
    QUERY_SLO_SLI_ERROR_3D, QUERY_SLO_SLI_ERROR_6H, QUERY_SLO_SLI_ERROR_30D,
    QUERY_SLO_SLI_ERROR_30M, QUERY_STATUS_EVIDENCE_EXPIRES_TS, QUERY_STATUS_FEED_OBSERVED_TS,
    QUERY_STATUS_FEED_READ_OK, QUERY_STATUS_PUBLICATION_TS, QUERY_STATUS_REVISION,
    QUERY_STATUS_UNKNOWN_COMPONENTS, VictoriaMetricsSnapshot,
};

pub trait StatusFeed: Send + Sync {
    fn read(&self) -> SourceFuture<'_, StatusV2Snapshot>;
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SloHealthView {
    pub key: String,
    pub remaining_percent: Observed<f64>,
    pub burn_30m: Observed<f64>,
    pub burn_1h: Observed<f64>,
    pub burn_6h: Observed<f64>,
    pub burn_3d: Observed<f64>,
    pub burn_30d: Observed<f64>,
    pub exhaustion_s: Observed<f64>,
    pub requests_30d: Observed<f64>,
    pub low_sample: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low_sample_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EvidenceTruthEntryView {
    pub source: String,
    pub ok: Observed<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TextfileTruthView {
    pub file: String,
    pub age_s: Observed<f64>,
    pub max_age_s: Observed<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PublicStatusView {
    pub feed_ok: Observed<bool>,
    pub revision: Observed<u64>,
    pub published_at: ObservedTimestamp,
    pub observed_at: ObservedTimestamp,
    pub expires_at: ObservedTimestamp,
    pub unknown_components: Observed<u64>,
    pub components: BTreeMap<String, Observed<PublicComponent>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ServiceHealthView {
    #[serde(with = "time::serde::rfc3339")]
    pub evaluated_at: OffsetDateTime,
    pub internal_slos: Vec<SloHealthView>,
    pub page_load_error_rate_5m: Observed<f64>,
    pub page_loads_rate_5m: Observed<f64>,
    pub evidence_truth: Vec<EvidenceTruthEntryView>,
    pub textfiles: Vec<TextfileTruthView>,
    pub public_status: PublicStatusView,
}

pub struct HealthService;

impl HealthService {
    pub fn build_view(
        vm: &SourceSlot<VictoriaMetricsSnapshot>,
        status_feed: Option<&StatusV2Snapshot>,
        settings: &OpsSettings,
        now: OffsetDateTime,
    ) -> ServiceHealthView {
        let min_sample_floor = settings
            .thresholds
            .get("slo_min_samples")
            .copied()
            .unwrap_or(1000.0);

        let mut slo_keys = std::collections::BTreeSet::new();
        if let Some(snap) = vm.current.as_ref() {
            for q in [
                QUERY_SLO_ERROR_BUDGET_RATIO,
                QUERY_SLO_SLI_ERROR_1H,
                QUERY_SLO_SLI_ERROR_6H,
                QUERY_SLO_REQUESTS_30D,
            ] {
                for s in snap.series.get(q).into_iter().flatten() {
                    if let Some(k) = s.metric.get("slo").filter(|k| !k.is_empty()) {
                        slo_keys.insert(k.clone());
                    }
                }
            }
        }

        let internal_slos = slo_keys
            .into_iter()
            .map(|key| {
                let find = |q: &str| {
                    vm.current
                        .as_ref()?
                        .series
                        .get(q)?
                        .iter()
                        .find(|s| s.metric.get("slo").map(String::as_str) == Some(&key))
                        .map(|s| s.value)
                };
                let rem = find(QUERY_SLO_ERROR_BUDGET_RATIO).map(|r| r * 100.0);
                let b30m = find(QUERY_SLO_SLI_ERROR_30M);
                let b1h = find(QUERY_SLO_SLI_ERROR_1H);
                let b6h = find(QUERY_SLO_SLI_ERROR_6H);
                let b3d = find(QUERY_SLO_SLI_ERROR_3D);
                let b30d = find(QUERY_SLO_SLI_ERROR_30D);
                let req30d = find(QUERY_SLO_REQUESTS_30D);
                let req1h = find(QUERY_SLO_REQUESTS_1H);
                let req30m = find(QUERY_SLO_REQUESTS_30M);
                let exhaustion = match (rem, b1h) {
                    (Some(r), Some(b)) if b > 0.0 && r > 0.0 => {
                        Some((r / 100.0) * 30.0 * 86_400.0 / b)
                    }
                    (Some(r), _) if r <= 0.0 => Some(0.0),
                    _ => None,
                };
                let sample_count = req30d.or(req1h).or(req30m);
                let low_sample = sample_count.is_some_and(|n| n < min_sample_floor);
                SloHealthView {
                    key,
                    remaining_percent: vm.observe(rem, Some("%".into()), now),
                    burn_30m: vm.observe(b30m, None, now),
                    burn_1h: vm.observe(b1h, None, now),
                    burn_6h: vm.observe(b6h, None, now),
                    burn_3d: vm.observe(b3d, None, now),
                    burn_30d: vm.observe(b30d, None, now),
                    exhaustion_s: vm.observe(exhaustion, Some("s".into()), now),
                    requests_30d: vm.observe(req30d, Some("count".into()), now),
                    low_sample,
                    low_sample_note: low_sample
                        .then(|| format!("Low sample (n < {})", min_sample_floor as u64)),
                }
            })
            .collect();

        let first_val = |q: &str| vm.current.as_ref()?.series.get(q)?.first().map(|s| s.value);

        let evidence_truth = vm
            .current
            .as_ref()
            .and_then(|s| s.series.get(QUERY_OPS_EVIDENCE_OK))
            .map(|samples| {
                samples
                    .iter()
                    .filter_map(|s| {
                        let source = s.metric.get("source")?.clone();
                        Some(EvidenceTruthEntryView {
                            source,
                            ok: vm.observe(Some(s.value > 0.0), None, now),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let textfiles = vm
            .current
            .as_ref()
            .and_then(|s| s.series.get(QUERY_OPS_TEXTFILE_AGE))
            .map(|samples| {
                samples
                    .iter()
                    .filter_map(|s| {
                        let file = s.metric.get("file")?.clone();
                        let max_age = vm
                            .current
                            .as_ref()?
                            .series
                            .get(QUERY_OPS_TEXTFILE_MAX_AGE)
                            .and_then(|v| {
                                v.iter()
                                    .find(|m| {
                                        m.metric.get("file").map(String::as_str) == Some(&file)
                                    })
                                    .map(|m| m.value)
                            });
                        Some(TextfileTruthView {
                            file,
                            age_s: vm.observe(Some(s.value), Some("s".into()), now),
                            max_age_s: vm.observe(max_age, Some("s".into()), now),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let ts_from_vm = |q: &str| {
            first_val(q)
                .filter(|v| *v > 0.0)
                .and_then(|v| OffsetDateTime::from_unix_timestamp(v as i64).ok())
                .map(UtcTimestamp::new)
        };

        let mut public_components = BTreeMap::new();
        if let Some(feed) = status_feed
            && let Some(latest) = feed.evidence.samples.last()
        {
            for (comp, state) in &latest.components {
                public_components.insert(
                    comp.clone(),
                    Observed::current(
                        PublicComponent::from(*state),
                        None,
                        "status-feed".to_owned(),
                        *latest.at,
                        now,
                        vm.interval_s,
                    ),
                );
            }
        }

        let public_status = PublicStatusView {
            feed_ok: vm.observe(
                first_val(QUERY_STATUS_FEED_READ_OK).map(|v| v > 0.0),
                None,
                now,
            ),
            revision: vm.observe(
                status_feed
                    .map(|f| f.rev)
                    .or_else(|| first_val(QUERY_STATUS_REVISION).map(|v| v.max(0.0) as u64)),
                None,
                now,
            ),
            published_at: vm.observe(
                status_feed
                    .map(|f| f.generated_at)
                    .or_else(|| ts_from_vm(QUERY_STATUS_PUBLICATION_TS)),
                None,
                now,
            ),
            observed_at: vm.observe(ts_from_vm(QUERY_STATUS_FEED_OBSERVED_TS), None, now),
            expires_at: vm.observe(ts_from_vm(QUERY_STATUS_EVIDENCE_EXPIRES_TS), None, now),
            unknown_components: vm.observe(
                first_val(QUERY_STATUS_UNKNOWN_COMPONENTS).map(|v| v.max(0.0) as u64),
                Some("count".into()),
                now,
            ),
            components: public_components,
        };

        ServiceHealthView {
            evaluated_at: now,
            internal_slos,
            page_load_error_rate_5m: vm.observe(first_val(QUERY_SLI_PAGE_LOAD_ERRORS), None, now),
            page_loads_rate_5m: vm.observe(first_val(QUERY_SLI_PAGE_LOADS), None, now),
            evidence_truth,
            textfiles,
            public_status,
        }
    }
}
