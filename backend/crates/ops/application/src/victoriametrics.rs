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
pub const QUERY_OPS_EVIDENCE_OK: &str = "ops:evidence_ok";
pub const QUERY_OPS_TEXTFILE_AGE: &str = "ops:textfile_age_seconds";
pub const QUERY_OPS_TEXTFILE_EXPECTED: &str = "ops:textfile_expected";
pub const QUERY_OPS_TEXTFILE_MAX_AGE: &str = "ops:textfile_max_age_seconds";
pub const QUERY_STATUS_FEED_READ_OK: &str = "console_status_feed_read_ok";
pub const QUERY_STATUS_FEED_OBSERVED_TS: &str = "console_status_feed_observed_timestamp_seconds";
pub const QUERY_STATUS_OBSERVER_MAX_AGE: &str = "console_status_observer_max_age_seconds";
pub const QUERY_STATUS_PUBLICATION_TS: &str = "console_status_publication_timestamp_seconds";
pub const QUERY_STATUS_EVIDENCE_EXPIRES_TS: &str =
    "console_status_evidence_expires_timestamp_seconds";
pub const QUERY_STATUS_EVIDENCE_MAX_AGE: &str = "console_status_evidence_max_age_seconds";
pub const QUERY_STATUS_REVISION: &str = "console_status_revision";
pub const QUERY_STATUS_UNKNOWN_COMPONENTS: &str = "console_status_unknown_components";
pub const QUERY_ONCALL_SYNTHETIC_PAGE_TS: &str = "console_oncall_synthetic_page_timestamp_seconds";
pub const QUERY_ONCALL_SYNTHETIC_PAGE_OK: &str = "console_oncall_synthetic_page_ok";
pub const QUERY_OPS_RECORDS_SPOOL_FILES: &str = "console_ops_records_spool_files";
pub const QUERY_OPS_RECORDS_UNSHIPPED: &str = "console_ops_records_unshipped";
pub const QUERY_OPS_RECORDS_SHIP_ERRORS: &str = "console_ops_records_ship_errors";
pub const QUERY_OPS_RECORDS_CHAIN_BROKEN: &str = "console_ops_records_chain_broken";
pub const QUERY_OPS_RECORDS_OLDEST_UNSHIPPED_TS: &str =
    "console_ops_records_oldest_unshipped_timestamp_seconds";
pub const QUERY_SLO_SLI_ERROR_30M: &str = "slo:sli_error:ratio_rate30m";
pub const QUERY_SLO_SLI_ERROR_3D: &str = "slo:sli_error:ratio_rate3d";
pub const QUERY_SLO_SLI_ERROR_30D: &str = "slo:sli_error:ratio_rate30d";
pub const QUERY_SLO_REQUESTS_1H: &str = "slo:requests:rate1h";
pub const QUERY_SLO_REQUESTS_30M: &str = "slo:requests:rate30m";
pub const QUERY_DEPLOY_LAST_TS: &str = "console_deploy_last_timestamp_seconds";
pub const QUERY_CONFIG_LAST_TS: &str = "console_config_last_timestamp_seconds";
pub const QUERY_RECOVERY_DEFERRED_SINCE_TS: &str =
    "console_recovery_deferred_since_timestamp_seconds";
pub const QUERY_RECOVERY_LAST_EXIT_CODE: &str = "console_recovery_last_exit_code";
pub const QUERY_WAL_REPO: &str = "console_wal_repo";
pub const QUERY_LVM_SNAPSHOT_TS: &str = "console_lvm_snapshot_timestamp_seconds";
pub const QUERY_ONPREM_MOUNT_EXPECTED: &str = "console_onprem_mount_expected";
pub const QUERY_HOST_DRIFT_FILES: &str = "console_host_drift_files";
pub const QUERY_APT_PENDING_UPDATES: &str = "console_apt_pending_updates";
pub const QUERY_APT_SECURITY_UPDATES: &str = "console_apt_security_updates";
pub const QUERY_REBOOT_REQUIRED_SINCE_S: &str = "console_reboot_required_since_seconds";
pub const QUERY_EGRESS_GUARD_DROPS: &str = "console_egress_guard_drops_total";
pub const QUERY_PREVIEW_RUNNING: &str = "console_preview_running";
pub const QUERY_PREVIEW_DIGEST_INFO: &str = "console_preview_digest_info";

pub const ALL_QUERIES: &[&str] = &[
    QUERY_UP,
    QUERY_NODE_TEXTFILE_MTIME,
    QUERY_SLO_ERROR_BUDGET_RATIO,
    QUERY_SLO_SLI_ERROR_1H,
    QUERY_SLO_SLI_ERROR_6H,
    QUERY_SLO_SLI_ERROR_30M,
    QUERY_SLO_SLI_ERROR_3D,
    QUERY_SLO_SLI_ERROR_30D,
    QUERY_SLO_REQUESTS_30D,
    QUERY_SLO_REQUESTS_1H,
    QUERY_SLO_REQUESTS_30M,
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
    QUERY_WAL_REPO,
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
    QUERY_OPS_EVIDENCE_OK,
    QUERY_OPS_TEXTFILE_AGE,
    QUERY_OPS_TEXTFILE_EXPECTED,
    QUERY_OPS_TEXTFILE_MAX_AGE,
    QUERY_STATUS_FEED_READ_OK,
    QUERY_STATUS_FEED_OBSERVED_TS,
    QUERY_STATUS_OBSERVER_MAX_AGE,
    QUERY_STATUS_PUBLICATION_TS,
    QUERY_STATUS_EVIDENCE_EXPIRES_TS,
    QUERY_STATUS_EVIDENCE_MAX_AGE,
    QUERY_STATUS_REVISION,
    QUERY_STATUS_UNKNOWN_COMPONENTS,
    QUERY_ONCALL_SYNTHETIC_PAGE_TS,
    QUERY_ONCALL_SYNTHETIC_PAGE_OK,
    QUERY_OPS_RECORDS_SPOOL_FILES,
    QUERY_OPS_RECORDS_UNSHIPPED,
    QUERY_OPS_RECORDS_SHIP_ERRORS,
    QUERY_OPS_RECORDS_CHAIN_BROKEN,
    QUERY_OPS_RECORDS_OLDEST_UNSHIPPED_TS,
    QUERY_DEPLOY_LAST_TS,
    QUERY_CONFIG_LAST_TS,
    QUERY_RECOVERY_DEFERRED_SINCE_TS,
    QUERY_RECOVERY_LAST_EXIT_CODE,
    QUERY_LVM_SNAPSHOT_TS,
    QUERY_ONPREM_MOUNT_EXPECTED,
    QUERY_HOST_DRIFT_FILES,
    QUERY_APT_PENDING_UPDATES,
    QUERY_APT_SECURITY_UPDATES,
    QUERY_REBOOT_REQUIRED_SINCE_S,
    QUERY_EGRESS_GUARD_DROPS,
    QUERY_PREVIEW_RUNNING,
    QUERY_PREVIEW_DIGEST_INFO,
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
