// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroU64;

use console_ops_domain::bundle::ComponentsMap;
use console_ops_domain::ladders::{Drift, Health};
use console_ops_domain::{Observed, ObservedTimestamp, UtcTimestamp, roll_up};
use time::OffsetDateTime;

use crate::snapshot::{ComponentView, Membership, RollupView, RunningView};
use crate::sources_status::{SourceSlot, sanitize_text};
use crate::victoriametrics::{
    InstantSample, QUERY_CONTAINER_INFO, QUERY_CONTAINER_RELEASE_STALE, QUERY_CONTAINER_RUNNING,
    QUERY_CONTAINER_STARTED_TS, QUERY_CONTAINER_UNHEALTHY, QUERY_SYSTEMD_UNIT_ACTIVE,
    QUERY_SYSTEMD_UNIT_FAILED, QUERY_UP, VictoriaMetricsSnapshot,
};

pub fn evaluate_running(
    vm: &SourceSlot<VictoriaMetricsSnapshot>,
    components: &ComponentsMap,
    bundle_observed_at: OffsetDateTime,
    now: OffsetDateTime,
) -> RunningView {
    let mut out = Vec::with_capacity(components.len());
    let mut matched_services = BTreeSet::new();
    let bundle_interval = NonZeroU64::new(86400).unwrap_or(NonZeroU64::MIN);

    for (key, spec) in components {
        matched_services.insert(key.clone());
        let observed = inspect_component(vm, key, spec.interval_s, now);
        let runbook = Observed::current(
            spec.runbook.clone(),
            None,
            "bundle".to_owned(),
            bundle_observed_at,
            now,
            bundle_interval,
        );
        out.push(ComponentView {
            key: key.clone(),
            group: spec.group.clone(),
            host: spec.host.clone(),
            health: observed.health,
            drift: observed.drift,
            image: observed.image,
            digest: observed.digest,
            started: observed.started,
            source: spec.source.clone(),
            observed_at: observed.observed_at,
            age: observed.age,
            last_error: observed.last_error,
            runbook,
            membership: Membership::Declared,
        });
    }

    if let Some(snap) = vm.current.as_ref() {
        for sample in snap
            .series
            .get(QUERY_CONTAINER_RUNNING)
            .into_iter()
            .flatten()
        {
            let svc = sample
                .metric
                .get("service")
                .or_else(|| sample.metric.get("name"))
                .cloned();
            let Some(key) = svc.filter(|k| !k.is_empty() && !matched_services.contains(k)) else {
                continue;
            };
            matched_services.insert(key.clone());
            let observed = inspect_component(vm, &key, vm.interval_s, now);
            out.push(ComponentView {
                key,
                group: sample
                    .metric
                    .get("project")
                    .and_then(|v| sanitize_text(v))
                    .unwrap_or_else(|| "extra".to_owned()),
                host: sample
                    .metric
                    .get("instance")
                    .and_then(|v| sanitize_text(v))
                    .unwrap_or_else(|| "unassigned".to_owned()),
                health: observed.health,
                drift: observed.drift,
                image: observed.image,
                digest: observed.digest,
                started: observed.started,
                source: vm.producer.clone(),
                observed_at: observed.observed_at,
                age: observed.age,
                last_error: observed.last_error,
                runbook: Observed::unknown("bundle".to_owned(), "not instrumented".to_owned()),
                membership: Membership::Extra,
            });
        }
    }

    let hosts = rollup_by(&out, |c| c.host.as_str(), vm, now);
    let groups = rollup_by(&out, |c| c.group.as_str(), vm, now);
    let count = vm.observe(
        vm.current.as_ref().map(|_| out.len()),
        Some("count".into()),
        now,
    );

    RunningView {
        evaluated_at: now,
        components: out,
        hosts,
        groups,
        count,
    }
}

struct ComponentObs {
    health: Observed<Health>,
    drift: Observed<Drift>,
    image: Option<Observed<String>>,
    digest: Option<Observed<String>>,
    started: Option<ObservedTimestamp>,
    observed_at: Option<OffsetDateTime>,
    age: u64,
    last_error: Option<Observed<String>>,
}

fn matches_key(sample: &InstantSample, key: &str) -> bool {
    let unit = format!("console-{key}.service");
    sample.metric.get("component").map(String::as_str) == Some(key)
        || sample.metric.get("service").map(String::as_str) == Some(key)
        || sample.metric.get("job").map(String::as_str) == Some(key)
        || sample.metric.get("name").map(String::as_str) == Some(key)
        || sample.metric.get("unit").map(String::as_str) == Some(unit.as_str())
}

