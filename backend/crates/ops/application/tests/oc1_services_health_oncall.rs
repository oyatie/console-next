// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::sync::Mutex;

use console_ops_application::actions::{
    ActionRecord, ActionStatus, ActionStore, CmdHandOffInput, new_action_id,
};
use console_ops_application::domain::UtcTimestamp;
use console_ops_application::domain::bundle::validate_oncall_json;
use console_ops_application::domain::ladders::PublicComponent;
use console_ops_application::domain::recovery::{
    BackupRequestInput, BackupType, DrillRepo, DrillRequestInput, DrillType, ExecutionWindow,
};
use console_ops_application::domain::status::parse_status_v2_json;
use console_ops_application::health::HealthService;
use console_ops_application::obligations::{Context, Error as SpoolError, Operator};
use console_ops_application::oncall::OncallService;
use console_ops_application::recovery::{RecoveryError, RecoveryService, rerun_job_cmd};
use console_ops_application::runbooks::{
    RunbookDoc, RunbookDocMeta, RunbookError, RunbookStore, RunbooksService,
};
use console_ops_application::snapshot::SourceKind;
use console_ops_application::sources_status::SourceSlot;
use console_ops_application::victoriametrics::{
    InstantSample, QUERY_CONFIG_BUNDLE_INFO, QUERY_OPS_EVIDENCE_OK,
    QUERY_PGBACKREST_ARCHIVE_MAX_WAL_AGE, QUERY_SLO_ERROR_BUDGET_RATIO, QUERY_SLO_REQUESTS_30D,
    QUERY_SLO_SLI_ERROR_1H, VictoriaMetricsSnapshot,
};
use serde_json::json;
use time::macros::datetime;

mod eval_support;
use eval_support::{bundle, sample};

type TestResult = Result<(), Box<dyn std::error::Error>>;

struct MemActions(Mutex<Vec<ActionRecord>>);
impl ActionStore for MemActions {
    fn list_actions(&self) -> Result<Vec<ActionRecord>, SpoolError> {
        Ok(self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone())
    }
    fn record_handoff(
        &self,
        input: &CmdHandOffInput<'_>,
        context: &Context,
    ) -> Result<ActionRecord, SpoolError> {
        let mut g = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let seq = g.len() as u64 + 1;
        let rec = ActionRecord {
            seq,
            hash: "h".into(),
            support_ref: context.support_ref.clone(),
            at: UtcTimestamp::new(context.at),
            operator: context.operator.person.clone(),
            status: ActionStatus::Pending,
            handoff: console_ops_application::domain::changes::CmdHandOff {
                action_id: new_action_id(seq),
                kind: input.kind.to_owned(),
                command: input.command.to_owned(),
                target: input.target.to_owned(),
                consequence: input.consequence.to_owned(),
                expected_result: input.expected_result.to_owned(),
                verify_step: input.verify_step.to_owned(),
                operator: context.operator.person.clone(),
                at: UtcTimestamp::new(context.at),
            },
        };
        g.push(rec.clone());
        Ok(rec)
    }
}

struct DummyRunbooks;
impl RunbookStore for DummyRunbooks {
    fn list_docs(&self) -> Result<Vec<RunbookDocMeta>, RunbookError> {
        Ok(vec![RunbookDocMeta {
            path: "RUNBOOK.md".into(),
            anchors: vec![],
        }])
    }
    fn read_doc(&self, rel_path: &str) -> Result<RunbookDoc, RunbookError> {
        Ok(RunbookDoc {
            path: rel_path.into(),
            content: "# Runbook".into(),
            anchors: vec![],
        })
    }
}

