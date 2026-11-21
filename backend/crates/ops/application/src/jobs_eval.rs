// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroU64;

use console_ops_domain::UtcTimestamp;
use console_ops_domain::ladders::JobState;
use time::OffsetDateTime;

use crate::snapshot::{JobView, JobsView};
use crate::sources_status::SourceSlot;
use crate::victoriametrics::{
    QUERY_JOB_LAST_EXIT_CODE, QUERY_JOB_LAST_SUCCESS_TS, VictoriaMetricsSnapshot,
};

pub fn evaluate_jobs(
    vm: &SourceSlot<VictoriaMetricsSnapshot>,
    known_jobs: &BTreeSet<String>,
    budgets: &BTreeMap<String, NonZeroU64>,
    now: OffsetDateTime,
) -> JobsView {
    let mut names = known_jobs.clone();
    if let Some(snap) = vm.current.as_ref() {
        for query in [QUERY_JOB_LAST_EXIT_CODE, QUERY_JOB_LAST_SUCCESS_TS] {
            for sample in snap.series.get(query).into_iter().flatten() {
                if let Some(name) = sample.metric.get("job").filter(|j| !j.is_empty()) {
                    names.insert(name.clone());
                }
            }
        }
    }
    let default_budget = budgets
        .get("job_max_age_s")
        .map(|n| n.get() as f64)
        .unwrap_or(86400.0);

    let jobs: Vec<JobView> = names
        .into_iter()
        .map(|name| {
            let exit_val = vm.current.as_ref().and_then(|snap| {
                snap.series
                    .get(QUERY_JOB_LAST_EXIT_CODE)?
                    .iter()
                    .find(|s| s.metric.get("job").map(String::as_str) == Some(&name))
                    .map(|s| s.value)
            });
            let success_ts = vm.current.as_ref().and_then(|snap| {
                snap.series
                    .get(QUERY_JOB_LAST_SUCCESS_TS)?
                    .iter()
                    .find(|s| s.metric.get("job").map(String::as_str) == Some(&name))
                    .map(|s| s.value)
            });
            let budget_s = budgets
                .get(&format!("job.{name}.max_age_s"))
                .or_else(|| budgets.get(&name))
                .map(|n| n.get() as f64)
                .unwrap_or(default_budget);
            let last_run_dt = success_ts
                .filter(|ts| *ts > 0.0)
                .and_then(|ts| OffsetDateTime::from_unix_timestamp(ts as i64).ok());
            let job_state = if vm.current.is_none() {
                None
            } else if exit_val.is_some_and(|code| code != 0.0) {
                Some(JobState::Failed)
            } else if success_ts.is_none_or(|ts| ts <= 0.0) {
                Some(JobState::NeverReported)
            } else if let Some(at) = last_run_dt
                && (now - at).whole_seconds() as f64 > budget_s
            {
                Some(JobState::Late)
            } else {
                Some(JobState::Succeeded)
            };
            JobView {
                name,
                state: vm.observe(job_state, None, now),
                last_run: vm.observe(last_run_dt.map(UtcTimestamp::new), None, now),
                last_exit: vm.observe(exit_val, None, now),
                budget: vm.observe(Some(budget_s), Some("s".into()), now),
                next_run: None,
            }
        })
        .collect();

    let count = vm.observe(
        vm.current.as_ref().map(|_| jobs.len()),
        Some("count".into()),
        now,
    );
    JobsView {
        evaluated_at: now,
        jobs,
        count,
    }
}
