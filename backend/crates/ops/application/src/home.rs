// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use console_ops_domain::bundle::{ComponentsMap, OpsSettings};
use console_ops_domain::ladders::{EvidenceState, Health, WorkKind};
use console_ops_domain::{roll_up, verdict};
use time::OffsetDateTime;

use crate::alert_actions::{AlertAckStore, overlay_acks_and_changes};
use crate::alerts_eval::{collect_known_groups, evaluate_alerts};
use crate::changes::HostStateStore;
use crate::home_sections::{build_budgets, build_changing, build_cost, build_data_safety};
use crate::home_worklist::{SourcesInputs, build_worklist, collect_sources};
use crate::home_worklist_extra::collect_recent_changes;
use crate::jobs_eval::evaluate_jobs;
use crate::running_eval::evaluate_running;
use crate::snapshot::{EvaluatedSnapshot, EvidenceView, HomeSnapshotView, SourceKind, SourcesView};
use crate::sources_status::{ExternalSourceStatus, SourceSlot, count_evidence};
use crate::victoriametrics::{
    QUERY_JOB_LAST_EXIT_CODE, QUERY_JOB_LAST_SUCCESS_TS, VictoriaMetrics, VictoriaMetricsSnapshot,
    read_catalogue,
};
use crate::{Alertmanager, AlertmanagerSnapshot, SourceError, Vmalert, VmalertSnapshot};

pub struct SourcePorts {
    pub alertmanager: Arc<dyn Alertmanager>,
    pub vmalert: Arc<dyn Vmalert>,
    pub victoriametrics: Arc<dyn VictoriaMetrics>,
}

pub struct TickReport {
    pub source: &'static str,
    pub ok: bool,
}

pub struct CockpitEvaluator {
    ports: SourcePorts,
    components: ComponentsMap,
    settings: OpsSettings,
    alertmanager: SourceSlot<AlertmanagerSnapshot>,
    vmalert: SourceSlot<VmalertSnapshot>,
    victoriametrics: SourceSlot<VictoriaMetricsSnapshot>,
    bundle_observed_at: OffsetDateTime,
    evaluator_observed_at: Option<OffsetDateTime>,
    access_jwks_status: ExternalSourceStatus,
    known_jobs: BTreeSet<String>,
    known_groups: BTreeMap<String, String>,
    ack_store: Option<Arc<dyn AlertAckStore>>,
    host_state: Option<Arc<dyn HostStateStore>>,
}

impl CockpitEvaluator {
    pub fn new(
        ports: SourcePorts,
        components: ComponentsMap,
        settings: OpsSettings,
        boot_at: OffsetDateTime,
    ) -> Self {
        let am_prod = settings.sources.alertmanager.producer.clone();
        let am_int = settings.sources.alertmanager.interval_s;
        let vm_prod = settings.sources.vmalert.producer.clone();
        let vm_int = settings.sources.vmalert.interval_s;
        let vmetrics_prod = settings.sources.victoriametrics.producer.clone();
        let vmetrics_int = settings.sources.victoriametrics.interval_s;
        let access_jwks_status = ExternalSourceStatus {
            name: "access_jwks".to_owned(),
            kind: SourceKind::AccessJwks,
            producer: settings.access.team.clone(),
            interval_s: settings.access.interval_s,
            observed_at: None,
            error: None,
        };
        Self {
            ports,
            components,
            settings,
            alertmanager: SourceSlot::new(
                "alertmanager",
                SourceKind::Alertmanager,
                am_prod,
                am_int,
            ),
            vmalert: SourceSlot::new("vmalert", SourceKind::Vmalert, vm_prod, vm_int),
            victoriametrics: SourceSlot::new(
                "victoriametrics",
                SourceKind::VictoriaMetrics,
                vmetrics_prod,
                vmetrics_int,
            ),
            bundle_observed_at: boot_at,
            evaluator_observed_at: None,
            access_jwks_status,
            known_jobs: BTreeSet::new(),
            known_groups: BTreeMap::new(),
            ack_store: None,
            host_state: None,
        }
    }

    pub fn with_ack_store(mut self, ack_store: Arc<dyn AlertAckStore>) -> Self {
        self.ack_store = Some(ack_store);
        self
    }

    pub fn with_host_state(mut self, host_state: Arc<dyn HostStateStore>) -> Self {
        self.host_state = Some(host_state);
        self
    }

    pub fn set_access_jwks_status(
        &mut self,
        observed_at: Option<OffsetDateTime>,
        error: Option<String>,
    ) {
        self.access_jwks_status.observed_at = observed_at;
        self.access_jwks_status.error = error;
    }