fn find_sample<'a>(
    snap: &'a VictoriaMetricsSnapshot,
    query: &str,
    key: &str,
) -> Option<&'a InstantSample> {
    snap.series
        .get(query)
        .and_then(|v| v.iter().find(|s| matches_key(s, key)))
}

fn inspect_component(
    vm: &SourceSlot<VictoriaMetricsSnapshot>,
    key: &str,
    interval_s: NonZeroU64,
    now: OffsetDateTime,
) -> ComponentObs {
    let Some(snap) = vm.current.as_ref() else {
        return ComponentObs {
            health: Observed::unknown(vm.producer.clone(), vm.reason.clone()),
            drift: Observed::unknown(vm.producer.clone(), vm.reason.clone()),
            image: None,
            digest: None,
            started: None,
            observed_at: None,
            age: 0,
            last_error: None,
        };
    };

    let unhealthy = find_sample(snap, QUERY_CONTAINER_UNHEALTHY, key);
    let running = find_sample(snap, QUERY_CONTAINER_RUNNING, key);
    let sys_failed = find_sample(snap, QUERY_SYSTEMD_UNIT_FAILED, key);
    let sys_active = find_sample(snap, QUERY_SYSTEMD_UNIT_ACTIVE, key);
    let up = find_sample(snap, QUERY_UP, key);

    let health_val = if unhealthy.is_some_and(|s| s.value > 0.0)
        || sys_failed.is_some_and(|s| s.value > 0.0)
        || up.is_some_and(|s| s.value == 0.0)
    {
        Health::Degraded
    } else if running.is_some_and(|s| s.value == 0.0) || sys_active.is_some_and(|s| s.value == 0.0)
    {
        Health::Missing
    } else if running.is_some_and(|s| s.value > 0.0)
        || sys_active.is_some_and(|s| s.value > 0.0)
        || up.is_some_and(|s| s.value > 0.0)
    {
        Health::Healthy
    } else {
        Health::Missing
    };

    let obs_at = vm.attempted_at;
    let health = match obs_at {
        Some(at) => Observed::current(health_val, None, vm.producer.clone(), at, now, interval_s),
        None => Observed::unknown(vm.producer.clone(), vm.reason.clone()),
    };
    let drift_sample = find_sample(snap, QUERY_CONTAINER_RELEASE_STALE, key);
    let drift = match (obs_at, drift_sample) {
        (Some(at), Some(s)) => Observed::current(
            if s.value > 0.0 {
                Drift::OutOfSync
            } else {
                Drift::Synced
            },
            None,
            vm.producer.clone(),
            at,
            now,
            interval_s,
        ),
        _ => Observed::unknown(vm.producer.clone(), "not instrumented".to_owned()),
    };

    let info = find_sample(snap, QUERY_CONTAINER_INFO, key);
    let image = info
        .and_then(|s| s.metric.get("image"))
        .and_then(|v| sanitize_text(v))
        .map(|val| vm.observe_at(Some(val), None, obs_at, now, interval_s));
    let digest = info
        .and_then(|s| s.metric.get("digest"))
        .and_then(|v| sanitize_text(v))
        .map(|val| vm.observe_at(Some(val), None, obs_at, now, interval_s));
    let started = find_sample(snap, QUERY_CONTAINER_STARTED_TS, key)
        .and_then(|s| OffsetDateTime::from_unix_timestamp(s.value as i64).ok())
        .map(|ts| vm.observe_at(Some(UtcTimestamp::new(ts)), None, obs_at, now, interval_s));

    let age = health.age_s();
    ComponentObs {
        health,
        drift,
        image,
        digest,
        started,
        observed_at: obs_at,
        age,
        last_error: None,
    }
}

fn rollup_by(
    components: &[ComponentView],
    key_fn: impl Fn(&ComponentView) -> &str,
    vm: &SourceSlot<VictoriaMetricsSnapshot>,
    now: OffsetDateTime,
) -> Vec<RollupView> {
    let mut grouped: BTreeMap<String, Vec<&ComponentView>> = BTreeMap::new();
    for c in components {
        grouped.entry(key_fn(c).to_owned()).or_default().push(c);
    }
    grouped
        .into_iter()
        .map(|(key, items)| {
            let health = roll_up(
                items
                    .iter()
                    .map(|c| c.health.value().copied().unwrap_or(Health::Unknown)),
            );
            let drift = items
                .iter()
                .map(|c| c.drift.value().copied().unwrap_or(Drift::Unknown))
                .max()
                .unwrap_or(Drift::Unknown);
            RollupView {
                key,
                health: vm.observe(Some(health), None, now),
                drift: vm.observe(Some(drift), None, now),
            }
        })
        .collect()
}
