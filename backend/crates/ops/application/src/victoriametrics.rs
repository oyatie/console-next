// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;

use time::OffsetDateTime;

use crate::{SourceError, SourceFuture};

pub const QUERY_UP: &str = "up";
pub const QUERY_NODE_TEXTFILE_MTIME: &str = "node_textfile_mtime_seconds";
pub const QUERY_SLO_ERROR_BUDGET_RATIO: &str = "slo:error_budget:ratio";
pub const QUERY_SLO_SLI_ERROR_1H: &str = "slo:sli_error:ratio_rate1h";
pub const QUERY_SLO_SLI_ERROR_6H: &str = "slo:sli_error:ratio_rate6h";
pub const QUERY_SLO_REQUESTS_30D: &str = "slo:requests:rate30d";
pub const QUERY_SLI_PAGE_LOAD_ERRORS: &str = "sli:page_load_errors:rate5m";
pub const QUERY_SLI_PAGE_LOADS: &str = "sli:page_loads:rate5m";
pub const QUERY_CONTAINER_RUNNING: &str = "console_container_running";
pub const QUERY_CONTAINER_UNHEALTHY: &str = "console_container_unhealthy";
pub const QUERY_CONTAINER_RESTARTS: &str = "console_container_restarts_total";
pub const QUERY_CONTAINER_OOM_KILLS: &str = "console_container_oom_kills_total";
pub const QUERY_CONTAINER_INFO: &str = "console_container_info";
pub const QUERY_CONTAINER_STARTED_TS: &str = "console_container_started_timestamp_seconds";
pub const QUERY_CONTAINER_RELEASE_STALE: &str = "console_container_release_stale";
pub const QUERY_CONTAINER_METRICS_TS: &str = "console_container_metrics_timestamp_seconds";
pub const QUERY_SYSTEMD_UNIT_ACTIVE: &str = "console_systemd_unit_active";
pub const QUERY_SYSTEMD_UNIT_FAILED: &str = "console_systemd_unit_failed";
pub const QUERY_SYSTEMD_UNIT_RESULT: &str = "console_systemd_unit_result";
pub const QUERY_SYSTEMD_TIMER_LAST_TRIGGER: &str =
    "console_systemd_timer_last_trigger_timestamp_seconds";
pub const QUERY_SYSTEMD_TIMER_NEXT_ELAPSE: &str =
    "console_systemd_timer_next_elapse_timestamp_seconds";
pub const QUERY_SYSTEMD_TIMER_NEVER_TRIGGERED: &str = "console_systemd_timer_never_triggered";
pub const QUERY_SYSTEMD_METRICS_TS: &str = "console_systemd_metrics_timestamp_seconds";
pub const QUERY_ROLLOUT_WEIGHT_PERCENT: &str = "console_rollout_weight_percent";
pub const QUERY_ROLLOUT_CANARY_PERCENT: &str = "console_rollout_canary_percent";
pub const QUERY_APP_COLOUR_RUNNING: &str = "console_app_colour_running";
pub const QUERY_FREEZE: &str = "console_freeze";
pub const QUERY_CONFIG_BUNDLE_INFO: &str = "console_config_bundle_info";
pub const QUERY_PGBACKREST_LAST_BACKUP_STOP: &str = "pgbackrest_last_backup_stop_timestamp_seconds";
pub const QUERY_PGBACKREST_ARCHIVE_MAX_WAL_AGE: &str = "pgbackrest_archive_max_wal_age_seconds";
pub const QUERY_WAL_REPO2_PUSH_FAILURES: &str = "console_wal_repo2_push_failures_total";
pub const QUERY_JOB_LAST_EXIT_CODE: &str = "console_job_last_exit_code";
pub const QUERY_JOB_LAST_SUCCESS_TS: &str = "console_job_last_success_timestamp_seconds";
pub const QUERY_SECRET_STATE: &str = "console_secret_state";
pub const QUERY_SECRET_EXPIRY_WINDOW: &str = "console_secret_expiry_window";
pub const QUERY_PAID_SKU_COUNT: &str = "paid_sku_count";
pub const QUERY_PAID_COST_MTD: &str = "paid_cost_mtd";
pub const QUERY_BILLING_UNREAD: &str = "billing_unread";
pub const QUERY_VAULT_FREE_TIER_BYTES: &str = "console_vault_free_tier_bytes";
pub const QUERY_VAULT_FREE_TIER_LIMIT_BYTES: &str = "console_vault_free_tier_limit_bytes";
pub const QUERY_HYGIENE_BYTES: &str = "console_hygiene_bytes";
pub const QUERY_OPS_REQUEST_LAST_TS: &str = "console_ops_request_last_timestamp_seconds";