    pub async fn tick(&mut self, now: OffsetDateTime) -> Vec<TickReport> {
        let mut reports = Vec::new();
        if self.alertmanager.due(now) {
            self.alertmanager.begin_read(now);
            let ok = match self.ports.alertmanager.read().await {
                Ok(snap) => {
                    self.known_groups = collect_known_groups(&snap.alerts);
                    self.alertmanager.finish_ok(snap);
                    true
                }
                Err(err) => {
                    self.alertmanager.finish_err(err.to_string());
                    false
                }
            };
            reports.push(TickReport {
                source: "alertmanager",
                ok,
            });
        }
        if self.vmalert.due(now) {
            self.vmalert.begin_read(now);
            let ok = match self.ports.vmalert.read().await {
                Ok(snap) => {
                    self.vmalert.finish_ok(snap);
                    true
                }
                Err(err) => {
                    self.vmalert.finish_err(err.to_string());
                    false
                }
            };
            reports.push(TickReport {
                source: "vmalert",
                ok,
            });
        }
        if self.victoriametrics.due(now) {
            self.victoriametrics.begin_read(now);
            let ok = match read_catalogue(&*self.ports.victoriametrics).await {
                Ok(snap) => {
                    for q in [QUERY_JOB_LAST_EXIT_CODE, QUERY_JOB_LAST_SUCCESS_TS] {
                        for s in snap.series.get(q).into_iter().flatten() {
                            if let Some(job) = s.metric.get("job").filter(|j| !j.is_empty()) {
                                self.known_jobs.insert(job.clone());
                            }
                        }
                    }
                    self.victoriametrics.finish_ok(snap);
                    true
                }
                Err(err) => {
                    self.victoriametrics.finish_err(err.to_string());
                    false
                }
            };
            reports.push(TickReport {
                source: "victoriametrics",
                ok,
            });
        }
        self.evaluator_observed_at = Some(now);
        reports
    }

    pub fn inject_source_error_for_test(
        &mut self,
        source: &str,
        err: SourceError,
        now: OffsetDateTime,
    ) {
        match source {
            "alertmanager" => {
                self.alertmanager.attempted_at = Some(now);
                self.alertmanager.finish_err(err.to_string());
            }
            "vmalert" => {
                self.vmalert.attempted_at = Some(now);
                self.vmalert.finish_err(err.to_string());
            }
            "victoriametrics" => {
                self.victoriametrics.attempted_at = Some(now);
                self.victoriametrics.finish_err(err.to_string());
            }
            _ => {}
        }
    }

    pub fn evaluate(&self, now: OffsetDateTime) -> EvaluatedSnapshot {
        let (mut alerts, mut alert_details, silences, am_vm_disagreement) =
            evaluate_alerts(&self.alertmanager, &self.vmalert, &self.known_groups, now);
        let acks = self
            .ack_store
            .as_ref()
            .and_then(|s| s.list_acks().ok())
            .unwrap_or_default();
        let recent_changes =
            collect_recent_changes(&self.victoriametrics, self.host_state.as_deref(), now);
        overlay_acks_and_changes(
            &mut alerts,
            &mut alert_details,
            &acks,
            &recent_changes,
            now,
            self.settings.sources.alertmanager.interval_s,
        );
        let running = evaluate_running(
            &self.victoriametrics,
            &self.components,
            self.bundle_observed_at,
            now,
        );
        let jobs = evaluate_jobs(
            &self.victoriametrics,
            &self.known_jobs,
            &self.settings.budgets,
            now,
        );
        let sources_list = collect_sources(
            SourcesInputs {
                alertmanager: &self.alertmanager,
                vmalert: &self.vmalert,
                victoriametrics: &self.victoriametrics,
                access_jwks_status: &self.access_jwks_status,
                settings: &self.settings,
                bundle_observed_at: self.bundle_observed_at,
                evaluator_observed_at: self.evaluator_observed_at,
            },
            now,
            am_vm_disagreement.as_deref(),
        );
        let worklist = build_worklist(
            &alerts,
            &jobs,
            &self.alertmanager,
            &self.victoriametrics,
            now,
        );

        let work_kinds: Vec<WorkKind> = worklist.iter().map(|w| w.kind).collect();
        let worst_health = if running.components.is_empty() {
            Health::Healthy
        } else {
            roll_up(
                running
                    .components
                    .iter()
                    .map(|c| c.health.value().copied().unwrap_or(Health::Unknown)),
            )
        };
        let evidence_pairs: Vec<(EvidenceState, Option<&str>)> = sources_list
            .iter()
            .map(|s| (s.state, s.reason.as_deref()))
            .collect();
        let home = HomeSnapshotView {
            evaluated_at: now,
            verdict: verdict(worst_health, &work_kinds, &evidence_pairs),
            launch_readiness: None,
            worklist,
            changing: build_changing(&self.victoriametrics, now),
            budgets: build_budgets(&self.victoriametrics, now),
            data_safety: build_data_safety(&self.victoriametrics, &self.settings, now),
            cost: build_cost(&self.victoriametrics, &self.settings, now),
            evidence: EvidenceView {
                counts: count_evidence(&sources_list),
                sources: sources_list
                    .iter()
                    .filter(|s| s.state != EvidenceState::Verified)
                    .cloned()
                    .collect(),
            },
        };

        EvaluatedSnapshot {
            evaluated_at: now,
            home,
            alerts,
            alert_details,
            silences,
            running,
            jobs,
            sources: SourcesView {
                evaluated_at: now,
                sources: sources_list,
            },
        }
    }
}
