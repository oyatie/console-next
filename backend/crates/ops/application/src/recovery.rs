// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeSet;

use console_ops_domain::bundle::OpsSettings;
use console_ops_domain::changes::CmdHandOff;
use console_ops_domain::recovery::{BackupRequestInput, DrillRequestInput, DrillType};
use console_ops_domain::{Observed, ObservedTimestamp, UtcTimestamp};
use serde::Serialize;
use time::OffsetDateTime;

use crate::actions::{ActionStore, CmdHandOffInput};
use crate::obligations::{Context, Error as SpoolError};
use crate::sources_status::SourceSlot;
use crate::victoriametrics::{
    QUERY_LVM_SNAPSHOT_TS, QUERY_ONPREM_MOUNT_EXPECTED, QUERY_PGBACKREST_ARCHIVE_MAX_WAL_AGE,
    QUERY_PGBACKREST_LAST_BACKUP_STOP, QUERY_RECOVERY_DEFERRED_SINCE_TS,
    QUERY_RECOVERY_LAST_EXIT_CODE, QUERY_WAL_REPO, QUERY_WAL_REPO2_PUSH_FAILURES,
    VictoriaMetricsSnapshot,
};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecoveryRepoView {
    pub repository: String,
    pub rpo_s: Observed<f64>,
    pub limit_s: Observed<f64>,
    pub last_base_backup: ObservedTimestamp,
    pub push_failures: Observed<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecoveryView {
    #[serde(with = "time::serde::rfc3339")]
    pub evaluated_at: OffsetDateTime,
    pub repos: Vec<RecoveryRepoView>,
    pub rto: Observed<f64>,
    pub deferred_since: ObservedTimestamp,
    pub last_exit_code: Observed<f64>,
    pub lvm_snapshot_at: ObservedTimestamp,
    pub onprem_mount_expected: Observed<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryError {
    InvalidInput(String),
    NotFound,
    Spool(SpoolError),
}

impl From<SpoolError> for RecoveryError {
    fn from(value: SpoolError) -> Self {
        Self::Spool(value)
    }
}

pub struct RecoveryService<'a> {
    pub actions: &'a dyn ActionStore,
}

impl<'a> RecoveryService<'a> {
    pub fn build_view(
        &self,
        vm: &SourceSlot<VictoriaMetricsSnapshot>,
        settings: &OpsSettings,
        now: OffsetDateTime,
    ) -> RecoveryView {
        let mut repo_names = BTreeSet::new();
        if let Some(snap) = vm.current.as_ref() {
            for q in [
                QUERY_PGBACKREST_LAST_BACKUP_STOP,
                QUERY_PGBACKREST_ARCHIVE_MAX_WAL_AGE,
                QUERY_WAL_REPO,
            ] {
                for s in snap.series.get(q).into_iter().flatten() {
                    if let Some(repo) = s.metric.get("repo").filter(|r| !r.is_empty()) {
                        repo_names.insert(repo.clone());
                    }
                }
            }
        }
        let limit = settings.thresholds.get("rpo_limit_s").copied();
        let repos = repo_names
            .into_iter()
            .map(|repository| {
                let find = |q: &str| {
                    vm.current
                        .as_ref()?
                        .series
                        .get(q)?
                        .iter()
                        .find(|s| s.metric.get("repo").map(String::as_str) == Some(&repository))
                        .map(|s| s.value)
                };
                let rpo = find(QUERY_PGBACKREST_ARCHIVE_MAX_WAL_AGE);
                let backup = find(QUERY_PGBACKREST_LAST_BACKUP_STOP)
                    .and_then(|ts| OffsetDateTime::from_unix_timestamp(ts as i64).ok())
                    .map(UtcTimestamp::new);
                let push_failures = if repository == "2" {
                    vm.current
                        .as_ref()
                        .and_then(|s| s.series.get(QUERY_WAL_REPO2_PUSH_FAILURES))
                        .and_then(|v| v.first())
                        .map(|s| s.value)
                } else {
                    None
                };
                RecoveryRepoView {
                    repository,
                    rpo_s: vm.observe(rpo, Some("s".into()), now),
                    limit_s: vm.observe(limit, Some("s".into()), now),
                    last_base_backup: vm.observe(backup, None, now),
                    push_failures: vm.observe(push_failures, Some("count".into()), now),
                }
            })
            .collect();

        let first_val = |q: &str| vm.current.as_ref()?.series.get(q)?.first().map(|s| s.value);
        let deferred_since = first_val(QUERY_RECOVERY_DEFERRED_SINCE_TS)
            .filter(|ts| *ts > 0.0)
            .and_then(|ts| OffsetDateTime::from_unix_timestamp(ts as i64).ok())
            .map(UtcTimestamp::new);
        let lvm_snapshot = first_val(QUERY_LVM_SNAPSHOT_TS)
            .filter(|ts| *ts > 0.0)
            .and_then(|ts| OffsetDateTime::from_unix_timestamp(ts as i64).ok())
            .map(UtcTimestamp::new);
        let last_exit = first_val(QUERY_RECOVERY_LAST_EXIT_CODE);
        let onprem_mount = first_val(QUERY_ONPREM_MOUNT_EXPECTED).map(|v| v > 0.0);

        RecoveryView {
            evaluated_at: now,
            repos,
            rto: Observed::unknown("dr-rehearse".to_owned(), "Not measured".to_owned()),
            deferred_since: vm.observe(deferred_since, None, now),
            last_exit_code: vm.observe(last_exit, None, now),
            lvm_snapshot_at: vm.observe(lvm_snapshot, None, now),
            onprem_mount_expected: vm.observe(onprem_mount, None, now),
        }
    }

    pub fn request_backup(
        &self,
        input: &BackupRequestInput,
        context: &Context,
    ) -> Result<CmdHandOff, RecoveryError> {
        let cmd = format!(
            "scripts/tb backup-now type={} window={}",
            input.backup_type.as_str(),
            input.window.as_str()
        );
        let consequence = format!(
            "Schedules {} pgBackRest backup ({})",
            input.backup_type.as_str(),
            input.window.as_str()
        );
        let rec = self.actions.record_handoff(
            &CmdHandOffInput {
                kind: "backup-now",
                command: &cmd,
                target: input.backup_type.as_str(),
                consequence: &consequence,
                expected_result: "New pgBackRest base backup recorded and RPO/backup timestamp updated",
                verify_step: "Verify /recovery shows updated last_base_backup",
            },
            context,
        )?;
        Ok(rec.handoff)
    }

    pub fn request_drill(
        &self,
        input: &DrillRequestInput,
        context: &Context,
    ) -> Result<CmdHandOff, RecoveryError> {
        input
            .validate()
            .map_err(|e| RecoveryError::InvalidInput(e.0))?;
        let (kind, cmd) = match input.drill_type {
            DrillType::Name => {
                let target_arg = input
                    .target
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|t| format!(" target={t}"))
                    .unwrap_or_default();
                (
                    "drill",
                    format!(
                        "scripts/tb drill repo={} window={}{target_arg}",
                        input.repo.as_str(),
                        input.window.as_str()
                    ),
                )
            }
            DrillType::Time => {
                let target = input.target.as_deref().map(str::trim).unwrap_or("");
                (
                    "drill-at",
                    format!(
                        "scripts/tb drill-at repo={} target={target} window={}",
                        input.repo.as_str(),
                        input.window.as_str()
                    ),
                )
            }
        };
        let rec = self.actions.record_handoff(
            &CmdHandOffInput {
                kind,
                command: &cmd,
                target: input.repo.as_str(),
                consequence: "Executes non-destructive isolated database restore verification drill",
                expected_result: "Restore drill completes with exit code 0 and checksum verification",
                verify_step: "Verify /recovery last_exit_code == 0",
            },
            context,
        )?;
        Ok(rec.handoff)
    }
}

pub fn rerun_job_cmd(
    known_jobs: &[String],
    job_name: &str,
    actions: &dyn ActionStore,
    context: &Context,
) -> Result<CmdHandOff, RecoveryError> {
    let name = job_name.trim();
    if name.is_empty()
        || name.chars().any(|c| c.is_control() || c.is_whitespace())
        || !known_jobs.iter().any(|j| j == name)
    {
        return Err(RecoveryError::NotFound);
    }
    let cmd = format!("sudo systemctl start console-{name}.service");
    let consequence = format!("Triggers one-shot systemd run for job {name}");
    let expected = format!("Job {name} runs and updates job-{name}-exit.prom");
    let rec = actions.record_handoff(
        &CmdHandOffInput {
            kind: "jobs-rerun",
            command: &cmd,
            target: name,
            consequence: &consequence,
            expected_result: &expected,
            verify_step: "Verify /running/jobs shows exit code 0 and updated last_run",
        },
        context,
    )?;
    Ok(rec.handoff)
}
