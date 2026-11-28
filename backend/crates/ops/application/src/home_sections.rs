// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeSet;

use console_ops_domain::UtcTimestamp;
use console_ops_domain::bundle::OpsSettings;
use time::OffsetDateTime;

use crate::snapshot::{
    BudgetView, ChangingView, CostView, DataSafetyView, FreeTierMeterView, LinkView,
};
use crate::sources_status::{SourceSlot, sanitize_text};
use crate::victoriametrics::{
    QUERY_APP_COLOUR_RUNNING, QUERY_CONFIG_BUNDLE_INFO, QUERY_FREEZE, QUERY_PAID_COST_MTD,
    QUERY_PAID_SKU_COUNT, QUERY_PGBACKREST_ARCHIVE_MAX_WAL_AGE, QUERY_PGBACKREST_LAST_BACKUP_STOP,
    QUERY_ROLLOUT_CANARY_PERCENT, QUERY_ROLLOUT_WEIGHT_PERCENT, QUERY_SLO_ERROR_BUDGET_RATIO,
    QUERY_SLO_REQUESTS_30D, QUERY_SLO_SLI_ERROR_1H, QUERY_SLO_SLI_ERROR_6H,
    QUERY_VAULT_FREE_TIER_BYTES, QUERY_VAULT_FREE_TIER_LIMIT_BYTES, VictoriaMetricsSnapshot,
};

pub fn build_changing(
    vm: &SourceSlot<VictoriaMetricsSnapshot>,
    now: OffsetDateTime,
) -> Vec<ChangingView> {
    let Some(snap) = vm.current.as_ref() else {
        return Vec::new();
    };
    let has_rollout = [
        QUERY_ROLLOUT_WEIGHT_PERCENT,
        QUERY_ROLLOUT_CANARY_PERCENT,
        QUERY_APP_COLOUR_RUNNING,
        QUERY_FREEZE,
        QUERY_CONFIG_BUNDLE_INFO,
    ]
    .iter()
    .any(|q| snap.series.get(*q).is_some_and(|v| !v.is_empty()));
    if !has_rollout {
        return Vec::new();
    }
    let colour = snap
        .series
        .get(QUERY_APP_COLOUR_RUNNING)
        .and_then(|v| v.iter().find(|s| s.value > 0.0))
        .and_then(|s| s.metric.get("colour"))
        .and_then(|v| sanitize_text(v));
    let digest = snap
        .series
        .get(QUERY_CONFIG_BUNDLE_INFO)
        .and_then(|v| v.first())
        .and_then(|s| s.metric.get("digest"))
        .and_then(|v| sanitize_text(v));
    let bundle_sha = snap
        .series
        .get(QUERY_CONFIG_BUNDLE_INFO)
        .and_then(|v| v.first())
        .and_then(|s| s.metric.get("sha"))
        .and_then(|v| sanitize_text(v));
    let weight = snap
        .series
        .get(QUERY_ROLLOUT_CANARY_PERCENT)
        .or_else(|| snap.series.get(QUERY_ROLLOUT_WEIGHT_PERCENT))
        .and_then(|v| v.first())
        .map(|s| s.value);
    vec![ChangingView {
        key: "production".to_owned(),
        digest: vm.observe(digest, None, now),
        colour: vm.observe(colour, None, now),
        canary_step: vm.observe(None, None, now),
        bundle_sha: vm.observe(bundle_sha, None, now),
        preview_candidate: vm.observe(None, None, now),
        maintenance_window: vm.observe(None, None, now),
        weight_percent: vm.observe(weight, Some("%".into()), now),
        watch_until: vm.observe(None, None, now),
        freeze: vm.deployment_freeze(now),
        next: LinkView {
            href: "/running".to_owned(),
            label: "Inspect rollout".to_owned(),
        },
    }]
}