#[test]
fn recovery_health_runbooks_and_oncall_services_work_end_to_end() -> TestResult {
    let (_, settings) = bundle()?;
    let now = datetime!(2026-11-20 00:00 UTC);
    let interval = NonZeroU64::new(60).ok_or("nonzero")?;
    let ctx = Context {
        at: now,
        operator: Operator {
            person: "op-1".into(),
            method: "access-jwt".into(),
        },
        support_ref: "sup-1".into(),
    };
    let actions = MemActions(Mutex::new(vec![]));

    let mut vm_slot = SourceSlot::new(
        "victoriametrics",
        SourceKind::VictoriaMetrics,
        "vm".into(),
        interval,
    );
    vm_slot.begin_read(now);
    let mut series: BTreeMap<String, Vec<InstantSample>> = BTreeMap::new();
    series.insert(
        QUERY_SLO_ERROR_BUDGET_RATIO.into(),
        vec![sample(&[("slo", "availability")], 0.95)],
    );
    series.insert(
        QUERY_SLO_SLI_ERROR_1H.into(),
        vec![sample(&[("slo", "availability")], 0.5)],
    );
    series.insert(
        QUERY_SLO_REQUESTS_30D.into(),
        vec![sample(&[("slo", "availability")], 200.0)],
    );
    series.insert(
        QUERY_OPS_EVIDENCE_OK.into(),
        vec![sample(&[("source", "pgbackrest")], 1.0)],
    );
    series.insert(
        QUERY_PGBACKREST_ARCHIVE_MAX_WAL_AGE.into(),
        vec![sample(&[("repo", "1")], 60.0)],
    );
    series.insert(
        QUERY_CONFIG_BUNDLE_INFO.into(),
        vec![sample(&[("sha", "deployed-sha")], 1.0)],
    );
    vm_slot.finish_ok(VictoriaMetricsSnapshot {
        series,
        targets: vec![],
    });

    let rec_svc = RecoveryService { actions: &actions };
    let rec_view = rec_svc.build_view(&vm_slot, &settings, now);
    assert_eq!(rec_view.rto.reason(), Some("Not measured"));
    assert!(
        rec_svc
            .request_backup(
                &BackupRequestInput {
                    backup_type: BackupType::Diff,
                    window: ExecutionWindow::Now
                },
                &ctx
            )
            .is_ok()
    );
    assert!(
        rec_svc
            .request_drill(
                &DrillRequestInput {
                    repo: DrillRepo::Repo1,
                    drill_type: DrillType::Name,
                    target: None,
                    window: ExecutionWindow::Window
                },
                &ctx
            )
            .is_ok()
    );
    assert!(matches!(
        rerun_job_cmd(&["nightly".into()], "missing", &actions, &ctx),
        Err(RecoveryError::NotFound)
    ));
    assert!(rerun_job_cmd(&["nightly".into()], "nightly", &actions, &ctx).is_ok());

    let status_snap = parse_status_v2_json(&json!({
        "schema": 2, "rev": 2, "generated_at": "2026-11-20T00:00:00Z", "record_start": "2026-10-01T00:00:00Z",
        "evidence": {"schema": 1, "samples": [{"at": "2026-11-20T00:00:00Z", "components": {"api": "ok"}}]},
        "incidents": [], "maintenances": []
    }).to_string())?;
    let health = HealthService::build_view(&vm_slot, Some(&status_snap), &settings, now);
    assert!(health.internal_slos[0].low_sample);
    assert_eq!(
        health.public_status.components["api"].value(),
        Some(&PublicComponent::Operational)
    );

    let rb_svc = RunbooksService {
        store: &DummyRunbooks,
        bundle_sha: Some("old-sha".into()),
    };
    let rb_list = rb_svc.list(&vm_slot, now).map_err(|e| format!("{e:?}"))?;
    assert!(rb_list.stale_warning.is_some());

    let oncall_cfg = validate_oncall_json(&json!({
        "version": 1, "mode": "single-operator", "display_status": "Single operator on call", "timezone": "Asia/Seoul",
        "rotation": {"primary_person": null, "backup_person": null, "handoff_weekday": "Mon", "handoff_hour_local": 9},
        "escalation": {"ack_timeout_s": 900, "repeat_interval_s": 43200, "out_of_hours_policy": "sev1-symptoms-only", "daily_page_budget": 2},
        "synthetic_page_test": {"enabled": true, "schedule": "weekly", "weekday": "Mon", "hour_utc": 0, "max_delivery_lag_s": 120}
    }).to_string(), None)?;
    let oncall = OncallService::build_view(Some(&oncall_cfg), &vm_slot, now);
    assert_eq!(
        oncall.display_status.value().map(String::as_str),
        Some("Single operator on call")
    );
    assert!(OncallService::request_page_test(&actions, &ctx).is_ok());
    Ok(())
}
