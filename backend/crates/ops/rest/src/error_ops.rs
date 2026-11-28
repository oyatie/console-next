// SPDX-License-Identifier: LicenseRef-Proprietary
use axum::http::StatusCode;
use console_ops_application::alert_actions::AlertActionError;
use console_ops_application::changes::ChangeError;
use console_ops_application::domain::alert_actions::SilenceValidationError;
use console_ops_application::domain::incident::IncidentRefusal;
use console_ops_application::domain::obligation::Refusal as ObligationRefusal;
use console_ops_application::incidents::IncidentError;
use console_ops_application::obligations::Error as SpoolError;
use console_ops_application::promote::PromoteError;
use console_ops_application::recovery::RecoveryError;
use console_ops_application::runbooks::RunbookError;

use crate::error::OpsApiError;

pub fn from_spool_error(err: SpoolError, support_ref: String, route: &'static str) -> OpsApiError {
    let message = err.reason();
    OpsApiError::with_code(
        StatusCode::SERVICE_UNAVAILABLE,
        err.code(),
        support_ref,
        route,
        message,
    )
}

pub fn from_obligation_error(
    err: SpoolError,
    support_ref: String,
    route: &'static str,
) -> OpsApiError {
    match err {
        SpoolError::Obligation(refusal) => {
            let (status, message) = match refusal {
                ObligationRefusal::Invalid => (StatusCode::BAD_REQUEST, "invalid obligation input"),
                ObligationRefusal::Incomplete => (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "incomplete obligation fields",
                ),
                ObligationRefusal::Final => (StatusCode::CONFLICT, "obligation is already final"),
                ObligationRefusal::NotFound => (StatusCode::NOT_FOUND, "obligation not found"),
            };
            OpsApiError::with_code(status, refusal.code(), support_ref, route, message)
        }
        other => from_spool_error(other, support_ref, route),
    }
}

pub fn from_alert_action_error(
    err: AlertActionError,
    support_ref: String,
    route: &'static str,
) -> OpsApiError {
    match err {
        AlertActionError::NotFound => {
            OpsApiError::not_found(support_ref, route, "alert group not found")
        }
        AlertActionError::InvalidAckNote => OpsApiError::with_code(
            StatusCode::BAD_REQUEST,
            "OPS_ALERT_ACK_INVALID",
            support_ref,
            route,
            "invalid alert acknowledgement note",
        ),
        AlertActionError::SilenceValidation(err) => {
            let status = match err {
                SilenceValidationError::WatchdogUnsilenceable => StatusCode::UNPROCESSABLE_ENTITY,
                SilenceValidationError::Invalid(_) | SilenceValidationError::TtlExceeded(_) => {
                    StatusCode::BAD_REQUEST
                }
            };
            OpsApiError::with_code(
                status,
                err.code(),
                support_ref,
                route,
                err.message().to_owned(),
            )
        }
        AlertActionError::Spool(err) => from_spool_error(err, support_ref, route),
        AlertActionError::Upstream(_) => OpsApiError::with_code(
            StatusCode::BAD_GATEWAY,
            "OPS_UPSTREAM_FAILED",
            support_ref,
            route,
            "alertmanager write failed",
        ),
    }
}

pub fn from_incident_error(
    err: IncidentError,
    support_ref: String,
    route: &'static str,
) -> OpsApiError {
    match err {
        IncidentError::Domain(refusal) => {
            let (status, message) = match refusal {
                IncidentRefusal::Invalid => (StatusCode::BAD_REQUEST, "invalid incident request"),
                IncidentRefusal::NotFound => (StatusCode::NOT_FOUND, "incident not found"),
                IncidentRefusal::Conflict => (StatusCode::CONFLICT, "incident sequence conflict"),
                IncidentRefusal::PostmortemRequired => (
                    StatusCode::CONFLICT,
                    "SEV1/SEV2 incidents require a linked postmortem before resolving",
                ),
                IncidentRefusal::Final => (StatusCode::CONFLICT, "incident is already resolved"),
            };
            OpsApiError::with_code(status, refusal.code(), support_ref, route, message)
        }
        IncidentError::Spool(err) => from_spool_error(err, support_ref, route),
    }
}

pub fn from_change_error(
    err: ChangeError,
    support_ref: String,
    route: &'static str,
) -> OpsApiError {
    match err {
        ChangeError::InvalidInput(msg) => OpsApiError::bad_request(support_ref, route, msg),
        ChangeError::Spool(err) => from_spool_error(err, support_ref, route),
    }
}

pub fn from_promote_error(
    err: PromoteError,
    support_ref: String,
    route: &'static str,
) -> OpsApiError {
    match err {
        PromoteError::EvidenceUnavailable => OpsApiError::with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "OPS_PROMOTE_EVIDENCE_UNAVAILABLE",
            support_ref,
            route,
            "promotion readiness evidence unavailable",
        ),
        PromoteError::NotReady => OpsApiError::with_code(
            StatusCode::CONFLICT,
            "OPS_PROMOTE_NOT_READY",
            support_ref,
            route,
            "candidate digest is not ready for promotion",
        ),
        PromoteError::InvalidInput(msg) => OpsApiError::bad_request(support_ref, route, msg),
        PromoteError::Spool(err) => from_spool_error(err, support_ref, route),
    }
}

pub fn from_recovery_error(
    err: RecoveryError,
    support_ref: String,
    route: &'static str,
) -> OpsApiError {
    match err {
        RecoveryError::InvalidInput(msg) => OpsApiError::bad_request(support_ref, route, msg),
        RecoveryError::NotFound => OpsApiError::not_found(support_ref, route, "job not found"),
        RecoveryError::Spool(err) => from_spool_error(err, support_ref, route),
    }
}

pub fn from_runbook_error(
    err: RunbookError,
    support_ref: String,
    route: &'static str,
) -> OpsApiError {
    let message = match err {
        RunbookError::NotFound => "runbook not found",
        RunbookError::InvalidPath => "invalid runbook path",
        RunbookError::Unreadable => "runbook unreadable",
    };
    OpsApiError::with_code(
        StatusCode::NOT_FOUND,
        "OPS_RUNBOOK_NOT_FOUND",
        support_ref,
        route,
        message,
    )
}
