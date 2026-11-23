// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::operators::VALID_ACTIONS;

pub fn init_ops_metrics() {
    metrics::gauge!("ops_cockpit_evaluator_last_success_timestamp_seconds").set(0.0);
    metrics::gauge!("ops_cockpit_access_jwks_age_seconds").set(0.0);
    metrics::gauge!("ops_cockpit_sse_clients").set(0.0);
    metrics::counter!("ops_cockpit_sse_resyncs_total").absolute(0);
    metrics::describe_histogram!(
        "ops_cockpit_evaluator_duration_seconds",
        "Duration of ops cockpit evaluation cycles in seconds"
    );
    for outcome in ["success", "error"] {
        metrics::counter!("ops_cockpit_evaluator_runs_total", "outcome" => outcome).absolute(0);
        metrics::counter!("ops_cockpit_record_writes_total", "outcome" => outcome).absolute(0);
        metrics::counter!("ops_cockpit_record_verifications_total", "outcome" => outcome)
            .absolute(0);
    }
    for source in ["alertmanager", "vmalert", "victoriametrics", "access_jwks"] {
        metrics::gauge!("ops_cockpit_source_age_seconds", "source" => source).set(0.0);
        for outcome in ["success", "error"] {
            metrics::counter!(
                "ops_cockpit_source_reads_total",
                "source" => source,
                "outcome" => outcome
            )
            .absolute(0);
        }
    }
    for kind in [
        "home.changed",
        "alert.group.changed",
        "alert.group.resolved",
        "component.changed",
        "job.changed",
        "source.changed",
        "obligation.changed",
        "incident.changed",
        "action.changed",
        "silence.changed",
        "promotion.changed",
        "heartbeat",
        "resync",
    ] {
        metrics::counter!("ops_cockpit_sse_events_total", "type" => kind).absolute(0);
    }
    for action in VALID_ACTIONS {
        for decision in ["allow", "deny"] {
            metrics::counter!(
                "ops_cockpit_authz_decisions_total",
                "action" => action,
                "decision" => decision
            )
            .absolute(0);
        }
    }
}