pub fn build_budgets(
    vm: &SourceSlot<VictoriaMetricsSnapshot>,
    now: OffsetDateTime,
) -> Vec<BudgetView> {
    let Some(snap) = vm.current.as_ref() else {
        return Vec::new();
    };
    let mut keys = BTreeSet::new();
    for q in [
        QUERY_SLO_ERROR_BUDGET_RATIO,
        QUERY_SLO_SLI_ERROR_1H,
        QUERY_SLO_SLI_ERROR_6H,
        QUERY_SLO_REQUESTS_30D,
    ] {
        for s in snap.series.get(q).into_iter().flatten() {
            if let Some(k) = s.metric.get("slo").filter(|k| !k.is_empty()) {
                keys.insert(k.clone());
            }
        }
    }
    keys.into_iter()
        .map(|key| {
            let find = |q: &str| {
                snap.series
                    .get(q)?
                    .iter()
                    .find(|s| s.metric.get("slo").map(String::as_str) == Some(&key))
                    .map(|s| s.value)
            };
            let rem = find(QUERY_SLO_ERROR_BUDGET_RATIO).map(|r| r * 100.0);
            let b1 = find(QUERY_SLO_SLI_ERROR_1H);
            let b6 = find(QUERY_SLO_SLI_ERROR_6H);
            let reqs = find(QUERY_SLO_REQUESTS_30D).map(|v| v.max(0.0) as u64);
            BudgetView {
                key,
                remaining_percent: vm.observe(rem, Some("%".into()), now),
                burn_1h: vm.observe(b1, None, now),
                burn_6h: vm.observe(b6, None, now),
                exhaustion_s: vm.observe(None, Some("s".into()), now),
                requests_30d: vm.observe(reqs, Some("count".into()), now),
            }
        })
        .collect()
}

pub fn build_data_safety(
    vm: &SourceSlot<VictoriaMetricsSnapshot>,
    settings: &OpsSettings,
    now: OffsetDateTime,
) -> Vec<DataSafetyView> {
    let Some(snap) = vm.current.as_ref() else {
        return Vec::new();
    };
    let mut repos = BTreeSet::new();
    for q in [
        QUERY_PGBACKREST_LAST_BACKUP_STOP,
        QUERY_PGBACKREST_ARCHIVE_MAX_WAL_AGE,
    ] {
        for s in snap.series.get(q).into_iter().flatten() {
            if let Some(r) = s.metric.get("repo").filter(|r| !r.is_empty()) {
                repos.insert(r.clone());
            }
        }
    }
    let limit = settings.thresholds.get("rpo_limit_s").copied();
    repos
        .into_iter()
        .map(|repository| {
            let find = |q: &str| {
                snap.series
                    .get(q)?
                    .iter()
                    .find(|s| s.metric.get("repo").map(String::as_str) == Some(&repository))
                    .map(|s| s.value)
            };
            let rpo = find(QUERY_PGBACKREST_ARCHIVE_MAX_WAL_AGE);
            let last_backup = find(QUERY_PGBACKREST_LAST_BACKUP_STOP)
                .and_then(|ts| OffsetDateTime::from_unix_timestamp(ts as i64).ok())
                .map(UtcTimestamp::new);
            DataSafetyView {
                repository,
                rpo_s: vm.observe(rpo, Some("s".into()), now),
                limit_s: vm.observe(limit, Some("s".into()), now),
                last_base_backup: vm.observe(last_backup, None, now),
                last_proven_restore: vm.observe(None, None, now),
            }
        })
        .collect()
}

pub fn build_cost(
    vm: &SourceSlot<VictoriaMetricsSnapshot>,
    settings: &OpsSettings,
    now: OffsetDateTime,
) -> Vec<CostView> {
    let Some(snap) = vm.current.as_ref() else {
        return Vec::new();
    };
    let mtd = snap
        .series
        .get(QUERY_PAID_COST_MTD)
        .and_then(|v| v.first())
        .map(|s| s.value);
    let skus = snap
        .series
        .get(QUERY_PAID_SKU_COUNT)
        .and_then(|v| v.first())
        .map(|s| s.value.max(0.0) as u64);
    let free_used = snap
        .series
        .get(QUERY_VAULT_FREE_TIER_BYTES)
        .into_iter()
        .flatten();
    let mut limits = Vec::new();
    let warn_ratio = settings.thresholds.get("free_tier_warning_ratio").copied();
    for s in free_used {
        if let Some(meter) = s.metric.get("meter").and_then(|v| sanitize_text(v)) {
            let limit_val = snap
                .series
                .get(QUERY_VAULT_FREE_TIER_LIMIT_BYTES)
                .and_then(|v| {
                    v.iter()
                        .find(|l| l.metric.get("meter").map(String::as_str) == Some(&meter))
                        .map(|l| l.value)
                });
            limits.push(FreeTierMeterView {
                key: meter,
                used: vm.observe(Some(s.value), Some("bytes".into()), now),
                limit: vm.observe(limit_val, Some("bytes".into()), now),
                warning_ratio: vm.observe(warn_ratio, None, now),
            });
        }
    }
    if mtd.is_none() && skus.is_none() && limits.is_empty() {
        return Vec::new();
    }
    vec![CostView {
        key: "oci".to_owned(),
        mtd: vm.observe(mtd, Some("USD".into()), now),
        lag_s: vm.observe(None, Some("s".into()), now),
        billed_skus: vm.observe(skus, Some("count".into()), now),
        limits,
    }]
}