pub const ALL_QUERIES: &[&str] = &[
    QUERY_UP,
    QUERY_NODE_TEXTFILE_MTIME,
    QUERY_SLO_ERROR_BUDGET_RATIO,
    QUERY_SLO_SLI_ERROR_1H,
    QUERY_SLO_SLI_ERROR_6H,
    QUERY_SLO_REQUESTS_30D,
    QUERY_SLI_PAGE_LOAD_ERRORS,
    QUERY_SLI_PAGE_LOADS,
    QUERY_CONTAINER_RUNNING,
    QUERY_CONTAINER_UNHEALTHY,
    QUERY_CONTAINER_RESTARTS,
    QUERY_CONTAINER_OOM_KILLS,
    QUERY_CONTAINER_INFO,
    QUERY_CONTAINER_STARTED_TS,
    QUERY_CONTAINER_RELEASE_STALE,
    QUERY_CONTAINER_METRICS_TS,
    QUERY_SYSTEMD_UNIT_ACTIVE,
    QUERY_SYSTEMD_UNIT_FAILED,
    QUERY_SYSTEMD_UNIT_RESULT,
    QUERY_SYSTEMD_TIMER_LAST_TRIGGER,
    QUERY_SYSTEMD_TIMER_NEXT_ELAPSE,
    QUERY_SYSTEMD_TIMER_NEVER_TRIGGERED,
    QUERY_SYSTEMD_METRICS_TS,
    QUERY_ROLLOUT_WEIGHT_PERCENT,
    QUERY_ROLLOUT_CANARY_PERCENT,
    QUERY_APP_COLOUR_RUNNING,
    QUERY_FREEZE,
    QUERY_CONFIG_BUNDLE_INFO,
    QUERY_PGBACKREST_LAST_BACKUP_STOP,
    QUERY_PGBACKREST_ARCHIVE_MAX_WAL_AGE,
    QUERY_WAL_REPO2_PUSH_FAILURES,
    QUERY_JOB_LAST_EXIT_CODE,
    QUERY_JOB_LAST_SUCCESS_TS,
    QUERY_SECRET_STATE,
    QUERY_SECRET_EXPIRY_WINDOW,
    QUERY_PAID_SKU_COUNT,
    QUERY_PAID_COST_MTD,
    QUERY_BILLING_UNREAD,
    QUERY_VAULT_FREE_TIER_BYTES,
    QUERY_VAULT_FREE_TIER_LIMIT_BYTES,
    QUERY_HYGIENE_BYTES,
    QUERY_OPS_REQUEST_LAST_TS,
];

#[derive(Debug, Clone, PartialEq)]
pub struct InstantSample {
    pub metric: BTreeMap<String, String>,
    pub timestamp_s: f64,
    pub value: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetHealth {
    Up,
    Down,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScrapeTarget {
    pub labels: BTreeMap<String, String>,
    pub scrape_pool: String,
    pub health: TargetHealth,
    pub last_error: String,
    pub last_scrape: Option<OffsetDateTime>,
}

#[derive(Debug, Clone, Default)]
pub struct VictoriaMetricsSnapshot {
    pub series: BTreeMap<String, Vec<InstantSample>>,
    pub targets: Vec<ScrapeTarget>,
}

pub trait VictoriaMetrics: Send + Sync {
    fn query_instant(&self, query: &str) -> SourceFuture<'_, Vec<InstantSample>>;
    fn targets(&self) -> SourceFuture<'_, Vec<ScrapeTarget>>;
}

pub async fn read_catalogue(
    port: &dyn VictoriaMetrics,
) -> Result<VictoriaMetricsSnapshot, SourceError> {
    let targets = port.targets().await?;
    let mut series = BTreeMap::new();
    for query in ALL_QUERIES {
        let samples = port.query_instant(query).await?;
        if !samples.is_empty() {
            series.insert((*query).to_owned(), samples);
        }
    }
    Ok(VictoriaMetricsSnapshot { series, targets })
}
